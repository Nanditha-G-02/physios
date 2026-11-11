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

import React, { useState, useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import clsx from 'clsx';
import toast, { useToasterStore } from 'react-hot-toast';
import { MdKeyboardDoubleArrowLeft, MdKeyboardDoubleArrowRight } from 'react-icons/md';
import ControlPanel from '../components/ControlPanel';
import HeartbeatStatus from '../components/HeartbeatStatus';
import ImageGrid from '../components/ImageGrid';
import InferencePanel from '../components/InferencePanel';
import { addTag, setTaskInstruction } from '../features/tasks/taskSlice';
import { setIsFirstLoadFalse } from '../features/ui/uiSlice';
import { Segmented } from '../components/ui';
import SimulationView from '../features/record/SimulationView';
import { usePlanningService } from '../hooks/usePlanningService';
import HostRollout from '../features/rollout/HostRollout';

function ContainerInference({ isActive = true }) {
  const dispatch = useDispatch();

  // Toast limit implementation using useToasterStore
  const { toasts } = useToasterStore();
  const TOAST_LIMIT = 3;

  const taskStatus = useSelector((state) => state.tasks.taskStatus);
  const taskInfo = useSelector((state) => state.tasks.taskInfo);

  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(false);

  // 2026: live robot feedback view + instruction from the approved plan
  const [view, setView] = useState('original');
  const [planInstr, setPlanInstr] = useState(null);
  const { call } = usePlanningService();
  useEffect(() => {
    if (!isActive) return;
    call('record.state', {})
      .then((r) => {
        const eps = r.plan?.episodes || [];
        const instr = [...new Set(eps.map((e) => e.instruction))];
        setPlanInstr(instr.length ? { name: r.plan.task.name, instr } : null);
      })
      .catch(() => setPlanInstr(null));
  }, [isActive, call]);

  const isFirstLoad = useSelector((state) => state.ui.isFirstLoad.inference);

  useEffect(() => {
    toasts
      .filter((t) => t.visible) // Only consider visible toasts
      .filter((_, i) => i >= TOAST_LIMIT) // Is toast index over limit?
      .forEach((t) => toast.dismiss(t.id)); // Dismiss – Use toast.remove(t.id) for no exit animation
  }, [toasts]);

  useEffect(() => {
    if (isFirstLoad && taskStatus.robotType !== '' && taskInfo.tags.length === 0) {
      dispatch(addTag(taskStatus.robotType));
      dispatch(addTag('robotis'));
    }
    dispatch(setIsFirstLoadFalse('inference'));
  }, [taskInfo.tags, taskStatus.robotType, dispatch, isFirstLoad]);

  const classMainContainer = 'h-full flex flex-col overflow-hidden';
  const classContentsArea = 'flex-1 flex min-h-0 pt-0 px-0 justify-center items-start';
  const classImageGridContainer = clsx(
    'transition-all',
    'duration-300',
    'ease-in-out',
    'flex',
    'items-center',
    'justify-center',
    'min-h-0',
    'h-full',
    'overflow-hidden',
    'm-2',
    {
      'flex-[12]': isRightPanelCollapsed,
      'flex-[10]': !isRightPanelCollapsed,
    },
  );

  const classRightPanelArea = clsx(
    'h-full',
    'w-full',
    'transition-all',
    'duration-300',
    'ease-in-out',
    'relative',
    'overflow-y-auto',
    {
      'flex-[0_0_40px]': isRightPanelCollapsed,
      'flex-[1]': !isRightPanelCollapsed,
      'min-w-[60px]': isRightPanelCollapsed,
      'min-w-[360px]': !isRightPanelCollapsed,
      'max-w-[60px]': isRightPanelCollapsed,
      'max-w-[360px]': !isRightPanelCollapsed,
    },
  );

  const classHideButton = clsx(
    'absolute',
    'top-3',
    'bg-white',
    'border',
    'border-gray-300',
    'rounded-full',
    'w-12',
    'h-12',
    'flex',
    'items-center',
    'justify-center',
    'shadow-md',
    'hover:bg-gray-50',
    'transition-all',
    'duration-200',
    'z-10',
    {
      'left-2': isRightPanelCollapsed,
      'left-[10px]': !isRightPanelCollapsed,
    },
  );

  const classRightPanel = clsx(
    'h-full',
    'flex',
    'flex-col',
    'items-center',
    'overflow-hidden',
    'transition-opacity',
    'duration-300',
    {
      'opacity-0': isRightPanelCollapsed,
      'opacity-100': !isRightPanelCollapsed,
      'pointer-events-none': isRightPanelCollapsed,
      'pointer-events-auto': !isRightPanelCollapsed,
    },
  );

  // PHYSIOS 1.2: robot type and the heartbeat chip sit side by side at the top left, so the
  // chip no longer covers the label of the Processed / Simulation views below it.
  const classTopLeft = clsx('absolute', 'top-4', 'left-4', 'z-20', 'flex', 'items-center', 'gap-2');
  const classRobotTypeContainer = clsx(
    'flex',
    'flex-row',
    'items-center',
    'bg-white/90',
    'backdrop-blur-sm',
    'rounded-full',
    'px-3',
    'py-1',
    'shadow-md',
    'border',
    'border-gray-100',
  );
  const classRobotType = clsx('ml-1.5 mr-1 my-1 text-ink-3 text-[12.5px]');
  const classRobotTypeValue = clsx('mx-1 my-1 px-2 py-px text-[12.5px] font-medium text-sky-ink focus:outline-none bg-sky-100 rounded-full');


  return (
    <div className={classMainContainer}>
      <div className={classContentsArea}>
        <div className="w-full h-full flex flex-col relative">
          <div className={classTopLeft}>
            <div className={classRobotTypeContainer}>
              <div className={classRobotType}>Robot Type</div>
              <div className={classRobotTypeValue}>{taskStatus?.robotType}</div>
            </div>
            <HeartbeatStatus />
          </div>
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30">
            <Segmented
              size="sm"
              value={view}
              onChange={setView}
              options={[
                { value: 'original', label: 'Cameras' },
                { value: 'simulation', label: 'Live robot view' },
              ]}
            />
          </div>
          <div className={classImageGridContainer} style={{ paddingTop: view === 'original' ? 0 : 56 }}>
            {view === 'original' ? (
              <ImageGrid isActive={isActive} />
            ) : (
              <div className="h-full w-full border border-ink">
                <SimulationView active={isActive} />
              </div>
            )}
          </div>
        </div>
        <div className={classRightPanelArea}>
          <button onClick={() => setIsRightPanelCollapsed(!isRightPanelCollapsed)} className={classHideButton} title="Hide">
            <span className="text-gray-600 text-3xl transition-transform duration-200">
              {isRightPanelCollapsed ? <MdKeyboardDoubleArrowLeft /> : <MdKeyboardDoubleArrowRight />}
            </span>
          </button>
          <div className={classRightPanel}>
            <div className="w-full min-h-10"></div>
            {planInstr && (
              <div className="w-[calc(100%-1.5rem)] mx-3 mb-2 border border-ink bg-white px-3 py-2 text-[12.5px]">
                <div className="label">Instruction from plan · {planInstr.name}</div>
                {planInstr.instr.slice(0, 3).map((t) => (
                  <button
                    key={t}
                    className="block w-full text-left mt-1 hover:bg-paper px-1 py-0.5"
                    onClick={() => dispatch(setTaskInstruction([t]))}
                    title="Use this instruction for inference"
                  >
                    “{t}” <span className="text-sky-ink">use →</span>
                  </button>
                ))}
              </div>
            )}
            <InferencePanel />
          </div>
        </div>
      </div>
      <ControlPanel />
    </div>
  );
}

// Inference session: the original container inference (LeRobot of physical_ai_server)
// and host rollouts of models trained on this PC.
export default function InferencePage({ isActive = true }) {
  const target = useSelector((s) => s.planning.rolloutTarget);
  const [mode, setMode] = useState(() => {
    try {
      return window.localStorage.getItem('pam.inference.mode') || 'container';
    } catch (e) {
      return 'container';
    }
  });
  useEffect(() => {
    if (target) setMode('host');
  }, [target]);
  useEffect(() => {
    try {
      window.localStorage.setItem('pam.inference.mode', mode);
    } catch (e) {
      /* ignore */
    }
  }, [mode]);
  return (
    <div className="h-full w-full flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-4 pt-3">
        <Segmented
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'container', label: 'Container inference' },
            { value: 'host', label: 'Host rollout (trained on this PC)' },
          ]}
        />
      </div>
      <div className="flex-1 min-h-0">{mode === 'host' ? <HostRollout /> : <ContainerInference isActive={isActive} />}</div>
    </div>
  );
}
