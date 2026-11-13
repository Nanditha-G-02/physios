# Copyright 2026 ROBOTIS CO., LTD.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Small 2-D helpers for the top-down table frame (millimetres)."""

import math


def dist(ax, ay, bx, by):
    return math.hypot(ax - bx, ay - by)


def in_rect(x, y, rect, pad=0.0):
    return (rect['x_min_mm'] + pad <= x <= rect['x_max_mm'] - pad
            and rect['y_min_mm'] + pad <= y <= rect['y_max_mm'] - pad)


def point_problems(x, y, ws, radius=0.0):
    """Return a list of problem codes for an item footprint centred at (x, y)."""
    problems = []
    r = math.hypot(x, y)
    margin = ws.get('margin_mm', 0)
    if not in_rect(x, y, ws, pad=radius):
        problems.append('outside_workspace')
    if r > ws['reach_max_mm']:
        problems.append('out_of_reach')
    if r < max(ws['reach_min_mm'], ws.get('base_keepout_mm', 0) + radius + margin):
        problems.append('too_close_to_base')
    for k in ws.get('keepouts', []) or []:
        if in_rect(x, y, {
            'x_min_mm': k['x_min_mm'] - radius, 'x_max_mm': k['x_max_mm'] + radius,
            'y_min_mm': k['y_min_mm'] - radius, 'y_max_mm': k['y_max_mm'] + radius,
        }):
            problems.append('in_keepout')
            break
    return problems


def nearest_valid_point(x, y, ws, radius=0.0, avoid=None, step=4.0):
    """Closest point to (x, y) without workspace problems.

    ``avoid`` is a list of (x, y, min_distance) tuples that the point must
    stay away from.  Searches outward on rings; returns None if nothing fits.
    """
    avoid = avoid or []

    def ok(px, py):
        if point_problems(px, py, ws, radius):
            return False
        return all(dist(px, py, ax, ay) >= d for ax, ay, d in avoid)

    if ok(x, y):
        return (round(x, 1), round(y, 1))
    max_r = math.hypot(ws['x_max_mm'] - ws['x_min_mm'], ws['y_max_mm'] - ws['y_min_mm'])
    ring = step
    while ring <= max_r:
        n = max(12, int(2 * math.pi * ring / step))
        best = None
        for i in range(n):
            a = 2 * math.pi * i / n
            px, py = x + ring * math.cos(a), y + ring * math.sin(a)
            if ok(px, py):
                d = dist(px, py, x, y)
                if best is None or d < best[0]:
                    best = (d, px, py)
        if best:
            return (round(best[1], 1), round(best[2], 1))
        ring += step
    return None


def region_center(region):
    return ((region['x_min_mm'] + region['x_max_mm']) / 2.0,
            (region['y_min_mm'] + region['y_max_mm']) / 2.0)


def region_of(x, y, regions):
    for reg in regions or []:
        if in_rect(x, y, reg):
            return reg['id']
    return None
