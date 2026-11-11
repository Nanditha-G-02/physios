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

// App-wide: shows training events (finished / failed / queue) as toasts and,
// when the operator allowed it, as desktop notifications. Silent when the
// training service is not running.

import { useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { trainerFetch } from './useTrainer';

const KEY = 'pam.trainerEventSeq';

export default function useTrainerEvents() {
  const seq = useRef(null);
  useEffect(() => {
    let alive = true;
    let delay = 8000;
    let timer;
    const tick = async () => {
      try {
        if (seq.current == null) {
          let saved = null;
          try {
            saved = Number(window.localStorage.getItem(KEY));
          } catch (e) {
            /* storage unavailable */
          }
          const first = await trainerFetch('/events?after=999999999', { timeoutMs: 5000 });
          // start from what this browser saw last, never replay older history
          seq.current = saved && saved <= first.seq ? saved : first.seq;
        }
        const r = await trainerFetch(`/events?after=${seq.current}`, { timeoutMs: 5000 });
        r.events.forEach((ev) => {
          const text = `${ev.title}: ${ev.body}`;
          if (ev.level === 'error') toast.error(text, { duration: 8000 });
          else if (ev.level === 'warn') toast(text, { icon: '⚠️', duration: 6000 });
          else toast.success(text, { duration: 5000 });
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
            try {
              // eslint-disable-next-line no-new
              new Notification(ev.title, { body: ev.body, tag: `pam-${ev.seq}` });
            } catch (e) {
              /* ignore */
            }
          }
        });
        seq.current = Math.max(seq.current, r.seq);
        try {
          window.localStorage.setItem(KEY, String(seq.current));
        } catch (e) {
          /* ignore */
        }
        delay = 8000;
      } catch (e) {
        delay = 30000; // service not running: check rarely
      }
      if (alive) timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, 1500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
}
