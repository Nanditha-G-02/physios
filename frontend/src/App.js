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
// 2026: five-session navigation (Home -> Planning -> Record -> Data -> Inference)

import React, { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { Toaster } from 'react-hot-toast';
import toast from 'react-hot-toast';
import { useDispatch, useSelector } from 'react-redux';
import './App.css';
import HomePage from './pages/HomePage';
import PlanningPage from './pages/PlanningPage';
import RecordPage from './pages/RecordPage';
import DataPage from './pages/DataPage';
import InferencePage from './pages/InferencePage';
import TrainingPage from './pages/TrainingPage';
import LocalTrainingPage from './pages/LocalTrainingPage';
import RobotsPage from './pages/RobotsPage';
import { useRosTopicSubscription } from './hooks/useRosTopicSubscription';
import { useHeartbeatMonitor, useRosLink } from './hooks/useConnectionMonitor';
import useTrainerEvents from './hooks/useTrainerEvents';
import rosConnectionManager from './utils/rosConnectionManager';
import { setRosHost } from './features/ros/rosSlice';
import { moveToPage } from './features/ui/uiSlice';
import { setDataTab } from './features/planning/planningSlice';
import PageType from './constants/pageType';
import TaskPhase from './constants/taskPhases';
import { ReactComponent as RawLogo } from './assets/raw-logo.svg';

// v2.2: Training is local training on this PC (physios_trainer). The original in-container
// training page stays reachable from the Training page ("In container" tab).
const SHOW_TRAINING = false;

const NAV = [
  { page: PageType.HOME, code: '01', label: 'Home', needs: null },
  { page: PageType.PLANNING, code: '02', label: 'Planning', needs: 'robot' },
  { page: PageType.RECORD, code: '03', label: 'Record', needs: 'robot' },
  { page: PageType.DATA, code: '04', label: 'Data', needs: 'link' },
  { page: PageType.LOCAL_TRAINING, code: '05', label: 'Training', needs: null },
  { page: PageType.INFERENCE, code: '06', label: 'Inference', needs: 'robot' },
];
// Not a workflow step: the custom robot library (always reachable).
const EXTRA_NAV = [{ page: PageType.ROBOTS, code: 'R', label: 'Robots', needs: null }];

function NavGlyph({ page }) {
  // Small line-drawn glyphs in the drawing style (no icon font).
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 };
  switch (page) {
    case PageType.HOME:
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
          <path {...common} d="M4 11 12 4l8 7v9H4z" />
          <path {...common} d="M10 20v-5h4v5" />
        </svg>
      );
    case PageType.PLANNING:
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
          <rect {...common} x="3.5" y="3.5" width="17" height="17" />
          <path {...common} d="M3.5 9.5h17M9.5 3.5v17" strokeDasharray="2 2" />
          <circle cx="14.5" cy="14.5" r="2" fill="currentColor" />
        </svg>
      );
    case PageType.RECORD:
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
          <rect {...common} x="3" y="6" width="13" height="12" />
          <path {...common} d="m16 10 5-3v10l-5-3" />
          <circle cx="7" cy="10" r="1.3" fill="currentColor" />
        </svg>
      );
    case PageType.DATA:
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
          <ellipse {...common} cx="12" cy="6" rx="7.5" ry="2.5" />
          <path {...common} d="M4.5 6v12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V6" />
          <path {...common} d="M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5" />
        </svg>
      );
    case PageType.LOCAL_TRAINING:
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
          <path {...common} d="M4 19V5M4 19h16" />
          <path {...common} d="m7 15 4-5 3 3 5-7" />
          <circle cx="19" cy="6" r="1.4" fill="currentColor" />
        </svg>
      );
    case PageType.ROBOTS:
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
          <path {...common} d="M5 20h14M8 20v-3h8v3M12 17V11" />
          <circle {...common} cx="12" cy="9" r="2" />
          <path {...common} d="m13.5 7.5 4-3.5 2 2" />
        </svg>
      );
    case PageType.INFERENCE:
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
          <rect {...common} x="6" y="6" width="12" height="12" />
          <rect {...common} x="9.5" y="9.5" width="5" height="5" />
          <path {...common} d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
          <path {...common} d="M4 18 9 12l4 3 7-9" />
        </svg>
      );
  }
}

function App() {
  const dispatch = useDispatch();
  const taskStatus = useSelector((state) => state.tasks.taskStatus);
  const taskInfo = useSelector((state) => state.tasks.taskInfo);
  const trainingTopicReceived = useSelector((state) => state.training.topicReceived);
  const heartbeat = useSelector((state) => state.tasks.heartbeatStatus);
  const page = useSelector((state) => state.ui.currentPage);
  const robotType = useSelector((state) => state.tasks.taskStatus.robotType);
  useTrainerEvents();

  // Set before children mount so their first service calls have a URL (as before).
  const hostSet = useRef(false);
  if (!hostSet.current) {
    hostSet.current = true;
    dispatch(setRosHost(window.location.hostname));
  }

  const isFirstLoad = useRef(true);

  // Subscribe to task status from ROS topic (always active)
  const rosSubscriptionControls = useRosTopicSubscription();
  rosConnectionManager.setOnConnected(rosSubscriptionControls.initializeSubscriptions);
  useHeartbeatMonitor();
  const linked = useRosLink();

  useEffect(() => {
    return () => {
      rosConnectionManager.disconnect();
    };
  }, []);

  // Resume the page of a task that is already running on the server.
  useEffect(() => {
    if (isFirstLoad.current && page === PageType.HOME && taskStatus.topicReceived) {
      if (taskInfo?.taskType === PageType.RECORD) {
        dispatch(moveToPage(PageType.RECORD));
      } else if (taskInfo?.taskType === PageType.INFERENCE) {
        dispatch(moveToPage(PageType.INFERENCE));
      }
      isFirstLoad.current = false;
    } else if (
      SHOW_TRAINING &&
      isFirstLoad.current &&
      page === PageType.HOME &&
      trainingTopicReceived
    ) {
      dispatch(moveToPage(PageType.TRAINING));
      isFirstLoad.current = false;
    }
  }, [page, taskInfo?.taskType, taskStatus.topicReceived, trainingTopicReceived, dispatch]);

  const navigate = (item) => {
    isFirstLoad.current = false;
    const debug = process.env.REACT_APP_DEBUG === 'true';
    const taskRunning = taskStatus && taskStatus.phase > TaskPhase.READY;
    if (!debug && item.needs === 'robot' && !(robotType && robotType.trim())) {
      toast.error('Select and confirm a robot on Home first.', { id: 'nav-guard' });
      return;
    }
    if (!debug && item.needs === 'link' && !linked) {
      toast.error('Server is not reachable (rosbridge). Check that the RawBot Studio robot runtime is running (./start_physios.sh --with-robot).', {
        id: 'nav-guard',
      });
      return;
    }
    if (taskRunning && page === PageType.RECORD && item.page !== PageType.RECORD) {
      toast('Recording keeps running in the background.', { id: 'nav-bg', icon: '●' });
    }
    if (item.page === PageType.EDIT_DATASET) {
      dispatch(setDataTab('tools'));
      dispatch(moveToPage(PageType.DATA));
      return;
    }
    dispatch(moveToPage(item.page));
  };

  // Clean up all image streams when the page changes (unchanged behaviour)
  useEffect(() => {
    return () => {
      const allStreamImgs = document.querySelectorAll('img[src*="/stream"]');
      allStreamImgs.forEach((img) => {
        img.src = '';
        if (img.parentNode) {
          img.parentNode.removeChild(img);
        }
      });
    };
  }, [page]);

  const activeIndex = NAV.findIndex((n) => n.page === page);
  const nav = [
    ...(SHOW_TRAINING ? [...NAV, { page: PageType.TRAINING, code: '··', label: 'Train', needs: 'robot' }] : NAV),
    ...EXTRA_NAV,
  ];

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-paper text-ink bp-grid">
      <aside className="w-[78px] shrink-0 bg-white/85 backdrop-blur border-r border-rule flex flex-col">
        <div className="h-12 flex items-center justify-center">
          <RawLogo className="h-[14px] w-auto text-ink" role="img" aria-label="RawBot Studio" />
        </div>
        <nav className="flex-1 flex flex-col gap-0.5 px-1.5 overflow-y-auto scroll-thin" aria-label="Sessions">
          {nav.map((item, i) => {
            const active = item.page === page;
            const done = activeIndex > -1 && i < activeIndex && i < NAV.length;
            const blocked =
              (item.needs === 'robot' && !robotType) || (item.needs === 'link' && !linked);
            return (
              <button
                key={item.page}
                onClick={() => navigate(item)}
                aria-current={active ? 'page' : undefined}
                title={blocked ? `${item.label} (needs ${item.needs === 'robot' ? 'a robot' : 'the server'})` : item.label}
                className={clsx(
                  'group relative flex flex-col items-center gap-0.5 rounded-xl py-2 transition-all duration-150',
                  active ? 'bg-ink text-white shadow-lift' : 'hover:bg-paper-2',
                  blocked && !active && 'text-ink-4'
                )}
              >
                <span
                  className={clsx(
                    'font-mono text-[9px] leading-none',
                    active ? 'text-white/60' : done ? 'text-signal-ok' : 'text-ink-4'
                  )}
                >
                  {done && !active ? '✓' : item.code}
                </span>
                <NavGlyph page={item.page} />
                <span className="text-[10.5px] font-medium leading-tight">{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="m-1.5 rounded-xl bg-paper px-2.5 py-2 space-y-1">
          <div className="flex items-center gap-1.5" title="rosbridge websocket">
            <span className={clsx('h-1.5 w-1.5 rounded-full', linked ? 'bg-signal-ok' : 'bg-signal-err')} />
            <span className="text-[10px] font-medium text-ink-3">Link</span>
          </div>
          <div className="flex items-center gap-1.5" title="physical_ai_server heartbeat">
            <span
              className={clsx(
                'h-1.5 w-1.5 rounded-full',
                heartbeat === 'connected'
                  ? 'bg-signal-ok animate-pulsedot'
                  : heartbeat === 'timeout'
                  ? 'bg-signal-warn'
                  : 'bg-ink-4'
              )}
            />
            <span className="text-[10px] font-medium text-ink-3">Robot</span>
          </div>
        </div>
      </aside>
      <main className="flex-1 min-w-0 flex flex-col h-screen overflow-hidden">
        {page === PageType.HOME ? (
          <HomePage />
        ) : page === PageType.PLANNING ? (
          <PlanningPage />
        ) : page === PageType.RECORD ? (
          <RecordPage isActive />
        ) : page === PageType.DATA || page === PageType.EDIT_DATASET ? (
          <DataPage />
        ) : page === PageType.LOCAL_TRAINING ? (
          <LocalTrainingPage />
        ) : page === PageType.INFERENCE ? (
          <InferencePage isActive />
        ) : page === PageType.ROBOTS ? (
          <RobotsPage />
        ) : page === PageType.TRAINING ? (
          <TrainingPage isActive />
        ) : (
          <HomePage />
        )}
      </main>
      <Toaster
        position="top-center"
        gutter={8}
        toastOptions={{
          duration: 3000,
          style: {
            background: '#0B0C0E',
            color: '#FFFFFF',
            borderRadius: 999,
            padding: '8px 16px',
            fontSize: '13px',
            maxWidth: '520px',
            wordWrap: 'break-word',
            whiteSpace: 'pre-wrap',
            lineHeight: '1.4',
          },
          success: {
            duration: 3000,
            iconTheme: { primary: '#7FA6FF', secondary: '#0B0C0E' },
          },
          error: {
            duration: 6000,
            style: { background: '#C42B2B', color: '#fff', borderRadius: 16, fontSize: '13px' },
          },
        }}
      />
    </div>
  );
}

export default App;
