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

// Editors used by the Planning session. All of them are controlled components:
// they receive a value and call onChange with a new value - persistence is done
// by PlanningPage through /planning/command.

import React from 'react';
import clsx from 'clsx';
import { Field, NumberInput, Segmented, Select, TextInput, Toggle } from '../../components/ui';

export const STRATEGIES = [
  {
    type: 'static',
    title: 'Static',
    blurb: 'Same fixed positions every episode.',
    detail: 'Fixed object and target locations and an optional predefined action sequence.',
  },
  {
    type: 'semi_dynamic',
    title: 'Semi-dynamic',
    blurb: 'Choose what stays fixed and what varies.',
    detail: 'E.g. the source stays put while the target moves between regions.',
  },
  {
    type: 'dynamic',
    title: 'Dynamic',
    blurb: 'Balanced coverage of regions, angles, distances.',
    detail: 'Every combination of regions / orientations / distance bands, spread evenly.',
  },
  {
    type: 'randomized',
    title: 'Randomized',
    blurb: 'Random within bounds and constraints.',
    detail: 'Seeded random positions and orientations inside per-item boundaries.',
  },
  {
    type: 'sequential',
    title: 'Sequential',
    blurb: 'Ordered multi-step action sequence.',
    detail: 'Build Pick → Move → Place → Return-home style sequences.',
  },
  {
    type: 'scenario',
    title: 'Scenario-based',
    blurb: 'Success, failure and recovery demos.',
    detail: 'Mix normal demonstrations with displacements, failed grasps and retries.',
  },
];

const ACTION_LABELS = {
  pick: 'Pick',
  place: 'Place',
  move_to: 'Move to',
  push: 'Push',
  open_gripper: 'Open gripper',
  close_gripper: 'Close gripper',
  rotate: 'Rotate',
  wait: 'Wait',
  return_home: 'Return home',
  custom: 'Custom',
};

const PERTURBATION_LABELS = {
  none: 'None (normal)',
  off_target_approach: 'Off-target approach, then correct',
  object_displacement: 'Object displaced',
  wrong_orientation: 'Wrong orientation',
  failed_grasp: 'Failed grasp, retry',
  drop_and_regrasp: 'Drop and re-grasp',
  custom: 'Custom (describe in notes)',
};

const COLORS = ['#D9534F', '#E0A030', '#3E8E5E', '#2F6DB5', '#7B4FB0', '#8A6D3B', '#121414'];

function StrategyGlyph({ type }) {
  const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 };
  const sq = (x, y, o = 1, k) => <rect key={k} x={x} y={y} width="8" height="8" fill="currentColor" opacity={o} />;
  return (
    <svg viewBox="0 0 64 40" className="h-10 w-16" aria-hidden>
      <rect {...s} x="1" y="1" width="62" height="38" />
      {type === 'static' && (
        <>
          {sq(12, 16)}
          <rect {...s} x="40" y="12" width="14" height="14" />
        </>
      )}
      {type === 'semi_dynamic' && (
        <>
          {sq(10, 16)}
          {[0, 1, 2].map((i) => (
            <rect key={i} {...s} x={30 + i * 11} y={8 + i * 8} width="9" height="9" opacity={i === 1 ? 1 : 0.45} />
          ))}
        </>
      )}
      {type === 'dynamic' && (
        <>
          <path {...s} d="M22 1v38M43 1v38" strokeDasharray="2 2" />
          {sq(7, 8, 1, 'a')}
          {sq(28, 24, 0.6, 'b')}
          {sq(49, 12, 0.35, 'c')}
        </>
      )}
      {type === 'randomized' && (
        <>
          {[
            [8, 9],
            [20, 26],
            [33, 7],
            [46, 22],
            [52, 8],
            [27, 17],
          ].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="2.4" fill="currentColor" opacity={0.3 + (i % 3) * 0.25} />
          ))}
          <rect {...s} x="5" y="5" width="54" height="30" strokeDasharray="4 2" />
        </>
      )}
      {type === 'sequential' && (
        <>
          {[0, 1, 2, 3].map((i) => (
            <g key={i}>
              <circle cx={10 + i * 15} cy="20" r="4" {...s} fill={i === 0 ? 'currentColor' : 'none'} />
              {i < 3 && <path {...s} d={`M${15 + i * 15} 20h6`} />}
            </g>
          ))}
        </>
      )}
      {type === 'scenario' && (
        <>
          <rect x="6" y="26" width="10" height="9" fill="currentColor" />
          <rect x="20" y="16" width="10" height="19" fill="currentColor" opacity="0.6" />
          <rect x="34" y="21" width="10" height="14" fill="currentColor" opacity="0.35" />
          <path {...s} d="M48 12l8 8M56 12l-8 8" />
        </>
      )}
    </svg>
  );
}

export function StrategyPicker({ value, onChange, disabled }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {STRATEGIES.map((s, i) => {
        const on = s.type === value;
        return (
          <button
            key={s.type}
            type="button"
            disabled={disabled}
            onClick={() => onChange(s.type)}
            className={clsx(
              'text-left border p-3 transition-colors flex gap-3 items-start disabled:opacity-60',
              on ? 'border-ink bg-ink text-paper' : 'border-rule bg-white hover:border-ink'
            )}
            aria-pressed={on}
            data-strategy={s.type}
          >
            <span className={on ? 'text-sky' : 'text-ink'}>
              <StrategyGlyph type={s.type} />
            </span>
            <span className="min-w-0">
              <span className={clsx('label block', on && 'text-sky')}>{String(i + 1).padStart(2, '0')}</span>
              <span className="block font-semibold text-[14px]">{s.title}</span>
              <span className={clsx('block text-[12px] mt-0.5', on ? 'text-paper/80' : 'text-ink-3')}>
                {s.blurb}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ items --
export function ItemsEditor({ items, onChange, disabled }) {
  const update = (k, patch) => onChange(items.map((it, i) => (i === k ? { ...it, ...patch } : it)));
  const add = (role) => {
    const n = items.filter((i) => i.role === role).length + 1;
    const used = new Set(items.map((i) => i.id));
    let id = `${role === 'object' ? 'obj' : 'tgt'}${n}`;
    let k = n;
    while (used.has(id)) {
      k += 1;
      id = `${role === 'object' ? 'obj' : 'tgt'}${k}`;
    }
    onChange([
      ...items,
      {
        id,
        name: role === 'object' ? `Object ${k}` : `Target ${k}`,
        role,
        size_mm: role === 'object' ? 30 : 80,
        color: COLORS[items.length % COLORS.length],
      },
    ]);
  };
  return (
    <div className="space-y-2">
      <div className="hidden md:grid grid-cols-[22px_1fr_110px_90px_120px_28px] gap-2 px-1">
        <span />
        <span className="label">Name</span>
        <span className="label">Role</span>
        <span className="label">Footprint</span>
        <span className="label">Colour (view)</span>
        <span />
      </div>
      {items.map((it, k) => (
        <div
          key={it.id}
          className="grid grid-cols-[22px_1fr] md:grid-cols-[22px_1fr_110px_90px_120px_28px] gap-2 items-center"
        >
          <span
            className={clsx('h-4 w-4 border border-ink', it.role === 'target' && 'bg-white')}
            style={it.role === 'object' ? { background: it.color } : { boxShadow: `inset 0 0 0 3px ${it.color}` }}
          />
          <TextInput value={it.name} onChange={(v) => update(k, { name: v })} disabled={disabled} aria-label="Item name" />
          <Select
            value={it.role}
            onChange={(v) => update(k, { role: v })}
            options={[
              { value: 'object', label: 'Object (moved)' },
              { value: 'target', label: 'Target (place/act on)' },
            ]}
            disabled={disabled}
          />
          <NumberInput value={it.size_mm} min={5} max={400} suffix="mm" onChange={(v) => update(k, { size_mm: v })} disabled={disabled} />
          <div className="flex gap-1">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                disabled={disabled}
                aria-label={`colour ${c}`}
                onClick={() => update(k, { color: c, track_color: c })}
                className={clsx('h-5 w-[14px] border', it.color === c ? 'border-ink ring-1 ring-ink' : 'border-rule')}
                style={{ background: c }}
              />
            ))}
          </div>
          <button
            type="button"
            className="btn-ghost btn-sm px-1.5"
            disabled={disabled || items.length <= 1}
            onClick={() => onChange(items.filter((_, i) => i !== k))}
            aria-label={`Remove ${it.name}`}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="flex gap-2 pt-1">
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => add('object')}>
          + Object
        </button>
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => add('target')}>
          + Target
        </button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- workspace --
export function WorkspaceEditor({ workspace, regions, onChange, onRegionsChange, disabled }) {
  const set = (k, v) => onChange({ ...workspace, [k]: v });
  const setReg = (i, patch) => onRegionsChange(regions.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const num = (k, label, extra = {}) => (
    <Field label={label}>
      <NumberInput value={workspace[k]} suffix="mm" onChange={(v) => set(k, v)} disabled={disabled} {...extra} />
    </Field>
  );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {num('x_min_mm', 'Table x min')}
        {num('x_max_mm', 'Table x max')}
        {num('y_min_mm', 'Table y min (right)')}
        {num('y_max_mm', 'Table y max (left)')}
        {num('reach_min_mm', 'Reach min')}
        {num('reach_max_mm', 'Reach max')}
        {num('base_keepout_mm', 'Base keep-out')}
        {num('margin_mm', 'Clearance margin')}
      </div>
      <div className="flex items-center justify-between gap-3 border border-rule bg-paper px-3 py-2">
        <div className="text-[12.5px]">
          {workspace.verified ? (
            <span className="text-signal-ok">Workspace limits checked on the real table.</span>
          ) : (
            <span className="text-signal-warn">
              Limits are robot defaults — measure your table, then mark as verified.
            </span>
          )}
        </div>
        <Toggle checked={!!workspace.verified} onChange={(v) => set('verified', v)} label="Verified" disabled={disabled} />
      </div>
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="label">Regions</span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => {
              const used = new Set(regions.map((r) => r.id));
              let n = regions.length + 1;
              while (used.has(`R${n}`)) n += 1;
              onRegionsChange([
                ...regions,
                {
                  id: `R${n}`,
                  name: `Region ${n}`,
                  x_min_mm: workspace.reach_min_mm + 20,
                  x_max_mm: workspace.reach_min_mm + 120,
                  y_min_mm: -60,
                  y_max_mm: 60,
                },
              ]);
            }}
          >
            + Region
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left">
                {['Id', 'Name', 'x min', 'x max', 'y min', 'y max', ''].map((h) => (
                  <th key={h} className="label font-normal py-1 pr-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {regions.map((r, i) => (
                <tr key={i} className="border-t border-rule">
                  <td className="py-1 pr-2 w-16">
                    <TextInput value={r.id} onChange={(v) => setReg(i, { id: v.replace(/\s/g, '') })} disabled={disabled} />
                  </td>
                  <td className="py-1 pr-2">
                    <TextInput value={r.name} onChange={(v) => setReg(i, { name: v })} disabled={disabled} />
                  </td>
                  {['x_min_mm', 'x_max_mm', 'y_min_mm', 'y_max_mm'].map((k) => (
                    <td key={k} className="py-1 pr-2 w-24">
                      <NumberInput value={r[k]} onChange={(v) => setReg(i, { [k]: v })} disabled={disabled} />
                    </td>
                  ))}
                  <td className="py-1 w-8">
                    <button
                      type="button"
                      className="btn-ghost btn-sm px-1.5"
                      onClick={() => onRegionsChange(regions.filter((_, k) => k !== i))}
                      disabled={disabled}
                      aria-label={`Remove region ${r.id}`}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------- item placement ----
const MODE_LABELS = {
  fixed: 'Fixed',
  regions: 'By region',
  points: 'Point list',
  random: 'Random in bounds',
};

export function ItemPlacementEditor({ item, spec, regions, workspace, modes, onChange, disabled, yawModes }) {
  const set = (patch) => onChange({ ...spec, ...patch });
  const fixed = spec.fixed || { x_mm: 200, y_mm: 0, yaw_deg: 0 };
  const yaw = spec.yaw || { mode: 'fixed', value: 0 };
  const bounds =
    spec.bounds || {
      x_min_mm: Math.max(workspace.x_min_mm, workspace.reach_min_mm),
      x_max_mm: Math.min(workspace.x_max_mm, workspace.reach_max_mm),
      y_min_mm: workspace.y_min_mm,
      y_max_mm: workspace.y_max_mm,
    };
  return (
    <div className="border border-rule bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-rule px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="h-3.5 w-3.5 border border-ink shrink-0"
            style={item.role === 'object' ? { background: item.color } : { boxShadow: `inset 0 0 0 2px ${item.color}` }}
          />
          <span className="font-medium text-[13px] truncate">{item.name}</span>
          <span className="label">{item.role}</span>
        </div>
        {modes.length > 1 && (
          <Segmented
            size="sm"
            value={spec.mode}
            onChange={(m) => set({ mode: m, bounds: m === 'random' ? bounds : spec.bounds })}
            options={modes.map((m) => ({ value: m, label: MODE_LABELS[m] }))}
          />
        )}
      </div>
      <div className="p-3 grid gap-3">
        {spec.mode === 'fixed' && (
          <div className="grid grid-cols-3 gap-2">
            <Field label="x">
              <NumberInput value={fixed.x_mm} suffix="mm" disabled={disabled} onChange={(v) => set({ fixed: { ...fixed, x_mm: v } })} />
            </Field>
            <Field label="y">
              <NumberInput value={fixed.y_mm} suffix="mm" disabled={disabled} onChange={(v) => set({ fixed: { ...fixed, y_mm: v } })} />
            </Field>
            <Field label="yaw">
              <NumberInput
                value={yaw.mode === 'fixed' ? yaw.value ?? fixed.yaw_deg : fixed.yaw_deg}
                suffix="°"
                disabled={disabled}
                onChange={(v) => set({ fixed: { ...fixed, yaw_deg: v }, yaw: { ...yaw, mode: 'fixed', value: v } })}
              />
            </Field>
            <p className="col-span-3 text-[11.5px] text-ink-3">Drag the marker on the map to place it.</p>
          </div>
        )}
        {spec.mode === 'regions' && (
          <div className="grid gap-2 grid-cols-[minmax(0,1fr)]">
            <div className="flex flex-wrap gap-1.5">
              {regions.map((r) => {
                const on = (spec.regions || []).includes(r.id);
                return (
                  <button
                    key={r.id}
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      set({
                        regions: on ? spec.regions.filter((x) => x !== r.id) : [...(spec.regions || []), r.id],
                      })
                    }
                    className={clsx('chip cursor-pointer', on && 'border-sky-ink bg-sky text-ink')}
                    aria-pressed={on}
                  >
                    {r.id} · {r.name}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <span className="label">Within region</span>
              <Segmented
                size="sm"
                value={spec.region_placement || 'centre'}
                onChange={(v) => set({ region_placement: v })}
                options={[
                  { value: 'centre', label: 'Centre' },
                  { value: 'random_in_region', label: 'Random spot' },
                ]}
              />
            </div>
          </div>
        )}
        {spec.mode === 'points' && (
          <PointList points={spec.points || []} disabled={disabled} onChange={(pts) => set({ points: pts })} />
        )}
        {spec.mode === 'random' && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {['x_min_mm', 'x_max_mm', 'y_min_mm', 'y_max_mm'].map((k) => (
              <Field key={k} label={k.replace('_mm', '').replace('_', ' ')}>
                <NumberInput value={bounds[k]} suffix="mm" disabled={disabled} onChange={(v) => set({ bounds: { ...bounds, [k]: v } })} />
              </Field>
            ))}
          </div>
        )}
        {(yawModes || []).length > 0 && spec.mode !== 'fixed' && (
          <YawEditor yaw={yaw} modes={yawModes} disabled={disabled} onChange={(y) => set({ yaw: y })} />
        )}
      </div>
    </div>
  );
}

function PointList({ points, onChange, disabled }) {
  return (
    <div className="space-y-1.5">
      {points.map((p, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_1fr_28px] gap-2">
          {['x_mm', 'y_mm', 'yaw_deg'].map((k) => (
            <NumberInput
              key={k}
              value={p[k]}
              suffix={k === 'yaw_deg' ? '°' : 'mm'}
              disabled={disabled}
              onChange={(v) => onChange(points.map((q, j) => (j === i ? { ...q, [k]: v } : q)))}
            />
          ))}
          <button type="button" className="btn-ghost btn-sm px-1.5" disabled={disabled} onClick={() => onChange(points.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-sm"
        disabled={disabled}
        onClick={() => onChange([...points, { x_mm: 200, y_mm: 0, yaw_deg: 0 }])}
      >
        + Point
      </button>
    </div>
  );
}

export function YawEditor({ yaw, onChange, modes = ['fixed', 'set', 'range'], disabled }) {
  const labels = { fixed: 'Fixed', set: 'Set of angles', range: 'Range' };
  return (
    <div className="grid gap-2 grid-cols-[minmax(0,1fr)]">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="label">Orientation</span>
        <Segmented
          size="sm"
          value={yaw.mode || 'fixed'}
          onChange={(m) => onChange({ ...yaw, mode: m })}
          options={modes.map((m) => ({ value: m, label: labels[m] }))}
        />
      </div>
      {yaw.mode === 'fixed' && (
        <NumberInput value={yaw.value ?? 0} suffix="°" disabled={disabled} onChange={(v) => onChange({ ...yaw, value: v })} className="max-w-[140px]" />
      )}
      {yaw.mode === 'set' && (
        <TextInput
          value={(yaw.values || []).join(', ')}
          disabled={disabled}
          placeholder="0, 45, 90"
          onChange={(v) =>
            onChange({
              ...yaw,
              values: v
                .split(',')
                .map((x) => x.trim())
                .filter((x) => x !== '' && !Number.isNaN(Number(x)))
                .map(Number),
            })
          }
        />
      )}
      {yaw.mode === 'range' && (
        <div className="grid grid-cols-2 gap-2 max-w-[300px]">
          <NumberInput value={yaw.min ?? -45} suffix="° min" disabled={disabled} onChange={(v) => onChange({ ...yaw, min: v })} />
          <NumberInput value={yaw.max ?? 45} suffix="° max" disabled={disabled} onChange={(v) => onChange({ ...yaw, max: v })} />
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------- sequence builder --
export function SequenceBuilder({ steps, items, onChange, disabled, compact }) {
  const objects = items.filter((i) => i.role === 'object');
  const targets = items.filter((i) => i.role === 'target');
  const set = (i, patch) => onChange(steps.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const needsItem = (a) => ['pick', 'place', 'push', 'rotate', 'move_to'].includes(a);
  return (
    <div className="space-y-2">
      <ol className="flex flex-wrap items-center gap-1.5" aria-label="Sequence preview">
        {steps.map((s, i) => (
          <li key={s.id || i} className="flex items-center gap-1.5">
            <span className="chip-ink">
              {i + 1}. {ACTION_LABELS[s.action] || s.action}
              {s.item_id && needsItem(s.action) ? ` ${items.find((x) => x.id === s.item_id)?.name || ''}` : ''}
            </span>
            {i < steps.length - 1 && <span className="text-ink-3">→</span>}
          </li>
        ))}
        {!steps.length && <li className="text-[12.5px] text-ink-3">No steps — add the first action.</li>}
      </ol>
      {!compact &&
        steps.map((s, i) => (
          <div key={s.id || i} className="grid grid-cols-[28px_140px_1fr_1fr_auto] gap-2 items-center border border-rule bg-white p-2">
            <span className="num text-[12px] text-ink-3 text-center">{i + 1}</span>
            <Select
              value={s.action}
              disabled={disabled}
              onChange={(v) => set(i, { action: v })}
              options={Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label }))}
            />
            {needsItem(s.action) ? (
              <Select
                value={s.item_id || ''}
                disabled={disabled}
                onChange={(v) => set(i, { item_id: v })}
                options={[{ value: '', label: 'Choose item…', disabled: true }, ...items.map((it) => ({ value: it.id, label: it.name }))]}
              />
            ) : (
              <TextInput value={s.notes || ''} placeholder="Notes" disabled={disabled} onChange={(v) => set(i, { notes: v })} />
            )}
            {s.action === 'place' || s.action === 'move_to' ? (
              <Select
                value={s.target_id || ''}
                disabled={disabled}
                onChange={(v) => set(i, { target_id: v })}
                options={[{ value: '', label: 'Target…' }, ...targets.map((it) => ({ value: it.id, label: it.name }))]}
              />
            ) : needsItem(s.action) ? (
              <TextInput value={s.notes || ''} placeholder="Notes" disabled={disabled} onChange={(v) => set(i, { notes: v })} />
            ) : (
              <span />
            )}
            <div className="flex gap-1">
              <button type="button" className="btn-ghost btn-sm px-1.5" disabled={disabled || i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                ↑
              </button>
              <button type="button" className="btn-ghost btn-sm px-1.5" disabled={disabled || i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                ↓
              </button>
              <button type="button" className="btn-ghost btn-sm px-1.5" disabled={disabled} onClick={() => onChange(steps.filter((_, k) => k !== i))} aria-label="Remove step">
                ✕
              </button>
            </div>
          </div>
        ))}
      {!compact && (
        <div className="flex flex-wrap gap-1.5">
          {['pick', 'place', 'move_to', 'push', 'rotate', 'wait', 'return_home', 'custom'].map((a) => (
            <button
              key={a}
              type="button"
              className="btn btn-sm"
              disabled={disabled}
              onClick={() =>
                onChange([
                  ...steps,
                  {
                    id: `s${Date.now().toString(36)}${steps.length}`,
                    action: a,
                    item_id: needsItem(a) ? objects[0]?.id || '' : undefined,
                    target_id: a === 'place' ? targets[0]?.id || '' : undefined,
                    notes: '',
                  },
                ])
              }
            >
              + {ACTION_LABELS[a]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------- scenario editor --
export function ScenarioEditor({ params, episodeCount, onChange, disabled }) {
  const scenarios = params.scenarios || [];
  const total = scenarios.reduce((a, s) => a + (Number(s.count) || 0), 0);
  const set = (i, patch) => onChange({ ...params, scenarios: scenarios.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const kindTone = { success: 'chip-ok', failure: 'chip-err', recovery: 'chip-warn' };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="flex h-3 flex-1 border border-ink overflow-hidden bg-white">
          {scenarios.map((s, i) => (
            <div
              key={s.id || i}
              title={`${s.name}: ${s.count}`}
              className={clsx(
                'h-full border-r border-ink last:border-r-0',
                s.kind === 'success' ? 'bg-ink' : s.kind === 'failure' ? 'bg-signal-err' : 'bg-sky'
              )}
              style={{ width: `${total ? ((Number(s.count) || 0) / Math.max(total, episodeCount)) * 100 : 0}%` }}
            />
          ))}
        </div>
        <span className={clsx('num text-[12.5px]', total === episodeCount ? 'text-signal-ok' : 'text-signal-err')}>
          {total} / {episodeCount}
        </span>
      </div>
      {scenarios.map((s, i) => (
        <div key={s.id || i} className="border border-rule bg-white p-3 grid gap-2">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_130px_1fr_90px_28px] gap-2 items-end">
            <Field label="Scenario">
              <TextInput value={s.name} disabled={disabled} onChange={(v) => set(i, { name: v })} />
            </Field>
            <Field label="Kind">
              <Select
                value={s.kind}
                disabled={disabled}
                onChange={(v) => set(i, { kind: v })}
                options={[
                  { value: 'success', label: 'Success' },
                  { value: 'failure', label: 'Failure' },
                  { value: 'recovery', label: 'Recovery' },
                ]}
              />
            </Field>
            <Field label="Condition">
              <Select
                value={s.perturbation}
                disabled={disabled}
                onChange={(v) => set(i, { perturbation: v })}
                options={Object.entries(PERTURBATION_LABELS).map(([value, label]) => ({ value, label }))}
              />
            </Field>
            <Field label="Episodes">
              <NumberInput value={s.count} min={0} disabled={disabled} onChange={(v) => set(i, { count: v })} />
            </Field>
            <button
              type="button"
              className="btn-ghost btn-sm px-1.5 mb-[3px]"
              disabled={disabled}
              onClick={() => onChange({ ...params, scenarios: scenarios.filter((_, k) => k !== i) })}
              aria-label="Remove scenario"
            >
              ✕
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr] gap-2">
            {['off_target_approach', 'object_displacement'].includes(s.perturbation) && (
              <Field label="Offset">
                <NumberInput value={s.offset_mm} suffix="mm" disabled={disabled} onChange={(v) => set(i, { offset_mm: v })} />
              </Field>
            )}
            {s.perturbation === 'wrong_orientation' && (
              <Field label="Rotation">
                <NumberInput value={s.rotate_deg} suffix="°" disabled={disabled} onChange={(v) => set(i, { rotate_deg: v })} />
              </Field>
            )}
            <Field label="Instruction override (optional)" hint="Leave empty to use the task instruction.">
              <TextInput value={s.instruction} disabled={disabled} onChange={(v) => set(i, { instruction: v })} />
            </Field>
            <Field label="Operator notes">
              <TextInput value={s.notes} disabled={disabled} onChange={(v) => set(i, { notes: v })} />
            </Field>
          </div>
          <span className={clsx('w-fit', kindTone[s.kind] || 'chip')}>{s.kind}</span>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-sm"
          disabled={disabled}
          onClick={() =>
            onChange({
              ...params,
              scenarios: [
                ...scenarios,
                {
                  id: `sc${Date.now().toString(36)}`,
                  name: 'New scenario',
                  kind: 'recovery',
                  count: 0,
                  perturbation: 'object_displacement',
                  offset_mm: 30,
                  rotate_deg: 0,
                  instruction: '',
                  notes: '',
                },
              ],
            })
          }
        >
          + Scenario
        </button>
        <span className="label ml-2">Order</span>
        <Segmented
          size="sm"
          value={params.scenario_order || 'interleaved'}
          onChange={(v) => onChange({ ...params, scenario_order: v })}
          options={[
            { value: 'interleaved', label: 'Interleaved' },
            { value: 'blocked', label: 'Blocked' },
            { value: 'random', label: 'Random' },
          ]}
        />
      </div>
    </div>
  );
}

export function DistanceBands({ bands = [], onChange, disabled }) {
  return (
    <div className="space-y-1.5">
      {bands.map((b, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_28px] gap-2">
          <NumberInput value={b.min_mm} suffix="mm min" disabled={disabled} onChange={(v) => onChange(bands.map((x, k) => (k === i ? { ...x, min_mm: v } : x)))} />
          <NumberInput value={b.max_mm} suffix="mm max" disabled={disabled} onChange={(v) => onChange(bands.map((x, k) => (k === i ? { ...x, max_mm: v } : x)))} />
          <button type="button" className="btn-ghost btn-sm px-1.5" disabled={disabled} onClick={() => onChange(bands.filter((_, k) => k !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => onChange([...bands, { min_mm: 80, max_mm: 160 }])}>
        + Distance band
      </button>
    </div>
  );
}

export { ACTION_LABELS, PERTURBATION_LABELS };
