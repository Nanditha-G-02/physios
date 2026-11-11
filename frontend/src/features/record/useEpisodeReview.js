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

// Optional per-episode review in Record. The ON/OFF setting and every decision
// live on the server (settings.* / data.review), so they survive restarts and
// show up in the Data session. When OFF nothing here interrupts recording.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { usePlanningService } from '../../hooks/usePlanningService';
import TaskPhase from '../../constants/taskPhases';

export function useEpisodeReview(active) {
  const { call } = usePlanningService();
  const phase = useSelector((s) => s.tasks.taskStatus.phase);
  const [enabled, setEnabledState] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [queue, setQueue] = useState([]);
  const [error, setError] = useState('');
  const lastPhase = useRef(phase);

  const refresh = useCallback(async () => {
    try {
      const r = await call('record.recent', { limit: 10 });
      setEnabledState(!!r.settings.record_review_enabled);
      setQueue(r.awaiting_review || []);
      setLoaded(true);
      setError('');
      return r;
    } catch (e) {
      setError(e.message);
      return null;
    }
  }, [call]);

  useEffect(() => {
    if (!active) return undefined;
    refresh();
    const id = setInterval(refresh, enabled ? 2000 : 6000);
    return () => clearInterval(id);
  }, [active, enabled, refresh]);

  // a take just finished -> look for the new episode quickly
  useEffect(() => {
    if (active && lastPhase.current !== phase && (phase === TaskPhase.READY || phase === TaskPhase.RESETTING)) {
      setTimeout(refresh, 500);
      setTimeout(refresh, 1800);
    }
    lastPhase.current = phase;
  }, [phase, active, refresh]);

  const setEnabled = useCallback(
    async (on) => {
      const r = await call('settings.set', { record_review_enabled: !!on });
      setEnabledState(!!r.record_review_enabled);
      await refresh();
      return r;
    },
    [call, refresh]
  );

  const decide = useCallback(
    async (item, status, { comment, categories } = {}) => {
      const rec = await call('data.review', {
        dataset_id: item.dataset_id,
        episode_index: item.episode_index,
        status,
        comment: comment || undefined,
        failure_categories: categories && categories.length ? categories : undefined,
        source: 'record',
      });
      setQueue((q) => q.filter((x) => !(x.dataset_id === item.dataset_id && x.episode_index === item.episode_index)));
      refresh();
      return rec;
    },
    [call, refresh]
  );

  return { enabled, loaded, setEnabled, queue, current: enabled ? queue[0] || null : null, decide, refresh, error };
}
