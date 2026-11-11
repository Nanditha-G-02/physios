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

// Custom Robot Library: robots added from a URDF. The built-in robots (SO-101 etc.) come from
// physical_ai_server and are selected on Home as before; nothing here changes them.

import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Callout, Empty, Sheet, Spinner } from '../components/ui';
import AddRobotWizard from '../features/robots/AddRobotWizard';
import RobotDetail, { StageBadge } from '../features/robots/RobotDetail';
import { ROBOT_TYPE_LABELS, listRobots } from '../features/robots/robotsApi';
import { robotExtraTabs } from '../features/robots/RobotSetup';
import { setRobotsView } from '../features/ui/uiSlice';

export default function RobotsPage() {
  const dispatch = useDispatch();
  const view = useSelector((s) => s.ui.robotsView) || { mode: 'library' };
  const setView = (v) => dispatch(setRobotsView(v));
  const [robots, setRobots] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await listRobots();
      setRobots(r.robots);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex-1 overflow-y-auto scroll-thin">
      <div className="max-w-[1760px] mx-auto px-5 py-4 space-y-4" data-robots-page>
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="label">Robots</div>
            <h1 className="text-[24px] font-semibold tracking-tight">Custom robot library</h1>
            <p className="text-[13px] text-ink-3 max-w-2xl">
              Add a robot from its URDF, check it, look at it in 3D, then configure and verify it step by step. Recording and
              training unlock only after the robot has been verified on hardware.
            </p>
          </div>
          {view.mode === 'library' && (
            <button className="btn-primary" onClick={() => setView({ mode: 'add' })} data-action="add-robot">
              + Add custom robot
            </button>
          )}
        </header>

        {error && (
          <Callout tone="err" title="The robot library is not reachable">
            {error} The library is kept by the host service (pam-trainer); start it with the training service.
          </Callout>
        )}

        {view.mode === 'add' && (
          <AddRobotWizard
            onCancel={() => setView({ mode: 'library' })}
            onCreated={(id) => {
              load();
              setView({ mode: 'detail', id });
            }}
          />
        )}

        {view.mode === 'detail' && view.id && (
          <RobotDetail robotId={view.id} onBack={() => setView({ mode: 'library' })} onChanged={load} extraTabs={robotExtraTabs} />
        )}

        {view.mode === 'library' && (
          <Sheet title="Custom robots" code="R">
            {robots === null && !error ? (
              <div className="py-8 flex justify-center"><Spinner /></div>
            ) : robots && robots.length ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-robot-library>
                {robots.map((r) => (
                  <button
                    key={r.id}
                    className="text-left rounded-2xl bg-paper hover:bg-paper-2 p-4 transition-all hover:-translate-y-[1px]"
                    onClick={() => setView({ mode: 'detail', id: r.id })}
                    data-robot-card={r.id}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-semibold truncate">{r.name}</div>
                        <div className="text-[11.5px] text-ink-3 truncate">
                          {ROBOT_TYPE_LABELS[r.type] || r.type}
                          {r.manufacturer ? ` · ${r.manufacturer}` : ''}
                        </div>
                      </div>
                      <StageBadge stage={r.stage} state={r.state} />
                    </div>
                    <div className="mt-2 text-[12px] text-ink-2">
                      {r.links ? `${r.links} links · ${r.joints} joints · ${r.dof} DOF` : 'No model yet'}
                      {r.validation_status && (
                        <span className={r.validation_status === 'errors' ? 'text-signal-err' : r.validation_status === 'warnings' ? 'text-signal-warn' : 'text-signal-ok'}>
                          {' '}· {r.validation_status}
                        </span>
                      )}
                      {r.connected && <span className="text-signal-ok"> · connected</span>}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <Empty
                title="No custom robots yet"
                action={<button className="btn-primary" onClick={() => setView({ mode: 'add' })}>+ Add custom robot</button>}
              >
                The SO-101 and other built-in robots are selected on Home. Add your own robot here from its URDF.
              </Empty>
            )}
          </Sheet>
        )}
      </div>
    </div>
  );
}
