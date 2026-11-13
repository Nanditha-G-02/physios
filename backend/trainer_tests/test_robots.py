# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0
import sys
import zipfile
import io
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

from physios_trainer.robots import archive, urdf, xacro  # noqa: E402
from physios_trainer.robots.store import RobotError, RobotStore  # noqa: E402
import robot_fixtures as rf  # noqa: E402


def levels(rep):
    return {(c['id'], c['level']) for c in rep['checks']}


def ids(rep, level):
    return {c['id'] for c in rep['checks'] if c['level'] == level}


# ---- validator -----------------------------------------------------------------------------
def test_valid_arm_with_meshes():
    files = ['demo_arm/meshes/%s.stl' % n for n in ('base', 'l1', 'l2', 'l3')]
    rep = urdf.validate(rf.arm_urdf(), files, read_bytes=lambda f: rf.stl_box())
    assert rep['status'] == 'passed', rep['checks']
    s = rep['summary']
    assert (s['links'], s['joints'], s['dof'], s['base_link']) == (4, 3, 3, 'base')
    assert s['meshes_found'] == 4 and s['end_links'] == ['l3']
    assert abs(s['extent_m'][2] - 0.3) < 1e-6
    assert rep['tree']['link'] == 'base'


def test_syntax_and_root_errors():
    assert 'xml_syntax' in ids(urdf.validate('<robot><link></robot>'), 'error')
    assert 'root' in ids(urdf.validate('<notrobot/>'), 'error')
    assert 'xml_entity' in ids(urdf.validate('<!DOCTYPE x [<!ENTITY a "b">]><robot/>'), 'error')


def test_structure_errors():
    base = '<robot name="r">%s%s%s</robot>'
    # missing link, bad type, duplicate parent
    r = urdf.validate(base % (rf.link('a'), rf.link('b'), rf.joint('j', 'a', 'zz')))
    assert 'joint_link_missing' in ids(r, 'error')
    r = urdf.validate(base % (rf.link('a'), rf.link('b'),
                              rf.joint('j', 'a', 'b', typ='wobbly')))
    assert 'joint_type' in ids(r, 'error')
    r = urdf.validate('<robot name="r">%s%s%s%s%s</robot>' % (
        rf.link('a'), rf.link('b'), rf.link('c'), rf.joint('j1', 'a', 'c'),
        rf.joint('j2', 'b', 'c')))
    assert 'multi_parent' in ids(r, 'error')
    r = urdf.validate(base % (rf.link('a'), rf.link('b'), ''))
    assert 'base_link' in ids(r, 'error')  # two roots
    r = urdf.validate('<robot name="r">%s%s%s%s</robot>' % (
        rf.link('a'), rf.link('b'), rf.joint('j1', 'a', 'b'), rf.joint('j2', 'b', 'a')))
    assert 'cycle' in ids(r, 'error')


def test_limits_and_units():
    base = '<robot name="r">%s%s%s</robot>'
    r = urdf.validate(base % (rf.link('a'), rf.link('b'), rf.joint('j', 'a', 'b', lo=1, hi=-1)))
    assert 'limit_order' in ids(r, 'error')
    r = urdf.validate(base % (rf.link('a'), rf.link('b'), rf.joint('j', 'a', 'b', lo=-90, hi=90)))
    assert 'limit_units' in ids(r, 'warning')
    r = urdf.validate(base % (rf.link('a'), rf.link('b'), rf.joint('j', 'a', 'b', z=500)))
    assert 'units_length' in ids(r, 'warning')
    r = urdf.validate(base % (rf.link('a'), rf.link('b'),
                              rf.joint('j', 'a', 'b', axis='0 0 0')))
    assert 'axis_zero' in ids(r, 'error')
    nolimit = ('<robot name="r"><link name="a"/><link name="b"/><joint name="j" type="revolute">'
               '<parent link="a"/><child link="b"/></joint></robot>')
    assert 'limit_missing' in ids(urdf.validate(nolimit), 'error')


def test_mesh_checks():
    r = urdf.validate(rf.arm_urdf(), files=[])
    assert 'mesh_missing' in ids(r, 'error')
    big = rf.stl_box(500, 500, 900)  # looks like mm
    files = ['demo_arm/meshes/%s.stl' % n for n in ('base', 'l1', 'l2', 'l3')]
    r = urdf.validate(rf.arm_urdf(), files, read_bytes=lambda f: big)
    assert 'mesh_units' in ids(r, 'warning')
    remote = rf.arm_urdf().replace('package://demo_arm/meshes/base.stl', 'http://evil.example/x.stl')
    assert 'mesh_remote' in ids(urdf.validate(remote, files), 'error')


# ---- archive safety ----------------------------------------------------------------------------
def test_zip_traversal_and_types(tmp_path):
    bad = rf.make_zip({'../evil.urdf': 'x'})
    p = tmp_path / 'b.zip'
    p.write_bytes(bad)
    with pytest.raises(archive.UploadError):
        archive.extract_zip(p, tmp_path / 'out')
    assert not (tmp_path / 'evil.urdf').exists()
    absz = rf.make_zip({'/etc/x.urdf': 'x'})
    p.write_bytes(absz)
    with pytest.raises(archive.UploadError):
        archive.extract_zip(p, tmp_path / 'out')
    ok = rf.make_zip({'a/r.urdf': '<robot/>', 'a/run.sh': 'rm -rf /', 'a/x.py': 'print(1)',
                      '__MACOSX/._r.urdf': 'junk'})
    p.write_bytes(ok)
    kept, skipped = archive.extract_zip(p, tmp_path / 'out2')
    assert kept == ['a/r.urdf'] and len(skipped) == 2
    assert not (tmp_path / 'out2' / 'a' / 'run.sh').exists()
    p.write_bytes(b'not a zip')
    with pytest.raises(archive.UploadError):
        archive.extract_zip(p, tmp_path / 'o3')


def test_zip_symlink_skipped(tmp_path):
    bio = io.BytesIO()
    with zipfile.ZipFile(bio, 'w') as z:
        zi = zipfile.ZipInfo('a/link.urdf')
        zi.external_attr = (0o120777 << 16)
        z.writestr(zi, '/etc/passwd')
        z.writestr('a/r.urdf', '<robot/>')
    p = tmp_path / 's.zip'
    p.write_bytes(bio.getvalue())
    kept, skipped = archive.extract_zip(p, tmp_path / 'o')
    assert kept == ['a/r.urdf'] and 'symbolic' in skipped[0]


# ---- xacro ---------------------------------------------------------------------------------------
def _expand(files, entry, **kw):
    def find(name, frm):
        n = name.replace('$(find demo_arm)/', 'demo_arm/').replace('package://', '')
        return n if n in files else None
    return xacro.expand_to_urdf(lambda f: files[f], find, entry)


def test_xacro_macros_include_math():
    files = {'robot.urdf.xacro': rf.ARM_XACRO, 'demo_arm/urdf/common.xacro': rf.COMMON_XACRO}
    text, notes = _expand(files, 'robot.urdf.xacro')
    rep = urdf.validate(text)
    assert rep['status'] != 'errors', rep['checks']
    assert rep['summary']['links'] == 3 and rep['summary']['dof'] == 2
    js = {j['name']: j for j in rep['summary']['joint_list']}
    assert js['j_l1']['xyz'] == [0.0, 0.0, 0.1] and js['j_l2']['xyz'][2] == 0.4
    assert js['j_l1']['lower'] == -1.0 and js['j_l1']['upper'] == 1.0
    assert any('find' in n for n in notes)


@pytest.mark.parametrize('expr', [
    '__import__("os").system("id")', 'open("/etc/passwd").read()',
    '().__class__.__bases__', '[x for x in range(9)]', 'lambda: 1',
    'math.__dict__', 'eval("1")', '9**9**9', '"a"*10**9'])
def test_xacro_rejects_code(expr):
    src = ('<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="r">'
           '<xacro:property name="p" value="${%s}"/><link name="l_${p}"/></robot>' % expr)
    with pytest.raises(xacro.XacroError):
        xacro.expand_to_urdf(lambda f: src, lambda n, f: None, 'r.xacro')


@pytest.mark.parametrize('sub', ['$(env HOME)', '$(optenv X)', '$(eval 1+1)', '$(cwd)'])
def test_xacro_rejects_substitutions(sub):
    src = ('<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="r"><link name="%s"/>'
           '</robot>' % sub)
    with pytest.raises(xacro.XacroError):
        xacro.expand_to_urdf(lambda f: src, lambda n, f: None, 'r.xacro')


def test_xacro_include_outside_archive_refused():
    src = ('<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="r">'
           '<xacro:include filename="/etc/passwd"/></robot>')
    with pytest.raises(xacro.XacroError, match='not in the uploaded archive'):
        xacro.expand_to_urdf(lambda f: src, lambda n, f: None, 'r.xacro')


def test_xacro_macro_bomb_limited():
    src = ('<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="r">'
           '<xacro:macro name="m" params="n"><xacro:m n="${n+1}"/></xacro:macro>'
           '<xacro:m n="0"/></robot>')
    with pytest.raises(xacro.XacroError):
        xacro.expand_to_urdf(lambda f: src, lambda n, f: None, 'r.xacro')


# ---- store ---------------------------------------------------------------------------------------
def test_store_lifecycle_and_persistence(tmp_path):
    st = RobotStore(tmp_path)
    p = st.create({'name': 'Demo Arm', 'description': 'd', 'manufacturer': 'ACME', 'type': 'arm'})
    rid = p['id']
    with pytest.raises(RobotError):
        st.create({'name': 'demo arm'})
    with pytest.raises(RobotError, match='Upload'):
        st.validate(rid)
    kept, _ = st.add_zip(rid, rf.arm_zip())
    assert len(kept) == 5
    with pytest.raises(RobotError, match='errors|Validate'):
        st.register(rid)
    p = st.validate(rid)
    assert p['validation']['status'] == 'passed' and p['entry'].endswith('demo_arm.urdf')
    p = st.register(rid)
    assert p['state'] == 'registered' and p['stage'] == 1
    # persisted across a "restart"
    st2 = RobotStore(tmp_path)
    assert st2.list()[0]['state'] == 'registered'
    data, ctype = st2.read_asset(rid, 'resolved.urdf')
    assert b'<robot' in data
    data, ctype = st2.read_asset(rid, 'demo_arm/meshes/base.stl')
    assert ctype == 'model/stl'
    for bad in ('../profile.json', '../../etc/passwd', '/etc/passwd'):
        with pytest.raises(Exception):
            st2.read_asset(rid, bad)
    with pytest.raises(RobotError):
        st2.read_asset('../x', 'a')
    # connect needs stage 2
    with pytest.raises(RobotError, match='Stage 2'):
        st2.set_connected(rid, True)
    # replace resets
    st2.replace_urdf(rid)
    p = st2.get(rid)
    assert p['state'] == 'draft' and p['stage'] == 0 and p['files'] == []
    # delete needs the exact name
    with pytest.raises(RobotError, match='exactly'):
        st2.delete(rid, 'nope')
    st2.delete(rid, 'Demo Arm')
    assert st2.list() == []


def test_store_xacro_zip_and_invalid(tmp_path):
    st = RobotStore(tmp_path)
    rid = st.create({'name': 'X'})['id']
    st.add_zip(rid, rf.make_zip({'robot.urdf.xacro': rf.ARM_XACRO,
                                 'demo_arm/urdf/common.xacro': rf.COMMON_XACRO}))
    p = st.validate(rid)
    assert p['source'] == 'xacro' and p['validation']['status'] != 'errors'
    assert (tmp_path / 'robots' / rid / 'resolved.urdf').exists()
    # an unsafe xacro becomes a validation error, never an exception or code execution
    rid2 = st.create({'name': 'Y'})['id']
    st.add_file(rid2, 'bad.urdf.xacro',
                b'<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="r">'
                b'<link name="${__import__(\'os\').getcwd()}"/></robot>')
    p = st.validate(rid2)
    assert p['validation']['status'] == 'errors'
    with pytest.raises(RobotError):
        st.register(rid2)


def test_registered_robot_demoted_when_revalidation_fails(tmp_path):
    st = RobotStore(tmp_path)
    rid = st.create({'name': 'Z'})['id']
    st.add_zip(rid, rf.arm_zip())
    st.validate(rid)
    st.register(rid)
    st.add_file(rid, 'demo_arm/urdf/demo_arm.urdf', b'<robot name="x"><link name="a"></robot>')
    p = st.validate(rid)
    assert p['state'] == 'draft' and p['stage'] == 0


def test_multiple_urdfs_require_choice(tmp_path):
    st = RobotStore(tmp_path)
    rid = st.create({'name': 'M'})['id']
    st.add_file(rid, 'a.urdf', rf.arm_urdf().encode())
    st.add_file(rid, 'b.urdf', rf.arm_urdf('other').encode())
    with pytest.raises(RobotError, match='Several'):
        st.validate(rid)
    p = st.validate(rid, entry='b.urdf')
    assert p['validation']['summary']['name'] == 'other'


# ---- HTTP -----------------------------------------------------------------------------------------
def test_http_roundtrip(tmp_path):
    import json
    import threading
    import urllib.request
    from http.server import ThreadingHTTPServer
    from physios_trainer.server import make_handler

    class FakeSvc:
        robots = RobotStore(tmp_path)

    httpd = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(FakeSvc()))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d' % httpd.server_address[1]

    def call(method, path, body=None, raw=None, ok=True):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(base + path, data=data, method=method)
        if raw is None and data:
            req.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    try:
        c, b, _ = call('POST', '/robots', {'name': 'HTTP Arm', 'type': 'arm'})
        rid = json.loads(b)['id']
        c, b, _ = call('POST', '/robots/%s/upload?kind=zip' % rid, raw=rf.arm_zip())
        assert c == 200 and len(json.loads(b)['files']) == 5
        c, b, _ = call('POST', '/robots/%s/validate' % rid, {})
        assert json.loads(b)['validation']['status'] == 'passed'
        c, b, _ = call('POST', '/robots/%s/register' % rid, {})
        assert json.loads(b)['state'] == 'registered'
        c, b, h = call('GET', '/robots/%s/asset/demo_arm/meshes/base.stl' % rid)
        assert c == 200 and h['X-Content-Type-Options'] == 'nosniff' and len(b) > 84
        c, b, _ = call('GET', '/robots/%s/asset/../profile.json' % rid)
        assert c in (400, 404)
        c, b, _ = call('POST', '/robots/%s/upload?path=../x.urdf' % rid, raw=b'x')
        assert c == 400
        c, b, _ = call('POST', '/robots/%s/upload?path=run.sh' % rid, raw=b'x')
        assert c == 400
        c, b, _ = call('POST', '/robots/%s/delete' % rid, {'confirm_name': 'wrong'})
        assert c == 409
        c, b, _ = call('POST', '/robots/%s/delete' % rid, {'confirm_name': 'HTTP Arm'})
        assert c == 200
        c, b, _ = call('GET', '/robots')
        assert json.loads(b)['robots'] == []
    finally:
        httpd.shutdown()
