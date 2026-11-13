"""Host metrics. Static facts (OS, RAM, disks, GPU via nvidia-smi) come from the PHYSIOS
training service's ``physios_trainer.environment`` module, imported, not copied. The gateway adds what no backend
measured: CPU utilisation (from /proc/stat deltas), load average and uptime."""

import os
import sys
import threading
import time


def _load_trainer_env(trainer_dir):
    if str(trainer_dir) not in sys.path:
        sys.path.insert(0, str(trainer_dir))
    try:
        from physios_trainer import environment  # noqa: WPS433
        return environment
    except Exception:  # noqa: BLE001 - the gateway still runs without it
        return None


def _cpu_times():
    try:
        with open('/proc/stat', encoding='ascii') as f:
            parts = f.readline().split()[1:]
        vals = [int(x) for x in parts]
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
        return sum(vals), idle
    except (OSError, ValueError, IndexError):
        return None


class SystemMonitor:

    def __init__(self, trainer_dir, paths, interval=2.0):
        self.env = _load_trainer_env(trainer_dir)
        self.paths = paths
        self.interval = interval
        self.cpu_percent = None
        self._gpu = None
        self._gpu_t = 0.0
        self._stop = threading.Event()

    def start(self):
        threading.Thread(target=self._sample, daemon=True, name='cpu-sampler').start()

    def stop(self):
        self._stop.set()

    def _sample(self):
        prev = _cpu_times()
        while not self._stop.wait(self.interval):
            cur = _cpu_times()
            if prev and cur and cur[0] > prev[0]:
                busy = (cur[0] - prev[0]) - (cur[1] - prev[1])
                self.cpu_percent = round(100.0 * busy / (cur[0] - prev[0]), 1)
            prev = cur

    def _gpu_info(self):
        # nvidia-smi takes ~50-200 ms; cache for 3 s
        if self.env and time.time() - self._gpu_t > 3.0:
            try:
                self._gpu = self.env.nvidia_smi()
            except Exception:  # noqa: BLE001
                self._gpu = None
            self._gpu_t = time.time()
        return self._gpu

    def snapshot(self):
        existing = [p for p in self.paths if os.path.exists(p)]
        info = {}
        if self.env:
            try:
                info = self.env.system_info(())
            except Exception:  # noqa: BLE001
                info = {}
        disks = []
        import shutil
        for p in existing:
            try:
                u = shutil.disk_usage(p)
                disks.append({'path': str(p), 'total': u.total, 'free': u.free,
                              'used': u.total - u.free})
            except OSError:
                pass
        info['disks'] = disks
        info['gpu'] = self._gpu_info()
        info['cpu_percent'] = self.cpu_percent
        try:
            info['load_avg'] = list(os.getloadavg())
        except OSError:
            info['load_avg'] = None
        try:
            with open('/proc/uptime', encoding='ascii') as f:
                info['uptime_s'] = float(f.read().split()[0])
        except (OSError, ValueError):
            info['uptime_s'] = None
        info.setdefault('cpu_count', os.cpu_count())
        info['source'] = 'physios_trainer.environment + gateway' if self.env else 'gateway only'
        return info
