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

// Camera match check: compares each live camera with frames from the dataset a
// model was (or will be) trained on - resolution, frame rate, brightness, colour
// balance and camera position. Read-only: it only looks at the streams.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import clsx from 'clsx';
import ROSLIB from 'roslib';
import { usePlanningService } from '../../hooks/usePlanningService';
import rosConnectionManager from '../../utils/rosConnectionManager';
import { streamUrl } from '../record/ProcessedCameraView';
import { videoUrl } from '../data/EpisodeViewer';
import { setCameraCheck } from '../planning/planningSlice';
import { Callout, Select, Spinner } from '../../components/ui';
import { averageStats, bestShift, colourStats, edgeMap, evaluate, SMALL_H, SMALL_W } from './imageStats';

const LEVEL = { ok: 'chip-ok', warn: 'chip-warn', error: 'chip-err', unknown: 'chip' };
const RANK = { ok: 0, unknown: 1, warn: 2, error: 3 };

function short(key) {
  return key.replace('observation.images.', '');
}

function grab(el, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(el, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, canvas: c };
}

function loadVideoFrame(url, t) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    const fail = () => reject(new Error(`Cannot read ${url}`));
    const timer = setTimeout(fail, 15000);
    v.onerror = fail;
    v.onloadeddata = () => {
      v.currentTime = Math.min(t, Math.max(0, (v.duration || t) - 0.05));
    };
    v.onseeked = () => {
      clearTimeout(timer);
      resolve(v);
    };
    v.src = url;
  });
}

async function measureFps(rosbridgeUrl, topic, seconds = 3) {
  try {
    const ros = await rosConnectionManager.getConnection(rosbridgeUrl);
    if (!ros) return null;
    return await new Promise((resolve) => {
      const tp = new ROSLIB.Topic({ ros, name: topic, messageType: 'sensor_msgs/msg/CompressedImage', queue_length: 1 });
      const stamps = [];
      tp.subscribe(() => stamps.push(performance.now()));
      setTimeout(() => {
        tp.unsubscribe();
        if (stamps.length < 3) resolve(null);
        else resolve(((stamps.length - 1) * 1000) / (stamps[stamps.length - 1] - stamps[0]));
      }, seconds * 1000);
    });
  } catch (e) {
    return null;
  }
}

function pairTopics(cams, topics) {
  const used = new Set();
  const out = {};
  cams.forEach((c) => {
    const s = short(c.key).toLowerCase();
    const t = topics.find((x) => !used.has(x) && x.toLowerCase().includes(s));
    if (t) {
      out[c.key] = t;
      used.add(t);
    }
  });
  cams.forEach((c) => {
    if (!out[c.key]) {
      const t = topics.find((x) => !used.has(x));
      if (t) {
        out[c.key] = t;
        used.add(t);
      }
    }
  });
  return out;
}

function CameraRow({ cam, result, refCanvas, liveCanvas }) {
  const [mode, setMode] = useState('side');
  const blendRef = useRef(null);
  const liveRef = useRef(null);
  const refRef = useRef(null);
  useEffect(() => {
    const put = (holder, c) => {
      if (holder.current && c) {
        holder.current.innerHTML = '';
        c.className = 'w-full h-auto rounded-xl';
        holder.current.appendChild(c);
      }
    };
    if (mode === 'side') {
      put(liveRef, liveCanvas);
      put(refRef, refCanvas);
    } else if (blendRef.current && liveCanvas && refCanvas) {
      const c = blendRef.current;
      c.width = liveCanvas.width;
      c.height = liveCanvas.height;
      const ctx = c.getContext('2d');
      ctx.globalAlpha = 1;
      ctx.drawImage(liveCanvas, 0, 0, c.width, c.height);
      ctx.globalAlpha = 0.5;
      ctx.drawImage(refCanvas, 0, 0, c.width, c.height);
    }
  }, [mode, liveCanvas, refCanvas]);
  const worst = result.checks.reduce((a, c) => (RANK[c.level] > RANK[a] ? c.level : a), 'ok');
  return (
    <div className="rounded-2xl bg-paper p-4 grid gap-3" data-camera-check={short(cam.key)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-[14px]">{short(cam.key)}</span>
        <span className="num text-[11px] text-ink-3 truncate">{result.topic}</span>
        <span className={clsx(LEVEL[worst], 'ml-auto')}>
          {worst === 'ok' ? 'matches training' : worst === 'error' ? 'mismatch' : worst === 'warn' ? 'check' : 'incomplete'}
        </span>
        <div className="inline-flex rounded-pill bg-white p-[2px] text-[11.5px]">
          {['side', 'overlay'].map((m) => (
            <button
              key={m}
              className={clsx('rounded-pill px-2.5 py-0.5', mode === m ? 'bg-ink text-white' : 'text-ink-2')}
              onClick={() => setMode(m)}
            >
              {m === 'side' ? 'Side by side' : 'Overlay'}
            </button>
          ))}
        </div>
      </div>
      {mode === 'side' ? (
        <div className="grid grid-cols-2 gap-3">
          <figure>
            <div ref={liveRef} className="bg-white rounded-xl min-h-[80px]" />
            <figcaption className="text-[11px] text-ink-3 mt-1">Live</figcaption>
          </figure>
          <figure>
            <div ref={refRef} className="bg-white rounded-xl min-h-[80px]" />
            <figcaption className="text-[11px] text-ink-3 mt-1">Training (episode start)</figcaption>
          </figure>
        </div>
      ) : (
        <figure>
          <canvas ref={blendRef} className="w-full h-auto rounded-xl" />
          <figcaption className="text-[11px] text-ink-3 mt-1">
            Live with the training frame at 50% on top — line up edges by moving the camera
          </figcaption>
        </figure>
      )}
      <div className="grid gap-1.5 sm:grid-cols-2">
        {result.checks.map((c) => (
          <div key={c.id} className="flex items-start gap-2 text-[12px]">
            <span className={clsx(LEVEL[c.level], 'shrink-0 w-[92px] justify-center')}>{c.label}</span>
            <span className="text-ink-2">{c.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CameraMatchCheck({ datasetId: initialDataset, auto = true, onResult }) {
  const dispatch = useDispatch();
  const { call } = usePlanningService();
  const topicList = useSelector((s) => s.ros.imageTopicList);
  const topics = useMemo(() => topicList || [], [topicList]);
  const rosHost = useSelector((s) => s.ros.rosHost);
  const rosbridgeUrl = useSelector((s) => s.ros.rosbridgeUrl);
  const [datasets, setDatasets] = useState(null);
  const [datasetId, setDatasetId] = useState(initialDataset || '');
  const [state, setState] = useState({ phase: 'idle' });
  const [rows, setRows] = useState([]);
  const imgs = useRef({});
  const [pairing, setPairing] = useState({});

  useEffect(() => {
    call('data.list_datasets', {}).then(
      (r) => {
        setDatasets(r.datasets);
        setDatasetId((d) => d || (r.datasets[0] && r.datasets[0].id) || '');
      },
      (e) => setState({ phase: 'error', message: e.message }),
    );
  }, [call]);
  useEffect(() => {
    if (initialDataset) setDatasetId(initialDataset);
  }, [initialDataset]);

  const [overview, setOverview] = useState(null);
  useEffect(() => {
    if (!datasetId) return;
    setOverview(null);
    call('data.overview', { dataset_id: datasetId }).then(setOverview, (e) => setState({ phase: 'error', message: e.message }));
  }, [datasetId, call]);
  const cams = useMemo(() => overview?.cameras || [], [overview]);
  useEffect(() => {
    setPairing(pairTopics(cams, topics));
  }, [cams, topics]);

  const run = useCallback(async () => {
    if (!overview || !cams.length) return;
    setState({ phase: 'running', text: 'reading training frames' });
    try {
      const n = overview.total_episodes || 0;
      const picks = [...new Set([0, Math.floor(n / 2), Math.max(0, n - 1)])].filter((i) => i < n);
      const eps = await Promise.all(
        picks.map((i) => call('data.episode', { dataset_id: datasetId, episode_index: i, max_points: 10 })),
      );
      const out = [];
      for (const cam of cams) {
        const topic = pairing[cam.key];
        const refStats = [];
        let refEdges = null;
        let refCanvas = null;
        for (const ep of eps) {
          const vid = ep.videos?.[cam.key];
          if (!vid) continue;
          // eslint-disable-next-line no-await-in-loop
          const v = await loadVideoFrame(videoUrl(datasetId, vid.path), (vid.from_s || 0) + 0.3);
          const full = grab(v, v.videoWidth, v.videoHeight);
          refStats.push(colourStats(full.data));
          if (!refCanvas) {
            refCanvas = full.canvas;
            refEdges = edgeMap(grab(v, SMALL_W, SMALL_H).data);
          }
        }
        const shape = cam.shape || [];
        const refSize = shape.length >= 2 ? [shape[1], shape[0]] : refCanvas ? [refCanvas.width, refCanvas.height] : null;
        let live = null;
        let liveSize = null;
        let liveCanvas = null;
        let align = null;
        let fps = null;
        if (topic) {
          setState({ phase: 'running', text: `sampling ${short(cam.key)} live` });
          const img = imgs.current[cam.key];
          const t0 = performance.now();
          // eslint-disable-next-line no-await-in-loop
          while (!(img && img.naturalWidth) && performance.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 150));
          if (img && img.naturalWidth) {
            liveSize = [img.naturalWidth, img.naturalHeight];
            const samples = [];
            for (let k = 0; k < 5; k += 1) {
              samples.push(colourStats(grab(img, img.naturalWidth, img.naturalHeight).data));
              // eslint-disable-next-line no-await-in-loop
              await new Promise((r) => setTimeout(r, 200));
            }
            live = averageStats(samples);
            liveCanvas = grab(img, img.naturalWidth, img.naturalHeight).canvas;
            if (refEdges) align = bestShift(refEdges, edgeMap(grab(img, SMALL_W, SMALL_H).data));
          }
          setState({ phase: 'running', text: `measuring ${short(cam.key)} frame rate` });
          // eslint-disable-next-line no-await-in-loop
          fps = await measureFps(rosbridgeUrl, topic);
        }
        const checks = topic
          ? evaluate({
              live,
              ref: refStats.length ? averageStats(refStats) : null,
              liveSize,
              refSize,
              liveFps: fps,
              refFps: overview.fps,
              align,
            })
          : [{ id: 'topic', label: 'Topic', level: 'error', text: 'no live topic for this camera' }];
        if (topic && !live)
          checks.unshift({
            id: 'stream',
            label: 'Stream',
            level: 'error',
            text: 'no live image (camera or web_video_server not running?)',
          });
        out.push({ key: cam.key, topic, checks, refCanvas, liveCanvas });
      }
      setRows(out);
      const level = out.flatMap((r) => r.checks).reduce((a, c) => (RANK[c.level] > RANK[a] ? c.level : a), 'ok');
      const summary = {
        at: new Date().toISOString(),
        level,
        dataset: datasetId,
        cameras: out.map((r) => ({ key: r.key, topic: r.topic, checks: r.checks })),
      };
      dispatch(setCameraCheck(summary));
      if (onResult) onResult(summary);
      setState({ phase: 'done' });
    } catch (e) {
      setState({ phase: 'error', message: e.message });
    }
  }, [overview, cams, pairing, call, datasetId, rosbridgeUrl, dispatch, onResult]);

  const ready = overview && cams.length && Object.keys(pairing).length;
  const autoRan = useRef('');
  useEffect(() => {
    if (auto && ready && autoRan.current !== datasetId) {
      autoRan.current = datasetId;
      run();
    }
  }, [auto, ready, datasetId, run]);

  return (
    <div className="grid gap-3 grid-cols-[minmax(0,1fr)]">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 min-w-[260px] flex-1">
          <span className="label">Compare with dataset</span>
          <Select
            value={datasetId}
            onChange={setDatasetId}
            options={(datasets || []).map((d) => ({ value: d.id, label: d.id }))}
            data-camera-dataset
          />
        </label>
        {cams.map((c) => (
          <label key={c.key} className="grid gap-1 min-w-[200px]">
            <span className="label">{short(c.key)} ← live topic</span>
            <Select
              value={pairing[c.key] || ''}
              onChange={(v) => setPairing({ ...pairing, [c.key]: v })}
              options={[{ value: '', label: '— none —' }, ...topics.map((t) => ({ value: t, label: t }))]}
            />
          </label>
        ))}
        <button className="btn-primary" onClick={run} disabled={!ready || state.phase === 'running'} data-camera-run>
          {state.phase === 'running' && <Spinner />}
          {rows.length ? 'Check again' : 'Check cameras'}
        </button>
      </div>
      {state.phase === 'running' && <div className="text-[12px] text-ink-3">{state.text}…</div>}
      {state.phase === 'error' && <Callout tone="err">{state.message}</Callout>}
      {!topics.length && (
        <Callout tone="warn">No camera topics known yet — open Record once so the camera list is loaded.</Callout>
      )}
      {/* live sources (hidden) */}
      <div className="hidden">
        {cams.map(
          (c) =>
            pairing[c.key] && (
              <img
                key={`${c.key}-${pairing[c.key]}`}
                ref={(el) => {
                  imgs.current[c.key] = el;
                }}
                src={streamUrl(pairing[c.key], rosHost, true)}
                crossOrigin="anonymous"
                alt=""
              />
            ),
        )}
      </div>
      {rows.map((r) => (
        <CameraRow key={r.key} cam={{ key: r.key }} result={r} refCanvas={r.refCanvas} liveCanvas={r.liveCanvas} />
      ))}
      {rows.length > 0 && (
        <p className="text-[11px] text-ink-3">
          Training frames are taken 0.3 s into the first, middle and last episode. Position similarity compares edges, so objects
          that were moved also lower it a little; use Overlay to judge. Nothing is changed on the cameras.
        </p>
      )}
    </div>
  );
}
