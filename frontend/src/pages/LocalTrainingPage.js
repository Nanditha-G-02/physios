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

// Training session: trains a policy on this PC with the LeRobot installed in a
// local (conda) environment. Everything shown here comes from the host training
// service (physios_trainer); this page never runs anything on its own and a
// run starts only after the operator has reviewed the exact command.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { TrainerOffline, useTrainer } from '../hooks/useTrainer';
import RunMonitor, { StatusChip, q } from '../features/training/RunMonitor';
import OptimizationHome from '../features/optimization/OptimizationHome';
import TrainingPage from './TrainingPage';
import HealthReport from '../features/training/HealthReport';
import { ComparePanel, QueuePanel, StoragePanel } from '../features/training/TrainingPanels';
import EvaluationPanel from '../features/evaluation/EvaluationPanel';
import { setTrainingDatasetPath, setTrainingRunId } from '../features/planning/planningSlice';
import {
  Callout,
  Empty,
  Field,
  KeyValue,
  NumberInput,
  Segmented,
  Select,
  Sheet,
  Spinner,
  TextInput,
  Toggle,
  formatBytes,
  formatDuration,
} from '../components/ui';

const STEPS = [
  ['dataset', 'Dataset'],
  ['env', 'Environment'],
  ['model', 'Model'],
  ['config', 'Configure'],
  ['review', 'Review & start'],
];

function copy(text, what = 'Copied') {
  navigator.clipboard?.writeText(text);
  toast.success(what);
}

function CodeLine({ children }) {
  return (
    <div className="group flex items-start gap-2 rounded-xl bg-paper px-3 py-2">
      <code className="flex-1 min-w-0 text-[11.5px] break-all">{children}</code>
      <button
        className="btn-ghost btn-sm !px-2 !py-0.5 opacity-60 group-hover:opacity-100"
        onClick={() => copy(children, 'Command copied')}
      >
        Copy
      </button>
    </div>
  );
}

// one option per line; a value that follows its option stays on the same line
function pretty(argv) {
  const lines = [];
  argv.map(q).forEach((a, i) => {
    if (i === 0 || a.startsWith('-') || a.startsWith("'-")) lines.push(a);
    else lines[lines.length - 1] += ` ${a}`;
  });
  return lines.join(' \\\n    ');
}

// ---------------------------------------------------------------------------
function Offline({ message, onRetry }) {
  return (
    <div className="sheet p-8 grid gap-5 max-w-3xl">
      <div>
        <div className="label">Training service</div>
        <h2 className="text-[26px] font-light tracking-tight mt-1">Not running on this PC</h2>
        <p className="text-[13px] text-ink-3 mt-1">{message}</p>
      </div>
      <p className="text-[13px] text-ink-2">
        Local training runs through a small service on the host (outside Docker), so it can use your existing conda environment
        and GPU. It listens on 127.0.0.1 only and runs nothing until you confirm a command here. Start it in a terminal and keep
        it open:
      </p>
      <CodeLine>cd ~/physios && ./start_physios.sh</CodeLine>
      <p className="text-[12px] text-ink-3">
        It needs only Python 3.9+ (no packages). Training processes keep running if you close it; restart it and this page picks
        them up again.
      </p>
      <div>
        <button className="btn-primary" onClick={onRetry}>
          Check again
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function DatasetStep({ datasets, roots, value, onPick, env }) {
  if (!datasets) return <Spinner />;
  if (!datasets.length) {
    return <Empty title="No datasets found">Looked in {roots.join(', ')}. Record episodes in the Record session first.</Empty>;
  }
  return (
    <div className="grid gap-3">
      {datasets.map((d) => {
        const sel = value === d.path;
        const rc = d.review_counts || {};
        return (
          <button
            key={d.path}
            data-dataset={d.id}
            onClick={() => onPick(d.path)}
            className={clsx(
              'text-left rounded-2xl p-4 transition-all border',
              sel ? 'bg-ink text-white border-ink shadow-lift' : 'bg-white border-transparent shadow-card hover:shadow-lift',
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-[14px] truncate">{d.id}</span>
              <span className={sel ? 'chip bg-white/15 text-white' : 'chip'}>LeRobot {d.codebase_version}</span>
              {!d.complete && <span className="chip-err">incomplete</span>}
              <span className={clsx('ml-auto text-[11.5px] num', sel ? 'text-white/60' : 'text-ink-3')}>
                {formatBytes(d.size_bytes)}
              </span>
            </div>
            <div className={clsx('mt-2 grid grid-cols-2 md:grid-cols-5 gap-3 text-[12px]', sel ? 'text-white/80' : 'text-ink-2')}>
              <div>
                <div className={clsx('label', sel && '!text-white/50')}>Episodes</div>
                <div className="text-[20px] font-light">{d.total_episodes}</div>
              </div>
              <div>
                <div className={clsx('label', sel && '!text-white/50')}>Accepted</div>
                <div className="text-[20px] font-light">{rc.accepted ?? 0}</div>
              </div>
              <div>
                <div className={clsx('label', sel && '!text-white/50')}>Rejected</div>
                <div className="text-[20px] font-light">{rc.rejected ?? 0}</div>
              </div>
              <div>
                <div className={clsx('label', sel && '!text-white/50')}>Robot</div>
                <div className="truncate">{d.robot_type || '—'}</div>
                <div className={clsx('num text-[11px]', sel ? 'text-white/50' : 'text-ink-3')}>
                  {d.fps} fps · {d.total_frames} frames
                </div>
              </div>
              <div className="min-w-0">
                <div className={clsx('label', sel && '!text-white/50')}>Cameras</div>
                <div className="truncate">{(d.cameras || []).map((c) => c.split('.').pop()).join(', ') || '—'}</div>
              </div>
            </div>
            {d.tasks?.[0] && (
              <div className={clsx('mt-2 text-[12px] italic truncate', sel ? 'text-white/70' : 'text-ink-3')}>“{d.tasks[0]}”</div>
            )}
            <div className={clsx('mt-1 num text-[11px] truncate', sel ? 'text-white/40' : 'text-ink-4')}>{d.path}</div>
          </button>
        );
      })}
      {value && (
        <div className="sheet px-5 py-4 mt-2">
          <HealthReport path={value} env={env} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function EnvStep({ system, envs, envName, setEnvName, envInfo, refresh, loading }) {
  const p = envInfo?.probe;
  const pk = p?.packages || {};
  const gpu = system?.gpu;
  return (
    <div className="grid gap-4 grid-cols-[minmax(0,1fr)]">
      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-2xl bg-paper px-4 py-3">
          <div className="label">OS</div>
          <div className="text-[13px] mt-1">{system?.os}</div>
          <div className="num text-[11px] text-ink-3">
            {system?.machine} · {system?.cpu_count} CPU
          </div>
        </div>
        <div className="rounded-2xl bg-paper px-4 py-3">
          <div className="label">GPU</div>
          {gpu?.available ? (
            (gpu.gpus || []).map((g) => (
              <div key={g.index} className="text-[13px] mt-1">
                {g.name}
                <div className="num text-[11px] text-ink-3">
                  {(g.memory_total_mb / 1024).toFixed(1)} GB · {(g.memory_used_mb / 1024).toFixed(1)} GB used · driver {g.driver}
                </div>
              </div>
            ))
          ) : (
            <div className="text-[13px] mt-1 text-signal-warn">None detected</div>
          )}
          {!gpu?.available && <div className="text-[11px] text-ink-3">{gpu?.reason}</div>}
        </div>
        <div className="rounded-2xl bg-paper px-4 py-3">
          <div className="label">Memory</div>
          <div className="text-[20px] font-light mt-0.5">{formatBytes(system?.ram_total)}</div>
          <div className="num text-[11px] text-ink-3">{formatBytes(system?.ram_available)} free</div>
        </div>
        <div className="rounded-2xl bg-paper px-4 py-3">
          <div className="label">Storage (outputs)</div>
          {(system?.disks || []).slice(0, 1).map((d) => (
            <div key={d.path}>
              <div className="text-[20px] font-light mt-0.5">{formatBytes(d.free)} free</div>
              <div className="num text-[11px] text-ink-3 truncate">of {formatBytes(d.total)}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="label">Python environments</div>
          <button className="btn-ghost btn-sm" onClick={refresh} disabled={loading}>
            {loading && <Spinner />}Re-scan
          </button>
        </div>
        {!envs ? (
          <Spinner />
        ) : !envs.length ? (
          <Callout tone="err" title="No conda environment found">
            conda was not found or lists no environments. Create one with LeRobot (see LeRobot's install guide), or start the
            service with <code>--env NAME=/path/to/venv</code>.
          </Callout>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {envs.map((e) => (
              <button
                key={e.name}
                data-env={e.name}
                onClick={() => setEnvName(e.name)}
                className={clsx(
                  'text-left rounded-2xl px-4 py-3 border transition-all',
                  envName === e.name
                    ? 'border-ink bg-white shadow-lift'
                    : 'border-transparent bg-white shadow-card hover:shadow-lift',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[13.5px]">{e.name}</span>
                  {e.lerobot_train ? <span className="chip-ok">can train</span> : <span className="chip">no lerobot-train</span>}
                  {e.cuda_available && <span className="chip-sky">CUDA</span>}
                </div>
                <div className="num text-[11px] text-ink-3 mt-1 truncate">
                  {e.ok
                    ? `Python ${e.python} · LeRobot ${e.packages?.lerobot || '—'} · torch ${e.packages?.torch || '—'}`
                    : e.error}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {p && (
        <div className="grid gap-3">
          <KeyValue
            rows={[
              ['Path', <span className="num">{p.prefix}</span>],
              ['Python', p.python],
              ['LeRobot', `${pk.lerobot || 'not installed'}${p.codebase_version ? ` (datasets ${p.codebase_version})` : ''}`],
              [
                'PyTorch',
                `${pk.torch || '—'}${p.torch_cuda_build ? ` · CUDA build ${p.torch_cuda_build}` : ''} · GPU ${p.cuda_available ? `usable (${p.gpu?.name})` : 'not usable'}`,
              ],
              [
                'Packages',
                Object.entries(pk)
                  .filter(([k]) => !['lerobot', 'torch'].includes(k))
                  .map(([k, v]) => (
                    <span key={k} className={clsx('mr-1.5 mb-1 inline-flex', v ? 'chip' : 'chip-warn')}>
                      {k} {v || 'missing'}
                    </span>
                  )),
              ],
              envInfo.cli && [
                'lerobot-train',
                `${envInfo.cli.flag_count} options · ${envInfo.cli.policy_types.length} policy types`,
              ],
            ]}
          />
          {envInfo.checks.map((c, i) => (
            <Callout key={i} tone={c.level === 'error' ? 'err' : 'warn'} title={c.text}>
              {c.fix && <CodeLine>{c.fix}</CodeLine>}
            </Callout>
          ))}
          <p className="text-[11.5px] text-ink-3">
            The environment is used as it is — nothing is installed or changed in it. Fix commands above are for you to run
            yourself if you decide to.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function ModelStep({ models, otherTypes, value, onPick }) {
  if (!models) return <Spinner />;
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 md:grid-cols-2">
        {models.map((m) => {
          const sel = value === m.id;
          const blocked = m.status === 'blocked';
          return (
            <button
              key={m.id}
              data-model={m.id}
              disabled={blocked}
              onClick={() => onPick(m)}
              className={clsx(
                'text-left rounded-2xl p-4 border transition-all',
                sel ? 'border-ink bg-white shadow-lift' : 'border-transparent bg-white shadow-card hover:shadow-lift',
                blocked && 'opacity-60 cursor-not-allowed hover:shadow-card',
              )}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-[14px]">{m.name}</span>
                <span className="num text-[11px] text-ink-4">{m.id}</span>
                <span className="ml-auto flex gap-1">
                  {m.recommended && <span className="chip-ink">Recommended</span>}
                  {blocked ? (
                    <span className="chip-err">Not available</span>
                  ) : m.status === 'warn' ? (
                    <span className="chip-warn">Check notes</span>
                  ) : (
                    <span className="chip-ok">Compatible</span>
                  )}
                </span>
              </div>
              <p className="text-[12.5px] text-ink-2 mt-1.5">{m.summary}</p>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[11.5px]">
                <div>
                  <span className="label">Robots</span>
                  <div className="text-ink-2">{m.robots}</div>
                </div>
                <div>
                  <span className="label">Needs</span>
                  <div className="text-ink-2">
                    {m.min_vram_mb ? `≥ ${(m.min_vram_mb / 1024).toFixed(0)} GB GPU` : 'any GPU or CPU'}
                    {m.language ? ' · task text' : ''}
                    {m.packages?.length ? ` · ${m.packages.join(', ')}` : ''}
                  </div>
                </div>
              </div>
              {m.reasons?.length > 0 && (
                <ul className={clsx('mt-2 text-[11.5px] list-disc pl-4', blocked ? 'text-signal-err' : 'text-signal-warn')}>
                  {m.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              {m.notes && <p className="mt-2 text-[11.5px] text-ink-3">{m.notes}</p>}
            </button>
          );
        })}
      </div>
      {otherTypes?.length > 0 && (
        <p className="text-[11.5px] text-ink-3">
          This LeRobot also offers {otherTypes.join(', ')}. They have not been checked against this robot's datasets, so they are
          not offered here; use lerobot-train directly if you want to try one.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Optional held-out validation loss (only where this LeRobot supports it)
function ValidationOption({ cfg, setCfg, flags, dataset }) {
  const supported = (flags || []).includes('dataset.eval_split') && (flags || []).includes('eval_steps');
  const v = cfg.validation || { enabled: false, eval_split: 0.1, eval_steps: '' };
  const set = (patch) => setCfg({ ...cfg, validation: { ...v, ...patch } });
  const n = dataset?.total_episodes || 0;
  const held = n ? Math.max(1, Math.ceil((Number(v.eval_split) || 0) * n)) : null;
  return (
    <div className="rounded-2xl bg-paper px-4 py-3 grid gap-2" data-validation-option>
      <div className="flex items-center gap-3 flex-wrap">
        <Toggle
          checked={!!v.enabled && supported}
          disabled={!supported}
          onChange={(on) => set({ enabled: on })}
          label="Hold out episodes to measure validation loss"
        />
        {!supported && flags && <span className="chip">not supported by this LeRobot</span>}
      </div>
      <p className="text-[12px] text-ink-3">
        Sets aside the last episodes of the task. They are <b>not</b> learned from, and the model’s loss on them shows whether it
        generalises or only memorises. With a small dataset this costs real training data
        {held ? ` (${held} of ${n} episodes at this split)` : ''}; use it to choose settings, then train again with it off.
      </p>
      {v.enabled && supported && (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Share held out" hint="Between 0 and 0.5">
            <NumberInput value={v.eval_split} onChange={(x) => set({ eval_split: x })} min={0.02} max={0.49} step={0.01} />
          </Field>
          <Field label="Measure every N steps" hint="Empty = about 20 times per run">
            <NumberInput value={v.eval_steps} onChange={(x) => set({ eval_steps: x })} min={1} />
          </Field>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function ConfigStep({ cfg, setCfg, model, dataset, flags }) {
  const t = cfg.train;
  const setT = (k, v) => setCfg({ ...cfg, train: { ...t, [k]: v } });
  const rc = dataset?.review_counts || {};
  const adv = Object.entries(cfg.advanced || {});
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const pp = Object.entries(cfg.policy_params || {});
  return (
    <div className="grid gap-5">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Job name" hint="Also the output folder name">
          <TextInput value={cfg.job_name} onChange={(v) => setCfg({ ...cfg, job_name: v })} data-cfg="job_name" />
        </Field>
        <Field label="Output directory" hint="Leave empty for the default under lerobot/outputs/train">
          <TextInput value={cfg.output_dir} onChange={(v) => setCfg({ ...cfg, output_dir: v })} placeholder="default" />
        </Field>
      </div>

      {model?.source?.mode === 'path' && (
        <Field label="Start from pretrained model" hint="Hugging Face id or local folder (fine-tuning)">
          <TextInput value={cfg.source?.path} onChange={(v) => setCfg({ ...cfg, source: { mode: 'path', path: v } })} />
        </Field>
      )}

      <div>
        <div className="label mb-2">Episodes</div>
        <Segmented
          value={cfg.episodes}
          onChange={(v) => setCfg({ ...cfg, episodes: v })}
          options={[
            { value: 'all', label: `All (${dataset?.total_episodes ?? '—'})` },
            {
              value: 'exclude_rejected',
              label: `Skip rejected (${(dataset?.total_episodes || 0) - (rc.rejected || 0)})`,
              disabled: !rc.rejected,
            },
            {
              value: 'accepted_only',
              label: `Accepted only (${rc.accepted || 0})`,
              disabled: !rc.accepted,
            },
          ]}
        />
        <p className="text-[11.5px] text-ink-3 mt-1.5">
          Review status comes from the Data session. Rejected episodes stay in the dataset; they are only left out of training.
        </p>
      </div>

      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <Field label="Steps">
          <NumberInput value={t.steps} onChange={(v) => setT('steps', v)} min={1} data-cfg="steps" />
        </Field>
        <Field label="Batch size">
          <NumberInput value={t.batch_size} onChange={(v) => setT('batch_size', v)} min={1} data-cfg="batch_size" />
        </Field>
        <Field label="Learning rate">
          <TextInput value={t.lr} onChange={(v) => setT('lr', v)} className="num" />
        </Field>
        <Field label="Device">
          <Select value={t.device} onChange={(v) => setT('device', v)} options={['cuda', 'cpu']} />
        </Field>
        <Field label="Log every" hint="steps">
          <NumberInput value={t.log_freq} onChange={(v) => setT('log_freq', v)} min={1} data-cfg="log_freq" />
        </Field>
        <Field label="Checkpoint every" hint="steps">
          <NumberInput value={t.save_freq} onChange={(v) => setT('save_freq', v)} min={1} data-cfg="save_freq" />
        </Field>
        <Field label="Data workers">
          <NumberInput value={t.num_workers} onChange={(v) => setT('num_workers', v)} min={0} />
        </Field>
        <Field label="Seed">
          <NumberInput value={t.seed} onChange={(v) => setT('seed', v)} min={0} />
        </Field>
      </div>

      {(pp.length > 0 || Object.keys(cfg.rename_map || {}).length > 0 || cfg.empty_cameras != null) && (
        <div className="grid gap-3">
          <div className="label">Model options</div>
          <div className="grid gap-3 md:grid-cols-3">
            {pp.map(([k, v]) => (
              <Field key={k} label={k}>
                <TextInput
                  value={v}
                  onChange={(nv) =>
                    setCfg({
                      ...cfg,
                      policy_params: { ...cfg.policy_params, [k]: nv },
                    })
                  }
                  className="num"
                />
              </Field>
            ))}
            {cfg.empty_cameras != null && (
              <Field label="Empty camera slots" hint="SmolVLA expects 3 image inputs">
                <NumberInput value={cfg.empty_cameras} onChange={(v) => setCfg({ ...cfg, empty_cameras: v })} min={0} max={3} />
              </Field>
            )}
          </div>
          {Object.entries(cfg.rename_map || {}).map(([k, v]) => (
            <div key={k} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[12px]">
              <code className="rounded-xl bg-paper px-3 py-2 truncate">{k}</code>
              <span className="text-ink-4">→</span>
              <TextInput
                value={v}
                onChange={(nv) => setCfg({ ...cfg, rename_map: { ...cfg.rename_map, [k]: nv } })}
                className="num"
              />
            </div>
          ))}
        </div>
      )}

      <ValidationOption cfg={cfg} setCfg={setCfg} flags={flags} dataset={dataset} />

      <div className="grid gap-2">
        <div className="label">Advanced lerobot-train options</div>
        {adv.map(([k, v]) => (
          <div key={k} className="flex gap-2 items-center">
            <code className="rounded-xl bg-paper px-3 py-2 text-[12px] flex-1 truncate">
              --{k}={v}
            </code>
            <button
              className="btn-ghost btn-sm"
              onClick={() => {
                const a = { ...cfg.advanced };
                delete a[k];
                setCfg({ ...cfg, advanced: a });
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="grid grid-cols-[2fr_1fr_auto] gap-2">
          <TextInput
            value={newKey}
            onChange={setNewKey}
            placeholder="option, e.g. policy.chunk_size"
            list="lr-flags"
            className="num"
          />
          <TextInput value={newVal} onChange={setNewVal} placeholder="value" className="num" />
          <button
            className="btn"
            disabled={!newKey.trim()}
            onClick={() => {
              setCfg({
                ...cfg,
                advanced: {
                  ...(cfg.advanced || {}),
                  [newKey.trim().replace(/^-+/, '')]: newVal,
                },
              });
              setNewKey('');
              setNewVal('');
            }}
          >
            Add
          </button>
        </div>
        <datalist id="lr-flags">
          {(flags || []).map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        <p className="text-[11.5px] text-ink-3">
          Only options that the installed lerobot-train lists in its --help are accepted.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function ReviewStep({ plan, planning, planErr, ack, setAck, onStart, onQueue, starting, system, dsPath, envName }) {
  if (planErr)
    return (
      <Callout tone="err" title="Could not prepare the command">
        {planErr}
      </Callout>
    );
  if (!plan)
    return (
      <div className="grid place-items-center h-40">
        <Spinner />
      </div>
    );
  const r = plan.resources || {};
  const foreign = plan.foreign_trainings || [];
  const all = plan.stages.map((s) => s.argv.map(q).join(' ')).join('\n\n');
  return (
    <div className={clsx('grid gap-4 grid-cols-[minmax(0,1fr)] transition-opacity', planning && 'opacity-60')}>
      {plan.errors.map((e) => (
        <Callout key={e} tone="err">
          {e}
        </Callout>
      ))}
      {plan.busy && (
        <Callout tone="warn" title="Another training run is active">
          Run {plan.busy.id} ({plan.busy.job_name}) is {plan.busy.status}. One run at a time — use “Add to queue” to start this
          one automatically when it finishes.
        </Callout>
      )}
      {foreign.length > 0 && (
        <Callout tone="err" title="A training process started outside this app is running">
          {foreign.map((f) => (
            <div key={f.pid} className="num text-[11.5px] break-all">
              PID {f.pid}: {f.cmd}
            </div>
          ))}
          It is left untouched; starting another training would compete for the GPU.
        </Callout>
      )}
      {plan.warnings.map((w) => (
        <Callout key={w} tone="warn">
          {w}
        </Callout>
      ))}

      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <div className="rounded-2xl bg-paper px-4 py-3">
          <div className="label">Episodes used</div>
          <div className="text-[24px] font-light">{r.episodes_used}</div>
          <div className="num text-[11px] text-ink-3">≈ {r.frames_estimate} frames</div>
        </div>
        <div className="rounded-2xl bg-paper px-4 py-3">
          <div className="label">GPU memory</div>
          <div className="text-[24px] font-light">{r.gpu_estimate_mb ? `~${(r.gpu_estimate_mb / 1024).toFixed(1)} GB` : '—'}</div>
          <div className="num text-[11px] text-ink-3">
            {r.gpu_available_mb ? `of ${(r.gpu_available_mb / 1024).toFixed(1)} GB` : 'no GPU'}
          </div>
        </div>
        <div className="rounded-2xl bg-paper px-4 py-3">
          <div className="label">Dataset copy</div>
          <div className="text-[24px] font-light">
            {r.snapshot_bytes ? formatBytes(r.snapshot_bytes) : plan.snapshot ? 'reused' : 'none'}
          </div>
          <div className="num text-[11px] text-ink-3">
            {r.snapshot_bytes
              ? 'converted copy, original untouched'
              : plan.snapshot
                ? 'converted copy from an earlier run'
                : 'reads the dataset directly'}
          </div>
        </div>
        <div className="rounded-2xl bg-paper px-4 py-3">
          <div className="label">Environment</div>
          <div className="text-[15px] mt-1">{plan.env.name}</div>
          <div className="num text-[11px] text-ink-3">
            LeRobot {plan.env.lerobot} · torch {plan.env.torch}
          </div>
        </div>
      </div>

      {plan.storage && (
        <div className="rounded-2xl bg-paper px-4 py-3 grid gap-2" data-storage-estimate>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="label">Disk space</span>
            <span className="text-[15px]">~{formatBytes(plan.storage.total)} will be written</span>
          </div>
          <div className="grid gap-1 text-[12px]">
            {plan.storage.items.map((it) => (
              <div key={it.what} className="flex gap-2">
                <span className="w-44 shrink-0 text-ink-2">{it.what}</span>
                <span className="num w-20 shrink-0">{formatBytes(it.bytes)}</span>
                <span className="text-ink-3 truncate">{it.detail}</span>
              </div>
            ))}
            {plan.storage.disks.map((d) => (
              <div key={d.path} className="flex gap-2 text-ink-3">
                <span className="w-44 shrink-0">free on disk</span>
                <span className={clsx('num w-20 shrink-0', d.free != null && d.need > d.free && 'text-signal-err')}>
                  {formatBytes(d.free)}
                </span>
                <span className="num truncate">{d.path}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="sheet px-5 py-4">
        <HealthReport path={dsPath} env={envName} compact />
      </div>

      {plan.compat && plan.compat.same_minor === false && (
        <Callout tone="info" title="About using the result in Inference">
          Training uses LeRobot {plan.compat.training_lerobot}; the Inference session's container runs LeRobot{' '}
          {plan.compat.container_lerobot}. A model trained here cannot be loaded there — run it on the host with LeRobot{' '}
          {plan.compat.training_lerobot} instead.
        </Callout>
      )}

      <section className="night-panel">
        <div className="flex items-center justify-between px-5 pt-4">
          <div className="text-[12px] text-white/60 font-mono">
            {plan.stages.length} step{plan.stages.length > 1 ? 's' : ''} · runs without a shell, in {plan.env.prefix}
          </div>
          <button
            className="rounded-pill bg-white/10 px-3 py-1 text-[12px] text-white hover:bg-white/20"
            onClick={() => copy(all, 'Command copied')}
          >
            Copy
          </button>
        </div>
        <div className="p-4 grid gap-3">
          {plan.stages.map((s, i) => (
            <div key={i}>
              <div className="text-[11.5px] text-[#9db8ff] mb-1">
                {i + 1}. {s.desc}
              </div>
              <pre
                className="rounded-2xl bg-black/30 p-3 text-[11.5px] leading-[1.6] text-[#dfe8ff] font-mono whitespace-pre-wrap break-all"
                data-stage={s.kind}
              >
                {s.kind === 'copy' ? `copy ${s.argv[1]}\n  → ${s.argv[2]}` : pretty(s.argv)}
              </pre>
            </div>
          ))}
        </div>
      </section>

      <KeyValue
        rows={[
          ['Output', <span className="num">{plan.output_dir}</span>],
          ['Dataset used', <span className="num">{plan.dataset_root}</span>],
          ['Logs & state', <span className="num">{system?.data_dir}</span>],
        ]}
      />

      <div className="sheet p-4 flex flex-wrap items-center gap-4">
        <label className="flex items-start gap-2 text-[13px] flex-1 min-w-[260px]">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            disabled={!plan.ok}
            data-ack
          />
          <span>I have reviewed these commands and want to run them on this PC.</span>
        </label>
        <button
          className="btn-primary px-6"
          disabled={!plan.ok || !ack || starting || planning || !!plan.busy || foreign.length > 0}
          onClick={onStart}
          data-start-training
        >
          {starting && <Spinner />}Start training
        </button>
        <button
          className="btn"
          disabled={!plan.ok || !ack || starting || planning}
          onClick={onQueue}
          data-queue-training
          title="Runs after the jobs already waiting, when nothing else is training"
        >
          Add to queue
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function RunsList({ runs, current, onOpen }) {
  if (!runs) return <Spinner />;
  if (!runs.length)
    return (
      <Empty title="No training runs yet">
        Runs you start here are listed with their logs and checkpoints, also after a restart.
      </Empty>
    );
  return (
    <div className="grid gap-2">
      {runs.map((r) => {
        const p = r.progress || {};
        const pct = p.total ? Math.min(100, (p.step / p.total) * 100) : null;
        const dur = r.created_at
          ? ((r.finished_at ? new Date(r.finished_at) : new Date()) - new Date(r.created_at)) / 1000
          : null;
        return (
          <button
            key={r.id}
            data-run={r.id}
            onClick={() => onOpen(r.id)}
            className={clsx(
              'text-left rounded-2xl px-4 py-3 border transition-all grid gap-1.5',
              current === r.id ? 'border-ink bg-white shadow-lift' : 'border-transparent bg-white shadow-card hover:shadow-lift',
            )}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-semibold text-[13.5px] truncate flex-1">{r.job_name}</span>
              <StatusChip status={r.status} />
            </div>
            <div className="num text-[11px] text-ink-3 truncate">
              {r.policy} · {r.dataset}
              {r.resume_of ? ' · resumed' : ''}
            </div>
            {pct != null && (
              <div className="h-1 rounded-pill bg-paper-2 overflow-hidden">
                <div className="h-full bg-sky-ink" style={{ width: `${pct}%` }} />
              </div>
            )}
            <div className="flex justify-between num text-[11px] text-ink-3">
              <span>{p.step != null ? `${p.step.toLocaleString()} / ${p.total?.toLocaleString() ?? '—'} steps` : '—'}</span>
              <span>
                {p.last?.loss != null ? `loss ${Number(p.last.loss).toPrecision(4)}` : ''}
                {dur ? ` · ${formatDuration(dur)}` : ''}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function LocalTrainingPage() {
  const dispatch = useDispatch();
  const { get, post } = useTrainer();
  const handoffPath = useSelector((s) => s.planning.trainingDatasetPath);
  const handoffRun = useSelector((s) => s.planning.trainingRunId);
  const [tab, setTab] = useState('new');
  const [offline, setOffline] = useState(null);
  const [system, setSystem] = useState(null);
  const [datasets, setDatasets] = useState(null);
  const [roots, setRoots] = useState([]);
  const [envs, setEnvs] = useState(null);
  const [envLoading, setEnvLoading] = useState(false);
  const [envName, setEnvName] = useState('');
  const [envInfo, setEnvInfo] = useState(null);
  const [models, setModels] = useState(null);
  const [otherTypes, setOtherTypes] = useState([]);
  const [flags, setFlags] = useState([]);
  const [step, setStep] = useState('dataset');
  const [dsPath, setDsPath] = useState('');
  const [model, setModel] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [plan, setPlan] = useState(null);
  const [planErr, setPlanErr] = useState('');
  const [planning, setPlanning] = useState(false);
  const [ack, setAck] = useState(false);
  const [starting, setStarting] = useState(false);
  const [runs, setRuns] = useState(null);
  const [runId, setRunId] = useState(handoffRun || null);
  const planSeq = useRef(0);

  const fail = useCallback((e) => {
    if (e instanceof TrainerOffline) setOffline(e.message);
    else toast.error(e.message);
  }, []);

  const loadBase = useCallback(async () => {
    try {
      const [sys, ds, rr] = await Promise.all([get('/system'), get('/datasets'), get('/runs')]);
      setOffline(null);
      setSystem(sys);
      setDatasets(ds.datasets);
      setRoots(ds.roots);
      setRuns(rr.runs);
      const act = rr.runs.find((r) => ['starting', 'copying', 'converting', 'training', 'paused', 'stopping'].includes(r.status));
      if (act) {
        setRunId((cur) => cur || act.id);
        setTab((cur) => (cur === 'new' && !handoffPath ? 'runs' : cur));
      }
    } catch (e) {
      fail(e);
    }
  }, [get, fail, handoffPath]);

  const loadEnvs = useCallback(
    async (refresh) => {
      setEnvLoading(true);
      try {
        const r = await get(`/envs${refresh ? '?refresh=1' : ''}`, {
          timeoutMs: 180000,
        });
        setEnvs(r.envs);
        setEnvName((cur) => cur || (r.envs.find((e) => e.lerobot_train) || {}).name || '');
      } catch (e) {
        fail(e);
      } finally {
        setEnvLoading(false);
      }
    },
    [get, fail],
  );

  useEffect(() => {
    loadBase();
    loadEnvs(false);
  }, [loadBase, loadEnvs]);

  // the Data session hands over a dataset id (owner/name); map it to the host path
  useEffect(() => {
    if (!handoffPath || !datasets) return;
    const d = datasets.find((x) => x.id === handoffPath || x.path === handoffPath);
    if (d) setDsPath(d.path);
    else toast.error(`Dataset ${handoffPath} was not found in the training service's dataset folders.`);
  }, [handoffPath, datasets]);
  useEffect(() => {
    if (handoffPath) {
      setTab('new');
      setStep('dataset');
    }
  }, [handoffPath]);
  useEffect(() => {
    if (handoffRun) {
      setRunId(handoffRun);
      setTab('runs');
    }
  }, [handoffRun]);

  // runs list refresh
  useEffect(() => {
    if (offline) return undefined;
    const id = setInterval(async () => {
      try {
        setRuns((await get('/runs')).runs);
      } catch (e) {
        /* the offline state is detected by the other calls */
      }
    }, 5000);
    return () => clearInterval(id);
  }, [get, offline]);

  // environment detail
  useEffect(() => {
    if (!envName) return;
    setEnvInfo(null);
    get(`/envs/${encodeURIComponent(envName)}`, { timeoutMs: 180000 }).then(setEnvInfo, fail);
  }, [envName, get, fail]);

  // models for env + dataset
  useEffect(() => {
    if (!envName || !envInfo?.cli) {
      setModels(null);
      return;
    }
    setModels(null);
    get(`/models?env=${encodeURIComponent(envName)}${dsPath ? `&dataset=${encodeURIComponent(dsPath)}` : ''}`, {
      timeoutMs: 180000,
    }).then((r) => {
      setModels(r.models);
      setOtherTypes(r.other_types);
    }, fail);
  }, [envName, envInfo, dsPath, get, fail]);

  const dataset = useMemo(() => (datasets || []).find((d) => d.path === dsPath), [datasets, dsPath]);

  // keep the chosen model's details fresh (status can change with env/dataset)
  useEffect(() => {
    if (!model || !models) return;
    const m = models.find((x) => x.id === model.id);
    if (!m || m.status === 'blocked') {
      setModel(null);
      setCfg(null);
    } else if (m !== model) setModel(m);
  }, [models]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickModel = (m) => {
    setModel(m);
    const d = m.defaults || {};
    setCfg({
      job_name: `${(dataset?.name || 'dataset').slice(0, 40)}_${m.id}_${new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')}`,
      output_dir: '',
      episodes: dataset?.review_counts?.rejected ? 'exclude_rejected' : 'all',
      train: { ...(d.train || {}) },
      policy_params: { ...(d.policy_params || {}) },
      rename_map: { ...(d.rename_map || {}) },
      empty_cameras: d.empty_cameras,
      source: d.source,
      advanced: {},
    });
    get(`/policy-flags?env=${encodeURIComponent(envName)}&policy=${m.id}`, {
      timeoutMs: 120000,
    }).then(
      (r) => setFlags(r.flags),
      () => setFlags([]),
    );
  };

  const fullCfg = useMemo(
    () =>
      cfg && model
        ? {
            ...cfg,
            env: envName,
            dataset_path: dsPath,
            policy: model.id,
            output_dir: cfg.output_dir || null,
            train: { ...cfg.train, lr: Number(cfg.train.lr) },
          }
        : null,
    [cfg, model, envName, dsPath],
  );

  // build the plan whenever the review step is open and the config changes
  useEffect(() => {
    if (step !== 'review' || !fullCfg) return undefined;
    const seq = ++planSeq.current;
    setPlanning(true);
    setAck(false);
    const t = setTimeout(async () => {
      try {
        const p = await post('/plan', { config: fullCfg }, { timeoutMs: 180000 });
        if (seq === planSeq.current) {
          setPlan(p);
          setPlanErr('');
        }
      } catch (e) {
        if (seq === planSeq.current) {
          setPlan(null);
          setPlanErr(e.message);
        }
        if (e instanceof TrainerOffline) setOffline(e.message);
      } finally {
        if (seq === planSeq.current) setPlanning(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [step, fullCfg, post]);

  const start = async () => {
    setStarting(true);
    try {
      const r = await post('/runs', { config: fullCfg, confirm_token: plan.token }, { timeoutMs: 120000 });
      toast.success('Training started');
      dispatch(setTrainingRunId(r.id));
      dispatch(setTrainingDatasetPath(null));
      setRunId(r.id);
      setTab('runs');
      setPlan(null);
      setAck(false);
      loadBase();
    } catch (e) {
      if (e.status === 409) {
        toast.error(e.message);
        setPlan(null);
        setStep('config');
        setTimeout(() => setStep('review'), 0);
      } else fail(e);
    } finally {
      setStarting(false);
    }
  };

  const openRun = (id) => {
    setRunId(id);
    setTab('runs');
  };

  const enqueue = async () => {
    setStarting(true);
    try {
      await post('/queue', { config: fullCfg, confirm_token: plan.token }, { timeoutMs: 120000 });
      toast.success('Added to the queue');
      setTab('queue');
      setPlan(null);
      setAck(false);
    } catch (e) {
      if (e.status === 409) toast.error(e.message);
      else fail(e);
    } finally {
      setStarting(false);
    }
  };

  const can = {
    dataset: true,
    env: !!dsPath,
    model: !!dsPath && !!envInfo?.cli,
    config: !!dsPath && !!model,
    review: !!dsPath && !!model && !!cfg,
  };
  const idx = STEPS.findIndex(([k]) => k === step);
  const next = STEPS[idx + 1];
  const activeRun = (runs || []).find((r) =>
    ['starting', 'copying', 'converting', 'training', 'paused', 'stopping'].includes(r.status),
  );

  const body = {
    dataset: <DatasetStep datasets={datasets} roots={roots} value={dsPath} onPick={(p) => setDsPath(p)} env={envName} />,
    env: (
      <EnvStep
        system={system}
        envs={envs}
        envName={envName}
        setEnvName={setEnvName}
        envInfo={envInfo}
        refresh={() => loadEnvs(true)}
        loading={envLoading}
      />
    ),
    model: <ModelStep models={models} otherTypes={otherTypes} value={model?.id} onPick={pickModel} />,
    config: cfg && <ConfigStep cfg={cfg} setCfg={setCfg} model={model} dataset={dataset} flags={flags} />,
    review: (
      <ReviewStep
        plan={plan}
        planning={planning}
        planErr={planErr}
        ack={ack}
        setAck={setAck}
        onStart={start}
        onQueue={enqueue}
        starting={starting}
        system={system}
        dsPath={dsPath}
        envName={envName}
      />
    ),
  }[step];

  return (
    <div className="h-full overflow-auto scroll-thin">
      <div className="mx-auto max-w-[1760px] px-5 py-4 grid gap-4 grid-cols-[minmax(0,1fr)]">
        {/* hero */}
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div className="orb absolute -top-10 right-24 h-40 w-40 pointer-events-none" aria-hidden />
          <div className="relative">
            <div className="label">05 · Training</div>
            <h1 className="text-[30px] leading-[1.1] font-light tracking-tight mt-0.5 fade-text">Train a policy on this PC</h1>
            <p className="text-[13px] text-ink-3 mt-1 max-w-2xl">
              Uses your recorded datasets and the LeRobot already installed in a local environment. Every command is shown before
              it runs; logs and checkpoints are kept on disk.
            </p>
          </div>
          <div className="relative flex items-center gap-3">
            {typeof Notification !== 'undefined' && Notification.permission === 'default' && (
              <button
                className="btn-ghost btn-sm"
                onClick={() => Notification.requestPermission().then(() => setTab((t) => t))}
                title="Show a desktop notification when a training finishes or fails"
              >
                Enable desktop alerts
              </button>
            )}
            {offline ? (
              <span className="chip-err">service offline</span>
            ) : system ? (
              <span className="chip-ok">service on 127.0.0.1</span>
            ) : (
              <Spinner />
            )}
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: 'new', label: 'New training' },
                {
                  value: 'runs',
                  label: `Runs${runs?.length ? ` (${runs.length})` : ''}`,
                },
                { value: 'queue', label: 'Queue' },
                { value: 'optimize', label: 'Optimize' },
                { value: 'evaluate', label: 'Evaluate' },
                { value: 'compare', label: 'Compare' },
                { value: 'storage', label: 'Storage' },
                { value: 'container', label: 'In container' },
              ]}
            />
          </div>
        </div>

        {tab === 'container' ? (
          <div className="grid gap-3">
            <Callout tone="info">
              The original training panel: trains inside the PHYSIOS robot container with its LeRobot (
              {system?.container_lerobot || '0.2.x'}
              ). Models trained there load directly in Inference.
            </Callout>
            <div className="sheet overflow-hidden min-h-[600px]">
              <TrainingPage isActive />
            </div>
          </div>
        ) : offline ? (
          <Offline
            message={offline}
            onRetry={() => {
              setOffline(null);
              loadBase();
              loadEnvs(false);
            }}
          />
        ) : tab === 'queue' ? (
          <QueuePanel onOpenRun={openRun} />
        ) : tab === 'optimize' ? (
          <OptimizationHome runs={runs} initialRunId={runId} onOpenRun={openRun} />
        ) : tab === 'evaluate' ? (
          <EvaluationPanel initialRunId={runId} />
        ) : tab === 'compare' ? (
          <ComparePanel runs={runs} onOpenRun={openRun} />
        ) : tab === 'storage' ? (
          <StoragePanel />
        ) : tab === 'runs' ? (
          <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
            <div>
              <RunsList runs={runs} current={runId} onOpen={setRunId} />
            </div>
            <div className="min-w-0">
              {runId ? (
                <RunMonitor
                  runId={runId}
                  onNewFrom={(id) => {
                    setRunId(id);
                    loadBase();
                  }}
                />
              ) : (
                <Empty title="Select a run">Pick a run on the left to see its log, metrics and checkpoints.</Empty>
              )}
            </div>
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[230px_minmax(0,1fr)]">
            {/* stepper */}
            <nav className="grid gap-1.5 content-start">
              {STEPS.map(([k, label], i) => (
                <button
                  key={k}
                  data-step={k}
                  disabled={!can[k]}
                  onClick={() => setStep(k)}
                  className={clsx(
                    'flex items-center gap-3 rounded-pill px-3 py-2 text-left text-[13px] transition-all disabled:opacity-40',
                    step === k ? 'bg-ink text-white shadow-lift' : 'hover:bg-white',
                  )}
                >
                  <span
                    className={clsx(
                      'grid place-items-center h-6 w-6 rounded-full num text-[11px]',
                      step === k ? 'bg-white text-ink' : i < idx ? 'bg-signal-okbg text-signal-ok' : 'bg-paper-2 text-ink-3',
                    )}
                  >
                    {i < idx ? '✓' : i + 1}
                  </span>
                  {label}
                </button>
              ))}
              {activeRun && (
                <button
                  className="mt-3 rounded-2xl bg-white shadow-card p-3 text-left"
                  onClick={() => {
                    setRunId(activeRun.id);
                    setTab('runs');
                  }}
                >
                  <div className="label">Running now</div>
                  <div className="text-[13px] font-semibold truncate mt-0.5">{activeRun.job_name}</div>
                  <div className="mt-1">
                    <StatusChip status={activeRun.status} />
                  </div>
                </button>
              )}
              {dataset && (
                <div className="mt-3 rounded-2xl bg-white/60 p-3 text-[11.5px] text-ink-3 grid gap-1">
                  {dataset && (
                    <div className="truncate">
                      <span className="label">Dataset</span>
                      <br />
                      {dataset.id}
                    </div>
                  )}
                  {envName && (
                    <div className="truncate">
                      <span className="label">Env</span>
                      <br />
                      {envName}
                    </div>
                  )}
                  {model && (
                    <div className="truncate">
                      <span className="label">Model</span>
                      <br />
                      {model.name}
                    </div>
                  )}
                </div>
              )}
            </nav>

            <Sheet
              title={STEPS[idx][1]}
              code={`0${idx + 1}`}
              actions={
                next && (
                  <button className="btn-primary btn-sm" disabled={!can[next[0]]} onClick={() => setStep(next[0])} data-next>
                    {next[1]} →
                  </button>
                )
              }
            >
              {body || <Spinner />}
            </Sheet>
          </div>
        )}
      </div>
    </div>
  );
}
