# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0
"""Test-only generated robot files: a 3-DOF arm URDF/Xacro, STL meshes and ZIPs."""

import io
import struct
import zipfile


def stl_box(sx=0.05, sy=0.05, sz=0.1):
    """Binary STL of a box (12 triangles)."""
    x, y, z = sx / 2, sy / 2, sz / 2
    v = [(-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z),
         (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)]
    f = [(0, 1, 2), (0, 2, 3), (4, 6, 5), (4, 7, 6), (0, 4, 5), (0, 5, 1), (1, 5, 6), (1, 6, 2),
         (2, 6, 7), (2, 7, 3), (3, 7, 4), (3, 4, 0)]
    out = b'\0' * 80 + struct.pack('<I', len(f))
    for a, b, c in f:
        out += struct.pack('<3f', 0, 0, 0)
        for i in (a, b, c):
            out += struct.pack('<3f', *v[i])
        out += b'\0\0'
    return out


def link(name, mesh=True, mass=0.5):
    vis = ('<visual><geometry><mesh filename="package://demo_arm/meshes/%s.stl"/></geometry>'
           '</visual><collision><geometry><box size="0.05 0.05 0.1"/></geometry></collision>' %
           name) if mesh else ''
    return ('<link name="%s"><inertial><mass value="%s"/><inertia ixx="0.001" iyy="0.001" '
            'izz="0.001" ixy="0" ixz="0" iyz="0"/></inertial>%s</link>' % (name, mass, vis))


def joint(name, parent, child, z=0.1, lo=-1.57, hi=1.57, typ='revolute', axis='0 0 1'):
    lim = '<limit lower="%s" upper="%s" effort="5" velocity="2"/>' % (lo, hi) \
        if typ in ('revolute', 'prismatic') else ''
    return ('<joint name="%s" type="%s"><parent link="%s"/><child link="%s"/>'
            '<origin xyz="0 0 %s" rpy="0 0 0"/><axis xyz="%s"/>%s</joint>' % (
                name, typ, parent, child, z, axis, lim))


def arm_urdf(name='demo_arm'):
    return ('<?xml version="1.0"?><robot name="%s">%s%s%s%s%s%s%s</robot>' % (
        name, link('base'), link('l1'), link('l2'), link('l3'),
        joint('j1', 'base', 'l1'), joint('j2', 'l1', 'l2', axis='0 1 0'),
        joint('j3', 'l2', 'l3', typ='continuous')))


ARM_XACRO = """<?xml version="1.0"?>
<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="xarm">
  <xacro:include filename="$(find demo_arm)/urdf/common.xacro"/>
  <xacro:property name="len" value="0.2"/>
  <xacro:property name="half" value="${len/2}"/>
  <link name="base"/>
  <xacro:seg name="l1" parent="base" z="${half}" ax="0 0 1"/>
  <xacro:seg name="l2" parent="l1" z="${len*2}" ax="0 1 0"/>
</robot>
"""
COMMON_XACRO = """<?xml version="1.0"?>
<robot xmlns:xacro="http://www.ros.org/wiki/xacro">
  <xacro:macro name="seg" params="name parent z ax lo:=-1.0">
    <link name="${name}"><visual><geometry><box size="0.05 0.05 0.1"/></geometry></visual></link>
    <joint name="j_${name}" type="revolute">
      <parent link="${parent}"/><child link="${name}"/><origin xyz="0 0 ${z}" rpy="0 0 0"/>
      <axis xyz="${ax}"/><limit lower="${lo}" upper="${-lo}" effort="5" velocity="2"/>
    </joint>
  </xacro:macro>
</robot>
"""


def make_zip(entries):
    bio = io.BytesIO()
    with zipfile.ZipFile(bio, 'w', zipfile.ZIP_DEFLATED) as z:
        for k, v in entries.items():
            z.writestr(k, v)
    return bio.getvalue()


def arm_zip():
    box = stl_box()
    return make_zip({'demo_arm/urdf/demo_arm.urdf': arm_urdf(),
                     'demo_arm/meshes/base.stl': box, 'demo_arm/meshes/l1.stl': box,
                     'demo_arm/meshes/l2.stl': box, 'demo_arm/meshes/l3.stl': box})
