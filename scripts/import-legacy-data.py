#!/usr/bin/env python3
"""Copy your data from an earlier installation into the PHYSIOS data folder.

PHYSIOS 1.x kept its data inside a physical_ai_tools checkout. PHYSIOS 2.x keeps everything
in its own data folder (PHYSIOS_DATA_DIR, default <physios>/data). This script copies:

    <old>/docker/huggingface/                     -> data/huggingface/        datasets, models
    <old>/docker/workspace/physical_ai_manager/   -> data/workspace/physios/  plans, reviews, runs
    <old>/docker/workspace/rosbag2/               -> data/workspace/rosbag2/  ROS bags
    <old>/lerobot/outputs/train/                  -> data/outputs/train/      checkpoints
    <old>/physical_ai_server/config/*_config.yaml -> data/robot-config/       robot configs that
                                                                              PHYSIOS does not ship

It never changes or deletes anything in <old>. Files that already exist in the data folder
are kept. On the same disk, files are hard-linked (no extra space); otherwise copied. The
paths written inside the copied JSON records (runs, plans, checkpoint configs) are updated to
the new locations, so finished runs and their checkpoints keep working. After checking
PHYSIOS, you may delete the old checkout yourself.

    python3 scripts/import-legacy-data.py ~/lerobot/physical_ai_tools [--data DIR] [--dry-run]

Some files of 1.x were written by the robot container as root and only root can read them
(for example workspace/physical_ai_manager/state.json). Without sudo they are skipped and
listed at the end. To import them too, run it with sudo and give the copies to your user:

    sudo python3 scripts/import-legacy-data.py ~/lerobot/physical_ai_tools --owner $(id -u):$(id -g)
"""

import argparse
import os
from pathlib import Path
import shutil
import sys
import tempfile

PHYSIOS = Path(__file__).resolve().parents[1]
BUILT_IN_CONFIGS = PHYSIOS / 'robot' / 'src' / 'physical_ai_server' / 'config'
OLD_CONTAINER_OUTPUTS = '/root/ros2_ws/src/physical_ai_tools/lerobot/outputs'
NEW_CONTAINER_OUTPUTS = '/physios/data/outputs'
MAX_REWRITE_BYTES = 8 << 20


OWNER = None          # (uid, gid) given with --owner


def chown(path):
    if OWNER:
        os.chown(path, *OWNER, follow_symlinks=False)


def make_dirs(d):
    """Create d and its missing parents, owned by OWNER."""
    missing = []
    while not d.exists():
        missing.append(d)
        d = d.parent
    for m in reversed(missing):
        m.mkdir()
        chown(m)


def link_or_copy(src, dst):
    # a hard link shares ownership with the old file, so with --owner only link files that
    # already belong to that user (the old installation's ownership is never changed)
    if not OWNER or os.stat(src).st_uid == OWNER[0]:
        try:
            os.link(src, dst)
            return 'linked'
        except OSError:
            pass
    shutil.copy2(src, dst)
    chown(dst)
    return 'copied'


def copy_tree(src, dst, dry, stats, unreadable):
    if not src.is_dir():
        return
    for root, dirs, files in os.walk(src, onerror=lambda e: unreadable.append(e.filename)):
        rel = Path(root).relative_to(src)
        for name in files:
            s = Path(root) / name
            d = dst / rel / name
            if s.is_symlink():
                stats['skipped symlinks'] += 1
                continue
            if d.exists():
                stats['kept (already present)'] += 1
                continue
            stats['bytes'] += s.stat().st_size
            if not os.access(s, os.R_OK):
                unreadable.append(str(s))
                continue
            if dry:
                stats['to copy'] += 1
                continue
            make_dirs(d.parent)
            try:
                stats[link_or_copy(s, d)] += 1
            except PermissionError:
                unreadable.append(str(s))


def rewrite_paths(folder, pairs, dry, stats):
    """Replace old absolute paths inside JSON records (written to a new file, so a hard
    link to the old installation is never modified)."""
    if not folder.is_dir():
        return
    for root, _, files in os.walk(folder):
        for name in files:
            if not name.endswith(('.json', '.jsonl')):
                continue
            p = Path(root) / name
            try:
                if p.stat().st_size > MAX_REWRITE_BYTES:
                    continue
                text = p.read_text(encoding='utf-8')
            except (OSError, UnicodeDecodeError):
                continue
            new = text
            for a, b in pairs:
                new = new.replace(a, b)
            if new == text:
                continue
            stats['records updated'] += 1
            if dry:
                continue
            fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix='.import-')
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                f.write(new)
            shutil.copymode(p, tmp)
            if OWNER:
                os.chown(tmp, *OWNER)
            os.replace(tmp, p)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('old', help='the earlier physical_ai_tools checkout')
    ap.add_argument('--data', default=os.environ.get('PHYSIOS_DATA_DIR') or str(PHYSIOS / 'data'),
                    help='PHYSIOS data folder (default: $PHYSIOS_DATA_DIR or <physios>/data)')
    ap.add_argument('--dry-run', action='store_true', help='only report what would be copied')
    ap.add_argument('--owner', metavar='UID:GID',
                    help='with sudo: make the imported files belong to this user, e.g. '
                         '--owner $(id -u):$(id -g)')
    a = ap.parse_args(argv)
    global OWNER
    OWNER = None
    if a.owner:
        try:
            OWNER = tuple(int(x) for x in a.owner.split(':', 1))
            assert len(OWNER) == 2
        except (ValueError, AssertionError):
            print('--owner must be UID:GID, e.g. --owner $(id -u):$(id -g)', file=sys.stderr)
            return 2
        if os.geteuid() != 0 and OWNER != (os.getuid(), os.getgid()):
            print('--owner needs sudo.', file=sys.stderr)
            return 2
    old = Path(os.path.expanduser(a.old)).resolve()
    data = Path(os.path.expanduser(a.data)).resolve()
    if not (old / 'docker').is_dir():
        print('%s does not look like an earlier installation (no docker/ folder).' % old,
              file=sys.stderr)
        return 2
    if data == old or old in data.parents:
        print('The data folder must not be inside the old installation.', file=sys.stderr)
        return 2

    from collections import Counter
    stats = Counter()
    unreadable = []
    moves = [
        (old / 'docker' / 'huggingface', data / 'huggingface'),
        (old / 'docker' / 'workspace' / 'physical_ai_manager', data / 'workspace' / 'physios'),
        (old / 'docker' / 'workspace' / 'rosbag2', data / 'workspace' / 'rosbag2'),
        (old / 'lerobot' / 'outputs' / 'train', data / 'outputs' / 'train'),
    ]
    for src, dst in moves:
        if src.is_dir():
            print('  %s\n    -> %s' % (src, dst))
            copy_tree(src, dst, a.dry_run, stats, unreadable)

    built_in = {p.name for p in BUILT_IN_CONFIGS.glob('*_config.yaml')}
    for cfg in sorted((old / 'physical_ai_server' / 'config').glob('*_config.yaml')):
        if cfg.name in built_in:
            continue
        dst = data / 'robot-config' / cfg.name
        print('  robot config %s -> %s' % (cfg.name, dst.parent))
        if dst.exists():
            stats['kept (already present)'] += 1
        elif not os.access(cfg, os.R_OK):
            unreadable.append(str(cfg))
        elif a.dry_run:
            stats['to copy'] += 1
        else:
            make_dirs(dst.parent)
            shutil.copy2(cfg, dst)
            chown(dst)
            stats['copied'] += 1

    pairs = [
        (str(old / 'lerobot' / 'outputs'), str(data / 'outputs')),
        (str(old / 'docker' / 'huggingface'), str(data / 'huggingface')),
        (str(old / 'docker' / 'workspace' / 'physical_ai_manager'),
         str(data / 'workspace' / 'physios')),
        (str(old / 'docker' / 'workspace'), str(data / 'workspace')),
        (OLD_CONTAINER_OUTPUTS, NEW_CONTAINER_OUTPUTS),
    ]
    rewrite_paths(data / 'workspace' / 'physios', pairs, a.dry_run, stats)
    rewrite_paths(data / 'outputs', pairs, a.dry_run, stats)

    size = stats.pop('bytes', 0)
    print('\n%s: %s, %.1f GB' % ('Would import' if a.dry_run else 'Imported',
                                 ', '.join('%s %d' % kv for kv in sorted(stats.items())) or
                                 'nothing', size / 1e9))
    if not a.dry_run:
        print('Nothing was changed in %s.' % old)
    if unreadable:
        print('\n%d file(s) or folder(s) could not be read (written as root by the old robot '
              'container), for example:' % len(unreadable))
        for u in unreadable[:8]:
            print('  ' + u)
        print('Import them too (files already imported are kept):\n'
              '  sudo python3 %s %s --data %s --owner $(id -u):$(id -g)'
              % (Path(__file__).resolve(), old, data))
        return 3
    return 0


if __name__ == '__main__':
    sys.exit(main())
