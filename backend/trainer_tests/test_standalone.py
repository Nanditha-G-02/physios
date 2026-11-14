"""PHYSIOS 2.x standalone layout: the data folder, the LeRobot lock, and the import of data
from an earlier physical_ai_tools based installation."""

import importlib.util
import os
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
PHYSIOS = HERE.parents[1]
sys.path.insert(0, str(HERE.parent))

from physios_trainer import service as svc_mod  # noqa: E402
from physios_trainer.service import Service  # noqa: E402


def make(tmp_path):
    return Service(tmp_path / 'data', tmp_path / 'data' / 'workspace' / 'physios' / 'training',
                   [tmp_path / 'data' / 'huggingface' / 'lerobot'], {}, log=lambda m: None,
                   autostart_optimizer=False)


def test_repository_is_self_contained():
    """Nothing in the code refers to a surrounding physical_ai_tools checkout."""
    hits = []
    for folder in ('backend/physios_gateway', 'backend/physios_trainer', 'tests/e2e',
                   'docker', 'scripts'):
        for p in (PHYSIOS / folder).rglob('*'):
            if p.suffix not in ('.py', '.sh', '.yml', '') or not p.is_file() or \
                    p.name == 'import-legacy-data.py':
                continue
            text = p.read_text(errors='ignore')
            for needle in ('physical_ai_trainer', 'physical_ai_tools', 'PHYSIOS_REPO_ROOT',
                           'physical_ai_manager/e2e', "'..', '..'"):
                if needle in text:
                    hits.append('%s: %s' % (p.relative_to(PHYSIOS), needle))
    assert not hits, hits
    for f in ('start_physios.sh', 'stop_physios.sh'):
        text = (PHYSIOS / f).read_text()
        assert 'physical_ai' not in text and 'REPO=' not in text, f


def test_data_folder_and_container_paths(tmp_path):
    s = make(tmp_path)
    data = (tmp_path / 'data').resolve()
    assert s.output_root == data / 'outputs' / 'train'
    ck = data / 'outputs' / 'train' / 'run1' / 'checkpoints' / '000100'
    ck.mkdir(parents=True)
    assert s.container_path(ck) == '/physios/data/outputs/train/run1/checkpoints/000100'
    ds = data / 'huggingface' / 'lerobot' / 'me' / 'cube'
    ds.mkdir(parents=True)
    assert s.container_path(ds) == '/root/.cache/huggingface/lerobot/me/cube'
    assert s.container_path(tmp_path / 'elsewhere') is None
    assert s.system()['data_root'] == str(data)


def test_robot_lerobot_version_from_lock(tmp_path, monkeypatch):
    monkeypatch.delenv('PHYSIOS_ROBOT_LEROBOT_VERSION', raising=False)
    lock = (PHYSIOS / 'robot' / 'lerobot.lock').read_text()
    assert 'version = "0.2.0"' in lock and svc_mod.ROBOT_LEROBOT_LOCK.exists()
    assert make(tmp_path).container_lerobot() == '0.2.0'
    monkeypatch.setenv('PHYSIOS_ROBOT_LEROBOT_VERSION', '0.3.1')
    assert make(tmp_path).container_lerobot() == '0.3.1'
    # the Dockerfile installs the commit named in the lock
    commit = [l for l in lock.splitlines() if l.startswith('commit')][0].split('"')[1]
    assert commit in (PHYSIOS / 'docker' / 'robot' / 'Dockerfile').read_text()


def test_trainer_cli_defaults_to_physios_data(tmp_path):
    out = subprocess.run([sys.executable, '-m', 'physios_trainer', '--help'],
                         cwd=str(HERE.parent), capture_output=True, text=True, timeout=30)
    assert out.returncode == 0 and '--data-root' in out.stdout and 'physios' in out.stdout


def _load_importer():
    spec = importlib.util.spec_from_file_location(
        'import_legacy', PHYSIOS / 'scripts' / 'import-legacy-data.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_import_legacy_data(tmp_path):
    old = tmp_path / 'physical_ai_tools'
    ds = old / 'docker' / 'huggingface' / 'lerobot' / 'me' / 'cube' / 'meta'
    ds.mkdir(parents=True)
    (ds / 'info.json').write_text('{"fps": 30}')
    run = old / 'docker' / 'workspace' / 'physical_ai_manager' / 'training' / 'runs' / 'r1'
    run.mkdir(parents=True)
    (run / 'run.json').write_text(json.dumps({
        'output_dir': str(old / 'lerobot' / 'outputs' / 'train' / 'r1'),
        'dataset': str(old / 'docker' / 'huggingface' / 'lerobot' / 'me' / 'cube'),
        'container': '/root/ros2_ws/src/physical_ai_tools/lerobot/outputs/train/r1'}))
    ck = old / 'lerobot' / 'outputs' / 'train' / 'r1' / 'checkpoints' / '000100'
    ck.mkdir(parents=True)
    (ck / 'model.safetensors').write_bytes(b'weights')
    cfg = old / 'physical_ai_server' / 'config'
    cfg.mkdir(parents=True)
    (cfg / 'omx_f_config.yaml').write_text('built in')
    (cfg / 's101_config.yaml').write_text('mine')
    before = (run / 'run.json').read_text()

    data = tmp_path / 'data'
    mod = _load_importer()
    assert mod.main([str(old), '--data', str(data), '--dry-run']) == 0
    assert not data.exists()
    assert mod.main([str(old), '--data', str(data)]) == 0

    assert (data / 'huggingface' / 'lerobot' / 'me' / 'cube' / 'meta' / 'info.json').exists()
    assert (data / 'outputs' / 'train' / 'r1' / 'checkpoints' / '000100' /
            'model.safetensors').read_bytes() == b'weights'
    assert (data / 'robot-config' / 's101_config.yaml').read_text() == 'mine'
    assert not (data / 'robot-config' / 'omx_f_config.yaml').exists()
    rec = json.loads((data / 'workspace' / 'physios' / 'training' / 'runs' / 'r1' /
                      'run.json').read_text())
    assert rec['output_dir'] == str(data.resolve() / 'outputs' / 'train' / 'r1')
    assert rec['dataset'] == str(data.resolve() / 'huggingface' / 'lerobot' / 'me' / 'cube')
    assert rec['container'] == '/physios/data/outputs/train/r1'
    # the old installation is untouched, even where files were hard-linked
    assert (run / 'run.json').read_text() == before
    # a second run keeps what is there
    assert mod.main([str(old), '--data', str(data)]) == 0


def _old_with_root_file(tmp_path):
    old = tmp_path / 'physical_ai_tools'
    ws = old / 'docker' / 'workspace' / 'physical_ai_manager'
    (ws / 'plans' / 'p1').mkdir(parents=True)
    (ws / 'state.json').write_text('{"active_plan": "p1"}')
    (ws / 'plans' / 'p1' / 'plan.json').write_text('{"id": "p1"}')
    (old / 'docker' / 'huggingface').mkdir(parents=True)
    return old, ws


def test_import_skips_unreadable_files(tmp_path, monkeypatch):
    """Files only root can read (written by the old container) are skipped and listed,
    not a crash; the sudo command to import them is printed."""
    old, ws = _old_with_root_file(tmp_path)
    mod = _load_importer()
    real = os.access
    monkeypatch.setattr(mod.os, 'access',
                        lambda p, m: False if str(p).endswith('state.json') else real(p, m))
    data = tmp_path / 'data'
    assert mod.main([str(old), '--data', str(data)]) == 3
    assert (data / 'workspace' / 'physios' / 'plans' / 'p1' / 'plan.json').exists()
    assert not (data / 'workspace' / 'physios' / 'state.json').exists()


def test_import_with_owner_copies_and_never_changes_old_files(tmp_path):
    if os.geteuid() != 0:
        import pytest
        pytest.skip('needs root (as with sudo)')
    old, ws = _old_with_root_file(tmp_path)
    os.chmod(ws / 'state.json', 0o600)
    mod = _load_importer()
    data = tmp_path / 'data'
    assert mod.main([str(old), '--data', str(data), '--owner', '1234:1234']) == 0
    new = data / 'workspace' / 'physios' / 'state.json'
    st = new.stat()
    assert (st.st_uid, st.st_gid) == (1234, 1234)
    assert st.st_ino != (ws / 'state.json').stat().st_ino        # copied, not hard-linked
    assert (ws / 'state.json').stat().st_uid == 0                # old file untouched
    assert (data / 'workspace' / 'physios').stat().st_uid == 1234   # new folders too
    assert mod.main([str(old), '--data', str(data), '--owner', 'x']) == 2


def test_planning_store_files_are_readable(tmp_path):
    sys.path.insert(0, str(PHYSIOS / 'robot' / 'src' / 'physical_ai_server'))
    from physical_ai_server.planning import store
    store.atomic_write_json(tmp_path / 'a.json', {'x': 1})
    store.atomic_write_json(tmp_path / 's.json', {'t': 1}, mode=0o600)
    assert (tmp_path / 'a.json').stat().st_mode & 0o777 == 0o644
    assert (tmp_path / 's.json').stat().st_mode & 0o777 == 0o600


def test_import_recreates_symlinks(tmp_path):
    """The Hugging Face hub cache links snapshots to blobs; the links must survive."""
    old = tmp_path / 'physical_ai_tools'
    hub = old / 'docker' / 'huggingface' / 'hub' / 'models--me--policy'
    (hub / 'blobs').mkdir(parents=True)
    (hub / 'blobs' / 'abc').write_bytes(b'weights')
    snap = hub / 'snapshots' / 'r1'
    snap.mkdir(parents=True)
    (snap / 'model.safetensors').symlink_to('../../blobs/abc')
    (snap / 'abs.bin').symlink_to(hub / 'blobs' / 'abc')
    mod = _load_importer()
    data = tmp_path / 'data'
    assert mod.main([str(old), '--data', str(data)]) == 0
    nsnap = data / 'huggingface' / 'hub' / 'models--me--policy' / 'snapshots' / 'r1'
    assert (nsnap / 'model.safetensors').is_symlink()
    assert (nsnap / 'model.safetensors').read_bytes() == b'weights'
    assert str(data.resolve()) in os.readlink(nsnap / 'abs.bin')
    assert (nsnap / 'abs.bin').read_bytes() == b'weights'
    assert mod.main([str(old), '--data', str(data)]) == 0      # again: links kept


def test_robot_image_keeps_numpy1_compatible_packages():
    """pandas 3 needs NumPy 2 and crashed the robot server in the first 2.0.0 image."""
    c = (PHYSIOS / 'robot' / 'constraints.txt').read_text()
    for pin in ('numpy<2', 'pandas<3', 'pyarrow<26', 'opencv-python-headless<5'):
        assert pin in c.splitlines(), pin
    df = (PHYSIOS / 'docker' / 'robot' / 'Dockerfile').read_text()
    assert 'PIP_CONSTRAINT=/etc/physios/constraints.txt' in df
    assert "import physical_ai_server.physical_ai_server" in df   # build fails, not runtime


def test_robot_server_folders_are_packages():
    """A folder without __init__.py is left out by a normal colcon build
    ('No module named physical_ai_server.training.trainers.lerobot')."""
    root = PHYSIOS / 'robot' / 'src' / 'physical_ai_server' / 'physical_ai_server'
    missing = [str(d.relative_to(root)) for d in root.rglob('*')
               if d.is_dir() and d.name != '__pycache__' and any(d.glob('*.py'))
               and not (d / '__init__.py').exists()]
    assert not missing, missing
    assert '--symlink-install' in (PHYSIOS / 'docker' / 'robot' / 'Dockerfile').read_text()


def test_browse_and_add_dataset_location(tmp_path):
    """Training page: browse folders on this PC and add a dataset that lives elsewhere."""
    from physios_trainer.service import ApiError
    s = make(tmp_path)
    other = tmp_path / 'elsewhere' / 'lerobot'
    ds = other / 'me' / 'cube'
    (ds / 'meta').mkdir(parents=True)
    (ds / 'meta' / 'info.json').write_text(json.dumps({'codebase_version': 'v2.1', 'total_episodes': 3,
                                                       'fps': 30, 'features': {}}))
    (tmp_path / 'elsewhere' / 'notes').mkdir()
    listing = s.browse(str(tmp_path / 'elsewhere'))
    names = {e['name']: e for e in listing['entries']}
    assert set(names) == {'lerobot', 'notes'} and not names['lerobot']['dataset']
    assert s.browse(str(other / 'me'))['entries'][0]['dataset'] is True
    assert s.browse(str(ds))['dataset'] is True
    # picking the dataset folder adds its <folder>/<owner>/<name> root, persisted
    r = s.add_dataset_root(str(ds))
    assert r['root'] == str(other.resolve()) and r['dataset'] == str(ds.resolve())
    assert any(d['path'] == str(ds.resolve()) or d['id'] == 'me/cube' for d in s.datasets())
    assert s.dataset(str(ds))['id'] == 'me/cube'
    assert make(tmp_path).dataset(str(ds))['id'] == 'me/cube'       # survives a restart
    s.add_dataset_root(str(other))                                   # adding again: no duplicate
    assert [str(x.resolve()) for x in s.dataset_roots].count(str(other.resolve())) == 1
    for bad in (tmp_path / 'elsewhere' / 'notes', tmp_path / 'missing'):
        try:
            s.add_dataset_root(str(bad))
            assert False, bad
        except ApiError:
            pass
