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

// Adaptive configuration: the panel changes with the selected planning type.

import React, { useMemo } from 'react';
import { Field, NumberInput, Segmented } from '../../components/ui';
import { DistanceBands, ItemPlacementEditor, ScenarioEditor, SequenceBuilder } from './editors';

const MODES = {
  static: { modes: ['fixed'], yaw: [] },
  semi_dynamic: { modes: ['fixed', 'regions', 'points', 'random'], yaw: ['fixed', 'set', 'range'] },
  dynamic: { modes: ['regions', 'fixed'], yaw: ['fixed', 'set'] },
  randomized: { modes: ['random', 'fixed'], yaw: ['fixed', 'range', 'set'] },
  sequential: { modes: ['fixed', 'regions', 'points', 'random'], yaw: ['fixed', 'set', 'range'] },
  scenario: { modes: ['regions', 'fixed', 'random'], yaw: ['fixed', 'set'] },
};

export function combinationCount(task, params) {
  const regionIds = new Set((task.regions || []).map((r) => r.id));
  let n = 1;
  (task.items || []).forEach((it) => {
    const spec = params.items?.[it.id];
    if (spec?.mode === 'regions') {
      n *= Math.max(1, (spec.regions || []).filter((r) => regionIds.has(r)).length);
    }
  });
  const yawIds = params.vary_yaw_for || [];
  const yawItem = (task.items || []).find((it) => yawIds.includes(it.id));
  const yaw = yawItem && params.items?.[yawItem.id]?.yaw;
  if (yaw?.mode === 'set' && yaw.values?.length) n *= yaw.values.length;
  const bands = (params.distance_bands || []).filter((b) => b.max_mm > b.min_mm);
  if (bands.length) n *= bands.length;
  return n;
}

function Section({ title, hint, children, right }) {
  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="text-[13px] font-semibold">{title}</div>
          {hint && <div className="text-[12px] text-ink-3">{hint}</div>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

export default function StrategyConfig({ task, strategy, onChange, disabled }) {
  const type = strategy.type;
  const params = strategy.params || {};
  const cfg = MODES[type] || MODES.static;
  const setParams = (patch) => onChange({ ...strategy, params: { ...params, ...patch } });
  const setSpec = (itemId, spec) => setParams({ items: { ...params.items, [itemId]: spec } });
  const combos = useMemo(() => combinationCount(task, strategy.params || {}), [task, strategy.params]);

  const placementEditors = (
    <div className="grid gap-2 xl:grid-cols-2">
      {(task.items || []).map((it) => (
        <ItemPlacementEditor
          key={it.id}
          item={it}
          spec={params.items?.[it.id] || { mode: cfg.modes[0], fixed: { x_mm: 200, y_mm: 0, yaw_deg: 0 }, regions: [] }}
          regions={task.regions || []}
          workspace={task.workspace}
          modes={cfg.modes}
          yawModes={cfg.yaw}
          disabled={disabled}
          onChange={(spec) => setSpec(it.id, spec)}
        />
      ))}
    </div>
  );

  const seed = (
    <Field label="Random seed" hint="Same seed → same plan." className="max-w-[160px]">
      <NumberInput value={strategy.seed} disabled={disabled} onChange={(v) => onChange({ ...strategy, seed: v })} />
    </Field>
  );

  if (type === 'static') {
    return (
      <div className="space-y-5">
        <Section title="Fixed positions" hint="Every episode uses exactly these positions.">
          {placementEditors}
        </Section>
        <Section title="Predefined task sequence" hint="Optional — documents what each demonstration should contain.">
          <SequenceBuilder steps={params.sequence || []} items={task.items} disabled={disabled} onChange={(s) => setParams({ sequence: s })} />
        </Section>
      </div>
    );
  }

  if (type === 'semi_dynamic') {
    return (
      <div className="space-y-5">
        <Section
          title="Fixed or variable"
          hint="For each item choose Fixed, or how it varies (regions, a point list, or random in bounds). Orientation can vary independently."
        >
          {placementEditors}
        </Section>
        {seed}
      </div>
    );
  }

  if (type === 'dynamic') {
    const yawFor = params.vary_yaw_for || [];
    return (
      <div className="space-y-5">
        <Section
          title="Regions per item"
          hint="Every combination of the selected regions is demonstrated evenly."
          right={<span className="chip-sky">{combos} combination{combos === 1 ? '' : 's'}</span>}
        >
          {placementEditors}
        </Section>
        <Section title="Orientation variation" hint="Items whose 'Set of angles' becomes part of the balanced combinations.">
          <div className="flex flex-wrap gap-1.5">
            {(task.items || []).map((it) => {
              const on = yawFor.includes(it.id);
              return (
                <button
                  key={it.id}
                  type="button"
                  disabled={disabled}
                  className={on ? 'chip-ink' : 'chip'}
                  aria-pressed={on}
                  onClick={() => setParams({ vary_yaw_for: on ? yawFor.filter((x) => x !== it.id) : [...yawFor, it.id] })}
                >
                  {it.name}
                </button>
              );
            })}
          </div>
        </Section>
        <Section title="Object–target distance bands" hint="Optional. Each band becomes another dimension of the schedule.">
          <DistanceBands bands={params.distance_bands || []} disabled={disabled} onChange={(b) => setParams({ distance_bands: b })} />
        </Section>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Episode order">
            <Segmented
              size="sm"
              value={params.order || 'shuffled'}
              onChange={(v) => setParams({ order: v })}
              options={[
                { value: 'shuffled', label: 'Shuffled' },
                { value: 'grouped', label: 'Grouped' },
              ]}
            />
          </Field>
          {seed}
        </div>
      </div>
    );
  }

  if (type === 'randomized') {
    const cons = params.constraints || {};
    const setCons = (patch) => setParams({ constraints: { ...cons, ...patch } });
    return (
      <div className="space-y-5">
        <Section title="Randomisation boundaries" hint="Dashed rectangles on the map show each item's bounds.">
          {placementEditors}
        </Section>
        <Section title="Constraints">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Field label="Min object–target">
              <NumberInput value={cons.min_object_target_mm} suffix="mm" disabled={disabled} onChange={(v) => setCons({ min_object_target_mm: v })} />
            </Field>
            <Field label="Max object–target" hint="Empty = no limit">
              <NumberInput value={cons.max_object_target_mm ?? ''} suffix="mm" disabled={disabled} onChange={(v) => setCons({ max_object_target_mm: v === '' ? null : v })} />
            </Field>
            <Field label="Attempts per item">
              <NumberInput value={cons.max_attempts} disabled={disabled} onChange={(v) => setCons({ max_attempts: v })} />
            </Field>
            {seed}
          </div>
        </Section>
      </div>
    );
  }

  if (type === 'sequential') {
    return (
      <div className="space-y-5">
        <Section title="Sequence builder" hint="Add, remove and reorder actions. The sequence is stored with every episode.">
          <SequenceBuilder steps={params.sequence || []} items={task.items} disabled={disabled} onChange={(s) => setParams({ sequence: s })} />
        </Section>
        <Section title="Item positions">{placementEditors}</Section>
        {seed}
      </div>
    );
  }

  if (type === 'scenario') {
    return (
      <div className="space-y-5">
        <Section title="Scenarios" hint="Counts must add up to the total number of episodes.">
          <ScenarioEditor params={params} episodeCount={Number(task.episode_count) || 0} disabled={disabled} onChange={(p) => onChange({ ...strategy, params: p })} />
        </Section>
        <Section title="Item positions">{placementEditors}</Section>
        {seed}
      </div>
    );
  }
  return null;
}
