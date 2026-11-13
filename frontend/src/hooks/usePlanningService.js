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

// Calls the generic JSON services added by physical_ai_server/planning:
//   /planning/command  plans, plan-mode recording, robot profile
//   /data/command      datasets, reviews, publishing

import { useCallback } from 'react';
import { useRosServiceCaller } from './useRosServiceCaller';

const SRV_TYPE = 'physical_ai_interfaces/srv/PlanningCommand';

export function usePlanningService() {
  const { callService } = useRosServiceCaller();

  const call = useCallback(
    async (command, payload = {}, { timeoutMs = 15000 } = {}) => {
      const service = command.startsWith('data.') || command.startsWith('github.')
        ? '/data/command'
        : '/planning/command';
      let res;
      try {
        res = await callService(
          service,
          SRV_TYPE,
          { command, payload_json: JSON.stringify(payload) },
          timeoutMs
        );
      } catch (e) {
        const msg = String(e.message || e);
        if (/non-existent service|does not exist|Service .* not available/i.test(msg)) {
          throw new Error(
            'The server does not provide the planning services yet. Rebuild the RawBot Studio robot image (docker/physios-docker.sh build), then restart it.'
          );
        }
        throw e;
      }
      if (!res || !res.success) {
        throw new Error((res && res.message) || `Command ${command} failed`);
      }
      return res.result_json ? JSON.parse(res.result_json) : {};
    },
    [callService]
  );

  // Poll a background job (delete episodes, GitHub publish) until it ends.
  const waitForJob = useCallback(
    async (job, onProgress, intervalMs = 700) => {
      let current = job;
      while (current && current.status === 'running') {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, intervalMs));
        // eslint-disable-next-line no-await-in-loop
        current = await call('job.status', { job_id: job.id });
        if (onProgress) onProgress(current);
      }
      if (current.status === 'failed') throw new Error(current.message || 'Job failed');
      return current;
    },
    [call]
  );

  return { call, waitForJob };
}
