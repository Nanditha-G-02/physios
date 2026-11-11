// Copyright 2026 ROBOTIS CO., LTD.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// URDF validation report: passed checks, warnings, errors and suggested fixes.

import React, { useState } from 'react';
import clsx from 'clsx';
import { Callout, KeyValue } from '../../components/ui';

const GROUPS = [
  { level: 'error', title: 'Errors', chip: 'chip-err', open: true },
  { level: 'warning', title: 'Warnings', chip: 'chip-warn', open: true },
  { level: 'info', title: 'Notes', chip: 'chip', open: false },
  { level: 'ok', title: 'Passed checks', chip: 'chip-ok', open: false },
];

function Group({ g, items }) {
  const [open, setOpen] = useState(g.open);
  if (!items.length) return null;
  return (
    <div className="rounded-2xl bg-paper" data-check-group={g.level}>
      <button type="button" className="w-full flex items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(!open)}>
        <span className={clsx(g.chip, 'text-[10.5px]')}>{items.length}</span>
        <span className="text-[13px] font-semibold">{g.title}</span>
        <span className="ml-auto text-ink-4 text-[12px]">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul className="px-3 pb-3 space-y-2">
          {items.map((c, i) => (
            <li key={`${c.id}-${i}`} className="text-[12.5px]" data-check={c.id}>
              <div className="font-medium">
                {c.title}
                {c.where ? <span className="font-mono text-ink-3 text-[11px]"> · {c.where}</span> : null}
              </div>
              {c.detail && <div className="text-ink-2 break-words">{c.detail}</div>}
              {c.suggestion && (
                <div className="text-ink-3">
                  <span className="label text-[9.5px] mr-1">Fix</span>
                  {c.suggestion}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ValidationReport({ report }) {
  if (!report) return null;
  const s = report.summary || {};
  const by = (lvl) => (report.checks || []).filter((c) => c.level === lvl);
  const tone = report.status === 'errors' ? 'err' : report.status === 'warnings' ? 'warn' : 'ok';
  const headline =
    report.status === 'errors'
      ? 'Validation failed — this robot cannot be registered until the errors are fixed.'
      : report.status === 'warnings'
      ? 'Validation passed with warnings — review them before registering.'
      : 'Validation passed.';
  return (
    <div className="space-y-3" data-validation-status={report.status}>
      <Callout tone={tone} title={headline}>
        {report.counts?.error || 0} error(s) · {report.counts?.warning || 0} warning(s) · {report.counts?.ok || 0} passed
        {report.at ? <span className="text-ink-3"> · checked {new Date(report.at).toLocaleString()}</span> : null}
      </Callout>
      {s.links ? (
        <KeyValue
          rows={[
            ['Robot name', s.name],
            ['Links / joints', `${s.links} / ${s.joints}`],
            ['Degrees of freedom', s.dof],
            ['Base link', s.base_link],
            ['End links', (s.end_links || []).join(', ')],
            ['Joint types', Object.entries(s.joint_types || {}).map(([k, v]) => `${v} ${k}`).join(', ')],
            ['Meshes', s.meshes ? `${s.meshes_found} of ${s.meshes} found` : 'none'],
            ['Total mass', s.total_mass ? `${s.total_mass} kg` : 'not set'],
            ['Kinematic span', s.extent_m ? `${s.extent_m.map((v) => (v * 1000).toFixed(0)).join(' × ')} mm (joint origins)` : null],
            ['Units', s.units],
          ]}
        />
      ) : null}
      {GROUPS.map((g) => (
        <Group key={g.level} g={g} items={by(g.level)} />
      ))}
    </div>
  );
}
