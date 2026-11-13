# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""URDF validation. Pure functions: text (+ the uploaded file list) in, a report out.

Report: ``{status, counts, checks[], summary, tree}``. ``status`` is ``errors`` (cannot be
registered), ``warnings`` (can be registered, review them) or ``passed``. Each check has
``level`` (error|warning|info|ok), ``id``, ``title``, ``detail``, ``suggestion``, ``where``.
"""

import math
import re
import struct
import xml.etree.ElementTree as ET

JOINT_TYPES = ('revolute', 'continuous', 'prismatic', 'fixed', 'floating', 'planar')
MESH_RENDERABLE = ('.stl', '.dae', '.obj', '.glb', '.gltf')
NUM = re.compile(r'^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$')


def _floats(s, n, ctx, add, what):
    if s is None:
        return [0.0] * n
    parts = s.split()
    if len(parts) != n or not all(NUM.match(p) for p in parts):
        add('error', 'bad_vector', 'Invalid %s' % what,
            '"%s" must be %d numbers.' % (s, n), 'Write it as %s.' % ' '.join(['0'] * n), ctx)
        return None
    v = [float(p) for p in parts]
    if not all(math.isfinite(x) for x in v):
        add('error', 'bad_vector', 'Non-finite %s' % what, '"%s" contains inf/nan.' % s,
            'Use finite numbers.', ctx)
        return None
    return v


def stl_bounds(data, scale=(1, 1, 1)):
    """Bounding box (min, max) of a binary or ASCII STL, or None."""
    try:
        if len(data) >= 84:
            n = struct.unpack('<I', data[80:84])[0]
            if 84 + 50 * n == len(data) and n > 0:
                lo, hi = [math.inf] * 3, [-math.inf] * 3
                for i in range(n):
                    off = 84 + 50 * i + 12
                    for k in range(3):
                        v = struct.unpack('<3f', data[off + 12 * k:off + 12 * k + 12])
                        for a in range(3):
                            lo[a] = min(lo[a], v[a])
                            hi[a] = max(hi[a], v[a])
                return ([lo[a] * scale[a] for a in range(3)],
                        [hi[a] * scale[a] for a in range(3)])
        txt = data.decode('ascii', 'ignore')
        vs = re.findall(r'vertex\s+(\S+)\s+(\S+)\s+(\S+)', txt)
        if vs:
            pts = [[float(x) for x in v] for v in vs]
            lo = [min(p[a] for p in pts) * scale[a] for a in range(3)]
            hi = [max(p[a] for p in pts) * scale[a] for a in range(3)]
            return lo, hi
    except (struct.error, ValueError):
        return None
    return None


def resolve_mesh(filename, files, urdf_dir=''):
    """Map a mesh reference to a path inside the uploaded file list, or None."""
    f = filename.strip()
    if f.startswith('file://'):
        f = f[7:]
    if f.startswith('package://'):
        rest = f[len('package://'):]
        cands = [rest, rest.split('/', 1)[1] if '/' in rest else rest]
    else:
        cands = [f, (urdf_dir.rstrip('/') + '/' + f) if urdf_dir else f]
    fset = set(files)
    low = {x.lower(): x for x in files}
    for c in cands:
        c = c.lstrip('/')
        if c in fset:
            return c
        if c.lower() in low:
            return low[c.lower()]
    # suffix match: package name differs from folder name inside the ZIP
    for c in cands:
        c = c.lstrip('/')
        for x in files:
            if x == c or x.endswith('/' + c):
                return x
    return None


def validate(text, files=(), read_bytes=None, urdf_dir='', is_expanded_xacro=False):
    checks = []

    def add(level, cid, title, detail='', suggestion='', where=''):
        checks.append({'level': level, 'id': cid, 'title': title, 'detail': detail,
                       'suggestion': suggestion, 'where': where})

    summary = {'name': None, 'links': 0, 'joints': 0, 'dof': 0, 'base_link': None,
               'end_links': [], 'meshes': 0, 'meshes_found': 0, 'total_mass': 0.0,
               'joint_types': {}, 'extent_m': None, 'mesh_map': {}, 'units': 'meters / radians (assumed)'}
    tree = []

    low = text[:4096].lower()
    if '<!doctype' in low or '<!entity' in text.lower():
        add('error', 'xml_entity', 'DOCTYPE / ENTITY declaration',
            'The file declares an XML DOCTYPE or ENTITY, which is not accepted for uploads.',
            'Remove the declaration.')
        return _finish(checks, summary, tree)
    try:
        root = ET.fromstring(text)
    except ET.ParseError as e:
        add('error', 'xml_syntax', 'Not well-formed XML', str(e),
            'Fix the XML error at the position shown.')
        return _finish(checks, summary, tree)
    add('ok', 'xml_syntax', 'XML is well-formed')
    if root.tag != 'robot':
        add('error', 'root', 'Root element is not <robot>', 'Found <%s>.' % root.tag,
            'A URDF starts with <robot name="...">.')
        return _finish(checks, summary, tree)
    name = root.get('name')
    summary['name'] = name
    if not name:
        add('error', 'robot_name', 'Robot has no name', '', 'Add name="..." to <robot>.')
    else:
        add('ok', 'robot_name', 'Robot name: %s' % name)

    links, joints = {}, []
    for el in root:
        if el.tag == 'link':
            n = el.get('name')
            if not n:
                add('error', 'link_name', 'A <link> has no name', '', 'Give every link a name.')
            elif n in links:
                add('error', 'link_dup', 'Duplicate link name', '"%s" is defined twice.' % n,
                    'Link names must be unique.', n)
            else:
                links[n] = el
        elif el.tag == 'joint':
            joints.append(el)
        elif el.tag == 'material' or el.tag in ('transmission', 'gazebo', 'ros2_control', 'plugin'):
            pass
        elif el.tag not in ('material',):
            add('info', 'unknown_tag', 'Unrecognised element <%s>' % el.tag,
                'Ignored by the viewer.', '', el.tag)
    summary['links'], summary['joints'] = len(links), len(joints)
    if not links:
        add('error', 'no_links', 'No links', 'The robot has no <link>.', 'Add at least one link.')
        return _finish(checks, summary, tree)
    add('ok', 'links', '%d link(s) found' % len(links))

    jnames, parent_of, children, jinfo = set(), {}, {}, {}
    ok_struct = True
    for j in joints:
        jn = j.get('name')
        where = jn or '(unnamed joint)'
        if not jn:
            add('error', 'joint_name', 'A <joint> has no name', '', 'Name every joint.')
            ok_struct = False
            continue
        if jn in jnames:
            add('error', 'joint_dup', 'Duplicate joint name', '"%s" is defined twice.' % jn,
                'Joint names must be unique.', jn)
            ok_struct = False
            continue
        jnames.add(jn)
        jt = j.get('type')
        if jt not in JOINT_TYPES:
            add('error', 'joint_type', 'Invalid joint type', '"%s" has type "%s".' % (jn, jt),
                'Use one of: %s.' % ', '.join(JOINT_TYPES), jn)
            ok_struct = False
            continue
        summary['joint_types'][jt] = summary['joint_types'].get(jt, 0) + 1
        p = (j.find('parent').get('link') if j.find('parent') is not None else None)
        c = (j.find('child').get('link') if j.find('child') is not None else None)
        if not p or not c:
            add('error', 'joint_ends', 'Joint is missing <parent> or <child>',
                '"%s" needs both.' % jn, 'Add <parent link="..."/> and <child link="..."/>.', jn)
            ok_struct = False
            continue
        bad = [x for x in (p, c) if x not in links]
        if bad:
            add('error', 'joint_link_missing', 'Joint refers to a link that does not exist',
                '"%s" uses %s.' % (jn, ', '.join('"%s"' % b for b in bad)),
                'Define the link or fix the name.', jn)
            ok_struct = False
            continue
        if c in parent_of:
            add('error', 'multi_parent', 'A link has two parent joints',
                '"%s" is the child of "%s" and "%s".' % (c, parent_of[c][1], jn),
                'URDF is a tree: each link has exactly one parent joint. Use <mimic> or '
                'a closed-chain workaround instead.', jn)
            ok_struct = False
            continue
        parent_of[c] = (p, jn)
        children.setdefault(p, []).append((c, jn))
        og = j.find('origin')
        xyz = _floats(og.get('xyz') if og is not None else None, 3, jn, add, 'origin xyz')
        rpy = _floats(og.get('rpy') if og is not None else None, 3, jn, add, 'origin rpy')
        ax = [1.0, 0.0, 0.0]
        if jt in ('revolute', 'continuous', 'prismatic', 'planar'):
            ae = j.find('axis')
            if ae is not None:
                ax = _floats(ae.get('xyz'), 3, jn, add, 'axis') or ax
            n = math.sqrt(sum(x * x for x in ax))
            if n < 1e-9:
                add('error', 'axis_zero', 'Joint axis is zero', '"%s" axis is 0 0 0.' % jn,
                    'Give a non-zero axis such as 0 0 1.', jn)
                ok_struct = False
            elif abs(n - 1) > 1e-3:
                add('warning', 'axis_norm', 'Joint axis is not unit length',
                    '"%s" axis length is %.3f.' % (jn, n), 'Normalise it (e.g. 0 0 1).', jn)
        lim = j.find('limit')
        lo = hi = None
        if jt in ('revolute', 'prismatic'):
            if lim is None:
                add('error', 'limit_missing', 'Joint has no <limit>',
                    '"%s" is %s, which requires lower, upper, effort and velocity.' % (jn, jt),
                    'Add <limit lower="" upper="" effort="" velocity=""/> (or use continuous).', jn)
            else:
                try:
                    lo, hi = float(lim.get('lower', 'nan')), float(lim.get('upper', 'nan'))
                except ValueError:
                    lo = hi = math.nan
                if not (math.isfinite(lo) and math.isfinite(hi)):
                    add('error', 'limit_bounds', 'Limit lower/upper missing or invalid',
                        '"%s".' % jn, 'Set numeric lower and upper.', jn)
                elif lo >= hi:
                    add('error', 'limit_order', 'Lower limit is not below upper limit',
                        '"%s": lower=%g upper=%g.' % (jn, lo, hi), 'Swap or correct them.', jn)
                elif jt == 'revolute' and (abs(lo) > 4 * math.pi or abs(hi) > 4 * math.pi):
                    add('warning', 'limit_units', 'Revolute limit looks like degrees',
                        '"%s": %g .. %g. URDF angles are radians.' % (jn, lo, hi),
                        'Convert degrees to radians (x 0.01745).', jn)
                elif jt == 'revolute' and hi - lo > 2 * math.pi + 1e-6:
                    add('info', 'limit_range', 'Range exceeds one turn',
                        '"%s" spans %.1f rad.' % (jn, hi - lo), 'Use continuous if unlimited.', jn)
                for k in ('effort', 'velocity'):
                    v = lim.get(k)
                    try:
                        bad = v is None or not math.isfinite(float(v)) or float(v) <= 0
                    except ValueError:
                        bad = True
                    if bad:
                        add('warning', 'limit_' + k, 'Limit has no valid %s' % k,
                            '"%s": %s=%s.' % (jn, k, v),
                            'Set a positive %s (needed for safe speed caps).' % k, jn)
        elif jt == 'continuous' and lim is not None and lim.get('velocity') is None:
            add('info', 'limit_velocity', 'Continuous joint has no velocity limit', jn,
                'Add velocity so safety caps can be derived.', jn)
        mm = j.find('mimic')
        if mm is not None and mm.get('joint') not in [x.get('name') for x in joints]:
            add('error', 'mimic', 'Mimic refers to a missing joint',
                '"%s" mimics "%s".' % (jn, mm.get('joint')), 'Fix the joint name.', jn)
        jinfo[jn] = {'name': jn, 'type': jt, 'parent': p, 'child': c, 'axis': ax,
                     'lower': lo, 'upper': hi, 'xyz': xyz or [0, 0, 0], 'rpy': rpy or [0, 0, 0],
                     'velocity': (float(lim.get('velocity')) if lim is not None and
                                  lim.get('velocity') and NUM.match(lim.get('velocity')) else None),
                     'effort': (float(lim.get('effort')) if lim is not None and
                                lim.get('effort') and NUM.match(lim.get('effort')) else None),
                     'mimic': mm.get('joint') if mm is not None else None}
    if joints and ok_struct:
        add('ok', 'joints', '%d joint(s) consistent' % len(joints))

    roots = [n for n in links if n not in parent_of]
    if len(roots) == 1:
        summary['base_link'] = roots[0]
        add('ok', 'base_link', 'Base link: %s' % roots[0])
    elif not roots:
        add('error', 'cycle', 'Joints form a loop', 'Every link has a parent.',
            'Break the loop; URDF must be a tree.')
    else:
        add('error', 'base_link', 'More than one base link',
            'Unconnected root links: %s.' % ', '.join(roots[:8]),
            'Connect them with joints so only one link has no parent.')
    if roots and len(roots) == 1:
        seen, stack = set(), [roots[0]]
        while stack:
            n = stack.pop()
            if n in seen:
                continue
            seen.add(n)
            stack.extend(c for c, _ in children.get(n, []))
        if len(seen) != len(links):
            add('error', 'cycle', 'Part of the robot is disconnected or in a loop',
                'Unreachable from the base: %s.' % ', '.join(sorted(set(links) - seen)[:8]),
                'Check parent/child names.')
    summary['dof'] = sum(v for k, v in summary['joint_types'].items()
                         if k in ('revolute', 'continuous', 'prismatic'))
    summary['end_links'] = [n for n in links if n not in children]

    # links: inertial / visual / collision / meshes
    files = list(files)
    total_mass = 0.0
    no_inertial, no_visual, bad_inertia, missing_mesh, bad_ext = [], [], [], [], []
    mesh_bounds = {}
    for ln, el in links.items():
        ine = el.find('inertial')
        if ine is None:
            if ln != summary['base_link']:
                no_inertial.append(ln)
        else:
            me = ine.find('mass')
            try:
                m = float(me.get('value')) if me is not None else 0.0
            except (TypeError, ValueError):
                m = 0.0
            if m <= 0 or not math.isfinite(m):
                bad_inertia.append('%s (mass)' % ln)
            else:
                total_mass += m
                ie = ine.find('inertia')
                if ie is not None:
                    try:
                        ixx, iyy, izz = (float(ie.get(k, 0)) for k in ('ixx', 'iyy', 'izz'))
                        if min(ixx, iyy, izz) <= 0 or ixx + iyy < izz or ixx + izz < iyy or \
                                iyy + izz < ixx:
                            bad_inertia.append('%s (inertia)' % ln)
                    except ValueError:
                        bad_inertia.append('%s (inertia)' % ln)
        if el.find('visual') is None:
            no_visual.append(ln)
        for kind in ('visual', 'collision'):
            for g in el.findall(kind):
                me = g.find('geometry/mesh')
                if me is None:
                    continue
                fn = me.get('filename') or ''
                summary['meshes'] += 1
                if re.match(r'^[a-z]+://', fn) and not fn.startswith(('package://', 'file://')):
                    add('error', 'mesh_remote', 'Mesh uses a remote URL',
                        '"%s" in link %s.' % (fn, ln),
                        'Remote files are never fetched. Put the mesh in the upload and use '
                        'package:// or a relative path.', ln)
                    continue
                sc = me.get('scale')
                scale = [1.0, 1.0, 1.0]
                if sc:
                    sv = _floats(sc, 3, ln, add, 'mesh scale')
                    scale = sv or scale
                path = resolve_mesh(fn, files, urdf_dir)
                if not path:
                    missing_mesh.append('%s -> %s' % (ln, fn))
                    continue
                summary['meshes_found'] += 1
                summary['mesh_map'][fn] = path
                ext = path[path.rfind('.'):].lower() if '.' in path else ''
                if ext not in MESH_RENDERABLE:
                    bad_ext.append('%s (%s)' % (path, ext or 'no extension'))
                if ext == '.stl' and read_bytes and path not in mesh_bounds:
                    try:
                        b = stl_bounds(read_bytes(path), scale)
                    except OSError:
                        b = None
                    mesh_bounds[path] = b
                    if b:
                        size = max(b[1][a] - b[0][a] for a in range(3))
                        if size > 20:
                            add('warning', 'mesh_units', 'Mesh looks like millimetres',
                                '%s is %.0f units across. URDF expects metres.' % (path, size),
                                'Add scale="0.001 0.001 0.001" to the <mesh> or re-export in '
                                'metres.', ln)
                        elif 0 < size < 1e-3:
                            add('warning', 'mesh_units', 'Mesh is extremely small',
                                '%s is %.2g units across.' % (path, size),
                                'Check the export units (metres expected).', ln)
    summary['total_mass'] = round(total_mass, 4)
    if missing_mesh:
        add('error', 'mesh_missing', '%d mesh file(s) not found in the upload' % len(missing_mesh),
            '; '.join(missing_mesh[:6]) + (' ...' if len(missing_mesh) > 6 else ''),
            'Upload a ZIP that contains the meshes, keeping the folder names that the URDF '
            'refers to (e.g. meshes/link1.stl).')
    elif summary['meshes']:
        add('ok', 'meshes', 'All %d mesh reference(s) resolved' % summary['meshes'])
    if bad_ext:
        add('warning', 'mesh_format', 'Mesh format cannot be shown in the viewer',
            '; '.join(bad_ext[:5]), 'Convert to STL, DAE or OBJ (the robot is still usable).')
    if bad_inertia:
        add('warning', 'inertia', 'Mass / inertia values look invalid',
            ', '.join(bad_inertia[:6]), 'Fix for simulation; not needed for motion replay.')
    if no_inertial and len(no_inertial) == len(links) - (1 if summary['base_link'] else 0):
        add('info', 'inertial_none', 'No inertial data on any link',
            '', 'Only needed for physics simulation.')
    elif no_inertial:
        add('warning', 'inertial', 'Some links have no <inertial>', ', '.join(no_inertial[:8]),
            'Add mass and inertia if you plan to simulate.')
    if no_visual and len(no_visual) == len(links):
        add('warning', 'no_visual', 'No link has a <visual>',
            'The viewer will show only joint frames.', 'Add visual geometry.')

    # kinematic extent at the zero pose (origins only; mesh sizes are added in the viewer)
    if summary['base_link'] and ok_struct:
        pos = {summary['base_link']: (0.0, 0.0, 0.0)}
        R = {summary['base_link']: _I()}
        order = [summary['base_link']]
        for n in order:
            for c, jn in children.get(n, []):
                ji = jinfo.get(jn)
                if not ji:
                    continue
                Rj = _mm(R[n], _rpy(*ji['rpy']))
                x, y, z = ji['xyz']
                p0 = pos[n]
                pos[c] = (p0[0] + R[n][0][0] * x + R[n][0][1] * y + R[n][0][2] * z,
                          p0[1] + R[n][1][0] * x + R[n][1][1] * y + R[n][1][2] * z,
                          p0[2] + R[n][2][0] * x + R[n][2][1] * y + R[n][2][2] * z)
                R[c] = Rj
                order.append(c)
        xs = [p[0] for p in pos.values()]
        ys = [p[1] for p in pos.values()]
        zs = [p[2] for p in pos.values()]
        ext = [round(max(v) - min(v), 4) for v in (xs, ys, zs)]
        summary['extent_m'] = ext
        if max(ext) > 10:
            add('warning', 'units_length', 'Robot is larger than 10 m',
                'Joint origins span %.1f m. Values may be in millimetres.' % max(ext),
                'Scale lengths to metres.')
        elif 0 < max(ext) < 0.005:
            add('warning', 'units_length', 'Robot is smaller than 5 mm',
                'Joint origins span %.4f m.' % max(ext), 'Check the length units (metres).')
        else:
            add('ok', 'units_length', 'Dimensions plausible (%.2f m span, metres assumed)' %
                max(ext))

    def walk(n, depth, via):
        node = {'link': n, 'joint': via, 'depth': depth, 'children': []}
        ji = jinfo.get(via) if via else None
        if ji:
            node.update({'type': ji['type'], 'lower': ji['lower'], 'upper': ji['upper']})
        for c, jn in children.get(n, []):
            if depth < 80:
                node['children'].append(walk(c, depth + 1, jn))
        return node

    if summary['base_link']:
        tree = walk(summary['base_link'], 0, None)
    summary['joint_list'] = [jinfo[j.get('name')] for j in joints if j.get('name') in jinfo]
    return _finish(checks, summary, tree)


def _I():
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1]]


def _mm(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def _rpy(r, p, y):
    cr, sr, cp, sp, cy, sy = math.cos(r), math.sin(r), math.cos(p), math.sin(p), math.cos(y), \
        math.sin(y)
    return [[cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
            [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
            [-sp, cp * sr, cp * cr]]


def _finish(checks, summary, tree):
    counts = {k: sum(1 for c in checks if c['level'] == k)
              for k in ('error', 'warning', 'info', 'ok')}
    status = 'errors' if counts['error'] else ('warnings' if counts['warning'] else 'passed')
    return {'status': status, 'counts': counts, 'checks': checks, 'summary': summary,
            'tree': tree}
