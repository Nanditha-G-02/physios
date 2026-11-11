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

// Data session (replaces Training in the navigation): dataset dashboard,
// episode explorer and review, publishing, and the former Data Tools.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { usePlanningService } from '../hooks/usePlanningService';
import {
  setDataDatasetId,
  setDataTab,
  setRecordMode,
  setSelectedEpisodeId,
  setTrainingDatasetPath,
} from '../features/planning/planningSlice';
import { moveToPage } from '../features/ui/uiSlice';
import PageType from '../constants/pageType';
import EpisodeViewer from '../features/data/EpisodeViewer';
import PublishPanel from '../features/data/PublishPanel';
import EditDatasetPage from './EditDatasetPage';
import {
  Callout,
  Empty,
  KeyValue,
  Modal,
  Segmented,
  Sheet,
  Spinner,
  Stat,
  TextInput,
  formatBytes,
  formatDuration,
} from '../components/ui';

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'episodes', label: 'Episodes' },
  { value: 'publish', label: 'Publish' },
  { value: 'tools', label: 'Tools' },
];

const REVIEW_CHIP = { accepted: 'chip-ok', rejected: 'chip-err', needs_review: 'chip-warn' };

export default function DataPage() {
  const dispatch = useDispatch();
  const { call, waitForJob } = usePlanningService();
  const datasetId = useSelector((s) => s.planning.dataDatasetId);
  const tab = useSelector((s) => s.planning.dataTab);
  const [datasets, setDatasets] = useState(null);
  const [root, setRoot] = useState('');
  const [listError, setListError] = useState('');
  const [overview, setOverview] = useState(null);
  const [episodes, setEpisodes] = useState(null);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState(null); // {indices}
  const [confirmText, setConfirmText] = useState('');
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');

  const loadList = useCallback(async () => {
    try {
      const r = await call('data.list_datasets', {});
      setDatasets(r.datasets);
      setRoot(r.root);
      setListError('');
      if (!datasetId && r.datasets.length) dispatch(setDataDatasetId(r.datasets[0].id));
    } catch (e) {
      setDatasets([]);
      setListError(e.message);
    }
  }, [call, datasetId, dispatch]);

  const loadDataset = useCallback(async () => {
    if (!datasetId) return;
    setError('');
    try {
      const [ov, eps] = await Promise.all([
        call('data.overview', { dataset_id: datasetId }),
        call('data.episodes', { dataset_id: datasetId }),
      ]);
      setOverview(ov);
      setEpisodes(eps);
      setSelected((s) => (s != null && eps.episodes.some((e) => e.episode_index === s) ? s : eps.episodes[0]?.episode_index ?? null));
    } catch (e) {
      setOverview(null);
      setEpisodes(null);
      setError(e.message);
    }
  }, [call, datasetId]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    setOverview(null);
    setEpisodes(null);
    setSelected(null);
    loadDataset();
  }, [loadDataset]);

  const rows = useMemo(() => {
    const list = episodes?.episodes || [];
    return list.filter((e) => {
      const st = e.review?.status || 'unreviewed';
      if (filter === 'pending') {
        if (st !== 'needs_review' && st !== 'unreviewed') return false;
      } else if (filter !== 'all' && st !== filter) return false;
      if (query) {
        const q = query.toLowerCase();
        const hay = `${e.episode_index} ${e.plan?.episode_id || ''} ${(e.tasks || []).join(' ')} ${e.review?.comment || ''} ${(e.review?.failure_categories || []).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [episodes, filter, query]);

  const onReviewed = (idx, rec) => {
    setEpisodes((eps) =>
      eps ? { ...eps, episodes: eps.episodes.map((e) => (e.episode_index === idx ? { ...e, review: rec } : e)) } : eps
    );
    call('data.overview', { dataset_id: datasetId }).then(setOverview).catch(() => {});
  };

  const doDelete = async () => {
    try {
      const j = await call('data.delete_episodes', {
        dataset_id: datasetId,
        episode_indices: deleting.indices,
        confirm: confirmText,
      });
      setJob(j);
      setDeleting(null);
      setConfirmText('');
      await waitForJob(j, setJob);
      toast.success(`Deleted ${deleting.indices.length} episode(s); later episodes were renumbered.`);
      setJob(null);
      await loadDataset();
      loadList();
    } catch (e) {
      toast.error(e.message);
      setJob(null);
    }
  };

  const recollect = async (plan) => {
    try {
      await call('plan.set_active', { plan_id: plan.plan_id });
      dispatch(setRecordMode('plan'));
      dispatch(setSelectedEpisodeId(plan.episode_id));
      dispatch(moveToPage(PageType.RECORD));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const rc = overview?.review_counts || {};

  return (
    <div className="h-full flex min-h-0 bp-grid">
      <aside className="w-[260px] shrink-0 border-r border-ink bg-white flex flex-col min-h-0">
        <div className="sheet-head">
          <div>
            <div className="label">Sheet 04</div>
            <div className="sheet-title">Datasets</div>
          </div>
          <button className="btn btn-sm" onClick={loadList} aria-label="Reload datasets">
            ↻
          </button>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin">
          {datasets === null && (
            <div className="p-4">
              <Spinner />
            </div>
          )}
          {listError && (
            <div className="p-3">
              <Callout tone="err" title="Data service unavailable">
                {listError}
              </Callout>
            </div>
          )}
          {(datasets || []).map((d) => (
            <button
              key={d.id}
              onClick={() => dispatch(setDataDatasetId(d.id))}
              className={clsx('w-full text-left px-3 py-2.5 border-b border-rule', d.id === datasetId ? 'bg-sky-50' : 'hover:bg-paper')}
            >
              <div className="text-[11px] text-ink-3 num truncate">{d.owner || d.id.split('/')[0]}</div>
              <div className="font-medium text-[13px] truncate">{d.name || d.id.split('/')[1]}</div>
              <div className="flex flex-wrap gap-1 mt-1">
                {d.integrity !== 'complete' ? (
                  <span className="chip-err">incomplete</span>
                ) : (
                  <>
                    <span className="chip num">{d.total_episodes} ep</span>
                    <span className="chip">{d.codebase_version}</span>
                    {d.plans?.length > 0 && <span className="chip-sky">planned</span>}
                    {d.review_counts?.accepted > 0 && <span className="chip-ok num">{d.review_counts.accepted} ok</span>}
                    {d.review_counts?.rejected > 0 && <span className="chip-err num">{d.review_counts.rejected} rej</span>}
                    {d.review_counts?.pending > 0 && <span className="chip-warn num">{d.review_counts.pending} pending</span>}
                  </>
                )}
              </div>
            </button>
          ))}
          {datasets && !datasets.length && !listError && (
            <div className="p-4 text-[12.5px] text-ink-3">No LeRobot datasets in {root || 'the dataset folder'} yet.</div>
          )}
        </div>
        <div className="border-t border-rule px-3 py-2 text-[11px] text-ink-3 num truncate" title={root}>
          {root}
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <header className="bg-white border-b border-ink px-5 py-3 flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="label">Dataset</div>
            <h1 className="text-[20px] font-semibold tracking-tight truncate">{datasetId || '—'}</h1>
          </div>
          <Segmented value={tab} onChange={(t) => dispatch(setDataTab(t))} options={TABS} />
        </header>

        <div className="flex-1 overflow-y-auto overflow-x-hidden scroll-thin p-5">
          {tab === 'tools' ? (
            <div className="sheet">
              <EditDatasetPage isActive />
            </div>
          ) : !datasetId ? (
            <Empty title="No dataset selected">Record episodes in Record; they appear here automatically.</Empty>
          ) : error ? (
            <Callout tone="err" title="Cannot read dataset">
              {error}
            </Callout>
          ) : !overview || !episodes ? (
            <div className="grid place-items-center h-40">
              <Spinner />
            </div>
          ) : tab === 'overview' ? (
            <div className="grid gap-4 grid-cols-[minmax(0,1fr)]">
              <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
                <Stat label="Total episodes" value={overview.total_episodes} />
                <Stat label="Accepted" value={rc.accepted || 0} tone="ok" />
                <Stat label="Rejected" value={rc.rejected || 0} tone={rc.rejected ? 'err' : undefined} sub="kept in dataset" />
                <Stat
                  label="Pending review"
                  value={rc.pending ?? (rc.needs_review || 0) + (rc.unreviewed || 0)}
                  tone={rc.pending ? 'warn' : undefined}
                  sub={`${rc.needs_review || 0} later · ${rc.unreviewed || 0} new`}
                />
                <Stat label="Failed checks" value={overview.validation_failed || 0} tone={overview.validation_failed ? 'err' : undefined} />
                <Stat label="Duration" value={formatDuration(overview.duration_s)} />
                <Stat label="Size" value={formatBytes(overview.size_bytes)} />
              </div>
              <div className="night-panel flex flex-wrap items-center gap-4 px-5 py-4">
                <div className="flex-1 min-w-[240px]">
                  <div className="text-[11px] uppercase tracking-[0.08em] text-white/50">Next · Training</div>
                  <div className="text-[15px] mt-0.5">
                    Train a policy on this dataset
                    {rc.rejected ? ` — ${rc.rejected} rejected episode${rc.rejected > 1 ? 's' : ''} can be left out` : ''}
                  </div>
                </div>
                <button
                  className="btn bg-white text-ink hover:bg-white/90"
                  data-action="train-dataset"
                  onClick={() => {
                    dispatch(setTrainingDatasetPath(overview.id));
                    dispatch(moveToPage(PageType.LOCAL_TRAINING));
                  }}
                >
                  Train with this dataset →
                </button>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                <Sheet title="Dataset sheet" code="F1">
                  <KeyValue
                    rows={[
                      ['Dataset', overview.id],
                      ['Task', (overview.tasks || []).join(' · ') || '—'],
                      ['Robot type', overview.robot_type],
                      ['Planning type', overview.planning_type],
                      ['Plans', (overview.plans || []).map((p) => p.name).join(', ') || '—'],
                      ['Format', `LeRobot ${overview.codebase_version}`],
                      ['FPS', overview.fps],
                      ['Frames', overview.total_frames],
                      ['Cameras', (overview.cameras || []).map((c) => `${c.key.replace('observation.images.', '')} ${c.shape ? `${c.shape[1]}×${c.shape[0]}` : ''}`).join(', ')],
                      ['Joints', (overview.state_names || []).join(', ')],
                      ['Created', overview.created && new Date(overview.created).toLocaleString()],
                      ['Last change', overview.modified && new Date(overview.modified).toLocaleString()],
                      ['Location', <span className="num break-all">{overview.path}</span>],
                    ]}
                  />
                </Sheet>
                <Sheet title="Review progress" code="F1b">
                  <div className="flex h-3 rounded-pill overflow-hidden bg-paper-2 gap-[2px]">
                    {[
                      ['accepted', 'bg-signal-ok'],
                      ['needs_review', 'bg-signal-warn'],
                      ['rejected', 'bg-signal-err'],
                      ['unreviewed', 'bg-paper-3'],
                    ].map(([k, c]) => (
                      <div
                        key={k}
                        className={clsx('h-full', c)}
                        style={{ width: `${((rc[k] || 0) / Math.max(1, overview.total_episodes)) * 100}%` }}
                        title={`${k}: ${rc[k] || 0}`}
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-3 mt-2 text-[12px]">
                    {['accepted', 'needs_review', 'rejected', 'unreviewed'].map((k) => (
                      <span key={k}>
                        {k.replace('_', ' ')} <b className="num">{rc[k] || 0}</b>
                      </span>
                    ))}
                  </div>
                  <div className="mt-4">
                    <div className="label mb-1">Publish history</div>
                    {(overview.uploads || []).length ? (
                      <ul className="text-[12px] space-y-1">
                        {overview.uploads.map((u, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="num text-ink-3">{new Date(u.t).toLocaleString()}</span>
                            <span>{u.target}</span>
                            <span className="num truncate">{u.repo}</span>
                            <span className={u.status === 'success' ? 'chip-ok' : u.status === 'failed' ? 'chip-err' : 'chip'}>{u.status}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[12px] text-ink-3">Not published yet.</p>
                    )}
                  </div>
                  <div className="flex gap-2 mt-4">
                    <button className="btn btn-sm" onClick={() => dispatch(setDataTab('episodes'))}>
                      Review episodes →
                    </button>
                    <button className="btn-sky btn-sm" onClick={() => dispatch(setDataTab('publish'))}>
                      Publish →
                    </button>
                  </div>
                </Sheet>
              </div>
            </div>
          ) : tab === 'episodes' ? (
            <div className="grid gap-4 2xl:grid-cols-[380px_minmax(0,1fr)]">
              <Sheet title="Episodes" code="F" bodyClassName="p-0" className="self-start">
                <div className="p-3 border-b border-rule grid gap-2">
                  <Segmented
                    size="sm"
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: 'all', label: 'All' },
                      { value: 'pending', label: 'Pending' },
                      { value: 'accepted', label: 'Accepted' },
                      { value: 'rejected', label: 'Rejected' },
                    ]}
                  />
                  <TextInput value={query} onChange={setQuery} placeholder="Search index, plan episode, comment…" />
                </div>
                <div className="max-h-[62vh] overflow-auto scroll-thin">
                  <table className="w-full text-[12.5px]">
                    <tbody>
                      {rows.map((e) => (
                        <tr
                          key={e.episode_index}
                          onClick={() => setSelected(e.episode_index)}
                          className={clsx('border-b border-rule cursor-pointer', e.episode_index === selected ? 'bg-sky-50' : 'hover:bg-paper')}
                        >
                          <td className="px-3 py-1.5 num w-10">{e.episode_index}</td>
                          <td className="px-1 py-1.5 num text-ink-3">{formatDuration(e.duration_s)}</td>
                          <td className="px-1 py-1.5">{e.plan ? <span className={e.plan.superseded ? 'chip' : 'chip-sky'}>{e.plan.episode_id}</span> : <span className="text-ink-4">—</span>}</td>
                          <td className="px-1 py-1.5">
                            {e.validation && !e.validation.ok && <span className="chip-err mr-1">files</span>}
                            {e.binding_stale && <span className="chip-warn mr-1">moved</span>}
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <span
                              className={REVIEW_CHIP[e.review?.status] || 'chip'}
                              title={e.review?.comment || (e.review?.source === 'record' ? 'Reviewed in Record' : '')}
                            >
                              {e.review?.status === 'needs_review' ? 'pending' : (e.review?.status || 'new').replace('_', ' ')}
                              {e.review?.source === 'record' ? ' ·R' : ''}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!rows.length && <p className="p-4 text-[12.5px] text-ink-3">No episodes match.</p>}
                </div>
              </Sheet>
              <div className="min-w-0">
                {selected != null ? (
                  <EpisodeViewer
                    key={`${datasetId}:${selected}`}
                    datasetId={datasetId}
                    episodeIndex={selected}
                    call={call}
                    onReviewed={onReviewed}
                    onDelete={(idx) => setDeleting({ indices: [idx] })}
                    onRecollect={recollect}
                  />
                ) : (
                  <Empty title="Select an episode" />
                )}
                {(rc.rejected || 0) > 0 && (
                  <div className="mt-4">
                    <button
                      className="btn-danger btn-sm"
                      onClick={() =>
                        setDeleting({
                          indices: episodes.episodes.filter((e) => e.review?.status === 'rejected').map((e) => e.episode_index),
                        })
                      }
                    >
                      Delete all {rc.rejected} rejected episode(s)…
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <PublishPanel datasetId={datasetId} overview={overview} call={call} waitForJob={waitForJob} onPublished={loadDataset} />
          )}
        </div>
      </div>

      <Modal
        open={!!deleting}
        title="Delete episodes permanently?"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button className="btn" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button className="btn-danger" disabled={confirmText !== datasetId} onClick={doDelete}>
              Delete {deleting?.indices.length} episode(s)
            </button>
          </>
        }
      >
        <div className="grid gap-3 text-[13px]">
          <p>
            Episodes <span className="num">{deleting?.indices.join(', ')}</span> are removed from <b>{datasetId}</b> on disk.
            Later episodes are renumbered; reviews and plan links are updated to match. This cannot be undone.
          </p>
          <p className="text-ink-3">Type the dataset id to confirm.</p>
          <TextInput value={confirmText} onChange={setConfirmText} placeholder={datasetId} autoFocus />
        </div>
      </Modal>
      {job && (
        <div className="fixed bottom-4 right-4 sheet px-4 py-3 text-[12.5px] z-50 w-[320px]">
          <div className="flex justify-between">
            <span>{job.message}</span>
            <Spinner />
          </div>
        </div>
      )}
    </div>
  );
}
