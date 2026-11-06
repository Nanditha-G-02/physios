// Strategy parameters: per-item placement rules, yaw, scenarios, seed/order, and the action
// sequence. The schema is the planning engine's (engine.default_params); unknown keys are kept.
import { Badge, Button, Check, Field, Input, NumberInput, Panel, Segmented, Select } from '@/design/ui';
import { I } from '@/design/icons';

const MODES = [{ value: 'fixed', label: 'Fixed position' }, { value: 'regions', label: 'Cycle regions' }, { value: 'random', label: 'Random in bounds' }, { value: 'points', label: 'Listed points' }];

export function StrategyEditor({ meta, task, strategy, onChange, onType }: { meta: any; task: any; strategy: any; onChange: (s: any) => void; onType: (t: string) => void }) {
  const params = strategy.params || {};
  const setParams = (p: any) => onChange({ ...strategy, params: { ...params, ...p } });
  const setSpec = (id: string, p: any) => setParams({ items: { ...params.items, [id]: { ...params.items[id], ...p } } });
  const types: string[] = meta?.strategy_types || [strategy.type];
  return (
    <div className="stack">
      <Panel title="Planning strategy" sub={meta?.strategy_info?.[strategy.type]}>
        <div className="stack">
          <Segmented value={strategy.type} onChange={onType} options={types.map((t) => ({ value: t, label: t.replace('_', ' ') }))} />
          <div className="grid g3">
            <Field label="Random seed" tip="Same seed + same settings = same episodes"><NumberInput value={strategy.seed} onChange={(v) => onChange({ ...strategy, seed: v ?? 0 })} /></Field>
            <Field label="Episode order"><Select value={params.order || 'shuffled'} onChange={(v) => setParams({ order: v })} options={[{ value: 'shuffled', label: 'Shuffled' }, { value: 'grouped', label: 'In generation order' }]} /></Field>
            {params.constraints && <Field label="Min object→target mm"><NumberInput value={params.constraints.min_object_target_mm} onChange={(v) => setParams({ constraints: { ...params.constraints, min_object_target_mm: v } })} /></Field>}
          </div>
          {params.vary_yaw_for && (
            <Field label="Vary orientation for">
              <div className="row">{task.items.map((it: any) => (
                <Check key={it.id} checked={params.vary_yaw_for.includes(it.id)} onChange={(c) => setParams({ vary_yaw_for: c ? [...params.vary_yaw_for, it.id] : params.vary_yaw_for.filter((x: string) => x !== it.id) })}>{it.name}</Check>
              ))}</div>
            </Field>
          )}
        </div>
      </Panel>

      {task.items.map((it: any) => {
        const spec = params.items?.[it.id];
        if (!spec) return null;
        const yaw = spec.yaw || { mode: 'fixed', value: 0 };
        return (
          <Panel key={it.id} title={<span className="row"><span style={{ width: 10, height: 10, borderRadius: 3, background: it.color, display: 'inline-block' }} />{it.name}<Badge>{it.role}</Badge></span>}>
            <div className="stack">
              <Field label="Placement"><Segmented value={spec.mode} onChange={(v) => setSpec(it.id, { mode: v })} options={MODES} /></Field>
              {spec.mode === 'fixed' && (
                <div className="grid g3">
                  <Field label="x mm"><NumberInput value={spec.fixed?.x_mm} onChange={(v) => setSpec(it.id, { fixed: { ...spec.fixed, x_mm: v ?? 0 } })} /></Field>
                  <Field label="y mm"><NumberInput value={spec.fixed?.y_mm} onChange={(v) => setSpec(it.id, { fixed: { ...spec.fixed, y_mm: v ?? 0 } })} /></Field>
                  <Field label="yaw °"><NumberInput value={spec.fixed?.yaw_deg} onChange={(v) => setSpec(it.id, { fixed: { ...spec.fixed, yaw_deg: v ?? 0 } })} /></Field>
                </div>
              )}
              {spec.mode === 'regions' && (
                <div className="grid g2">
                  <Field label="Regions">
                    <div className="row">{(task.regions || []).map((r: any) => (
                      <Check key={r.id} checked={(spec.regions || []).includes(r.id)} onChange={(c) => setSpec(it.id, { regions: c ? [...(spec.regions || []), r.id] : spec.regions.filter((x: string) => x !== r.id) })}>{r.name}</Check>
                    ))}</div>
                  </Field>
                  <Field label="Position inside region"><Select value={spec.region_placement || 'centre'} onChange={(v) => setSpec(it.id, { region_placement: v })} options={[{ value: 'centre', label: 'Centre' }, { value: 'random_in_region', label: 'Random inside' }]} /></Field>
                </div>
              )}
              {spec.mode === 'random' && (
                <div className="grid g4">
                  {(['x_min_mm', 'x_max_mm', 'y_min_mm', 'y_max_mm'] as const).map((k) => (
                    <Field key={k} label={k.replace('_mm', '').replace('_', ' ')}><NumberInput value={spec.bounds?.[k]} onChange={(v) => setSpec(it.id, { bounds: { ...(spec.bounds || {}), [k]: v ?? 0 } })} /></Field>
                  ))}
                </div>
              )}
              {spec.mode === 'points' && (
                <Field label="Points (x,y[,yaw] per line, mm)" hint="Episodes cycle through these">
                  <textarea className="textarea mono" rows={4} value={(spec.points || []).map((p: any) => [p.x_mm, p.y_mm, p.yaw_deg ?? 0].join(',')).join('\n')}
                    onChange={(e) => setSpec(it.id, { points: e.target.value.split('\n').map((l) => l.split(',').map(Number)).filter((a) => a.length >= 2 && a.every(isFinite)).map(([x, y, w]) => ({ x_mm: x, y_mm: y, yaw_deg: w || 0 })) })} />
                </Field>
              )}
              <div className="grid g4">
                <Field label="Orientation"><Select value={yaw.mode} onChange={(v) => setSpec(it.id, { yaw: { ...yaw, mode: v } })} options={[{ value: 'fixed', label: 'Fixed' }, { value: 'set', label: 'Cycle values' }, { value: 'range', label: 'Random range' }]} /></Field>
                {yaw.mode === 'fixed' && <Field label="yaw °"><NumberInput value={yaw.value} onChange={(v) => setSpec(it.id, { yaw: { ...yaw, value: v ?? 0 } })} /></Field>}
                {yaw.mode === 'set' && <Field label="values °"><Input value={(yaw.values || []).join(', ')} onChange={(e) => setSpec(it.id, { yaw: { ...yaw, values: e.target.value.split(',').map((x) => Number(x.trim())).filter(isFinite) } })} /></Field>}
                {yaw.mode === 'range' && <><Field label="min °"><NumberInput value={yaw.min} onChange={(v) => setSpec(it.id, { yaw: { ...yaw, min: v ?? 0 } })} /></Field><Field label="max °"><NumberInput value={yaw.max} onChange={(v) => setSpec(it.id, { yaw: { ...yaw, max: v ?? 0 } })} /></Field></>}
              </div>
            </div>
          </Panel>
        );
      })}

      {params.scenarios && (
        <Panel title="Scenarios" sub="Mix of normal, failure and recovery demonstrations" actions={<Button size="sm" icon={<I.plus />} onClick={() => setParams({ scenarios: [...params.scenarios, { id: `sc${params.scenarios.length + 1}`, name: 'Scenario', kind: 'success', count: 0, perturbation: 'none', offset_mm: 0, rotate_deg: 0, instruction: '', notes: '' }] })}>Add</Button>}>
          <div className="table-wrap"><table className="table"><thead><tr><th>Name</th><th>Kind</th><th>Perturbation</th><th>Count</th><th>Offset mm</th><th>Rotate °</th><th /></tr></thead>
            <tbody>{params.scenarios.map((s: any, i: number) => {
              const set = (p: any) => setParams({ scenarios: params.scenarios.map((x: any, j: number) => (j === i ? { ...x, ...p } : x)) });
              return (
                <tr key={s.id}>
                  <td><Input value={s.name} onChange={(e) => set({ name: e.target.value })} style={{ height: 28 }} /></td>
                  <td><Select value={s.kind} onChange={(v) => set({ kind: v })} options={meta?.scenario_kinds || ['success', 'failure', 'recovery']} style={{ height: 28 }} /></td>
                  <td><Select value={s.perturbation} onChange={(v) => set({ perturbation: v })} options={meta?.perturbations || ['none']} style={{ height: 28 }} /></td>
                  <td><NumberInput value={s.count} onChange={(v) => set({ count: v ?? 0 })} style={{ width: 70, height: 28 }} /></td>
                  <td><NumberInput value={s.offset_mm} onChange={(v) => set({ offset_mm: v ?? 0 })} style={{ width: 70, height: 28 }} /></td>
                  <td><NumberInput value={s.rotate_deg} onChange={(v) => set({ rotate_deg: v ?? 0 })} style={{ width: 70, height: 28 }} /></td>
                  <td><Button size="sm" variant="ghost" iconOnly icon={<I.trash />} onClick={() => setParams({ scenarios: params.scenarios.filter((_: any, j: number) => j !== i) })} /></td>
                </tr>
              );
            })}</tbody></table></div>
          <div className="small muted mt">Total {params.scenarios.reduce((a: number, s: any) => a + (s.count || 0), 0)} of {task.episode_count} episodes.</div>
        </Panel>
      )}
    </div>
  );
}

export function SequenceEditor({ meta, task, sequence, onChange }: { meta: any; task: any; sequence: any[]; onChange: (s: any[]) => void }) {
  const actions: string[] = meta?.action_types || ['pick', 'place', 'return_home'];
  const objects = task.items.filter((i: any) => i.role === 'object');
  const targets = task.items.filter((i: any) => i.role === 'target');
  const set = (i: number, p: any) => onChange(sequence.map((s, j) => (j === i ? { ...s, ...p } : s)));
  return (
    <div className="stack">
      {sequence.map((s, i) => (
        <div key={s.id || i} className="row" style={{ alignItems: 'flex-end' }}>
          <span className="badge">{i + 1}</span>
          <Field label="Action"><Select value={s.action} onChange={(v) => set(i, { action: v })} options={actions} /></Field>
          {['pick', 'place', 'push', 'rotate', 'move_to'].includes(s.action) && <Field label="Item"><Select value={s.item_id || ''} onChange={(v) => set(i, { item_id: v })} options={objects.map((o: any) => ({ value: o.id, label: o.name }))} placeholder="—" /></Field>}
          {['place', 'move_to', 'push'].includes(s.action) && <Field label="Target"><Select value={s.target_id || ''} onChange={(v) => set(i, { target_id: v })} options={targets.map((o: any) => ({ value: o.id, label: o.name }))} placeholder="—" /></Field>}
          <Field label="Notes"><Input value={s.notes || ''} onChange={(e) => set(i, { notes: e.target.value })} /></Field>
          <Button variant="ghost" iconOnly icon={<I.trash />} onClick={() => onChange(sequence.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div><Button size="sm" icon={<I.plus />} onClick={() => onChange([...sequence, { id: `s${sequence.length + 1}`, action: 'wait', notes: '' }])}>Add step</Button></div>
    </div>
  );
}
