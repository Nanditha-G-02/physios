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
// 2026: landing page - the RawBot Studio hero (animated arm) and robot selection with live
// connection status. The workflow pages are reached through the sidebar.
// Home keeps its own black-and-white look (heading, canvas, robot panel) inside the app's
// black, white and blue theme; the animated arm (HeroArm) keeps its own colours.
// Dark mode: a deep black canvas with the arm under a soft spotlight, white type and the
// robot panel kept light (theme-light), as in the dark reference design.

import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import HeroArm from '../components/HeroArm';
import { useTheme } from '../components/ThemeToggle';
import { useRosServiceCaller } from '../hooks/useRosServiceCaller';
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

export default function HomePage() {
  const dispatch = useDispatch();
  const robotTypeList = useSelector((state) => state.ui.robotTypeList);
  const robotType = useSelector((state) => state.tasks.taskStatus.robotType);
  const taskStatus = useSelector((state) => state.tasks.taskStatus);
  const heartbeat = useSelector((state) => state.tasks.heartbeatStatus);
  const lastHeartbeat = useSelector((state) => state.tasks.lastHeartbeatTime);
  const linked = useRosLink(1000);
  const { getRobotTypeList, setRobotType } = useRosServiceCaller();

  const [selected, setSelected] = useState('');
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fetchError, setFetchError] = useState('');
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
  const dot = { ok: 'bg-signal-ok', warn: 'bg-signal-warn', err: 'bg-signal-err', sky: 'bg-ink', idle: 'bg-ink-4' };
  const dark = useTheme() === 'dark';

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* light canvas with soft grey ambient light; dark: deep black, a soft spotlight on the
          arm and a faint blue glow behind the robot panel */}
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden
        style={{
          background: dark
            ? 'radial-gradient(520px 420px at 31% 69%, rgba(255,255,255,0.10), rgba(255,255,255,0) 70%),' +
              'radial-gradient(60% 60% at 80% 45%, rgba(36,87,230,0.10), rgba(36,87,230,0) 70%),' +
              'linear-gradient(180deg, #0C1018 0%, #06080D 100%)'
            : 'radial-gradient(48% 55% at 82% 14%, rgba(255,255,255,0.95), rgba(255,255,255,0) 70%),' +
              'radial-gradient(42% 50% at 10% 96%, rgba(11,12,14,0.05), rgba(11,12,14,0) 70%),' +
              'radial-gradient(35% 40% at 40% 60%, rgba(11,12,14,0.025), rgba(11,12,14,0) 70%),' +
              'linear-gradient(180deg, #F8F9FB 0%, #F3F4F7 100%)',
        }}
      />
      {/* barely visible texture: a fine light-grey dot grid that fades out towards the centre */}
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden
        style={{
          backgroundImage: dark
            ? 'radial-gradient(rgba(255,255,255,0.07) 0.8px, transparent 1.1px)'
            : 'radial-gradient(rgba(11,12,14,0.07) 0.8px, transparent 1.1px)',
          backgroundSize: '22px 22px',
          WebkitMaskImage: 'radial-gradient(120% 95% at 50% 50%, transparent 25%, #000 85%)',
          maskImage: 'radial-gradient(120% 95% at 50% 50%, transparent 25%, #000 85%)',
        }}
      />

      <div className="relative h-full overflow-y-auto scroll-thin">
        <div className="mx-auto grid w-full max-w-[1380px] min-h-full items-center gap-x-14 gap-y-8 px-6 py-10 md:px-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,430px)]">
          {/* hero: heading, tagline, animated arm */}
          <div className="min-w-0 animate-rise" style={{ animationDelay: '40ms' }}>
            <h1 className="text-[42px] sm:text-[56px] xl:text-[72px] font-light leading-[0.94] tracking-[-0.04em] text-ink">
              RawBot{' '}
              <span
                className="font-normal bg-clip-text text-transparent"
                style={{
                  backgroundImage: dark
                    ? 'linear-gradient(100deg, #F4F6FA 0%, #B7BDC8 55%, #6E7584 100%)'
                    : 'linear-gradient(100deg, #0B0C0E 0%, #4A4E57 55%, #9B9FA7 100%)',
                }}
              >
                Studio
              </span>
            </h1>
            <p className="mt-5 flex items-center gap-3 text-[15px] md:text-[18px] font-light tracking-[-0.01em] text-ink-2 dark:text-[#A3AAB6]">
              <span className="h-px w-10 shrink-0 bg-gradient-to-r from-ink to-transparent" aria-hidden />
              The Operating System for Physical Intelligence.
            </p>
            {/* dark: the arm's floor fades out at the bottom of the spotlight */}
            <div className="hero-arm relative mt-4 -ml-2 w-full max-w-[860px]">
              <HeroArm className="h-auto w-full" />
            </div>
          </div>

          <div className="lg-stage animate-rise" style={{ animationDelay: '120ms' }}>
          <span className="lg-orb lg-orb-a" aria-hidden />
          <span className="lg-orb lg-orb-b" aria-hidden />
          <span className="lg-orb lg-orb-c" aria-hidden />
          <section className="lg-panel theme-light" aria-label="Robot selection">
            <header className="lg-divider flex items-start justify-between gap-3 px-6 pt-5 pb-4">
              <div>
                <div className="label tracking-[0.12em]">Step 1 of 6</div>
                <h2 className="lg-title mt-1.5 text-[21px] font-semibold tracking-[-0.02em]">Select your robot</h2>
              </div>
              <button
                className="lg-btn lg-btn-sm"
                onClick={fetchRobotTypes}
                disabled={fetching}
                title="Reload robot types from the server"
                aria-label="Reload robot types"
              >
                {fetching ? <Spinner /> : '↻'} Refresh
              </button>
            </header>
            <div className="space-y-4 p-6">
                {fetchError && (
                  <div className="lg-alert">{fetchError}</div>
                )}
                <div
                  className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[268px] overflow-y-auto scroll-thin p-1 -m-1"
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
                        className={clsx('lg-tile group animate-rise', on && 'is-on')}
                        style={{ animationDelay: `${180 + i * 40}ms` }}
                      >
                        <span className="lg-icon">
                          <FamilyGlyph family={fam.key} className="h-7 w-7" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[13px] font-semibold truncate">{t}</span>
                          <span className="lg-sub block text-[11px] truncate">{fam.name}</span>
                        </span>
                        {on && (
                          <span className="lg-check" aria-hidden>
                            ✓
                          </span>
                        )}
                        {active && <span className="lg-chip-active">active</span>}
                      </button>
                    );
                  })}
                  {!robotTypeList.length && (
                    <div className="lg-tile lg-tile-add sm:col-span-2 justify-center p-4 text-[12.5px] lg-sub">
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
                        className="lg-tile group"
                      >
                        <span className="lg-icon">
                          <FamilyGlyph family="generic" className="h-7 w-7" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[13px] font-semibold truncate">{r.name}</span>
                          <span className="lg-sub block text-[11px] truncate">
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
                    className="lg-tile lg-tile-add group"
                  >
                    <span className="lg-plus">+</span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-semibold truncate">Add Custom Robot</span>
                      <span className="lg-sub block text-[11px] truncate">from a URDF / Xacro</span>
                    </span>
                  </button>
                </div>

                <button
                  className={clsx('lg-btn w-full py-3 text-[14px]', confirmed ? 'lg-btn-mint' : 'lg-btn-primary')}
                  onClick={confirm}
                  disabled={!selected || saving || busy}
                  data-action="confirm-robot"
                >
                  {saving ? <Spinner className="border-paper border-t-transparent" /> : null}
                  {confirmed ? `✓ ${robotType} confirmed — re-apply` : selected ? `Confirm ${selected}` : 'Choose a robot above'}
                </button>

                <div className="lg-status">
                  {status.map((s) => (
                    <div key={s.key} className="min-w-0 px-3 py-2.5">
                      <div className="label text-[9.5px] truncate">{s.label}</div>
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className={clsx('lg-dot h-2 w-2 rounded-full shrink-0', dot[s.tone], s.pulse && 'animate-pulsedot')} />
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

                <button className="lg-btn lg-btn-cta w-full py-3 text-[13.5px]" disabled={!robotType} onClick={() => go(PageType.PLANNING)}>
                  Continue to Planning →
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
