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

// What the monitor may do when it sees a critical problem in a LIVE run.
//   off   - nothing
//   flag  - desktop + in-app notification only (default for new users)
//   stop  - also stop the run (SIGINT first; saved checkpoints are kept)
//   auto  - stop, then run comparison trials within a budget
// Stopping a run automatically needs an explicit tick; nothing here moves the robot.

import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTrainer } from '../../hooks/useTrainer';
import { Callout, Field, NumberInput, Segmented } from '../../components/ui';

const HELP = {
  off: 'Not watching this run.',
  flag: 'Tells you when a critical problem (NaN, explosion, out-of-memory) persists for two checks. Does nothing else.',
  stop: 'Also stops the run when a critical problem persists. Its saved checkpoints are kept.',
  auto: 'Stops the run, then runs comparison trials from a checkpoint before the problem, within the budget below.',
};

export default function WatchControl({ runId }) {
  const { get, post } = useTrainer();
  const [mode, setMode] = useState('off');
  const [pick, setPick] = useState('off');
  const [ack, setAck] = useState(false);
  const [s, setS] = useState({ max_trials: 3, gpu_min: 60 });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await get('/optimization/sessions');
      const w = (r.watches || {})[runId];
      setMode(w ? w.mode : 'off');
      setPick(w ? w.mode : 'off');
    } catch (e) {
      /* the panel works without it */
    }
  }, [get, runId]);
  useEffect(() => {
    load();
  }, [load]);

  const apply = async () => {
    setBusy(true);
    try {
      await post(`/runs/${runId}/watch`, {
        mode: pick,
        ack,
        settings: pick === 'auto' ? { max_trials: s.max_trials, gpu_budget_s: Math.round(s.gpu_min * 60) } : undefined,
      });
      toast.success(pick === 'off' ? 'Monitor off' : `Monitor: ${pick}`);
      setMode(pick);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const needsAck = pick === 'stop' || pick === 'auto';
  return (
    <div className="rounded-2xl bg-white shadow-card p-4 grid gap-3" data-watch>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="label">Watch this run</div>
        <Segmented
          size="sm"
          value={pick}
          onChange={(v) => {
            setPick(v);
            setAck(false);
          }}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'flag', label: 'Flag problems' },
            { value: 'stop', label: 'Stop on problem' },
            { value: 'auto', label: 'Stop and try fixes' },
          ]}
        />
        {mode !== 'off' && <span className="chip-sky">active: {mode}</span>}
      </div>
      <p className="text-[12px] text-ink-3">{HELP[pick]}</p>
      {pick === 'auto' && (
        <div className="grid gap-3 md:grid-cols-2 max-w-md">
          <Field label="Most alternatives">
            <NumberInput value={s.max_trials} onChange={(v) => setS({ ...s, max_trials: v })} min={1} max={8} />
          </Field>
          <Field label="GPU time budget (min)">
            <NumberInput value={s.gpu_min} onChange={(v) => setS({ ...s, gpu_min: v })} min={1} />
          </Field>
        </div>
      )}
      {needsAck && (
        <Callout tone="warn">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} data-watch-ack />
            <span>I allow this run to be stopped automatically when a critical problem persists{pick === 'auto' ? ' and comparison trainings to start by themselves within the budget' : ''}.</span>
          </label>
        </Callout>
      )}
      <div>
        <button className="btn-primary btn-sm" disabled={busy || pick === mode || (needsAck && !ack)} onClick={apply} data-watch-apply>
          Apply
        </button>
      </div>
    </div>
  );
}
