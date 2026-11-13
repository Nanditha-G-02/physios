# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""Persistent custom-robot profiles (``<data_dir>/robots/<id>/``).

Layout: ``profile.json`` (metadata, latest validation, config, readiness, history),
``files/`` (uploaded files, unpacked and checked), ``resolved.urdf`` (the URDF the viewer and
the checks use; for Xacro it is the safely expanded output). A profile is a *draft* until its
URDF has no validation errors and the operator registers it (Stage 1). Uploads are never run.
The built-in SO-101 is not stored here and is never changed by this module.
"""

import os
from pathlib import Path
import re
import shutil
import tempfile
import threading
import uuid

import time

from physios_trainer.robots import archive, readiness as rd, urdf, xacro
from physios_trainer.util import atomic_write_json, now_iso, read_json, slug

ROBOT_TYPES = ('arm', 'mobile_manipulator', 'gripper', 'humanoid', 'other')


class RobotError(Exception):
    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.status = status


def _text(v, field, maxlen, required=False):
    v = (v or '').strip() if isinstance(v, str) or v is None else str(v).strip()
    if required and not v:
        raise RobotError('%s is required.' % field)
    if len(v) > maxlen:
        raise RobotError('%s is too long (max %d characters).' % (field, maxlen))
    return v


class RobotStore:
    def __init__(self, data_dir):
        self.root = Path(data_dir) / 'robots'
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.hw_tokens = {}  # token -> {rid, plan, fp, exp}; in memory only, single use

    # ---- paths ----------------------------------------------------------------------
    def _dir(self, rid):
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{2,60}', rid or ''):
            raise RobotError('Unknown robot.', 404)
        d = self.root / rid
        if not d.is_dir():
            raise RobotError('Unknown robot.', 404)
        return d

    def _load(self, rid):
        p = read_json(self._dir(rid) / 'profile.json')
        if not p:
            raise RobotError('Robot profile is unreadable.', 500)
        return p

    def _save(self, p):
        p['updated_at'] = now_iso()
        atomic_write_json(self.root / p['id'] / 'profile.json', p)

    def _event(self, p, kind, text):
        p.setdefault('history', []).append({'t': now_iso(), 'kind': kind, 'text': text})
        p['history'] = p['history'][-200:]

    # ---- listing ----------------------------------------------------------------------
    def brief(self, p):
        v = p.get('validation') or {}
        s = v.get('summary') or {}
        return {k: p.get(k) for k in ('id', 'name', 'description', 'manufacturer', 'type',
                                      'state', 'created_at', 'updated_at', 'connected')} | {
            'validation_status': v.get('status'), 'links': s.get('links'),
            'joints': s.get('joints'), 'dof': s.get('dof'), 'stage': p.get('stage', 0),
            'readiness': '%d/4' % (p.get('stage') or 0)}

    def list(self):
        out = []
        with self.lock:
            for d in sorted(self.root.iterdir()):
                p = read_json(d / 'profile.json') if d.is_dir() else None
                if p:
                    out.append(self.brief(p))
        out.sort(key=lambda r: r.get('created_at') or '')
        return out

    def get(self, rid):
        with self.lock:
            p = self._load(rid)
            p['files'] = archive.list_files(self._dir(rid) / 'files')
            p['readiness'] = rd.summarize(p)
            return p

    # ---- create / edit ----------------------------------------------------------------------
    def create(self, meta):
        name = _text(meta.get('name'), 'Name', 80, True)
        typ = meta.get('type') or 'arm'
        if typ not in ROBOT_TYPES:
            raise RobotError('Type must be one of: %s.' % ', '.join(ROBOT_TYPES))
        with self.lock:
            for r in self.list():
                if r['name'].lower() == name.lower():
                    raise RobotError('A custom robot named "%s" already exists.' % name, 409)
            rid = '%s-%s' % (slug(name, 'robot')[:30].strip('-_') or 'robot',
                             uuid.uuid4().hex[:6])
            rid = rid.lower()
            d = self.root / rid
            (d / 'files').mkdir(parents=True)
            p = {'id': rid, 'name': name, 'description': _text(meta.get('description'),
                                                              'Description', 1000),
                 'manufacturer': _text(meta.get('manufacturer'), 'Manufacturer', 80),
                 'type': typ, 'state': 'draft', 'created_at': now_iso(), 'entry': None,
                 'source': None, 'validation': None, 'stage': 0, 'connected': False,
                 'history': [], 'config': None, 'readiness': None}
            self._event(p, 'created', 'Profile created.')
            self._save(p)
            return p

    def update_meta(self, rid, meta):
        with self.lock:
            p = self._load(rid)
            if 'name' in meta:
                name = _text(meta['name'], 'Name', 80, True)
                for r in self.list():
                    if r['id'] != rid and r['name'].lower() == name.lower():
                        raise RobotError('A custom robot named "%s" already exists.' % name, 409)
                p['name'] = name
            if 'description' in meta:
                p['description'] = _text(meta['description'], 'Description', 1000)
            if 'manufacturer' in meta:
                p['manufacturer'] = _text(meta['manufacturer'], 'Manufacturer', 80)
            if 'type' in meta:
                if meta['type'] not in ROBOT_TYPES:
                    raise RobotError('Type must be one of: %s.' % ', '.join(ROBOT_TYPES))
                p['type'] = meta['type']
            self._event(p, 'edited', 'Details edited.')
            self._save(p)
            return p

    # ---- files ----------------------------------------------------------------------
    def _files_dir(self, rid):
        return self._dir(rid) / 'files'

    def add_file(self, rid, rel, data):
        with self.lock:
            p = self._load(rid)
            rel = archive.write_file(self._files_dir(rid), rel, data)
            self._event(p, 'file', 'Added %s.' % rel)
            self._save(p)
            return rel

    def add_zip(self, rid, data):
        with self.lock:
            p = self._load(rid)
            fd, tmp = tempfile.mkstemp(suffix='.zip', dir=str(self._dir(rid)))
            try:
                with os.fdopen(fd, 'wb') as f:
                    f.write(data)
                kept, skipped = archive.extract_zip(tmp, self._files_dir(rid))
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            self._event(p, 'file', 'Unpacked ZIP: %d file(s)%s.' % (
                len(kept), ', %d skipped' % len(skipped) if skipped else ''))
            self._save(p)
            return kept, skipped

    def clear_files(self, rid):
        with self.lock:
            fd = self._files_dir(rid)
            if fd.exists():
                shutil.rmtree(fd)
            fd.mkdir(parents=True)

    def detect_entries(self, rid):
        files = archive.list_files(self._files_dir(rid))
        urdfs = [f for f in files if f.lower().endswith('.urdf')]
        xac = [f for f in files if f.lower().endswith('.xacro')]
        top = [f for f in xac if f.lower().endswith('.urdf.xacro')]
        return urdfs, (top or xac)

    # ---- validate ----------------------------------------------------------------------
    def _read_text(self, rid, rel):
        path = (self._files_dir(rid) / rel).resolve()
        if self._files_dir(rid).resolve() not in path.parents:
            raise RobotError('Bad path.')
        return path.read_text(encoding='utf-8', errors='replace')

    def validate(self, rid, entry=None):
        with self.lock:
            p = self._load(rid)
            files = archive.list_files(self._files_dir(rid))
            if not files:
                raise RobotError('Upload a URDF (or a ZIP containing one) first.', 409)
            urdfs, xacros = self.detect_entries(rid)
            entry = entry or p.get('entry')
            if entry and entry not in files:
                entry = None
            expand_notes = []
            if not entry:
                cands = urdfs or xacros
                if not cands:
                    p['validation'] = urdf.validate('<x', files)  # reports syntax error
                    p['validation']['checks'] = [{
                        'level': 'error', 'id': 'no_entry', 'title': 'No URDF or Xacro file found',
                        'detail': 'The upload contains no .urdf or .xacro file.',
                        'suggestion': 'Upload a .urdf, a .urdf.xacro or a ZIP that contains one.',
                        'where': ''}]
                    p['validation'].update(status='errors', counts={
                        'error': 1, 'warning': 0, 'info': 0, 'ok': 0})
                    self._finish_validation(p, rid)
                    return p
                if len(cands) > 1:
                    # prefer a single file at the shallowest depth
                    cands = sorted(cands, key=lambda f: (f.count('/'), len(f)))
                    if cands[0].count('/') == cands[1].count('/') and not p.get('entry'):
                        p['entry_candidates'] = cands
                        self._save(p)
                        raise RobotError('Several URDF/Xacro files found (%s). Choose which one '
                                         'to use.' % ', '.join(cands[:6]), 409)
                entry = cands[0]
            p.pop('entry_candidates', None)
            p['entry'] = entry
            is_x = entry.lower().endswith('.xacro')
            p['source'] = 'xacro' if is_x else 'urdf'
            try:
                if is_x:
                    fset = set(files)

                    def find_include(name, frm):
                        n = name.replace('package://', '').lstrip('/')
                        base = os.path.dirname(frm)
                        for c in (os.path.normpath(os.path.join(base, n)).replace('\\', '/'), n):
                            if c in fset:
                                return c
                        for f in files:
                            if f.endswith('/' + n) or f == n:
                                return f
                        return None

                    text, expand_notes = xacro.expand_to_urdf(
                        lambda f: self._read_text(rid, f), find_include, entry)
                else:
                    text = self._read_text(rid, entry)
            except xacro.XacroError as e:
                rep = urdf._finish([{
                    'level': 'error', 'id': 'xacro', 'title': 'Xacro could not be expanded safely',
                    'detail': str(e), 'suggestion': 'Fix the file, or expand it yourself '
                    '("xacro robot.urdf.xacro > robot.urdf") and upload the URDF.', 'where': entry}],
                    {'name': None, 'links': 0, 'joints': 0, 'dof': 0}, [])
                p['validation'] = rep
                self._finish_validation(p, rid)
                return p
            (self._dir(rid) / 'resolved.urdf').write_text(text, encoding='utf-8')
            fdir = self._files_dir(rid)
            rep = urdf.validate(text, files, read_bytes=lambda f: (fdir / f).read_bytes(),
                                urdf_dir=os.path.dirname(entry),
                                is_expanded_xacro=is_x)
            if is_x:
                rep['checks'].insert(0, {
                    'level': 'info', 'id': 'xacro_expanded',
                    'title': 'Xacro expanded with the safe built-in expander',
                    'detail': 'No scripts were run. ' + ' '.join(expand_notes),
                    'suggestion': '', 'where': entry})
                rep['counts']['info'] += 1
            p['validation'] = rep
            self._finish_validation(p, rid)
            return p

    def _finish_validation(self, p, rid):
        v = p['validation']
        v['at'] = now_iso()
        self._event(p, 'validated', 'Validation: %s (%d error(s), %d warning(s)).' % (
            v['status'], v['counts'].get('error', 0), v['counts'].get('warning', 0)))
        if v['status'] == 'errors' and p.get('state') == 'registered':
            p['state'] = 'draft'
            p['stage'] = 0
            p['connected'] = False
            p['readiness'] = None
            p['verifications'] = {}
            self._event(p, 'unregistered', 'Registration withdrawn because validation failed.')
        self._save(p)

    # ---- register / replace / connect / delete ----------------------------------------------
    def register(self, rid):
        with self.lock:
            p = self._load(rid)
            v = p.get('validation')
            if not v:
                raise RobotError('Validate the URDF first.', 409)
            if v['status'] == 'errors':
                raise RobotError('This URDF has errors and cannot be registered. Fix the errors '
                                 'listed in the report.', 409)
            p['state'] = 'registered'
            p['stage'] = max(1, p.get('stage') or 0)
            if p.get('config'):  # a kept configuration is re-checked against the new URDF
                p['config'], p['config_issues'] = rd.check_config(p, p['config'])
            self._event(p, 'registered', 'Stage 1 complete: URDF registered.')
            self._save(p)
            return p

    def replace_urdf(self, rid):
        """Called before new files are uploaded: removes old files and resets later stages."""
        with self.lock:
            p = self._load(rid)
            self.clear_files(rid)
            for f in ('resolved.urdf',):
                q = self._dir(rid) / f
                if q.exists():
                    q.unlink()
            was = p.get('state')
            p.update(entry=None, source=None, validation=None, state='draft', stage=0,
                     connected=False, readiness=None, verifications={})
            p.pop('entry_candidates', None)
            self._event(p, 'replaced', 'URDF replaced%s; later stages must be verified again.' %
                        (' (was registered)' if was == 'registered' else ''))
            self._save(p)
            return p

    def set_connected(self, rid, on):
        with self.lock:
            p = self._load(rid)
            if on and (p.get('stage') or 0) < 2:
                raise RobotError('Complete ROS verification (Stage 2) before connecting.', 409)
            p['connected'] = bool(on)
            if not on:  # an open test authorisation never outlives a disconnect
                for t in [t for t, v in self.hw_tokens.items() if v['rid'] == rid]:
                    self.hw_tokens.pop(t, None)
            self._event(p, 'connected' if on else 'disconnected',
                        'Robot %s.' % ('connected' if on else 'disconnected'))
            self._save(p)
            return self.get(rid)

    def delete(self, rid, confirm_name):
        with self.lock:
            p = self._load(rid)
            if (confirm_name or '').strip() != p['name']:
                raise RobotError('Type the robot name exactly to confirm deletion.', 409)
            shutil.rmtree(self._dir(rid))
            return {'deleted': rid}

    # ---- configuration and readiness (Stages 2-4) -------------------------------------------
    def _need_stage(self, p, n, what):
        if p.get('state') != 'registered' or (p.get('stage') or 0) < n:
            raise RobotError('%s needs Stage %d (%s) first.' % (what, n, [
                'draft', 'URDF registered', 'ROS verified', 'hardware verified'][n]), 409)

    def default_config(self, rid):
        with self.lock:
            p = self._load(rid)
            return p.get('config') or rd.default_config(p)

    def save_config(self, rid, cfg):
        with self.lock:
            p = self._load(rid)
            self._need_stage(p, 1, 'Configuration')
            clean, issues = rd.check_config(p, cfg)
            new = rd.fingerprints(clean)
            ver = p.get('verifications') or {}
            stage, dropped = p.get('stage') or 1, None
            for key, n in (('ros', 2), ('hardware', 3), ('data', 4)):
                v = ver.get(key)
                fp_key = 'hardware' if key == 'hardware' else key
                if v and v.get('fp') != new[fp_key] and stage >= n:
                    dropped = n
                    break
            if dropped:
                stage = dropped - 1
                for key, n in (('ros', 2), ('hardware', 3), ('data', 4)):
                    if n >= dropped:
                        ver.pop(key, None)
                self._event(p, 'stage_reset', 'Configuration changed what Stage %d verified; '
                            'back to Stage %d.' % (dropped, stage))
            p.update(config=clean, config_issues=issues, verifications=ver, stage=stage)
            if stage < 2:
                p['connected'] = False
            self._event(p, 'config', 'Configuration saved (%d error(s), %d warning(s)).' % (
                sum(i['level'] == 'error' for i in issues),
                sum(i['level'] == 'warning' for i in issues)))
            self._save(p)
            return self.get(rid)

    def _cfg_ok(self, p):
        if not p.get('config'):
            raise RobotError('Save a robot configuration first.', 409)
        if any(i['level'] == 'error' for i in p.get('config_issues') or []):
            raise RobotError('Fix the configuration errors first.', 409)
        return p['config']

    def verify_ros(self, rid, evidence):
        with self.lock:
            p = self._load(rid)
            self._need_stage(p, 1, 'ROS verification')
            cfg = self._cfg_ok(p)
            checks = rd.check_ros_evidence(cfg, evidence)
            ok = not any(c['level'] == 'error' for c in checks)
            ver = p.setdefault('verifications', {})
            ver['ros_last'] = {'at': now_iso(), 'ok': ok, 'checks': checks}
            if ok:
                ver['ros'] = {'at': now_iso(), 'checks': checks,
                              'fp': rd.fingerprints(cfg)['ros']}
                if (p.get('stage') or 0) < 2:
                    p['stage'] = 2
                    self._event(p, 'stage', 'Stage 2 complete: ROS topics verified.')
            else:
                self._event(p, 'ros_failed', 'ROS checks failed (%d error(s)).' % sum(
                    c['level'] == 'error' for c in checks))
            self._save(p)
            return {'ok': ok, 'checks': checks, 'robot': self.get(rid)}

    def hardware_authorize(self, rid, joint, confirmations, confirm_name):
        with self.lock:
            p = self._load(rid)
            self._need_stage(p, 2, 'The hardware test')
            cfg = self._cfg_ok(p)
            if not p.get('connected'):
                raise RobotError('Connect the robot first.', 409)
            if cfg['command_interface'] == 'none':
                raise RobotError('Set a command interface first.', 409)
            if not cfg['calibration']['done']:
                raise RobotError('Mark calibration as done first.', 409)
            conf = confirmations if isinstance(confirmations, dict) else {}
            missing = [text for key, text in rd.CHECKLIST if conf.get(key) is not True]
            if missing:
                raise RobotError('Confirm every safety item: %s' % ' '.join(missing), 409)
            if (confirm_name or '').strip() != p['name']:
                raise RobotError('Type the robot name exactly to authorise motion.', 409)
            plan = rd.hardware_plan(cfg, p, joint)
            now = time.time()
            for t in [t for t, v in self.hw_tokens.items() if v['rid'] == rid or v['exp'] < now]:
                self.hw_tokens.pop(t, None)
            tok = rd.new_token()
            self.hw_tokens[tok] = {'rid': rid, 'plan': plan, 'exp': now + rd.HW_TOKEN_TTL_S,
                                   'fp': rd.fingerprints(cfg)['hardware']}
            self._event(p, 'hw_authorized', 'Operator authorised a one-joint test of %s '
                        '(%.3f at %.3f/s).' % (joint, plan['amplitude'], plan['velocity']))
            self._save(p)
            return {'token': tok, 'plan': plan, 'expires_in_s': rd.HW_TOKEN_TTL_S}

    def hardware_result(self, rid, token, result):
        with self.lock:
            p = self._load(rid)
            t = self.hw_tokens.pop(token or '', None)
            if not t or t['rid'] != rid:
                raise RobotError('Unknown or already used test authorisation.', 409)
            res = result if isinstance(result, dict) else {}
            ver = p.setdefault('verifications', {})
            cfg = p.get('config')
            if t['exp'] + 120 < time.time():
                ok, reasons = False, ['The authorisation expired before the result arrived.']
            elif not cfg or rd.fingerprints(cfg)['hardware'] != t['fp']:
                ok, reasons = False, ['The configuration changed during the test.']
            else:
                ok, reasons = rd.check_hardware_result(t['plan'], res)
            entry = {'at': now_iso(), 'ok': ok, 'joint': t['plan']['joint'], 'reasons': reasons,
                     'outcome': res.get('outcome'), 'reason': res.get('reason'),
                     'samples': len(res.get('samples') or []), 'plan': t['plan']}
            hist = ver.setdefault('hardware_attempts', [])
            hist.append(entry)
            ver['hardware_attempts'] = hist[-20:]
            if ok:
                ver['hardware'] = {'at': now_iso(), 'result': entry,
                                   'fp': rd.fingerprints(cfg)['hardware']}
                if (p.get('stage') or 0) < 3:
                    p['stage'] = 3
                self._event(p, 'stage', 'Stage 3 complete: supervised test of %s passed.' %
                            t['plan']['joint'])
            else:
                self._event(p, 'hw_failed', 'Hardware test of %s did not pass: %s' % (
                    t['plan']['joint'], ' '.join(reasons)[:300]))
            self._save(p)
            return {'ok': ok, 'reasons': reasons, 'robot': self.get(rid)}

    def verify_data(self, rid, policy=None, dataset_info=None, dataset_id=None):
        with self.lock:
            p = self._load(rid)
            self._need_stage(p, 3, 'The data/training check')
            cfg = self._cfg_ok(p)
            checks, compat, feats = rd.check_data(cfg, policy, dataset_info)
            ok = not any(c['level'] == 'error' for c in checks)
            ver = p.setdefault('verifications', {})
            ver['data_last'] = {'at': now_iso(), 'ok': ok, 'checks': checks,
                                'policy': policy, 'dataset': dataset_id}
            if ok:
                ver['data'] = {'at': now_iso(), 'checks': checks, 'compat': compat,
                               'policy': policy, 'dataset': dataset_id,
                               'fp': rd.fingerprints(cfg)['data']}
                if (p.get('stage') or 0) < 4:
                    p['stage'] = 4
                self._event(p, 'stage', 'Stage 4 complete: data and training layout compatible.')
            self._save(p)
            return {'ok': ok, 'checks': checks, 'compat': compat, 'features': feats,
                    'robot': self.get(rid)}

    def server_config(self, rid):
        with self.lock:
            p = self._load(rid)
            self._need_stage(p, 3, 'Exporting the server configuration')
            key, text = rd.server_config_yaml(p, self._cfg_ok(p))
            return {'robot_type': key, 'filename': '%s_config.yaml' % key, 'yaml': text}

    # ---- serving ----------------------------------------------------------------------
    def read_asset(self, rid, rel):
        """(bytes, content_type) for a file the viewer needs; confined to the robot folder."""
        with self.lock:
            self._load(rid)
            if rel == 'resolved.urdf':
                path = self._dir(rid) / 'resolved.urdf'
            else:
                rel = archive.clean_relpath(rel)
                path = (self._files_dir(rid) / rel).resolve()
                if self._files_dir(rid).resolve() not in path.parents:
                    raise RobotError('Not found.', 404)
            if not path.is_file() or path.is_symlink():
                raise RobotError('Not found.', 404)
            ext = os.path.splitext(str(path))[1].lower()
            ctype = {'.urdf': 'application/xml', '.stl': 'model/stl', '.dae': 'model/vnd.collada+xml',
                     '.obj': 'text/plain', '.glb': 'model/gltf-binary', '.png': 'image/png',
                     '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}.get(ext, 'application/octet-stream')
            return path.read_bytes(), ctype
