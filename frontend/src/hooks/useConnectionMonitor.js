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

// App-wide connection monitoring (previously done inside HeartbeatStatus, which
// only worked on pages that rendered it).
//  - link:      rosbridge websocket (server reachable)
//  - heartbeat: physical_ai_server /heartbeat topic (robot type configured)

import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { setHeartbeatStatus } from '../features/tasks/taskSlice';
import rosConnectionManager from '../utils/rosConnectionManager';

export function useHeartbeatMonitor(timeoutMs = 3000, disconnectTimeoutMs = 10000) {
  const dispatch = useDispatch();
  const heartbeatStatus = useSelector((state) => state.tasks.heartbeatStatus);
  const lastHeartbeatTime = useSelector((state) => state.tasks.lastHeartbeatTime);

  useEffect(() => {
    const id = setInterval(() => {
      let next = 'disconnected';
      if (lastHeartbeatTime) {
        const dt = Date.now() - lastHeartbeatTime;
        if (dt < timeoutMs) next = 'connected';
        else if (dt < disconnectTimeoutMs) next = 'timeout';
      }
      if (next !== heartbeatStatus) dispatch(setHeartbeatStatus(next));
    }, 1000);
    return () => clearInterval(id);
  }, [lastHeartbeatTime, heartbeatStatus, timeoutMs, disconnectTimeoutMs, dispatch]);
}

export function useRosLink(intervalMs = 1500) {
  const [linked, setLinked] = useState(rosConnectionManager.isConnected());
  useEffect(() => {
    const id = setInterval(() => setLinked(!!rosConnectionManager.isConnected()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return linked;
}
