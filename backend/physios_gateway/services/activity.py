"""Activity feed: gateway events (service up/down, commands issued) in a bounded ring,
persisted as JSON lines so the dashboard shows history across restarts."""

import json
import threading
import time
from collections import deque
from pathlib import Path


class Activity:

    def __init__(self, path=None, keep=500):
        self.path = Path(path) if path else None
        self._items = deque(maxlen=keep)
        self._lock = threading.Lock()
        self._seq = 0
        if self.path and self.path.exists():
            try:
                for line in self.path.read_text(encoding='utf-8').splitlines()[-keep:]:
                    ev = json.loads(line)
                    self._items.append(ev)
                    self._seq = max(self._seq, ev.get('seq', 0))
            except (OSError, ValueError):
                pass

    def add(self, source, level, text, **extra):
        with self._lock:
            self._seq += 1
            ev = {'seq': self._seq, 't': time.time(), 'source': source, 'level': level,
                  'text': text}
            ev.update(extra)
            self._items.append(ev)
            if self.path:
                try:
                    self.path.parent.mkdir(parents=True, exist_ok=True)
                    with open(self.path, 'a', encoding='utf-8') as f:
                        f.write(json.dumps(ev) + '\n')
                    if self._seq % 200 == 0:
                        self._compact()
                except OSError:
                    pass
        return ev

    def _compact(self):
        tmp = self.path.with_suffix('.tmp')
        tmp.write_text(''.join(json.dumps(e) + '\n' for e in self._items), encoding='utf-8')
        tmp.replace(self.path)

    def since(self, after=0, limit=100):
        with self._lock:
            out = [e for e in self._items if e['seq'] > after]
        return {'events': out[-limit:], 'seq': self._seq}
