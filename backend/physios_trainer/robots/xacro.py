# Copyright 2026 ROBOTIS CO., LTD.
# Licensed under the Apache License, Version 2.0

"""A restricted, safe Xacro expander.

The real ``xacro`` tool evaluates ``${...}`` with Python ``eval`` and can import modules, so
running it on an uploaded file would run the uploader's code. This module never evaluates
Python: expressions go through an AST whitelist (numbers, strings, property names, arithmetic,
comparisons, ``and/or/not``, a conditional expression and a short list of ``math`` functions).

Supported: ``xacro:property`` (value or block), ``xacro:arg`` (defaults only), ``xacro:macro``
with value / default (``p:=1``) / block (``*b``) parameters, macro calls, ``xacro:insert_block``,
``xacro:include`` (only files inside the uploaded archive), ``xacro:if`` / ``xacro:unless``,
``$(arg x)`` and ``$(find pkg)`` (mapped to ``package://pkg``, resolved later against the archive).

Not supported - reported as an error that says what to do: ``$(env ..)``, ``$(optenv ..)``,
``$(eval ..)``, ``$(cwd)``, ``xacro:element`` / ``xacro:attribute``, ``**`` parameters, Python
objects, attribute access other than ``math.<fn>``, ``xacro:call``. For such files the operator
should expand them once (``xacro robot.urdf.xacro > robot.urdf``) and upload the result.
"""

import ast
import math
import re
import xml.etree.ElementTree as ET

XACRO_NS = ('http://www.ros.org/wiki/xacro', 'http://wiki.ros.org/xacro',
            'http://ros.org/wiki/xacro')
MAX_NODES = 400_000
MAX_DEPTH = 60
MAX_INCLUDE_DEPTH = 12
MAX_STR = 1_000_000

FUNCS = {
    'sin': math.sin, 'cos': math.cos, 'tan': math.tan, 'asin': math.asin, 'acos': math.acos,
    'atan': math.atan, 'atan2': math.atan2, 'sqrt': math.sqrt, 'abs': abs, 'min': min,
    'max': max, 'round': round, 'floor': math.floor, 'ceil': math.ceil,
    'radians': math.radians, 'degrees': math.degrees, 'pow': pow, 'int': int, 'float': float,
    'str': str, 'len': len, 'exp': math.exp, 'log': math.log, 'hypot': math.hypot,
}
CONSTS = {'pi': math.pi, 'True': True, 'False': False, 'inf': math.inf, 'e': math.e}
_BIN = {
    ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b, ast.Mult: lambda a, b: a * b,
    ast.Div: lambda a, b: a / b, ast.FloorDiv: lambda a, b: a // b, ast.Mod: lambda a, b: a % b,
    ast.Pow: lambda a, b: a ** b,
}
_CMP = {
    ast.Eq: lambda a, b: a == b, ast.NotEq: lambda a, b: a != b, ast.Lt: lambda a, b: a < b,
    ast.LtE: lambda a, b: a <= b, ast.Gt: lambda a, b: a > b, ast.GtE: lambda a, b: a >= b,
}
SUBST = re.compile(r'\$\{([^}]*)\}|\$\(([^)]*)\)')
MAX_POW = 64


class XacroError(Exception):
    """A Xacro construct that is unsupported or invalid; the message tells the operator why."""


def local(tag):
    return tag.split('}', 1)[1] if tag.startswith('{') else tag


def is_xacro(tag):
    return tag.startswith('{') and tag[1:tag.index('}')] in XACRO_NS


def coerce(v):
    """Xacro treats numeric-looking strings as numbers inside expressions."""
    if isinstance(v, str):
        t = v.strip()
        if re.fullmatch(r'[+-]?\d+', t):
            return int(t)
        if re.fullmatch(r'[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?', t):
            return float(t)
        if t in ('true', 'True'):
            return True
        if t in ('false', 'False'):
            return False
    return v


def fmt_value(v):
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, float):
        if v.is_integer() and abs(v) < 1e15:
            return str(int(v))
        return '%.12g' % v
    return str(v)


class Lazy:
    __slots__ = ('text', 'scope', 'done', 'value')

    def __init__(self, text, scope):
        self.text, self.scope, self.done, self.value = text, scope, False, None


class Scope(dict):
    """Property scope with a parent chain (macro bodies see their own params, then globals)."""

    def __init__(self, parent=None):
        super().__init__()
        self.parent = parent

    def lookup(self, name):
        s = self
        while s is not None:
            if name in s:
                return s[name]
            s = s.parent
        raise KeyError(name)

    def has(self, name):
        try:
            self.lookup(name)
            return True
        except KeyError:
            return False


class Block:
    __slots__ = ('elem', 'scope')

    def __init__(self, elem, scope):
        self.elem, self.scope = elem, scope


class Expander:
    """``read(path) -> str`` returns a file inside the archive; ``find(pkg_rel) -> path|None``
    resolves an include given as ``$(find pkg)/rel`` or a relative name."""

    def __init__(self, read, find_include, notes=None):
        self.read = read
        self.find_include = find_include
        self.notes = notes if notes is not None else []
        self.macros = {}
        self.args = {}
        self.nodes = 0
        self.root_scope = Scope()

    # ---- expressions ---------------------------------------------------------------
    def value_of(self, name, scope):
        if name in CONSTS and not scope.has(name):
            return CONSTS[name]
        try:
            v = scope.lookup(name)
        except KeyError:
            raise XacroError('Unknown property "%s". Define it with xacro:property, or upload '
                             'the expanded URDF.' % name)
        if isinstance(v, Lazy):
            if not v.done:
                if v.value == 'busy':
                    raise XacroError('Property "%s" refers to itself.' % name)
                v.value = 'busy'
                v.value = self.eval_text(v.text, v.scope, keep_type=True)
                v.done = True
            return v.value
        if isinstance(v, Block):
            raise XacroError('"%s" is a block property; use xacro:insert_block.' % name)
        return v

    def eval_expr(self, src, scope):
        try:
            tree = ast.parse(src.strip(), mode='eval')
        except SyntaxError:
            raise XacroError('Cannot read the expression "${%s}".' % src)
        return self._ev(tree.body, scope, src)

    def _ev(self, n, scope, src):
        t = type(n)
        if t is ast.Constant:
            if isinstance(n.value, (int, float, str, bool)) or n.value is None:
                return n.value
        elif t is ast.Name:
            return self.value_of(n.id, scope)
        elif t is ast.UnaryOp:
            v = self._ev(n.operand, scope, src)
            if isinstance(n.op, ast.USub):
                return -v
            if isinstance(n.op, ast.UAdd):
                return +v
            if isinstance(n.op, ast.Not):
                return not v
        elif t is ast.BinOp and type(n.op) in _BIN:
            a, b = self._ev(n.left, scope, src), self._ev(n.right, scope, src)
            if isinstance(n.op, ast.Pow) and abs(b) > MAX_POW:
                raise XacroError('Exponent too large in "${%s}".' % src)
            if isinstance(n.op, ast.Mult) and isinstance(a, str) and isinstance(b, int) and \
                    len(a) * max(b, 0) > MAX_STR:
                raise XacroError('String too long in "${%s}".' % src)
            try:
                return _BIN[type(n.op)](a, b)
            except (TypeError, ZeroDivisionError, ValueError, OverflowError) as e:
                raise XacroError('Cannot evaluate "${%s}": %s.' % (src, e))
        elif t is ast.BoolOp:
            vals = [self._ev(v, scope, src) for v in n.values]
            return all(vals) if isinstance(n.op, ast.And) else any(vals)
        elif t is ast.Compare:
            left = self._ev(n.left, scope, src)
            for op, right_n in zip(n.ops, n.comparators):
                right = self._ev(right_n, scope, src)
                if type(op) not in _CMP or not _CMP[type(op)](left, right):
                    if type(op) in _CMP:
                        return False
                    break
                left = right
            else:
                return True
        elif t is ast.IfExp:
            return self._ev(n.body if self._ev(n.test, scope, src) else n.orelse, scope, src)
        elif t is ast.Call and not n.keywords:
            f = n.func
            name = f.id if isinstance(f, ast.Name) else (
                f.attr if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and
                f.value.id == 'math' else None)
            if name in FUNCS:
                args = [self._ev(a, scope, src) for a in n.args]
                try:
                    return FUNCS[name](*args)
                except (TypeError, ValueError, OverflowError, ZeroDivisionError) as e:
                    raise XacroError('Cannot evaluate "${%s}": %s.' % (src, e))
        elif t is ast.Attribute and isinstance(n.value, ast.Name) and n.value.id == 'math' and \
                n.attr in CONSTS:
            return CONSTS[n.attr]
        raise XacroError('"${%s}" uses a Python feature that is not supported (only arithmetic, '
                         'comparisons and math functions are). Expand the Xacro yourself with '
                         '"xacro file.urdf.xacro > robot.urdf" and upload the result.' % src)

    def eval_subst(self, m, scope):
        if m.group(1) is not None:
            return self.eval_expr(m.group(1), scope)
        cmd = m.group(2).strip()
        word, _, rest = cmd.partition(' ')
        rest = rest.strip()
        if word == 'arg':
            if rest not in self.args:
                raise XacroError('$(arg %s) has no default; declare it with '
                                 '<xacro:arg name="%s" default="..."/>.' % (rest, rest))
            return self.args[rest]
        if word == 'find':
            self.notes.append('$(find %s) is read as package://%s and looked up inside the '
                              'uploaded archive.' % (rest, rest))
            return 'package://%s' % rest
        raise XacroError('$(%s) is not supported (it reads the machine it runs on, which an '
                         'upload must not do). Expand the Xacro yourself and upload the URDF.' %
                         word)

    def eval_text(self, text, scope, keep_type=False):
        if text is None:
            return text
        if '$' not in text:
            return coerce(text) if keep_type else text
        ms = list(SUBST.finditer(text))
        if keep_type and len(ms) == 1 and ms[0].span() == (0, len(text.strip())) and \
                text.strip() == text:
            return coerce(self.eval_subst(ms[0], scope))
        out, last = [], 0
        for m in ms:
            out.append(text[last:m.start()])
            out.append(fmt_value(self.eval_subst(m, scope)))
            last = m.end()
        out.append(text[last:])
        s = ''.join(out)
        if len(s) > MAX_STR:
            raise XacroError('A value became too long while expanding.')
        return coerce(s) if keep_type else s

    # ---- document ------------------------------------------------------------------------
    def parse(self, path, text):
        low = text[:4096].lower()
        if '<!doctype' in low or '<!entity' in text.lower():
            raise XacroError('%s contains a DOCTYPE/ENTITY declaration, which is not accepted.'
                             % path)
        try:
            return ET.fromstring(text)
        except ET.ParseError as e:
            raise XacroError('%s is not well-formed XML: %s.' % (path, e))

    def expand(self, entry):
        root = self.parse(entry, self.read(entry))
        if local(root.tag) != 'robot':
            raise XacroError('%s has no <robot> root element.' % entry)
        out = ET.Element('robot', {k: self.eval_text(v, self.root_scope) for k, v in
                                   root.attrib.items() if not k.startswith('{') and
                                   not k.startswith('xmlns')})
        self._children(out, root, self.root_scope, entry, 0, 0)
        return out

    def _tick(self):
        self.nodes += 1
        if self.nodes > MAX_NODES:
            raise XacroError('The Xacro expands to too many elements (limit %d). Check macro '
                             'recursion.' % MAX_NODES)

    def _children(self, out, elem, scope, path, depth, inc_depth):
        if depth > MAX_DEPTH:
            raise XacroError('Macros are nested too deeply (limit %d).' % MAX_DEPTH)
        if elem.text and elem.text.strip() and len(out) == 0 and not out.text:
            out.text = self.eval_text(elem.text, scope)
        last = None
        for ch in list(elem):
            self._tick()
            if is_xacro(ch.tag):
                added = self._xacro(out, ch, scope, path, depth, inc_depth)
                if added is not None:
                    last = added
            else:
                el = ET.SubElement(out, local(ch.tag))
                for k, v in ch.attrib.items():
                    if k.startswith('{') or k.startswith('xmlns'):
                        continue
                    el.set(k, self.eval_text(v, scope))
                if ch.text and ch.text.strip():
                    el.text = self.eval_text(ch.text, scope)
                self._children(el, ch, scope, path, depth + 1, inc_depth)
                last = el
            if ch.tail and ch.tail.strip() and last is not None:
                last.tail = self.eval_text(ch.tail, scope)

    def _xacro(self, out, ch, scope, path, depth, inc_depth):
        name = local(ch.tag)
        a = ch.attrib
        if name == 'property':
            pname = self._attr(a, 'name', scope, 'xacro:property')
            if 'value' in a:
                scope[pname] = Lazy(a['value'], scope)
            else:
                scope[pname] = Block(ch, scope)
            return None
        if name == 'arg':
            aname = self._attr(a, 'name', scope, 'xacro:arg')
            if aname not in self.args:
                self.args[aname] = self.eval_text(a.get('default', ''), scope)
            return None
        if name == 'macro':
            mname = self._attr(a, 'name', scope, 'xacro:macro')
            self.macros[mname] = (ch, parse_params(a.get('params', '')))
            return None
        if name == 'include':
            return self._include(out, ch, scope, path, depth, inc_depth)
        if name in ('if', 'unless'):
            v = self.eval_text(a.get('value', ''), scope, keep_type=True)
            if isinstance(v, str):
                v = {'true': True, 'false': False, '1': True, '0': False}.get(
                    v.strip().lower(), None)
                if v is None:
                    raise XacroError('xacro:%s needs a true/false value.' % name)
            if bool(v) == (name == 'if'):
                self._children(out, ch, scope, path, depth + 1, inc_depth)
            return None
        if name == 'insert_block':
            bname = self._attr(a, 'name', scope, 'xacro:insert_block')
            try:
                blk = scope.lookup(bname)
            except KeyError:
                raise XacroError('xacro:insert_block "%s": no such block.' % bname)
            if not isinstance(blk, Block):
                raise XacroError('"%s" is not a block.' % bname)
            self._children(out, blk.elem, blk.scope, path, depth + 1, inc_depth)
            return None
        if name in ('element', 'attribute', 'call', 'macro_call'):
            raise XacroError('xacro:%s is not supported. Expand the Xacro yourself and upload '
                             'the URDF.' % name)
        if name in self.macros:
            return self._call(out, ch, name, scope, path, depth, inc_depth)
        raise XacroError('Unknown Xacro element <xacro:%s> (is the macro defined before use?).'
                         % name)

    def _attr(self, a, key, scope, what):
        if key not in a:
            raise XacroError('%s needs a "%s" attribute.' % (what, key))
        return self.eval_text(a[key], scope)

    def _include(self, out, ch, scope, path, depth, inc_depth):
        if inc_depth >= MAX_INCLUDE_DEPTH:
            raise XacroError('Includes are nested too deeply (cycle?).')
        fname = self._attr(ch.attrib, 'filename', scope, 'xacro:include')
        target = self.find_include(fname, path)
        if not target:
            raise XacroError('xacro:include "%s" is not in the uploaded archive. Add the file '
                             '(with its folder) to the ZIP.' % fname)
        root = self.parse(target, self.read(target))
        if local(root.tag) != 'robot':
            raise XacroError('Included file %s has no <robot> root.' % target)
        self._children(out, root, scope, target, depth + 1, inc_depth + 1)
        return None

    def _call(self, out, ch, name, scope, path, depth, inc_depth):
        mdef, params = self.macros[name]
        local_scope = Scope(self.root_scope)
        blocks = [Block(c, scope) for c in ch]
        bi = 0
        given = {k: v for k, v in ch.attrib.items() if not k.startswith('{')}
        for p in params:
            if p['kind'] == 'block':
                if bi >= len(blocks):
                    raise XacroError('Macro %s needs a block for "*%s".' % (name, p['name']))
                local_scope[p['name']] = blocks[bi]
                bi += 1
            elif p['kind'] == 'double':
                raise XacroError('Macro %s uses a "**%s" parameter, which is not supported.' %
                                 (name, p['name']))
            else:
                if p['name'] in given:
                    local_scope[p['name']] = self.eval_text(given.pop(p['name']), scope,
                                                            keep_type=True)
                elif p['default'] is not None:
                    d = p['default']
                    if d.startswith('^'):
                        pname, _, dflt = d[1:].partition('|')
                        local_scope[p['name']] = self.value_of(pname, scope) if scope.has(
                            pname) else (self.eval_text(dflt, scope, keep_type=True)
                                         if dflt else '')
                    else:
                        local_scope[p['name']] = Lazy(d, local_scope)
                else:
                    raise XacroError('Macro %s is called without its "%s" parameter.' %
                                     (name, p['name']))
        if given:
            raise XacroError('Macro %s has no parameter(s) %s.' % (name, ', '.join(sorted(given))))
        self._children(out, mdef, local_scope, path, depth + 1, inc_depth)
        return None


def parse_params(s):
    out = []
    for tok in s.split():
        if tok.startswith('**'):
            out.append({'name': tok[2:], 'kind': 'double', 'default': None})
        elif tok.startswith('*'):
            out.append({'name': tok[1:], 'kind': 'block', 'default': None})
        elif ':=' in tok:
            n, d = tok.split(':=', 1)
            out.append({'name': n, 'kind': 'value', 'default': d})
        else:
            out.append({'name': tok, 'kind': 'value', 'default': None})
    return out


def expand_to_urdf(read, find_include, entry):
    """Return (urdf_text, notes). Raises XacroError."""
    ex = Expander(read, find_include)
    root = ex.expand(entry)
    return ET.tostring(root, encoding='unicode'), sorted(set(ex.notes))
