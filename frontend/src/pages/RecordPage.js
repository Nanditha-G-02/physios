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
import { MdKeyboardDoubleArrowLeft, MdKeyboardDoubleArrowRight, MdTask } from 'react-icons/md';
import ControlPanel from '../components/ControlPanel';
import HeartbeatStatus from '../components/HeartbeatStatus';
import InfoPanel from '../components/InfoPanel';
import { addTag } from '../features/tasks/taskSlice';
import { setIsFirstLoadFalse } from '../features/ui/uiSlice';
import { setRecordMode, setSelectedEpisodeId } from '../features/planning/planningSlice';
import { Modal, Segmented, Toggle } from '../components/ui';
import CameraMatchCheck from '../features/camera/CameraMatchCheck';
import EpisodeReviewDialog from '../features/record/EpisodeReviewDialog';
import { useEpisodeReview } from '../features/record/useEpisodeReview';
import RecordViews, { VIEW_OPTIONS } from '../features/record/RecordViews';
import PlanRecordPanel from '../features/record/PlanRecordPanel';
import { usePlanRecording } from '../features/record/usePlanRecording';
import TaskPhase from '../constants/taskPhases';

export default function RecordPage({ isActive = true }) {
  const dispatch = useDispatch();

  const taskInfo = useSelector((state) => state.tasks.taskInfo);
  const taskStatus = useSelector((state) => state.tasks.taskStatus);
  const useMultiTaskMode = useSelector((state) => state.tasks.useMultiTaskMode);
  const multiTaskIndex = useSelector((state) => state.tasks.multiTaskIndex);

  // Toast limit implementation using useToasterStore
  const { toasts } = useToasterStore();
  const TOAST_LIMIT = 3;

  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(false);

  // 2026: plan-driven recording and the three visualisation modes
  const recordMode = useSelector((state) => state.planning.recordMode);
  const planMode = recordMode === 'plan';
  const rec = usePlanRecording(isActive && planMode);
  const running = taskStatus.phase > TaskPhase.READY;

  // 2026: optional review of each saved episode (OFF = unchanged workflow)
  const review = useEpisodeReview(isActive);
  const reviewItem = review.current;
  const decideReview = async (item, status, extra) => {
    try {
      const res = await review.decide(item, status, extra);
      const label = item.episode_id || `Episode ${item.episode_index}`;
      if (status === 'accepted') toast.success(`${label} approved`);
      else if (status === 'rejected') {
        if (res.plan_sync && res.plan_sync.status === 'pending') {
          toast(`${label} rejected — it is back in the plan queue to record again`, { icon: '↺' });
          dispatch(setSelectedEpisodeId(res.plan_sync.episode_id));
        } else {
          toast(`${label} rejected — kept in the dataset as rejected`, { icon: '✕' });
        }
      } else toast(`${label} left for review in Data`, { icon: '…' });
      if (planMode) rec.refresh();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const toggleReview = async (on) => {
    try {
      await review.setEnabled(on);
      toast.success(on ? 'Episode review ON — each saved episode asks for approval' : 'Episode review OFF');
    } catch (e) {
      toast.error(e.message);
    }
  };
  const reviewBlocks = planMode && !!reviewItem;
  const counts = rec.state?.counts;
  const [camOpen, setCamOpen] = useState(false);
  const camCheck = useSelector((s) => s.planning.cameraCheck);
  const planEpisodeInfo =
    planMode && rec.plan && counts
      ? {
          current: counts.done,
          total: counts.total,
          label: 'Plan progress',
          sub: rec.current
            ? `next ${rec.current.id}${counts.failed ? ` · ${counts.failed} failed` : ''}${counts.skipped ? ` · ${counts.skipped} skipped` : ''}`
            : 'all planned episodes done',
        }
      : null;
  const [view, setView] = useState(() => {
    try {
      return window.localStorage.getItem('pam.record.view') || 'original';
    } catch (e) {
      return 'original';
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('pam.record.view', view);
    } catch (e) {
      /* ignore */
    }
  }, [view]);

  const isFirstLoad = useSelector((state) => state.ui.isFirstLoad.record);

  useEffect(() => {
    toasts
      .filter((t) => t.visible) // Only consider visible toasts
      .filter((_, i) => i >= TOAST_LIMIT) // Is toast index over limit?
      .forEach((t) => toast.dismiss(t.id)); // Dismiss – Use toast.remove(t.id) for no exit animation
  }, [toasts]);

  useEffect(() => {
    if (planMode) return; // plan mode sets tags from the plan
    if (isFirstLoad && taskStatus.robotType !== '' && taskInfo.tags.length === 0) {
      dispatch(addTag(taskStatus.robotType));
      dispatch(addTag('robotis'));
    }
    dispatch(setIsFirstLoadFalse('record'));
  }, [taskInfo.tags, taskStatus.robotType, dispatch, isFirstLoad, planMode]);

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


  const classTaskInstructionContainer = clsx(
    'absolute',
    'bottom-1',
    'left-10',
    'w-[40%]',
    'z-30',
    'flex',
    'flex-row',
    'items-center',
    'bg-gradient-to-r',
    'from-green-50/70',
    'to-emerald-50/70',
    'backdrop-blur-xs',
    'rounded-xl',
    'px-4',
    'py-3',
    'shadow-lg',
    'border',
    'border-green-100/50',
    'hover:shadow-xl',
    'hover:from-green-50/80',
    'hover:to-emerald-50/80',
    'transition-all',
    'duration-300',
  );

  const classTaskIcon = clsx('text-green-600', 'text-2xl', 'mr-3', 'flex-shrink-0');

  const classTaskLabel = clsx('text-green-700', 'font-semibold', 'text-lg', 'mr-3', 'flex-shrink-0');

  const classTaskValue = clsx('text-green-800', 'text-lg', 'font-medium', 'flex-1', 'min-w-0', 'whitespace-normal');

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
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 flex flex-wrap items-center justify-center gap-2">
            <Segmented
              size="sm"
              value={recordMode}
              onChange={(m) => !running && dispatch(setRecordMode(m))}
              options={[
                { value: 'plan', label: 'Plan mode', disabled: running && !planMode },
                { value: 'free', label: 'Free recording', disabled: running && planMode },
              ]}
              className="shadow-sm"
            />
            <Segmented size="sm" value={view} onChange={setView} options={VIEW_OPTIONS} className="shadow-sm" />
            <div
              className="flex items-center gap-2 border border-ink bg-white px-2.5 py-1 shadow-sm"
              title="When ON, every saved episode is shown for approval before you continue (plan mode) or in a side panel (free recording)."
            >
              <Toggle
                checked={review.enabled}
                onChange={toggleReview}
                label={<span className="text-[12px]">Review episodes</span>}
                disabled={!review.loaded}
              />
              {review.enabled && review.queue.length > 0 && <span className="chip-warn num">{review.queue.length}</span>}
            </div>
            <button
              className={clsx(
                'rounded-pill px-3 py-1 text-[12px] shadow-sm flex items-center gap-1.5',
                !camCheck
                  ? 'bg-white'
                  : camCheck.level === 'ok'
                    ? 'bg-signal-okbg text-signal-ok'
                    : camCheck.level === 'error'
                      ? 'bg-signal-errbg text-signal-err'
                      : 'bg-signal-warnbg text-signal-warn',
              )}
              onClick={() => setCamOpen(true)}
              disabled={running}
              title="Compare the live cameras with the training data (resolution, fps, brightness, colour, position)"
              data-camera-check-open
            >
              {!camCheck
                ? 'Camera check'
                : camCheck.level === 'ok'
                  ? '✓ Cameras match'
                  : camCheck.level === 'error'
                    ? '✕ Camera mismatch'
                    : '⚠ Check cameras'}
            </button>
          </div>
          <div className={classImageGridContainer} style={{ paddingTop: view === 'original' ? 0 : 56 }}>
            <RecordViews
              view={view}
              isActive={isActive}
              items={planMode && rec.plan ? rec.plan.task.items : []}
              plan={planMode ? rec.plan : null}
              episode={planMode ? rec.current : null}
            />
            {!planMode && useMultiTaskMode && (
              <div className={classTaskInstructionContainer}>
                <div className="flex flex-col">
                  <div className="flex flex-row">
                    <MdTask className={classTaskIcon} />
                    <span className={classTaskLabel}>Current Task</span>
                    {multiTaskIndex !== undefined && (
                      <span className={classTaskLabel}>{`[${multiTaskIndex + 1} / ${taskInfo.taskInstruction.length}]`}</span>
                    )}
                  </div>
                  <span className={classTaskValue}>{taskStatus.currentTaskInstruction}</span>
                </div>
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
            {planMode ? (
              <div className="w-full flex-1 min-h-0 bg-white border-l border-t border-ink">
                <PlanRecordPanel rec={rec} />
              </div>
            ) : (
              <InfoPanel />
            )}
          </div>
        </div>
      </div>
      <ControlPanel
        onStartOverride={planMode ? rec.start : null}
        episodeInfo={planEpisodeInfo}
        startBlockedReason={reviewBlocks ? 'Review the saved episode before the next take.' : ''}
      />
      <Modal open={camOpen} title="Camera match check" onClose={() => setCamOpen(false)} width="max-w-5xl">
        {camOpen && <CameraMatchCheck datasetId={planMode ? rec.state?.dataset?.id : undefined} />}
      </Modal>
      {reviewItem && (
        <EpisodeReviewDialog
          item={reviewItem}
          waiting={review.queue.length}
          onDecide={decideReview}
          docked={!planMode || running}
        />
      )}
    </div>
  );
}
