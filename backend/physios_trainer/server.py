# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""HTTP API (JSON) on 127.0.0.1. The PHYSIOS interface reaches it through
nginx at /train-api/ (same origin)."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import traceback
from urllib.parse import parse_qs, urlparse

from physios_trainer import __version__
from physios_trainer.optimizer import OptError
from physios_trainer.robots.archive import UploadError
from physios_trainer.robots.readiness import ReadinessError
from physios_trainer.robots.store import ROBOT_TYPES, RobotError
from physios_trainer.runner import ACTIVE
from physios_trainer.service import ApiError, Service
from physios_trainer.util import read_json

MAX_BODY = 1 << 20
MAX_UPLOAD = 120 << 20  # robot ZIP / mesh uploads (raw body)


def make_handler(svc):
    class H(BaseHTTPRequestHandler):
        server_version = 'physios-trainer/' + __version__

        def log_message(self, fmt, *args):
            if os.environ.get('PAM_TRAINER_HTTP_LOG'):
                sys.stderr.write('%s\n' % (fmt % args))

        def _send(self, code, obj):
            raw = json.dumps(obj, default=str).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(raw)

        def _body(self):
            n = int(self.headers.get('Content-Length') or 0)
            if n > MAX_BODY:
                raise ApiError('Request too large.', 413)
            if not n:
                return {}
            try:
                data = json.loads(self.rfile.read(n))
            except ValueError:
                raise ApiError('Body must be JSON.')
            if not isinstance(data, dict):
                raise ApiError('Body must be a JSON object.')
            return data

        def _dispatch(self, method):
            u = urlparse(self.path)
            q = {k: v[-1] for k, v in parse_qs(u.query).items()}
            parts = [p for p in u.path.split('/') if p]
            if parts[:1] == ['api']:
                parts = parts[1:]
            try:
                # cross-site protection: browsers send Origin on POST; only same-origin allowed
                if method == 'POST':
                    origin = self.headers.get('Origin')
                    host = self.headers.get('X-Forwarded-Host') or self.headers.get('Host') or ''
                    if origin and urlparse(origin).netloc not in (host, host.split(',')[0]):
                        raise ApiError('Cross-origin request refused.', 403)
                if parts[:1] == ['robots'] and self._robot_binary(method, parts, q):
                    return
                body = self._body() if method == 'POST' else {}
                res = self.route(method, parts, q, body)
                self._send(200, res)
            except (RobotError, UploadError, ReadinessError) as e:
                self._send(getattr(e, 'status', 400), {'error': str(e)})
            except (ApiError, OptError) as e:
                self._send(e.status, {'error': str(e)})
            except KeyError as e:
                self._send(404, {'error': str(e).strip("'")})
            except (ValueError, RuntimeError) as e:
                self._send(400, {'error': str(e)})
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                self._send(500, {'error': 'Internal error: %s' % e})

        def _robot_binary(self, m, p, q):
            """Routes that carry raw bytes: file upload (POST) and asset download (GET)."""
            if m == 'POST' and len(p) == 3 and p[2] == 'upload':
                n = int(self.headers.get('Content-Length') or 0)
                if n > MAX_UPLOAD:
                    raise ApiError('Upload too large (limit %d MB).' % (MAX_UPLOAD >> 20), 413)
                data = self.rfile.read(n)
                if q.get('kind') == 'zip':
                    kept, skipped = svc.robots.add_zip(p[1], data)
                    self._send(200, {'files': kept, 'skipped': skipped})
                else:
                    rel = svc.robots.add_file(p[1], q.get('path', ''), data)
                    self._send(200, {'files': [rel], 'skipped': []})
                return True
            if m == 'GET' and len(p) >= 4 and p[2] == 'asset':
                data, ctype = svc.robots.read_asset(p[1], '/'.join(p[3:]))
                self.send_response(200)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                self.wfile.write(data)
                return True
            return False

        def _robots(self, m, p, b):
            r = svc.robots
            if m == 'GET' and not p:
                return {'robots': r.list(), 'types': list(ROBOT_TYPES)}
            if m == 'POST' and not p:
                return r.create(b)
            rid = p[0]
            if m == 'GET' and len(p) == 1:
                return r.get(rid)
            if m == 'GET' and p[1:] == ['config']:
                return {'config': r.default_config(rid)}
            if m == 'GET' and p[1:] == ['server-config']:
                return r.server_config(rid)
            if m == 'POST' and p[1:] == ['config']:
                return r.save_config(rid, b.get('config'))
            if m == 'POST' and p[1:] == ['verify', 'ros']:
                return r.verify_ros(rid, b.get('evidence'))
            if m == 'POST' and p[1:] == ['verify', 'hardware', 'authorize']:
                return r.hardware_authorize(rid, b.get('joint'), b.get('confirmations'),
                                            b.get('confirm_name'))
            if m == 'POST' and p[1:] == ['verify', 'hardware', 'result']:
                return r.hardware_result(rid, b.get('token'), b.get('result'))
            if m == 'POST' and p[1:] == ['verify', 'data']:
                info, did = None, b.get('dataset_id') or None
                if did:
                    ds = next((d for d in svc.datasets() if d.get('id') == did), None)
                    if not ds:
                        raise ApiError('Dataset %s not found.' % did, 404)
                    info = read_json(Path(ds['path']) / 'meta' / 'info.json') or {}
                return r.verify_data(rid, b.get('policy') or None, info, did)
            if m == 'POST' and len(p) == 2:
                act = p[1]
                if act == 'update':
                    return r.update_meta(rid, b)
                if act == 'replace':
                    return r.replace_urdf(rid)
                if act == 'validate':
                    return r.validate(rid, b.get('entry'))
                if act == 'register':
                    return r.register(rid)
                if act == 'connect':
                    return r.set_connected(rid, bool(b.get('connected')))
                if act == 'delete':
                    return r.delete(rid, b.get('confirm_name'))
            raise ApiError('Not found: %s robots/%s' % (m, '/'.join(p)), 404)

        def do_GET(self):
            self._dispatch('GET')

        def do_POST(self):
            self._dispatch('POST')

        def _optimization(self, m, p, q, b):
            o = svc.opt
            if m == 'GET' and p == ['sessions']:
                return {'sessions': o.list(), 'watches': o.watches()}
            if m == 'POST' and p == ['propose']:
                return o.propose(b.get('request') or {})
            if m == 'POST' and p == ['sessions']:
                return o.create(b.get('request') or {}, b.get('confirm_token'))
            if len(p) >= 2 and p[0] == 'sessions':
                sid = p[1]
                if m == 'GET' and len(p) == 2:
                    return o.load(sid)
                if m == 'POST' and p[2:] == ['stop']:
                    return o.stop(sid)
                if m == 'POST' and p[2:] == ['conclude']:
                    return o.conclude(sid)
                if m == 'POST' and len(p) == 5 and p[2] == 'trials' and p[4] == 'launch':
                    return o.launch_trial(sid, p[3], b.get('confirm_token'))
                if m == 'GET' and p[2:] == ['next-plan']:
                    return o.next_run_plan(sid, int(q['steps']) if q.get('steps') else None,
                                           q.get('init', 'winner'))
            raise ApiError('Not found: %s optimization/%s' % (m, '/'.join(p)), 404)

        def route(self, m, p, q, b):
            if m == 'GET' and p == ['health']:
                return {'ok': True, 'version': __version__}
            if m == 'GET' and p == ['system']:
                return svc.system()
            if m == 'GET' and p == ['envs']:
                return {'envs': svc.environments(refresh=q.get('refresh') == '1')}
            if m == 'GET' and len(p) == 2 and p[0] == 'envs':
                return svc.environment(p[1], refresh=q.get('refresh') == '1')
            if m == 'GET' and p == ['datasets']:
                return {'datasets': svc.datasets(), 'roots': [str(r) for r in svc.dataset_roots]}
            if m == 'GET' and p == ['models']:
                return svc.models(q.get('env', ''), q.get('dataset'))
            if m == 'GET' and p == ['policy-flags']:
                return {'flags': svc.policy_flags(q.get('env', ''), q.get('policy', ''))}
            if m == 'POST' and p == ['plan']:
                return svc.plan(b.get('config') or {})
            if m == 'GET' and p == ['runs']:
                runs = svc.runs.list()
                return {'runs': [_summary(r) for r in runs]}
            if m == 'POST' and p == ['runs']:
                return svc.start(b.get('config') or {}, b.get('confirm_token'))
            # ---- storage / queue / notifications / comparison / evaluations / health
            if m == 'GET' and p == ['storage']:
                return svc.storage.inventory()
            if m == 'POST' and p == ['storage', 'cleanup']:
                return svc.storage.cleanup(b.get('paths') or [], b.get('confirm'))
            if m == 'GET' and p == ['queue']:
                return {'items': svc.queue.list()}
            if m == 'POST' and p == ['queue']:
                return svc.enqueue(b.get('config') or {}, b.get('confirm_token'))
            if m == 'POST' and p == ['queue', 'clear']:
                return {'items': svc.queue.clear_finished()}
            if len(p) == 3 and p[0] == 'queue':
                if m == 'GET' and p[2] == 'preview':
                    return svc.queue_preview(p[1])
                if m == 'POST' and p[2] == 'cancel':
                    return svc.queue.cancel(p[1])
                if m == 'POST' and p[2] == 'confirm':
                    return svc.queue.confirm(p[1], b.get('confirm_token'))
                if m == 'POST' and p[2] == 'move':
                    return {'items': svc.queue.move(p[1], b.get('delta', 0))}
            if m == 'GET' and p == ['events']:
                return svc.notifier.since(int(q.get('after', 0) or 0))
            if m == 'GET' and p == ['compare']:
                return svc.compare((q.get('ids') or '').split(','))
            if m == 'GET' and p == ['evaluations']:
                return svc.evaluation_overview(q.get('run') or None)
            if m == 'POST' and p == ['evaluations']:
                return svc.add_trial(b)
            if len(p) == 2 and p[0] == 'evaluations' and m == 'POST':
                return svc.evaluations.update(p[1], b)
            if len(p) == 3 and p[0] == 'evaluations' and p[2] == 'delete' and m == 'POST':
                return svc.evaluations.delete(p[1])
            if m == 'GET' and p == ['health-report']:
                return svc.health(q.get('path', ''), video=q.get('video', '1') == '1')
            if m == 'POST' and p == ['health-report']:
                return svc.health(b.get('path', ''), b.get('env'), bool(b.get('video', True)),
                                  start=True, refresh=bool(b.get('refresh')))
            # ---- host rollout
            if m == 'POST' and p == ['rollouts', 'prepare']:
                return svc.rollout_prepare(b)
            if m == 'POST' and p == ['rollouts']:
                return svc.rollout_start(b.get('request') or {}, b.get('confirm_token'))
            if m == 'GET' and p == ['rollouts']:
                return {'rollouts': svc.rollouts.list()[:50],
                        'active': svc.rollouts.active()}
            if m == 'POST' and p == ['rollouts', 'limits']:
                return svc.rollouts.save_limits(b.get('dataset_id') or 'dataset',
                                                {'joints': (b.get('limits') or {}).get('joints')
                                                 or []})
            if len(p) >= 2 and p[0] == 'rollouts':
                if m == 'GET' and len(p) == 2:
                    return svc.rollouts.load(p[1])
                if m == 'GET' and p[2:] == ['log']:
                    return svc.rollouts.log_tail(p[1])
                if m == 'POST' and p[2:] == ['command']:
                    return svc.rollouts.command(p[1], b.get('command'))
                if m == 'POST' and p[2:] == ['heartbeat']:
                    return svc.rollouts.heartbeat(p[1])
            if p[:1] == ['robots']:
                return self._robots(m, p[1:], b)
            # ---- optimisation sessions
            if p[:1] == ['optimization']:
                return self._optimization(m, p[1:], q, b)
            if len(p) >= 2 and p[0] == 'runs':
                rid = p[1]
                if m == 'GET' and len(p) == 2:
                    r = svc.runs.load(rid)
                    r['resources_now'] = svc.runs.resources.get(rid) if r['status'] in ACTIVE \
                        else None
                    return r
                if m == 'GET' and p[2:] == ['log']:
                    return svc.runs.log_tail(rid, int(q.get('offset', -1)),
                                             int(q.get('limit', 65536)))
                if m == 'GET' and p[2:] == ['metrics']:
                    return svc.runs.metrics(rid)
                if m == 'GET' and p[2:] == ['diagnostics']:
                    return svc.diagnostics(rid)
                if m == 'GET' and p[2:] == ['resources']:
                    return {'rows': svc.runs.resource_history(rid)}
                if m == 'GET' and p[2:] == ['checkpoints']:
                    return svc.checkpoints(rid)
                if m == 'POST' and p[2:] == ['watch']:
                    return svc.opt.set_watch(rid, b.get('mode', 'off'), b.get('settings'),
                                             bool(b.get('ack')))
                if m == 'POST' and p[2:] == ['stop']:
                    return svc.runs.stop(rid)
                if m == 'POST' and p[2:] == ['pause']:
                    return svc.runs.pause(rid)
                if m == 'POST' and p[2:] == ['resume']:
                    return svc.runs.resume(rid)
                if m == 'POST' and p[2:] == ['retry']:
                    return svc.retry(rid, b.get('mode', 'resume'), b.get('confirm_token'),
                                     b.get('extra_steps'))
                if m == 'POST' and p[2:] == ['metadata']:
                    return svc.save_metadata(rid, b.get('notes', ''), b.get('name', ''))
                if m == 'POST' and p[2:] == ['export']:
                    return svc.export(rid, b.get('step'))
                if m == 'POST' and p[2:] == ['keep']:
                    return svc.keep_checkpoint(rid, b.get('step'), bool(b.get('keep', True)))
            raise ApiError('Not found: %s %s' % (m, '/'.join(p)), 404)

    return H


def _summary(r):
    return {k: r.get(k) for k in ('id', 'created_at', 'updated_at', 'finished_at', 'status',
                                  'job_name', 'output_dir', 'error', 'progress', 'resume_of',
                                  'stage_index')} | {
        'policy': (r.get('plan') or {}).get('policy'),
        'dataset': ((r.get('plan') or {}).get('dataset') or {}).get('id'),
        'env': (r.get('env') or {}).get('name'),
        'stages': [s['kind'] for s in (r.get('plan') or {}).get('stages', [])]}


def main(argv=None):
    physios_home = Path(__file__).resolve().parents[2]  # .../physios
    ap = argparse.ArgumentParser(prog='physios-trainer',
                                 description='RawBot Studio training service (runs on the host)')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=int(os.environ.get('PHYSIOS_TRAINER_PORT', 8766)))
    ap.add_argument('--data-root', default=os.environ.get('PHYSIOS_DATA_DIR') or
                    str(physios_home / 'data'),
                    help='RawBot Studio data folder, shared with the robot container '
                         '(default: $PHYSIOS_DATA_DIR or <physios>/data)')
    ap.add_argument('--repo-root', dest='data_root', help=argparse.SUPPRESS)  # old name
    ap.add_argument('--data-dir', default=None,
                    help='Runs, logs, converted copies (default: '
                         '<data-root>/workspace/physios/training)')
    ap.add_argument('--dataset-root', action='append', default=None,
                    help='Folder with <owner>/<dataset> LeRobot datasets (repeatable)')
    ap.add_argument('--env', action='append', default=[],
                    help='Extra Python environment NAME=PREFIX (e.g. a venv)')
    a = ap.parse_args(argv)
    root = Path(os.path.expanduser(a.data_root))
    root.mkdir(parents=True, exist_ok=True)
    work = root / 'workspace' / 'physios'
    data_dir = Path(a.data_dir) if a.data_dir else work / 'training'
    roots = a.dataset_root or [str(root / 'huggingface' / 'lerobot'),
                               '~/.cache/huggingface/lerobot']
    extra = dict(e.split('=', 1) for e in a.env)
    review_store = work / 'reviews'
    if a.host not in ('127.0.0.1', 'localhost', '::1'):
        print('Refusing to listen on %s: this service runs commands; keep it on 127.0.0.1.' %
              a.host, file=sys.stderr)
        return 2
    svc = Service(root, data_dir, roots, extra, review_store if review_store.exists() else None,
                  log=lambda m: print('[physios-trainer]', m, flush=True))
    httpd = ThreadingHTTPServer((a.host, a.port), make_handler(svc))
    print('[physios-trainer] %s listening on http://%s:%d  data: %s' % (
        __version__, a.host, a.port, data_dir), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
