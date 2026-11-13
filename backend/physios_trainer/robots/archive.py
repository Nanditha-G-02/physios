# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Safe handling of uploaded robot files: ZIP extraction and path rules.

Nothing in an upload is executed. Only files with an allow-listed extension are kept, paths are
normalised and confined to the robot folder (no ``..``, absolute paths, drive letters or
symlinks), and size / count / compression-ratio limits stop zip bombs.
"""

import os
from pathlib import Path, PurePosixPath
import zipfile

ALLOWED_EXT = {
    '.urdf', '.xacro', '.xml', '.stl', '.dae', '.obj', '.mtl', '.glb', '.gltf', '.bin',
    '.png', '.jpg', '.jpeg', '.tga', '.bmp', '.yaml', '.yml', '.md', '.txt', '.json', '.sdf',
}
MAX_FILES = 3000
MAX_FILE_BYTES = 80 << 20
MAX_TOTAL_BYTES = 300 << 20
MAX_RATIO = 200  # uncompressed / compressed per file


class UploadError(ValueError):
    pass


def clean_relpath(name):
    """Return a safe POSIX relative path or raise."""
    if not isinstance(name, str) or not name or '\x00' in name:
        raise UploadError('Bad file name.')
    n = name.replace('\\', '/')
    if n.startswith('/') or (len(n) > 1 and n[1] == ':'):
        raise UploadError('Absolute paths are not allowed: %s' % name)
    parts = []
    for p in PurePosixPath(n).parts:
        if p in ('', '.'):
            continue
        if p == '..':
            raise UploadError('Path escapes the robot folder: %s' % name)
        parts.append(p)
    if not parts or len(n) > 300:
        raise UploadError('Bad file name: %s' % name[:80])
    return '/'.join(parts)


def ext_of(path):
    return os.path.splitext(path)[1].lower()


def write_file(root, rel, data):
    rel = clean_relpath(rel)
    if ext_of(rel) not in ALLOWED_EXT:
        raise UploadError('File type not accepted: %s' % rel)
    if len(data) > MAX_FILE_BYTES:
        raise UploadError('%s is larger than %d MB.' % (rel, MAX_FILE_BYTES >> 20))
    root = Path(root).resolve()
    dest = (root / rel).resolve()
    if root not in dest.parents:
        raise UploadError('Path escapes the robot folder: %s' % rel)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return rel


def extract_zip(zip_path, root):
    """Extract allowed files; return (list of kept relative paths, list of skipped notes)."""
    kept, skipped, total = [], [], 0
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        raise UploadError('This is not a valid ZIP file.')
    with zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
        if len(infos) > MAX_FILES:
            raise UploadError('The ZIP has too many files (limit %d).' % MAX_FILES)
        for i in infos:
            mode = (i.external_attr >> 16) & 0o170000
            if mode == 0o120000:
                skipped.append('%s (symbolic link)' % i.filename)
                continue
            try:
                rel = clean_relpath(i.filename)
            except UploadError as e:
                raise UploadError('Unsafe path in the ZIP: %s' % e)
            if rel.startswith('__MACOSX/') or os.path.basename(rel).startswith('.'):
                continue
            if ext_of(rel) not in ALLOWED_EXT:
                skipped.append('%s (file type not accepted)' % rel)
                continue
            if i.file_size > MAX_FILE_BYTES:
                raise UploadError('%s is larger than %d MB.' % (rel, MAX_FILE_BYTES >> 20))
            if i.compress_size and i.file_size / i.compress_size > MAX_RATIO and \
                    i.file_size > (1 << 20):
                raise UploadError('%s has a suspicious compression ratio.' % rel)
            total += i.file_size
            if total > MAX_TOTAL_BYTES:
                raise UploadError('The ZIP is larger than %d MB when unpacked.' %
                                  (MAX_TOTAL_BYTES >> 20))
            with zf.open(i) as src:
                data = src.read(MAX_FILE_BYTES + 1)
            if len(data) > MAX_FILE_BYTES:
                raise UploadError('%s is larger than %d MB.' % (rel, MAX_FILE_BYTES >> 20))
            write_file(root, rel, data)
            kept.append(rel)
    return sorted(kept), skipped


def list_files(root):
    root = Path(root)
    out = []
    if root.is_dir():
        for p in sorted(root.rglob('*')):
            if p.is_file() and not p.is_symlink():
                out.append(p.relative_to(root).as_posix())
    return out
