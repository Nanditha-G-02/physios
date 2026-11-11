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

// Client for the host-side training service (physical_ai_trainer, 127.0.0.1:8766),
// reached through nginx at /train-api/ (same origin).

import { useCallback } from 'react';

export const TRAINER_BASE = '/train-api';

export class TrainerOffline extends Error {}

export async function trainerFetch(path, { method = 'GET', body, timeoutMs = 60000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${TRAINER_BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
  } catch (e) {
    throw new TrainerOffline(
      e.name === 'AbortError' ? 'The training service did not answer in time.' : 'The training service is not reachable.'
    );
  } finally {
    clearTimeout(t);
  }
  if (res.status === 502 || res.status === 504) {
    throw new TrainerOffline('The training service is not running on this PC.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    throw new TrainerOffline('Unexpected answer from /train-api (is the UI served by the bundled nginx?).');
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function useTrainer() {
  const get = useCallback((path, opts) => trainerFetch(path, opts), []);
  const post = useCallback((path, body, opts) => trainerFetch(path, { ...opts, method: 'POST', body: body || {} }), []);
  return { get, post };
}
