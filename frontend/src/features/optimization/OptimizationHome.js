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

// "Optimize" tab: Monitor (one run) · Trials & history (sessions) · Comparison (runs side by side).

import React, { useState } from 'react';
import { Segmented } from '../../components/ui';
import OptimizationPanel from './OptimizationPanel';
import OptimizationCompare from './OptimizationCompare';
import OptimizationSessions from './OptimizationSessions';

export default function OptimizationHome({ runs, initialRunId, onOpenRun }) {
  const [view, setView] = useState('monitor');
  const [sid, setSid] = useState(null);
  return (
    <div className="grid gap-4" data-opt-home>
      <div className="flex items-center gap-3 flex-wrap">
        <Segmented
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'monitor', label: 'Monitor & recommend' },
            { value: 'sessions', label: 'Trials & history' },
            { value: 'compare', label: 'Comparison dashboard' },
          ]}
        />
      </div>
      {view === 'monitor' ? (
        <OptimizationPanel
          runs={runs}
          initialRunId={initialRunId}
          onOpenRun={onOpenRun}
          onSession={(id) => {
            setSid(id);
            setView('sessions');
          }}
        />
      ) : view === 'sessions' ? (
        <OptimizationSessions runs={runs} selected={sid} setSelected={setSid} onOpenRun={onOpenRun} />
      ) : (
        <OptimizationCompare runs={runs} />
      )}
    </div>
  );
}
