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

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSelector } from 'react-redux';
import clsx from 'clsx';
import toast, { useToasterStore } from 'react-hot-toast';
import { MdPlayArrow, MdStop, MdReplay, MdSkipNext, MdCheck, MdNavigateNext } from 'react-icons/md';
import { useRosServiceCaller } from '../hooks/useRosServiceCaller';
import SystemStatus from './SystemStatus';
import Tooltip from './Tooltip';
import PageType from '../constants/pageType';
import TaskPhase from '../constants/taskPhases';
import FullTaskStatus from './FullTaskStatus';

const requiredFieldsForRecord = [
  { key: 'taskName', label: 'Task Name' },
  { key: 'taskInstruction', label: 'Task Instruction' },
  { key: 'userId', label: 'User ID' },
  { key: 'fps', label: 'FPS' },
  { key: 'warmupTime', label: 'Warmup Time' },
  { key: 'episodeTime', label: 'Episode Time' },
  { key: 'resetTime', label: 'Reset Time' },
  { key: 'numEpisodes', label: 'Num Episodes' },
];

const requiredFieldsForRecordInferenceMode = [
  { key: 'taskName', label: 'Task Name' },
  { key: 'taskInstruction', label: 'Task Instruction' },
  { key: 'policyPath', label: 'Policy Path' },
  { key: 'userId', label: 'User ID' },
  { key: 'fps', label: 'FPS' },
  { key: 'warmupTime', label: 'Warmup Time' },
  { key: 'episodeTime', label: 'Episode Time' },
  { key: 'resetTime', label: 'Reset Time' },
  { key: 'numEpisodes', label: 'Num Episodes' },
];

const requiredFieldsForInferenceOnly = [
  { key: 'taskInstruction', label: 'Task Instruction' },
  { key: 'policyPath', label: 'Policy Path' },
];

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];

export default function ControlPanel({
  onStartOverride = null,
  // optional overrides used by Record plan mode (2026 redesign)
  episodeInfo = null, // { current, total, label, sub }
  startBlockedReason = '', // e.g. an episode is waiting for review
} = {}) {
  const taskInfo = useSelector((state) => state.tasks.taskInfo);
  const taskStatus = useSelector((state) => state.tasks.taskStatus);
  const rosHost = useSelector((state) => state.ros.rosHost);
  const page = useSelector((state) => state.ui.currentPage);
  const useMultiTaskMode = useSelector((state) => state.tasks.useMultiTaskMode);

  const [hovered, setHovered] = useState(null);
  const [pressed, setPressed] = useState(null);
  const [started, setStarted] = useState(false);
  const [expandedSystemIndex, setExpandedSystemIndex] = useState(null);
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  const startedRef = useRef(started);

  const buttons = [
    {
      label: 'Start',
      icon: MdPlayArrow,
      color: '#1976d2',
      description: page === PageType.RECORD ? 'Start recording task' : 'Start inference',
      shortcut: 'Space',
    },
    {
      label: 'Stop',
      icon: MdStop,
      color: '#d32f2f',
      description:
        page === PageType.RECORD
          ? useMultiTaskMode
            ? 'Stop current task'
            : 'Stop and save current episode'
          : '',
      shortcut: 'Space',
    },
    {
      label: 'Skip\nTask',
      icon: MdNavigateNext,
      color: '#388e3c',
      description: page === PageType.RECORD ? 'Skip current task' : '',
      shortcut: 'Ctrl+Shift+N',
    },
    {
      label: 'Retry',
      icon: MdReplay,
      color: '#fbc02d',
      description:
        page === PageType.RECORD
          ? useMultiTaskMode
            ? 'Retry current task'
            : 'Retry current episode'
          : '',
      shortcut: '←',
    },
    {
      label: 'Next',
      icon: MdSkipNext,
      color: '#388e3c',
      description:
        page === PageType.RECORD
          ? useMultiTaskMode
            ? 'Move to next task'
            : 'Move to next episode'
          : '',
      shortcut: '→',
    },
    {
      label: 'Finish',
      icon: MdCheck,
      color: '#388e3c',
      description:
        page === PageType.RECORD
          ? useMultiTaskMode
            ? 'Finish and save'
            : 'Finish and save task'
          : 'Finish inference',
      shortcut: 'Ctrl+Shift+X',
    },
  ];

  const buttonEnabled = {
    Start: true,
    Stop: true,
    Retry: true,
    Next: true,
    Finish: true,
    'Skip\nTask': useMultiTaskMode && page === PageType.RECORD,
  };

  const { sendRecordCommand } = useRosServiceCaller();

  const { toasts } = useToasterStore();
  const TOAST_LIMIT = 3;

  useEffect(() => {
    toasts
      .filter((t) => t.visible) // Only consider visible toasts
      .filter((_, i) => i >= TOAST_LIMIT) // Is toast index over limit?
      .forEach((t) => toast.dismiss(t.id)); // Dismiss – Use toast.remove(t.id) for no exit animation
  }, [toasts]);

  useEffect(() => {
    startedRef.current = started;
  }, [started]);

  // Spinner animation effect - update whenever taskStatus changes (ROS topic received)
  useEffect(() => {
    // Update spinner index whenever taskStatus changes (regardless of phase)
    updateSpinnerFrame();
  }, [taskStatus]);

  const isReadyState = (phase) => {
    return phase === TaskPhase.READY;
  };

  const updateSpinnerFrame = () => {
    setSpinnerIndex((prevIndex) => (prevIndex + 1) % spinnerFrames.length);
  };

  // Check if button should be enabled based on phase
  const isButtonEnabled = useCallback(
    (label) => {
      if (taskStatus.running) {
        if (page === PageType.RECORD) {
          if (taskInfo?.taskType !== 'record' && taskInfo?.taskType !== '') {
            return false;
          } // disable buttons in Record page when inference task is running
        } else if (page === PageType.INFERENCE) {
          if (taskInfo?.taskType !== 'inference' && taskInfo?.taskType !== '') {
            return false;
          } // disable buttons in Inference page when record task is running
        }
      }

      const isRecordTaskType = taskInfo?.taskType === 'record';
      const isInferenceTaskType = taskInfo?.taskType === 'inference';

      switch (label) {
        case 'Start':
          // Start button disabled when task is running or when running flag is true
          if (startBlockedReason) return false;
          return !taskStatus.running;
        case 'Stop':
          if (isInferenceTaskType) {
            return taskStatus.running && taskInfo.recordInferenceMode;
          }
          // Stop button enabled only when task is running
          return taskStatus.running;
        case 'Retry':
          if (isRecordTaskType && useMultiTaskMode) {
            return taskStatus.running;
          }

          if (isInferenceTaskType) {
            return !isReadyState(taskStatus.phase) && taskInfo.recordInferenceMode;
          }
          // Retry button enabled only when task is stopped
          return !isReadyState(taskStatus.phase);
        case 'Next':
          if (isRecordTaskType && useMultiTaskMode) {
            return taskStatus.running;
          }

          if (isInferenceTaskType) {
            return !isReadyState(taskStatus.phase) && taskInfo.recordInferenceMode;
          }
          // Next button enabled only when task is stopped
          return !isReadyState(taskStatus.phase);
        case 'Skip\nTask':
          if (page === PageType.RECORD) {
            return !isReadyState(taskStatus.phase) && taskStatus.running;
          }
          return false;
        case 'Finish':
          // Finish button enabled only when task is stopped
          return true; // Always enabled
        default:
          return false;
      }
    },
    [
      taskStatus.phase,
      taskStatus.running,
      taskInfo.recordInferenceMode,
      taskInfo.taskType,
      page,
      useMultiTaskMode,
      startBlockedReason,
    ]
  );

  const validateTaskInfo = useCallback(() => {
    const requiredFields =
      page === PageType.RECORD
        ? requiredFieldsForRecord
        : page === PageType.INFERENCE
        ? taskInfo.recordInferenceMode
          ? requiredFieldsForRecordInferenceMode
          : requiredFieldsForInferenceOnly
        : requiredFieldsForInferenceOnly;

    const missingFields = [];

    for (const field of requiredFields) {
      const value = taskInfo[field.key];

      // Check if field is empty or invalid
      if (
        value === null ||
        value === undefined ||
        value === '' ||
        (typeof value === 'string' && value.trim() === '') ||
        (typeof value === 'number' && (isNaN(value) || value <= 0)) ||
        (Array.isArray(value) && value.length === 0) ||
        (Array.isArray(value) && value.every((item) => item.trim() === ''))
      ) {
        missingFields.push(field.label);
      }
    }

    if (taskInfo.userId === 'Select User ID') {
      missingFields.push('User ID');
    }

    return {
      isValid: missingFields.length === 0,
      missingFields,
    };
  }, [taskInfo, page]);

  const handleControlCommand = useCallback(
    async (cmd) => {
      console.log('Control command received:', cmd);
      let result;

      try {
        // Execute the appropriate command
        if (cmd === 'Start') {
          // Validate info before starting
          const validation = validateTaskInfo();
          if (!validation.isValid) {
            toast.error(`Missing required fields: ${validation.missingFields.join(', ')}`);
            console.error('Validation failed. Missing fields:', validation.missingFields);
            return;
          }
          if (page === PageType.RECORD) {
            // Plan mode supplies its own start (approved plan episode -> START_RECORD)
            result = onStartOverride
              ? await onStartOverride()
              : await sendRecordCommand('start_record');
          } else if (page === PageType.INFERENCE) {
            result = await sendRecordCommand('start_inference');
          } else {
            console.warn(`Unknown page: ${page}`);
            toast.error(`Unknown page: ${page}`);
            return;
          }
        } else if (cmd === 'Stop') {
          result = await sendRecordCommand('stop');
        } else if (cmd === 'Retry') {
          result = await sendRecordCommand('rerecord');
        } else if (cmd === 'Next') {
          result = await sendRecordCommand('next');
        } else if (cmd === 'Skip\nTask') {
          result = await sendRecordCommand('skip_task');
        } else if (cmd === 'Finish') {
          result = await sendRecordCommand('finish');
        } else {
          console.warn(`Unknown command: ${cmd}`);
          toast.error(`Unknown command: ${cmd}`);
          return;
        }

        console.log('Service call result:', result);

        // Handle service response
        if (result && result.success === false) {
          toast.error(`Command failed: ${result.message || 'Unknown error'}`);
          console.error(`Command '${cmd}' failed:`, result.message);
        } else if (result && result.success === true) {
          toast.success(`Command [${cmd}] executed successfully`);
          console.log(`Command '${cmd}' executed successfully`);

          // Task status will be updated automatically from ROS
        } else {
          // Handle case where result is undefined or doesn't have success field
          console.warn(`Unexpected result format for command '${cmd}':`, result);
          toast.error(`Command [${cmd}] completed with uncertain status`);
        }
      } catch (error) {
        console.error('Error handling control command:', error);

        // Show more specific error messages
        let errorMessage = error.message || error.toString();
        if (
          errorMessage.includes('ROS connection failed') ||
          errorMessage.includes('ROS connection timeout') ||
          errorMessage.includes('WebSocket')
        ) {
          toast.error(`🔌 ROS connection failed: rosbridge server is not running (${rosHost})`);
        } else if (errorMessage.includes('timeout')) {
          toast.error(`⏰ Command execution timeout [${cmd}]: Server did not respond`);
        } else {
          toast.error(`❌ Command execution failed [${cmd}]: ${errorMessage}`);
        }

        // Continue execution even after error - don't block UI
        console.log(`Continuing after error in command '${cmd}'`);
      }
    },
    [sendRecordCommand, validateTaskInfo, page, rosHost, onStartOverride]
  );

  const handleCommand = useCallback(
    (label) => {
      handleControlCommand(label);
      console.log(label + ' command executed');
      if (label === 'Start') setStarted(true);
      if (label === 'Stop' || label === 'Finish') setStarted(false);
    },
    [handleControlCommand]
  );

  // Helper function to get button label from keyboard event
  const getButtonFromKey = useCallback(
    (e) => {
      if (e.key === 'ArrowLeft' && isButtonEnabled('Retry')) {
        return 'Retry';
      } else if (e.key === 'ArrowRight' && isButtonEnabled('Next')) {
        return 'Next';
      } else if (e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space') {
        if (isButtonEnabled('Start')) {
          return 'Start';
        } else if (isButtonEnabled('Stop')) {
          return 'Stop';
        }
      } else if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        (e.key === 'x' || e.key === 'X') &&
        isButtonEnabled('Finish')
      ) {
        return 'Finish';
      }
      return null;
    },
    [isButtonEnabled]
  );

  // Add keyboard press visual feedback
  const handleKeyboardPress = useCallback((buttonLabel) => {
    if (buttonLabel) {
      setPressed(buttonLabel);
    }
  }, []);

  // Add keyboard release visual feedback
  const handleKeyboardRelease = useCallback(() => {
    setPressed(null);
  }, []);

  useEffect(() => {
    const isInputFocused = () => {
      const activeElement = document.activeElement;
      if (!activeElement) return false;

      const tagName = activeElement.tagName.toLowerCase();
      const isEditable = activeElement.contentEditable === 'true';

      return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || isEditable;
    };

    const handleKeyDown = (e) => {
      // Ignore repeated keydown events when holding the key
      if (e.repeat) return;

      // Ignore keyboard shortcuts when user is typing in input fields
      if (isInputFocused()) return;

      const buttonLabel = getButtonFromKey(e);
      if (buttonLabel) {
        handleKeyboardPress(buttonLabel);
      }
    };

    const handleKeyUp = (e) => {
      // Always release pressed state on keyup
      handleKeyboardRelease();

      // Ignore keyboard shortcuts when user is typing in input fields
      if (isInputFocused()) return;

      // Get the button label and execute the command
      const buttonLabel = getButtonFromKey(e);
      if (buttonLabel) {
        handleCommand(buttonLabel);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [
    handleCommand,
    isButtonEnabled,
    getButtonFromKey,
    handleKeyboardPress,
    handleKeyboardRelease,
  ]);

  // ---------------------------------------------------------------------------
  // 2026 redesign: Blueprint control bar. All command logic above is unchanged.
  // ---------------------------------------------------------------------------
  const handleButtonKeyUp = (e, label, isDisabled) => {
    if (isDisabled) return;
    if (e.key === 'Enter') {
      handleCommand(label);
    }
  };

  const handleButtonKeyDown = (e, label, isDisabled) => {
    if (isDisabled) return;
    if (e.key === ' ') {
      e.preventDefault(); // Prevent scrolling
    }
  };

  const phase = PHASE_STYLE[taskStatus.phase] || PHASE_STYLE[TaskPhase.READY];
  const guide =
    taskStatus.phase === TaskPhase.READY && startBlockedReason
      ? startBlockedReason
      : phase.guide[page === PageType.INFERENCE ? 'inference' : 'record'];
  const progress = Math.max(0, Math.min(100, Number(taskStatus.progress) || 0));
  const saving = taskStatus.phase === TaskPhase.SAVING;
  const ep = episodeInfo || {
    current: taskStatus.currentEpisodeNumber,
    total: useMultiTaskMode ? null : taskInfo.numEpisodes,
    label: useMultiTaskMode ? 'Episodes recorded' : 'Episode',
    sub: useMultiTaskMode ? `Scenario ${taskStatus.currentScenarioNumber || 0}` : 'this session',
  };
  const epPct = ep.total ? Math.min(100, (ep.current / ep.total) * 100) : 0;
  const meters = [
    { key: 'cpu', label: 'CPU', pct: Number(taskStatus.usedCpu) || 0, text: `${Math.round(Number(taskStatus.usedCpu) || 0)}%` },
    {
      key: 'ram',
      label: 'RAM',
      pct: taskStatus.totalRamSize ? (taskStatus.usedRamSize / taskStatus.totalRamSize) * 100 : 0,
      text: `${(Number(taskStatus.usedRamSize) || 0).toFixed(1)} / ${(Number(taskStatus.totalRamSize) || 0).toFixed(0)} GB`,
    },
    {
      key: 'storage',
      label: 'Disk',
      pct: taskStatus.totalStorageSize ? (taskStatus.usedStorageSize / taskStatus.totalStorageSize) * 100 : 0,
      text: `${Math.round(Number(taskStatus.usedStorageSize) || 0)} / ${Math.round(Number(taskStatus.totalStorageSize) || 0)} GB`,
    },
  ];

  return (
    <div
      className="relative mx-4 mb-3 mt-1 rounded-card bg-white shadow-lift flex flex-wrap 2xl:flex-nowrap items-stretch text-ink"
      role="region"
      aria-label="Recording controls"
    >
      {/* transport */}
      <div className="flex-[1.5] min-w-[440px] grid grid-flow-col auto-cols-fr gap-2 p-3">
        {buttons.map(({ label, icon: Icon, description, shortcut }) => {
          if (!buttonEnabled[label]) return null;
          const isDisabled = !isButtonEnabled(label);
          const variant = BUTTON_VARIANT[label] || 'neutral';
          const isPressed = pressed === label && !isDisabled;
          return (
            <Tooltip
              key={label}
              content={
                <div className="text-center text-[13px]">
                  <div className="font-semibold">{description || label.replace('\n', ' ')}</div>
                  {isDisabled ? (
                    <div className="text-[11px] mt-0.5 opacity-70">
                      {label === 'Start' && startBlockedReason ? startBlockedReason : 'Not available now'}
                    </div>
                  ) : (
                    <div className="text-[11px] mt-0.5 opacity-80">
                      Key <span className="font-mono">{shortcut}</span>
                    </div>
                  )}
                </div>
              }
              disabled={false}
              className="relative h-full min-w-0"
            >
              <button
                type="button"
                data-control={label.replace('\n', ' ')}
                className={clsx(
                  'group relative h-full w-full min-h-[72px] flex flex-col items-center justify-center gap-1.5 rounded-2xl transition-all duration-200 select-none',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-ink/50 focus-visible:ring-offset-1',
                  isDisabled && 'bg-paper/70 text-ink-4 cursor-not-allowed',
                  !isDisabled && variant === 'primary' && 'bg-ink text-white hover:bg-ink-2 shadow-[0_10px_24px_-12px_rgba(36,87,230,0.7)]',
                  !isDisabled && variant === 'danger' && 'text-signal-err bg-signal-errbg hover:bg-[#f8d9d9]',
                  !isDisabled && variant === 'ok' && 'bg-paper hover:bg-signal-okbg hover:text-signal-ok',
                  !isDisabled && variant === 'neutral' && 'bg-paper hover:bg-paper-2',
                  isPressed && 'scale-[0.97]'
                )}
                aria-label={label.replace('\n', ' ')}
                aria-keyshortcuts={shortcut}
                tabIndex={isDisabled ? -1 : 0}
                onClick={() => !isDisabled && handleCommand(label)}
                onKeyUp={(e) => handleButtonKeyUp(e, label, isDisabled)}
                onKeyDown={(e) => handleButtonKeyDown(e, label, isDisabled)}
                onMouseEnter={() => !isDisabled && setHovered(label)}
                onMouseLeave={() => {
                  setHovered(null);
                  setPressed(null);
                }}
                onMouseDown={() => !isDisabled && setPressed(label)}
                onMouseUp={() => setPressed(null)}
                disabled={isDisabled}
              >
                <Icon
                  size={28}
                  className={clsx(
                    'transition-transform duration-150',
                    !isDisabled && hovered === label && 'scale-110',
                    !isDisabled && variant === 'primary' && 'text-[#9db8ff]'
                  )}
                />
                <span className="text-[13px] font-semibold leading-none whitespace-pre-line text-center">
                  {label.replace('\n', ' ')}
                </span>
                <span
                  className={clsx(
                    'font-mono text-[9.5px] tracking-wider px-1.5 rounded-pill leading-[15px]',
                    variant === 'primary' && !isDisabled ? 'bg-white/15 text-white/70' : 'bg-ink/5 opacity-70'
                  )}
                >
                  {shortcut}
                </span>
              </button>
            </Tooltip>
          );
        })}
      </div>

      {/* status */}
      <div className="flex-[1.3] min-w-[320px] border-l border-rule px-4 py-3 flex flex-col justify-center gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0" aria-live="polite">
            <span className={clsx('h-2.5 w-2.5 rounded-full shrink-0', phase.dot, taskStatus.running && 'animate-pulsedot')} />
            <span className="text-[15px] font-semibold tracking-tight truncate">{phase.label}</span>
            {taskStatus.running && <span className="font-mono text-ink-3">{spinnerFrames[spinnerIndex]}</span>}
          </div>
          <div className="num text-[20px] leading-none whitespace-nowrap">
            {saving ? (
              <>
                {Math.round(progress)}
                <span className="text-ink-4 text-[14px]">%</span>
              </>
            ) : useMultiTaskMode ? (
              <>
                {taskStatus.proceedTime}
                <span className="text-ink-4 text-[14px]"> s</span>
              </>
            ) : (
              <>
                {taskStatus.proceedTime}
                <span className="text-ink-4 text-[14px]"> / {taskStatus.totalTime} s</span>
              </>
            )}
          </div>
        </div>
        <div className="relative h-2.5 rounded-pill bg-paper-2 overflow-hidden" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}>
          <div className={clsx('absolute inset-y-0 left-0 transition-[width] duration-300', phase.bar)} style={{ width: `${progress}%` }} />
          {[25, 50, 75].map((t) => (
            <span key={t} className="absolute top-0 bottom-0 w-px bg-ink/15" style={{ left: `${t}%` }} />
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 text-[12px]">
          <span className={clsx('truncate', startBlockedReason && taskStatus.phase === TaskPhase.READY ? 'text-signal-warn' : 'text-ink-3')}>
            {guide}
          </span>
          {taskStatus.currentTaskInstruction && taskStatus.running && (
            <span className="truncate text-ink-2 max-w-[55%]" title={taskStatus.currentTaskInstruction}>
              “{taskStatus.currentTaskInstruction}”
            </span>
          )}
        </div>
        {useMultiTaskMode && (
          <div className="pt-1">
            <FullTaskStatus />
          </div>
        )}
      </div>

      {/* episode */}
      <div className="w-[200px] border-l border-rule px-4 py-3 flex items-center gap-3">
        <div className="relative h-14 w-14 shrink-0" aria-hidden>
          <svg viewBox="0 0 36 36" className="h-14 w-14 -rotate-90">
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="#E3E4DC" strokeWidth="3.5" />
            <circle
              cx="18"
              cy="18"
              r="15.5"
              fill="none"
              stroke="#2E7D4F"
              strokeWidth="3.5"
              strokeDasharray={`${(epPct / 100) * 97.4} 97.4`}
              style={{ transition: 'stroke-dasharray .4s ease' }}
            />
          </svg>
          <span className="absolute inset-0 grid place-items-center num text-[11px]">
            {ep.total ? `${Math.round(epPct)}%` : '—'}
          </span>
        </div>
        <div className="min-w-0">
          <div className="label">{ep.label}</div>
          <div className="num text-[22px] leading-none mt-1" data-testid="episode-counter">
            {ep.current}
            {ep.total ? <span className="text-ink-4 text-[16px]"> / {ep.total}</span> : null}
          </div>
          {ep.sub && <div className="text-[11.5px] text-ink-3 mt-1 truncate">{ep.sub}</div>}
        </div>
      </div>

      {/* system */}
      <div className="relative w-[180px] border-l border-rule px-3 py-3 flex flex-col justify-center gap-2">
        {meters.map((m, i) => (
          <button
            key={m.key}
            type="button"
            className="text-left group"
            onClick={() => setExpandedSystemIndex(expandedSystemIndex === i ? null : i)}
            title={`${m.label}: ${m.text}`}
          >
            <div className="flex justify-between text-[11px]">
              <span className="label text-[9.5px]">{m.label}</span>
              <span className="num text-ink-2">{m.text}</span>
            </div>
            <div className="h-1.5 rounded-pill bg-paper-3 mt-0.5 overflow-hidden">
              <div
                className={clsx('h-full', m.pct > 90 ? 'bg-signal-err' : m.pct > 75 ? 'bg-signal-warn' : 'bg-ink')}
                style={{ width: `${Math.min(100, m.pct)}%` }}
              />
            </div>
          </button>
        ))}
        {expandedSystemIndex !== null && (
          <div
            className="absolute bottom-full right-0 mb-2 z-30 bg-white rounded-2xl shadow-lift overflow-hidden cursor-pointer"
            onClick={() => setExpandedSystemIndex(null)}
          >
            <SystemStatus
              label={['CPU', 'RAM', 'Storage'][expandedSystemIndex]}
              type={['cpu', 'ram', 'storage'][expandedSystemIndex]}
            />
          </div>
        )}
      </div>
    </div>
  );
}

const PHASE_STYLE = {
  [TaskPhase.READY]: {
    label: 'Ready',
    dot: 'bg-ink-4',
    bar: 'bg-ink',
    guide: { record: 'Press Start (Space) when the scene is set up.', inference: 'Press Start (Space) to run the policy.' },
  },
  [TaskPhase.WARMING_UP]: {
    label: 'Warming up',
    dot: 'bg-signal-warn',
    bar: 'bg-signal-warn',
    guide: { record: 'Get ready — recording starts when warm-up ends.', inference: 'Preparing the policy…' },
  },
  [TaskPhase.RESETTING]: {
    label: 'Resetting',
    dot: 'bg-sky-ink',
    bar: 'bg-sky',
    guide: { record: 'Reset the scene for the next episode.', inference: 'Resetting…' },
  },
  [TaskPhase.RECORDING]: {
    label: 'Recording',
    dot: 'bg-signal-err',
    bar: 'bg-signal-err',
    guide: { record: 'Demonstrate the task · → save early · ← retry', inference: 'Recording inference…' },
  },
  [TaskPhase.SAVING]: {
    label: 'Saving episode',
    dot: 'bg-sky-ink',
    bar: 'bg-sky-ink',
    guide: { record: 'Encoding video and writing the episode to disk.', inference: 'Saving…' },
  },
  [TaskPhase.STOPPED]: {
    label: 'Stopped',
    dot: 'bg-ink',
    bar: 'bg-ink-3',
    guide: { record: 'Stopped — Finish to save and close the session.', inference: 'Stopped.' },
  },
  [TaskPhase.INFERENCING]: {
    label: 'Running policy',
    dot: 'bg-signal-ok',
    bar: 'bg-signal-ok',
    guide: { record: 'Inference is running.', inference: 'Policy is controlling the robot.' },
  },
};

const BUTTON_VARIANT = {
  Start: 'primary',
  Stop: 'danger',
  Retry: 'neutral',
  Next: 'neutral',
  'Skip\nTask': 'neutral',
  Finish: 'ok',
};
