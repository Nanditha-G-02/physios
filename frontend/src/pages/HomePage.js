// Copyright 2025 ROBOTIS CO., LTD.
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
//
// Author: Kiwoong Park
// 2026: landing page - robot selection, live status and the workflow at a glance.

import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import background from '../assets/home-background.jpg';
import HeroArm from '../components/HeroArm';
import { useRosServiceCaller } from '../hooks/useRosServiceCaller';
import { usePlanningService } from '../hooks/usePlanningService';
import { useRosLink } from '../hooks/useConnectionMonitor';
import TaskPhase from '../constants/taskPhases';
import PageType from '../constants/pageType';
import { selectRobotType, removeAllTags } from '../features/tasks/taskSlice';
import { setRobotTypeList, setIsFirstLoadTrue, moveToPage, setRobotsView } from '../features/ui/uiSlice';
import { listRobots } from '../features/robots/robotsApi';
import { STAGE_NAMES } from '../features/robots/RobotDetail';
import { Spinner } from '../components/ui';

// Same families as physical_ai_server/planning/profiles.py
const FAMILIES = [
  { re: /(so[-_]?10[01]|s10[01])/i, key: 'so101', name: 'SO-101 arm' },
  { re: /omx/i, key: 'omx', name: 'OpenMANIPULATOR-X' },
  { re: /omy/i, key: 'omy', name: 'OpenMANIPULATOR-Y' },
  { re: /ffw|ai[_-]?worker/i, key: 'ffw', name: 'AI Worker' },
];
function familyOf(type) {
  return FAMILIES.find((f) => f.re.test(type || '')) || { key: 'generic', name: 'Robot' };
}

function FamilyGlyph({ family, className }) {
  const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round' };
  if (family === 'ffw') {
    return (
      <svg viewBox="0 0 40 40" className={className} aria-hidden>
        <rect {...s} x="14" y="6" width="12" height="9" />
        <rect {...s} x="12" y="16" width="16" height="13" />
        <path {...s} d="M12 18l-6 7 2 6M28 18l6 7-2 6M16 29v7M24 29v7" />
      </svg>
    );
  }
  const tall = family === 'omy';
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden>
      <path {...s} d="M8 35h20M11 35l2-5h10l2 5" />
      <path {...s} d={tall ? 'M18 30V18l9-9 6 4' : 'M18 30l-3-12 12-6 4 5'} />
      <circle cx="18" cy={tall ? 18 : 18} r="2.2" fill="currentColor" />
      <path {...s} d={tall ? 'M33 13l2 3M33 13l3-1' : 'M31 17l2 3M31 17l3-1'} />
    </svg>
  );
}

const STEPS = [
  { page: PageType.HOME, code: '01', name: 'Home' },
  { page: PageType.PLANNING, code: '02', name: 'Planning' },
  { page: PageType.RECORD, code: '03', name: 'Record' },
  { page: PageType.DATA, code: '04', name: 'Data' },
  { page: PageType.LOCAL_TRAINING, code: '05', name: 'Training' },
  { page: PageType.INFERENCE, code: '06', name: 'Inference' },
];

export default function HomePage() {
  const dispatch = useDispatch();
  const robotTypeList = useSelector((state) => state.ui.robotTypeList);
  const robotType = useSelector((state) => state.tasks.taskStatus.robotType);
  const taskStatus = useSelector((state) => state.tasks.taskStatus);
  const heartbeat = useSelector((state) => state.tasks.heartbeatStatus);
  const lastHeartbeat = useSelector((state) => state.tasks.lastHeartbeatTime);
  const linked = useRosLink(1000);
  const { getRobotTypeList, setRobotType } = useRosServiceCaller();
  const { call } = usePlanningService();

  const [selected, setSelected] = useState('');
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [glance, setGlance] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [customRobots, setCustomRobots] = useState([]);

  useEffect(() => {
    // custom robots live in the host service; Home works without it
    listRobots()
      .then((r) => setCustomRobots(r.robots || []))
      .catch(() => setCustomRobots([]));
  }, []);
  const openRobots = (view) => {
    dispatch(setRobotsView(view));
    dispatch(moveToPage(PageType.ROBOTS));
  };

  const busy = taskStatus.phase > TaskPhase.READY;

  const fetchRobotTypes = useCallback(async () => {
    setFetching(true);
    setFetchError('');
    try {
      const result = await getRobotTypeList();
      if (result && result.robot_types) {
        dispatch(setRobotTypeList(result.robot_types));
      } else {
        setFetchError('The server returned no robot types.');
      }
    } catch (error) {
      setFetchError(
        /timeout|connection/i.test(error.message)
          ? 'Cannot reach physical_ai_server (rosbridge on port 9090).'
          : error.message
      );
    } finally {
      setFetching(false);
    }
  }, [getRobotTypeList, dispatch]);

  useEffect(() => {
    fetchRobotTypes();
  }, [fetchRobotTypes]);

  // retry automatically when the link comes up after the page loaded
  useEffect(() => {
    if (linked && !robotTypeList.length && !fetching) fetchRobotTypes();
  }, [linked]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (robotType && !selected) setSelected(robotType);
  }, [robotType, selected]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // workflow at a glance (real data; hidden when the planning service is absent)
  const loadGlance = useCallback(async () => {
    try {
      const [plans, data, rec] = await Promise.all([
        call('plan.list', {}),
        call('data.list_datasets', {}),
        call('record.state', {}),
      ]);
      const approved = plans.plans.filter((p) => p.approved_version).length;
      const pending = data.datasets.reduce((a, d) => a + (d.review_counts?.pending || 0), 0);
      const episodes = data.datasets.reduce((a, d) => a + (d.total_episodes || 0), 0);
      setGlance({
        plans: plans.plans.length,
        approved,
        activePlan: rec.plan ? { name: rec.plan.task.name, counts: rec.counts } : null,
        datasets: data.datasets.length,
        episodes,
        pending,
      });
    } catch (e) {
      setGlance(null);
    }
  }, [call]);

  useEffect(() => {
    if (linked) loadGlance();
  }, [linked, robotType, loadGlance]);

  const confirm = async () => {
    if (!selected) return;
    if (busy) {
      toast.error('A task is running - robot type cannot change now.');
      return;
    }
    // A server robot type generated from a custom robot profile (exported at Stage 3) may only
    // be used while that profile is still hardware-verified. Built-in robots are unaffected.
    const custom = customRobots.find((r) => r.id.toLowerCase().replace(/[^a-z0-9_]/g, '_') === selected);
    if (custom && !(custom.state === 'registered' && (custom.stage || 0) >= 3)) {
      toast.error(`${custom.name} is not hardware-verified (Stage 3). Finish its readiness checks first.`, { id: 'custom-gate' });
      return;
    }
    setSaving(true);
    try {
      const result = await setRobotType(selected);
      if (result && result.success) {
        dispatch(selectRobotType(selected));
        dispatch(setIsFirstLoadTrue('record'));
        dispatch(removeAllTags());
        toast.success(`Robot set to ${selected}`);
      } else {
        toast.error(`Could not set robot type: ${(result && result.message) || 'unknown error'}`);
      }
    } catch (error) {
      toast.error(`Could not set robot type: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const go = (page) => {
    if (page !== PageType.HOME && page !== PageType.DATA && !robotType) {
      toast.error('Confirm a robot first.', { id: 'home-guard' });
      return;
    }
    if (page === PageType.DATA && !linked) {
      toast.error('Server is not reachable.', { id: 'home-guard' });
      return;
    }
    dispatch(moveToPage(page));
  };

  const confirmed = robotType && robotType === selected;
  const hbAge = lastHeartbeat ? Math.max(0, Math.round((now - lastHeartbeat) / 1000)) : null;
  const status = [
    {
      key: 'link',
      label: 'Server link',
      tone: linked ? 'ok' : 'err',
      value: linked ? 'open' : 'closed',
      hint: 'rosbridge :9090',
    },
    {
      key: 'hb',
      label: 'Robot server',
      tone: heartbeat === 'connected' ? 'ok' : heartbeat === 'timeout' ? 'warn' : robotType ? 'err' : 'idle',
      value:
        heartbeat === 'connected'
          ? 'alive'
          : heartbeat === 'timeout'
          ? `late ${hbAge}s`
          : robotType
          ? 'no heartbeat'
          : 'waiting',
      hint: heartbeat === 'connected' ? `beat ${hbAge ?? 0}s ago` : 'heartbeat',
      pulse: heartbeat === 'connected',
    },
    {
      key: 'robot',
      label: 'Active robot',
      tone: robotType ? 'sky' : 'idle',
      value: robotType || 'none',
      hint: robotType ? familyOf(robotType).name : 'select below',
    },
  ];
  const dot = { ok: 'bg-signal-ok', warn: 'bg-signal-warn', err: 'bg-signal-err', sky: 'bg-sky-ink', idle: 'bg-ink-4' };

  const stepInfo = (page) => {
    const g = glance;
    switch (page) {
      case PageType.HOME:
        return { state: robotType ? 'done' : 'current', text: robotType ? `robot ${robotType}` : 'select a robot' };
      case PageType.PLANNING:
        return {
          state: !robotType ? 'locked' : g?.approved ? 'done' : 'current',
          text: g ? `${g.plans} plan${g.plans === 1 ? '' : 's'} · ${g.approved} approved` : 'define a collection plan',
        };
      case PageType.RECORD: {
        const c = g?.activePlan?.counts;
        return {
          state: !robotType ? 'locked' : c && c.total && c.done >= c.total ? 'done' : 'open',
          text: c ? `${g.activePlan.name}: ${c.done}/${c.total} episodes` : 'record demonstrations',
          pct: c && c.total ? (c.done / c.total) * 100 : null,
        };
      }
      case PageType.DATA:
        return {
          state: !linked ? 'locked' : 'open',
          text: g ? `${g.datasets} dataset${g.datasets === 1 ? '' : 's'} · ${g.pending} pending review` : 'review & publish',
          badge: g?.pending || 0,
        };
      case PageType.LOCAL_TRAINING:
        return { state: 'open', text: 'train a policy on this PC' };
      default:
        return { state: !robotType ? 'locked' : 'open', text: 'run a trained policy' };
    }
  };

  return (
    <div className="relative h-full w-full overflow-hidden">
      <img
        src={background}
        alt=""
        aria-hidden
        className="absolute inset-0 h-full w-full object-cover select-none pointer-events-none opacity-[0.18] grayscale"
      />
      <div className="absolute inset-0 bg-gradient-to-br from-paper via-paper/95 to-paper/70" />
      <div className="orb absolute -top-24 right-[18%] h-[420px] w-[420px] pointer-events-none animate-drift" aria-hidden />
      <div className="orb absolute bottom-[-160px] left-[8%] h-[360px] w-[360px] pointer-events-none opacity-50" aria-hidden />

      <div className="relative h-full overflow-y-auto scroll-thin">
        <div className="mx-auto w-full max-w-[1320px] min-h-full px-6 md:px-10 py-6 flex flex-col justify-center gap-6">
          {/* hero */}
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)] items-center">
            <div className="animate-rise min-w-0" style={{ animationDelay: '60ms' }}>
              <h1 className="text-[40px] sm:text-[52px] md:text-[66px] font-light tracking-[-0.035em] leading-[0.95] fade-text">
                RawBot Studio
              </h1>
              <p className="mt-4 flex items-center gap-3 text-[15px] md:text-[17px] font-light tracking-[-0.01em] text-ink-2 max-w-[520px]">
                <span className="h-px w-8 shrink-0 bg-gradient-to-r from-sky-ink to-transparent" aria-hidden />
                The Operating System for Physical Intelligence.
              </p>
              <div className="relative mt-7 w-full max-w-[620px]">
                <div className="absolute -inset-3 tick-corners pointer-events-none" />
                <HeroArm className="w-full h-auto" />
              </div>
            </div>

            <section
              className="sheet bg-white/90 backdrop-blur-md animate-rise shadow-lift"
              style={{ animationDelay: '140ms' }}
              aria-label="Robot selection"
            >
              <header className="sheet-head">
                <div>
                  <div className="label">Step 1 of 6</div>
                  <h2 className="sheet-title text-[17px]">Select your robot</h2>
                </div>
                <button
                  className="btn btn-sm"
                  onClick={fetchRobotTypes}
                  disabled={fetching}
                  title="Reload robot types from the server"
                  aria-label="Reload robot types"
                >
                  {fetching ? <Spinner /> : '↻'} Refresh
                </button>
              </header>
              <div className="p-5 space-y-4">
                {fetchError && (
                  <div className="rounded-xl bg-signal-errbg px-3 py-2 text-[12.5px]">{fetchError}</div>
                )}
                <div
                  className="grid grid-cols-2 gap-2 max-h-[248px] overflow-y-auto scroll-thin pr-0.5"
                  role="radiogroup"
                  aria-label="Robot type"
                >
                  {robotTypeList.map((t, i) => {
                    const fam = familyOf(t);
                    const on = selected === t;
                    const active = robotType === t;
                    return (
                      <button
                        key={t}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        data-robot={t}
                        disabled={saving || busy}
                        onClick={() => setSelected(t)}
                        className={clsx(
                          'group relative overflow-hidden text-left rounded-2xl px-3 py-2.5 flex items-center gap-2.5 transition-all duration-200 animate-rise',
                          'hover:-translate-y-[1px] disabled:opacity-60',
                          on ? 'bg-ink text-white shadow-lift' : 'bg-paper hover:bg-paper-2'
                        )}
                        style={{ animationDelay: `${180 + i * 40}ms` }}
                      >
                        <FamilyGlyph family={fam.key} className={clsx('h-9 w-9 shrink-0', on ? 'text-[#9db8ff]' : 'text-ink-2')} />
                        <span className="min-w-0">
                          <span className="block text-[13px] font-semibold truncate">{t}</span>
                          <span className={clsx('block text-[11px] truncate', on ? 'text-white/60' : 'text-ink-3')}>{fam.name}</span>
                        </span>
                        {active && <span className="chip-ok absolute right-1.5 bottom-1.5 text-[9.5px] px-1 py-0">active</span>}
                      </button>
                    );
                  })}
                  {!robotTypeList.length && (
                    <div className="col-span-2 rounded-2xl bg-paper p-4 text-center text-[12.5px] text-ink-3">
                      <span>{fetching ? 'Loading robot types…' : 'No robot types yet'}</span>
                    </div>
                  )}
                  {customRobots.map((r) => {
                    const stage = r.state === 'registered' ? r.stage || 1 : 0;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        data-custom-robot={r.id}
                        onClick={() => openRobots({ mode: 'detail', id: r.id })}
                        title="Custom robot — open its profile (it is set up and verified there)"
                        className="relative text-left rounded-2xl px-3 py-2.5 flex items-center gap-2.5 bg-paper hover:bg-paper-2 transition-all hover:-translate-y-[1px]"
                      >
                        <FamilyGlyph family="generic" className="h-9 w-9 shrink-0 text-ink-3" />
                        <span className="min-w-0">
                          <span className="block text-[13px] font-semibold truncate">{r.name}</span>
                          <span className="block text-[11px] truncate text-ink-3">
                            Custom · {stage ? `Stage ${stage} ${STAGE_NAMES[stage].toLowerCase()}` : 'draft'}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    data-action="add-custom-robot"
                    onClick={() => openRobots({ mode: 'add' })}
                    className="rounded-2xl px-3 py-2.5 flex items-center gap-2.5 border border-dashed border-paper-3 text-ink-2 hover:bg-paper hover:text-ink transition-all"
                  >
                    <span className="h-9 w-9 shrink-0 grid place-items-center rounded-xl bg-paper text-[20px] leading-none">+</span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-semibold truncate">Add Custom Robot</span>
                      <span className="block text-[11px] truncate text-ink-3">from a URDF / Xacro</span>
                    </span>
                  </button>
                </div>

                <button
                  className={clsx('w-full py-2.5 text-[14px]', confirmed ? 'btn' : 'btn-primary')}
                  onClick={confirm}
                  disabled={!selected || saving || busy}
                  data-action="confirm-robot"
                >
                  {saving ? <Spinner className="border-paper border-t-transparent" /> : null}
                  {confirmed ? `✓ ${robotType} confirmed — re-apply` : selected ? `Confirm ${selected}` : 'Choose a robot above'}
                </button>

                <div className="grid grid-cols-3 gap-2">
                  {status.map((s) => (
                    <div key={s.key} className="rounded-2xl bg-paper px-3 py-2 min-w-0">
                      <div className="label text-[9.5px] truncate">{s.label}</div>
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className={clsx('h-2 w-2 rounded-full shrink-0', dot[s.tone], s.pulse && 'animate-pulsedot')} />
                        <span className="text-[12.5px] font-medium truncate" data-status={s.key}>
                          {s.value}
                        </span>
                      </div>
                      <div className="text-[10.5px] text-ink-3 truncate mt-0.5">{s.hint}</div>
                    </div>
                  ))}
                </div>
                {busy && (
                  <p className="text-[12px] text-signal-warn">A task is running — the robot type is locked until it finishes.</p>
                )}

                <button className="btn-sky w-full" disabled={!robotType} onClick={() => go(PageType.PLANNING)}>
                  Continue to Planning →
                </button>
              </div>
            </section>
          </div>

          {/* workflow */}
          <nav className="animate-rise" style={{ animationDelay: '240ms' }} aria-label="Workflow">
            <ol className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
              {STEPS.map((s) => {
                const info = stepInfo(s.page);
                return (
                  <li key={s.page} className="min-w-0">
                    <button
                      type="button"
                      onClick={() => go(s.page)}
                      className={clsx(
                        'group relative w-full h-full text-left rounded-2xl px-4 py-3 transition-all duration-200',
                        'hover:-translate-y-[2px] hover:shadow-lift',
                        info.state === 'current' ? 'bg-ink text-white shadow-lift' : 'bg-white/90 backdrop-blur-sm shadow-card',
                        info.state === 'locked' && 'opacity-60'
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={clsx('font-mono text-[10.5px]', info.state === 'done' ? 'text-signal-ok' : 'text-ink-4')}>
                          {info.state === 'done' ? '✓' : s.code}
                        </span>
                        {info.badge > 0 && <span className="chip-warn num py-0">{info.badge}</span>}
                        {info.state === 'locked' && <span className="label text-[9px]">locked</span>}
                      </div>
                      <div className="text-[14px] font-semibold mt-0.5 flex items-center gap-1">
                        {s.name}
                        <span className="opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all">→</span>
                      </div>
                      <div className={clsx('text-[11.5px] truncate', info.state === 'current' ? 'text-white/60' : 'text-ink-3')}>{info.text}</div>
                      {info.pct != null && (
                        <div className="mt-1.5 h-1 rounded-pill bg-paper-3 overflow-hidden">
                          <div className="h-1 rounded-pill bg-signal-ok transition-all" style={{ width: `${info.pct}%` }} />
                        </div>
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
        </div>
      </div>
    </div>
  );
}
