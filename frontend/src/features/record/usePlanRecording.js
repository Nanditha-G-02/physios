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

// Plan-driven recording. The approved plan (server) decides the task info of
// each episode; Start asks the server to bind the next take to that plan
// episode (record.begin) and then sends the ordinary START_RECORD with exactly
// the task info the server returned. The server refuses a START that does not
// match, so recording cannot silently drift from the plan.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { usePlanningService } from '../../hooks/usePlanningService';
import { useRosServiceCaller } from '../../hooks/useRosServiceCaller';
import { setTaskInfo, setUseMultiTaskMode } from '../tasks/taskSlice';
import { setRecordState, setSelectedEpisodeId } from '../planning/planningSlice';
import TaskPhase from '../../constants/taskPhases';
import TaskCommand from '../../constants/taskCommand';

export function taskInfoToRedux(ti) {
  return {
    taskName: ti.task_name,
    taskType: 'record',
    taskInstruction: ti.task_instruction,
    userId: ti.user_id,
    fps: ti.fps,
    tags: ti.tags,
    // ControlPanel's generic check rejects 0; plan takes use num_episodes=1 so the
    // reset timer is never reached. The START request itself uses the server's values.
    warmupTime: Math.max(1, ti.warmup_time_s || 0),
    episodeTime: ti.episode_time_s,
    resetTime: Math.max(1, ti.reset_time_s || 0),
    numEpisodes: 1,
    pushToHub: false,
    privateMode: ti.private_mode,
    useOptimizedSave: ti.use_optimized_save_mode,
    recordRosBag2: false,
    recordInferenceMode: false,
    policyPath: '',
  };
}

// Mirrors PlanningService._task_info_for so the panel can be filled before Start.
export function plannedTaskInfo(plan, episode) {
  const t = plan.task;
  const rec = t.recording || {};
  return {
    task_name: t.name,
    task_type: 'record',
    user_id: t.user_id,
    task_instruction: [episode.instruction],
    policy_path: '',
    record_inference_mode: false,
    fps: Number(rec.fps) || 30,
    tags: [t.robot_type, 'physical-ai-manager', `plan-${plan.strategy.type}`],
    warmup_time_s: Number(rec.warmup_s) || 0,
    episode_time_s: Number(rec.episode_s) || 20,
    reset_time_s: Number(rec.reset_s) || 0,
    num_episodes: 1,
    push_to_hub: false,
    private_mode: true,
    use_optimized_save_mode: rec.use_optimized_save !== false,
    record_rosbag2: false,
  };
}

export function usePlanRecording(active) {
  const dispatch = useDispatch();
  const { call } = usePlanningService();
  const { callService } = useRosServiceCaller();
  const state = useSelector((s) => s.planning.recordState);
  const selectedId = useSelector((s) => s.planning.selectedEpisodeId);
  const phase = useSelector((s) => s.tasks.taskStatus.phase);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const lastPhase = useRef(phase);

  const refresh = useCallback(async () => {
    try {
      const res = await call('record.state', {});
      dispatch(setRecordState(res));
      setError('');
      return res;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [call, dispatch]);

  // initial load + light polling while visible
  useEffect(() => {
    if (!active) return undefined;
    setLoading(true);
    refresh();
    const id = setInterval(refresh, 2500);
    return () => clearInterval(id);
  }, [active, refresh]);

  // refresh promptly when a take ends
  useEffect(() => {
    if (lastPhase.current !== phase && phase === TaskPhase.READY) {
      setTimeout(refresh, 400);
      setTimeout(refresh, 2000);
    }
    lastPhase.current = phase;
  }, [phase, refresh]);

  const plan = state?.plan || null;
  const episodes = plan ? [...plan.episodes].sort((a, b) => a.order - b.order) : [];
  const progressRaw = state?.progress?.episodes;
  const progress = useMemo(() => progressRaw || {}, [progressRaw]);
  const activeTake = state?.progress?.active || null;

  // choose the episode shown in the panel: active take > selection > next pending
  const currentId =
    activeTake?.episode_id ||
    (selectedId && episodes.some((e) => e.id === selectedId) ? selectedId : state?.next_episode_id) ||
    episodes[0]?.id;
  const current = episodes.find((e) => e.id === currentId) || null;

  // keep the recorder's task info in sync with the selected planned episode
  const syncedKey = useRef('');
  useEffect(() => {
    if (!active || !plan || !current) return;
    const key = `${plan.id}:${plan.version}:${current.id}`;
    if (syncedKey.current === key) return;
    syncedKey.current = key;
    dispatch(setUseMultiTaskMode(false));
    dispatch(setTaskInfo(taskInfoToRedux(plannedTaskInfo(plan, current))));
  }, [active, plan, current, dispatch]);

  const select = (id) => dispatch(setSelectedEpisodeId(id));

  // Start override used by ControlPanel in plan mode
  const start = useCallback(
    async (opts = {}) => {
      if (!plan || !current) return { success: false, message: 'No approved plan loaded.' };
      const st = progress[current.id]?.status;
      const retake = st === 'validated' || st === 'recorded' || opts.retake;
      let begin;
      try {
        begin = await call('record.begin', { plan_id: plan.id, episode_id: current.id, retake });
      } catch (e) {
        return { success: false, message: e.message };
      }
      dispatch(setTaskInfo(taskInfoToRedux(begin.task_info)));
      let res;
      try {
        res = await callService('/task/command', 'physical_ai_interfaces/srv/SendCommand', {
          task_info: begin.task_info,
          command: TaskCommand.START_RECORD,
        });
      } catch (e) {
        res = { success: false, message: e.message };
      }
      if (!res || !res.success) {
        await call('record.cancel', { plan_id: plan.id, reason: 'start_failed' }).catch(() => {});
      }
      refresh();
      return res;
    },
    [plan, current, progress, call, callService, dispatch, refresh]
  );

  const skip = async (episodeId, reason) => {
    const res = await call('record.skip', { plan_id: plan.id, episode_id: episodeId, reason });
    dispatch(setRecordState(res));
    return res;
  };
  const restore = async (episodeId) => {
    const res = await call('record.restore', { plan_id: plan.id, episode_id: episodeId });
    dispatch(setRecordState(res));
  };

  return { state, plan, episodes, progress, current, activeTake, error, loading, refresh, select, start, skip, restore };
}
