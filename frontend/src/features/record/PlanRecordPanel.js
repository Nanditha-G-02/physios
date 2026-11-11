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

// Right-hand panel of Record in plan mode: progress, the current planned
// episode (setup diagram, instruction, scenario), and per-episode controls.

import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import WorkspaceCanvas from '../planning/WorkspaceCanvas';
import { SequenceBuilder, PERTURBATION_LABELS } from '../planning/editors';
import { Callout, Empty, Modal, ProgressBar, TextInput, formatDuration } from '../../components/ui';
import { moveToPage } from '../ui/uiSlice';
import { setDataDatasetId, setDataTab } from '../planning/planningSlice';
import PageType from '../../constants/pageType';
import TaskPhase from '../../constants/taskPhases';

const STATUS_STYLE = {
  pending: 'bg-white',
  recording: 'bg-sky animate-pulsedot',
  recorded: 'bg-sky-100',
  validated: 'bg-signal-ok',
  failed: 'bg-signal-err',
  skipped: 'hatch-ink bg-paper-2',
};

export default function PlanRecordPanel({ rec }) {
  const dispatch = useDispatch();
  const phase = useSelector((s) => s.tasks.taskStatus.phase);
  const robotType = useSelector((s) => s.tasks.taskStatus.robotType);
  const { state, plan, episodes, progress, current, activeTake, error, loading, select } = rec;
  const [skipOpen, setSkipOpen] = useState(false);
  const [reason, setReason] = useState('');

  // When a take ends: report the result and move to the next planned episode.
  const lastTake = useRef(null);
  useEffect(() => {
    if (activeTake) {
      lastTake.current = activeTake.episode_id;
      return;
    }
    const eid = lastTake.current;
    if (!eid) return;
    const st = progress[eid]?.status;
    if (st === 'recording') return; // not closed yet
    lastTake.current = null;
    if (st === 'validated') {
      toast.success(`${eid} saved and validated`);
      if (state?.next_episode_id) select(state.next_episode_id);
    } else if (st === 'failed') {
      toast.error(`${eid} was saved but failed the file checks — see details`);
      select(eid);
    } else {
      toast(`${eid} was not saved — record it again when ready`, { icon: '!' });
      select(eid);
    }
  }, [activeTake, progress, state, select]);

  if (error) {
    return (
      <div className="p-4">
        <Callout tone="err" title="Plan service unavailable">
          {error}
        </Callout>
      </div>
    );
  }
  if (!plan) {
    return (
      <div className="p-4">
        <Empty
          title={loading ? 'Loading plan…' : 'No approved plan selected'}
          action={
            !loading && (
              <button className="btn-primary" onClick={() => dispatch(moveToPage(PageType.PLANNING))}>
                Open Planning
              </button>
            )
          }
        >
          {state?.message || 'Approve a collection plan in Planning; Record then follows it episode by episode.'}
        </Empty>
      </div>
    );
  }

  const counts = state.counts || {};
  const idx = current ? episodes.findIndex((e) => e.id === current.id) : -1;
  const st = current ? progress[current.id] || { status: 'pending', attempts: [] } : null;
  const running = phase > TaskPhase.READY;
  const robotMismatch = robotType && robotType !== plan.task.robot_type;
  const ds = state.dataset || {};
  const lastAttempt = st?.attempts?.[st.attempts.length - 1];
  const validation = st?.validation || lastAttempt?.validation;

  return (
    <div className="h-full flex flex-col min-h-0 text-[13px]">
      {/* plan header */}
      <div className="px-4 pt-4 pb-3 border-b border-rule">
        <div className="flex items-center justify-between gap-2">
          <span className="label">Approved plan · v{plan.version}</span>
          <span className="chip">{plan.strategy.type.replace('_', '-')}</span>
        </div>
        <div className="font-semibold text-[15px] mt-0.5 truncate">{plan.task.name}</div>
        <div className="num text-[11.5px] text-ink-3 truncate" title={ds.path}>
          {ds.id} · {ds.integrity === 'missing' ? 'new dataset' : `${ds.total_episodes} ep on disk`}
        </div>
        {state.working_status === 'draft' && (
          <div className="text-[11.5px] text-sky-ink mt-1">A newer draft (v{state.working_version}) exists — still recording v{plan.version}.</div>
        )}
        <div className="mt-3 grid grid-cols-4 gap-1 text-center">
          {[
            ['Done', counts.done, 'text-signal-ok'],
            ['Left', counts.remaining, ''],
            ['Failed', counts.failed, counts.failed ? 'text-signal-err' : ''],
            ['Skipped', counts.skipped, ''],
          ].map(([l, v, c]) => (
            <div key={l} className="rounded-xl bg-paper py-1.5">
              <div className={clsx('num text-[16px]', c)}>{v ?? 0}</div>
              <div className="label text-[9.5px]">{l}</div>
            </div>
          ))}
        </div>
        <ProgressBar className="mt-2" value={counts.done || 0} total={counts.total || 1} tone="ok" showText />
        <div className="text-[11.5px] text-ink-3 mt-1">Recorded time {formatDuration(counts.recorded_duration_s)}</div>
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin">
        {/* episode strip */}
        <div className="px-4 py-3 border-b border-rule">
          <div className="label mb-1.5">Episodes</div>
          <div className="flex flex-wrap gap-[3px]" role="list">
            {episodes.map((e) => {
              const s = progress[e.id]?.status || 'pending';
              return (
                <button
                  key={e.id}
                  role="listitem"
                  title={`${e.order}. ${e.id} — ${s}`}
                  disabled={running}
                  onClick={() => select(e.id)}
                  className={clsx(
                    'h-4 w-4 rounded-[5px] border',
                    STATUS_STYLE[s],
                    current?.id === e.id ? 'border-ink ring-2 ring-sky ring-offset-1' : 'border-ink/50'
                  )}
                />
              );
            })}
          </div>
        </div>

        {current && (
          <div className="px-4 py-3 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="label">Episode</div>
                <div className="num text-[22px] leading-none mt-1">
                  {idx + 1}
                  <span className="text-ink-4 text-[15px]"> / {episodes.length}</span>
                </div>
              </div>
              <div className="flex gap-1">
                <button className="btn btn-sm" disabled={running || idx <= 0} onClick={() => select(episodes[idx - 1].id)}>
                  ←
                </button>
                <button
                  className="btn btn-sm"
                  disabled={running || idx >= episodes.length - 1}
                  onClick={() => select(episodes[idx + 1].id)}
                >
                  →
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <span className="chip num">{current.id}</span>
              <span
                className={
                  st.status === 'validated' ? 'chip-ok' : st.status === 'failed' ? 'chip-err' : st.status === 'recording' ? 'chip-sky' : 'chip'
                }
              >
                {st.status}
              </span>
              <span className={current.scenario?.kind === 'success' ? 'chip' : 'chip-warn'}>{current.scenario?.name}</span>
              {current.demo_type && current.demo_type !== 'standard' && <span className="chip">{current.demo_type}</span>}
            </div>

            <div className="rounded-2xl bg-sky-50 px-3 py-2.5">
              <div className="label">Instruction (recorded with the episode)</div>
              <div className="text-[14px] font-medium mt-0.5">“{current.instruction}”</div>
            </div>

            {(current.operator_notes || (current.scenario?.perturbation && current.scenario.perturbation !== 'none')) && (
              <Callout tone="warn" title={PERTURBATION_LABELS[current.scenario?.perturbation] || 'Operator notes'}>
                {current.operator_notes}
              </Callout>
            )}

            <div>
              <div className="label mb-1">Set up before Start</div>
              <WorkspaceCanvas
                workspace={plan.task.workspace}
                regions={plan.task.regions}
                items={plan.task.items}
                placements={current.placements}
                height={220}
              />
              <table className="w-full text-[12px] mt-1">
                <tbody>
                  {current.placements.map((p) => {
                    const it = plan.task.items.find((i) => i.id === p.item_id);
                    return (
                      <tr key={p.item_id} className="border-t border-rule">
                        <td className="py-1 pr-2">{it?.name}</td>
                        <td className="py-1 pr-2">
                          <span className="chip">{p.region || '–'}</span>
                        </td>
                        <td className="py-1 num text-right">
                          x {Math.round(p.x_mm)} · y {Math.round(p.y_mm)} · {p.yaw_deg || 0}°
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {current.sequence?.length > 0 && (
              <div>
                <div className="label mb-1">Sequence</div>
                <SequenceBuilder steps={current.sequence} items={plan.task.items} compact disabled onChange={() => {}} />
              </div>
            )}

            {validation && (
              <div className={clsx('rounded-xl px-3 py-2 text-[12px]', validation.ok ? 'bg-signal-okbg' : 'bg-signal-errbg')}>
                <div className="font-semibold">
                  {validation.ok ? 'Last take valid' : 'Last take failed checks'}
                  {st.dataset_episode_index != null && <span className="num font-normal"> · dataset episode {st.dataset_episode_index}</span>}
                </div>
                {(validation.problems || []).map((p) => (
                  <div key={p}>✕ {p}</div>
                ))}
                {(validation.warnings || []).map((p) => (
                  <div key={p} className="text-signal-warn">! {p}</div>
                ))}
                {validation.duration_s != null && <div className="num text-ink-3">{validation.frames} frames · {validation.duration_s} s</div>}
              </div>
            )}
            {lastAttempt && lastAttempt.result !== 'saved' && (
              <div className="text-[12px] text-ink-3">
                Last attempt: {lastAttempt.result.replace('_', ' ')} ({new Date(lastAttempt.ended_at).toLocaleTimeString()})
              </div>
            )}
            {st.skipped_reason && <div className="text-[12px] text-ink-3">Skipped: {st.skipped_reason}</div>}

            {robotMismatch && (
              <Callout tone="err" title="Robot type mismatch">
                Plan is for {plan.task.robot_type}; the server is set to {robotType}.
              </Callout>
            )}
            {ds.integrity === 'incomplete' && (
              <Callout tone="err" title="Dataset folder incomplete">
                {ds.path} is missing {ds.missing?.join(', ')}. Recording is blocked so the recorder does not delete it.
              </Callout>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              {st.status === 'skipped' ? (
                <button className="btn btn-sm" disabled={running} onClick={() => rec.restore(current.id).catch((e) => toast.error(e.message))}>
                  Restore episode
                </button>
              ) : (
                st.status !== 'validated' && (
                  <button className="btn btn-sm" disabled={running || !!activeTake} onClick={() => setSkipOpen(true)}>
                    Skip…
                  </button>
                )
              )}
              {st.status === 'validated' && (
                <span className="text-[12px] text-ink-3 self-center">Start again to record a retake (kept as a new dataset episode).</span>
              )}
              <button
                className="btn btn-sm ml-auto"
                onClick={() => {
                  dispatch(setDataDatasetId(ds.id));
                  dispatch(setDataTab('episodes'));
                  dispatch(moveToPage(PageType.DATA));
                }}
                disabled={ds.integrity !== 'complete'}
              >
                Review in Data →
              </button>
            </div>
          </div>
        )}
      </div>

      <Modal
        open={skipOpen}
        title={`Skip ${current?.id}?`}
        onClose={() => setSkipOpen(false)}
        footer={
          <>
            <button className="btn" onClick={() => setSkipOpen(false)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={!reason.trim()}
              onClick={async () => {
                try {
                  await rec.skip(current.id, reason);
                  setSkipOpen(false);
                  setReason('');
                  toast.success(`${current.id} skipped`);
                } catch (e) {
                  toast.error(e.message);
                }
              }}
            >
              Skip episode
            </button>
          </>
        }
      >
        <p className="text-[12.5px] text-ink-3 mb-2">The reason is stored in the plan's collection metadata.</p>
        <TextInput value={reason} onChange={setReason} placeholder="e.g. target position blocked by camera mount" autoFocus />
      </Modal>
    </div>
  );
}
