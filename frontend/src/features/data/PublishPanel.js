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

// Publishing: Hugging Face (the whole LeRobot dataset, via the existing upload
// worker and /huggingface/status progress) and GitHub (metadata only).

import React, { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import toast from 'react-hot-toast';
import { useRosServiceCaller } from '../../hooks/useRosServiceCaller';
import HFStatus from '../../constants/HFStatus';
import {
  Callout,
  Field,
  ProgressBar,
  Select,
  Sheet,
  Spinner,
  TextInput,
  Toggle,
  formatBytes,
} from '../../components/ui';

export default function PublishPanel({ datasetId, overview, call, waitForJob, onPublished }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <HuggingFaceCard datasetId={datasetId} overview={overview} call={call} onPublished={onPublished} />
      <GitHubCard datasetId={datasetId} call={call} waitForJob={waitForJob} onPublished={onPublished} />
    </div>
  );
}

function HuggingFaceCard({ datasetId, overview, call, onPublished }) {
  const { registerHFUser, controlHfServer } = useRosServiceCaller();
  const hfStatus = useSelector((s) => s.editDataset.hfStatus);
  const upload = useSelector((s) => s.editDataset.uploadStatus);
  const [account, setAccount] = useState(null);
  const [accountError, setAccountError] = useState('');
  const [token, setToken] = useState('');
  const [owner, setOwner] = useState('');
  const [name, setName] = useState(datasetId.split('/')[1]);
  const [isPrivate, setIsPrivate] = useState(true);
  const [withMeta, setWithMeta] = useState(true);
  const [repos, setRepos] = useState([]);
  const [busy, setBusy] = useState('');
  const [started, setStarted] = useState(null);

  const loadAccount = useCallback(async () => {
    try {
      const a = await call('data.hf_account', {});
      setAccount(a);
      setAccountError('');
      setOwner((o) => o || a.name);
    } catch (e) {
      setAccount(null);
      setAccountError(e.message);
    }
  }, [call]);

  useEffect(() => {
    loadAccount();
  }, [loadAccount]);

  useEffect(() => {
    setName(datasetId.split('/')[1]);
  }, [datasetId]);

  useEffect(() => {
    if (!owner || !account) return;
    call('data.hf_repos', { author: owner })
      .then((r) => setRepos(r.repos))
      .catch(() => setRepos([]));
  }, [owner, account, call]);

  // record the outcome of the upload we started
  useEffect(() => {
    if (!started) return;
    if (hfStatus === HFStatus.SUCCESS || hfStatus === HFStatus.FAILED) {
      call('data.record_upload', {
        dataset_id: datasetId,
        target: 'huggingface',
        repo: started,
        status: hfStatus === HFStatus.SUCCESS ? 'success' : 'failed',
      }).catch(() => {});
      setStarted(null);
      onPublished && onPublished();
    }
  }, [hfStatus, started, call, datasetId, onPublished]);

  const signIn = async () => {
    setBusy('token');
    try {
      const res = await registerHFUser(token.trim());
      if (res && res.success) {
        setToken('');
        toast.success('Hugging Face token registered');
        await loadAccount();
      } else {
        toast.error((res && res.message) || 'Token rejected');
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };

  const repoId = `${owner}/${name}`;
  const exists = repos.find((r) => r.id === repoId);
  const rejected = overview?.review_counts?.rejected || 0;
  const uploading = [HFStatus.UPLOADING, HFStatus.PROCESSING].includes(hfStatus);

  const start = async () => {
    setBusy('upload');
    try {
      const prep = await call('data.hf_prepare', {
        dataset_id: datasetId,
        repo_id: repoId,
        private: isPrivate,
        include_metadata: withMeta,
      });
      if (prep.note) toast(prep.note, { icon: 'ℹ' });
      const res = await controlHfServer('upload', repoId, 'dataset', prep.local_dir);
      if (!res || !res.success) throw new Error((res && res.message) || 'Upload worker refused the request');
      setStarted(repoId);
      toast.success(`Uploading to ${repoId}`);
    } catch (e) {
      toast.error(e.message);
      call('data.record_upload', { dataset_id: datasetId, target: 'huggingface', repo: repoId, status: 'failed', message: e.message }).catch(() => {});
    } finally {
      setBusy('');
    }
  };

  return (
    <Sheet title="Hugging Face Hub" code="G1">
      <div className="grid gap-3 grid-cols-[minmax(0,1fr)]">
        {account ? (
          <div className="flex items-center gap-2 border border-rule bg-paper px-3 py-2">
            {account.avatar_url && <img src={account.avatar_url} alt="" className="h-6 w-6 border border-ink" />}
            <div className="text-[12.5px]">
              Signed in as <b>{account.name}</b>
              {account.orgs?.length > 0 && <span className="text-ink-3"> · orgs: {account.orgs.join(', ')}</span>}
            </div>
          </div>
        ) : (
          <div className="grid gap-2">
            <Callout tone="warn" title="Not signed in">
              {accountError || 'Register a Hugging Face write token. It is stored by huggingface_hub on the server and never shown again.'}
            </Callout>
            <div className="flex gap-2">
              <TextInput type="password" value={token} onChange={setToken} placeholder="hf_…" autoComplete="off" />
              <button className="btn-primary" disabled={!token.trim() || busy === 'token'} onClick={signIn}>
                {busy === 'token' ? <Spinner className="border-paper border-t-transparent" /> : 'Register'}
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-[1fr_1.4fr] gap-2">
          <Field label="Owner">
            <Select
              value={owner}
              onChange={setOwner}
              disabled={!account}
              options={account ? [account.name, ...(account.orgs || [])] : [owner || '—']}
            />
          </Field>
          <Field label="Dataset repository" hint={exists ? `Exists (${exists.private ? 'private' : 'public'}) — new files are added.` : 'Will be created.'}>
            <TextInput value={name} onChange={(v) => setName(v.replace(/[^A-Za-z0-9_.-]/g, '_'))} list="hf-repos" />
            <datalist id="hf-repos">
              {repos.map((r) => (
                <option key={r.id} value={r.id.split('/')[1]} />
              ))}
            </datalist>
          </Field>
        </div>
        <div className="flex flex-wrap gap-4">
          <Toggle checked={isPrivate} onChange={setIsPrivate} label={isPrivate ? 'Private repository' : 'Public repository'} disabled={!!exists} />
          <Toggle checked={withMeta} onChange={setWithMeta} label="Include plan & review metadata" />
        </div>
        {rejected > 0 && (
          <Callout tone="warn" title={`${rejected} rejected episode(s) are still in the dataset`}>
            The whole dataset is uploaded. Delete rejected episodes in the Episodes tab first if they should not be published;
            otherwise their review status travels in meta/episode_reviews.json.
          </Callout>
        )}
        <div className="text-[12px] text-ink-3">
          {formatBytes(overview?.size_bytes)} · {overview?.total_episodes} episodes · LeRobot {overview?.codebase_version}
        </div>
        {(uploading || started) && (
          <div className="grid gap-1">
            <div className="flex justify-between text-[12px]">
              <span>{hfStatus}</span>
              <span className="num">
                {upload.current}/{upload.total}
              </span>
            </div>
            <ProgressBar value={Number(upload.percentage) || 0} total={100} tone="sky" showText />
          </div>
        )}
        <div className="flex gap-2 justify-end">
          {uploading && (
            <button className="btn" onClick={() => controlHfServer('cancel').catch((e) => toast.error(e.message))}>
              Cancel
            </button>
          )}
          <button className="btn-primary" disabled={!account || !owner || !name || uploading || !!busy} onClick={start}>
            {busy === 'upload' && <Spinner className="border-paper border-t-transparent" />}
            Upload to {repoId}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function GitHubCard({ datasetId, call, waitForJob, onPublished }) {
  const [status, setStatus] = useState(null);
  const [token, setToken] = useState('');
  const [repos, setRepos] = useState([]);
  const [repo, setRepo] = useState('');
  const [branches, setBranches] = useState([]);
  const [branch, setBranch] = useState('');
  const [prefix, setPrefix] = useState(`datasets/${datasetId.split('/')[1]}`);
  const [hfRepo, setHfRepo] = useState(datasetId);
  const [files, setFiles] = useState([]);
  const [newRepo, setNewRepo] = useState('');
  const [newPrivate, setNewPrivate] = useState(true);
  const [busy, setBusy] = useState('');
  const [job, setJob] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const s = await call('github.status', {});
      setStatus(s);
      if (s.signed_in) {
        const r = await call('github.repos', {});
        setRepos(r.repos);
      }
    } catch (e) {
      setStatus({ signed_in: false, error: e.message });
    }
  }, [call]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    setPrefix(`datasets/${datasetId.split('/')[1]}`);
    setHfRepo(datasetId);
  }, [datasetId]);

  useEffect(() => {
    if (!repo) return;
    const r = repos.find((x) => x.full_name === repo);
    call('github.branches', { repo })
      .then((b) => {
        setBranches(b.branches);
        setBranch(r?.default_branch || b.branches[0] || 'main');
      })
      .catch((e) => toast.error(e.message));
  }, [repo, repos, call]);

  useEffect(() => {
    call('github.preview', { dataset_id: datasetId, prefix, hf_repo: hfRepo })
      .then((r) => setFiles(r.files))
      .catch(() => setFiles([]));
  }, [datasetId, prefix, hfRepo, call]);

  const signIn = async () => {
    setBusy('token');
    try {
      await call('github.set_token', { token });
      setToken('');
      await refresh();
      toast.success('GitHub connected');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };

  const create = async () => {
    setBusy('create');
    try {
      const r = await call('github.create_repo', { name: newRepo, private: newPrivate, description: `Collection metadata for ${datasetId}` });
      toast.success(`Created ${r.full_name}`);
      setNewRepo('');
      await refresh();
      setRepo(r.full_name);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };

  const publish = async () => {
    setBusy('publish');
    try {
      const j = await call('github.publish', { dataset_id: datasetId, repo, branch, prefix, hf_repo: hfRepo || null });
      setJob(j);
      const done = await waitForJob(j, setJob);
      toast.success('Metadata committed to GitHub');
      setJob(done);
      onPublished && onPublished();
    } catch (e) {
      toast.error(e.message);
      setJob((j) => (j ? { ...j, status: 'failed', message: e.message } : j));
    } finally {
      setBusy('');
    }
  };

  const total = files.reduce((a, f) => a + f.bytes, 0);

  return (
    <Sheet title="GitHub (metadata only)" code="G2">
      <div className="grid gap-3 grid-cols-[minmax(0,1fr)]">
        <p className="text-[12px] text-ink-3">
          Commits the plan, reviews, LeRobot metadata and a README that links to the Hugging Face dataset. Videos and
          frame data are never pushed to Git.
        </p>
        {status === null ? (
          <Spinner />
        ) : status.signed_in ? (
          <div className="flex items-center justify-between gap-2 border border-rule bg-paper px-3 py-2">
            <div className="flex items-center gap-2 text-[12.5px]">
              {status.user?.avatar_url && <img src={status.user.avatar_url} alt="" className="h-6 w-6 border border-ink" />}
              Signed in as <b>{status.user?.login}</b>
            </div>
            <button
              className="btn btn-sm"
              onClick={async () => {
                await call('github.logout', {});
                setRepos([]);
                setRepo('');
                refresh();
              }}
            >
              Sign out
            </button>
          </div>
        ) : (
          <div className="grid gap-2">
            {status.error && <Callout tone="err">{status.error}</Callout>}
            <Field label="Personal access token" hint="Fine-grained token with Contents: read & write (and Administration to create repos). Stored server-side with 0600 permissions.">
              <div className="flex gap-2">
                <TextInput type="password" value={token} onChange={setToken} placeholder="github_pat_…" autoComplete="off" />
                <button className="btn-primary" disabled={!token.trim() || busy === 'token'} onClick={signIn}>
                  {busy === 'token' ? <Spinner className="border-paper border-t-transparent" /> : 'Connect'}
                </button>
              </div>
            </Field>
          </div>
        )}
        {status?.signed_in && (
          <>
            <div className="grid grid-cols-[1.4fr_1fr] gap-2">
              <Field label="Repository">
                <Select
                  value={repo}
                  onChange={setRepo}
                  options={[{ value: '', label: 'Choose…', disabled: true }, ...repos.filter((r) => r.can_push).map((r) => ({ value: r.full_name, label: `${r.full_name}${r.private ? ' 🔒' : ''}` }))]}
                />
              </Field>
              <Field label="Branch" hint="A new name creates the branch.">
                <TextInput value={branch} onChange={setBranch} list="gh-branches" disabled={!repo} />
                <datalist id="gh-branches">
                  {branches.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              </Field>
            </div>
            <div className="flex gap-2 items-end">
              <Field label="…or create a repository" className="flex-1">
                <TextInput value={newRepo} onChange={setNewRepo} placeholder="robot-datasets" />
              </Field>
              <Toggle checked={newPrivate} onChange={setNewPrivate} label="Private" />
              <button className="btn" disabled={!newRepo.trim() || busy === 'create'} onClick={create}>
                Create
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Folder in repository">
                <TextInput value={prefix} onChange={setPrefix} />
              </Field>
              <Field label="Linked HF dataset (optional)">
                <TextInput value={hfRepo} onChange={setHfRepo} placeholder="owner/name" />
              </Field>
            </div>
          </>
        )}
        <div className="border border-rule bg-paper">
          <div className="flex justify-between px-3 py-1.5 border-b border-rule">
            <span className="label">Files to commit</span>
            <span className="num text-[11.5px] text-ink-3">{formatBytes(total)}</span>
          </div>
          <ul className="max-h-[140px] overflow-auto scroll-thin px-3 py-1.5 text-[12px] num">
            {files.map((f) => (
              <li key={f.path} className="flex justify-between gap-2">
                <span className="truncate min-w-0">{f.path}</span>
                <span className="text-ink-3 shrink-0">{formatBytes(f.bytes)}</span>
              </li>
            ))}
          </ul>
        </div>
        {job && (
          <div className="grid gap-1 text-[12px]">
            <div className="flex justify-between">
              <span>{job.message}</span>
              <span className="num">{job.status}</span>
            </div>
            <ProgressBar value={job.progress || 0} total={job.total || 1} tone="sky" />
            {job.result?.html_url && (
              <a className="underline text-sky-ink" href={job.result.html_url} target="_blank" rel="noreferrer">
                View commit {job.result.commit_sha?.slice(0, 7)} on {job.result.branch}
              </a>
            )}
          </div>
        )}
        <div className="flex justify-end">
          <button className="btn-primary" disabled={!status?.signed_in || !repo || !branch || busy === 'publish'} onClick={publish}>
            {busy === 'publish' && <Spinner className="border-paper border-t-transparent" />}
            Commit metadata
          </button>
        </div>
      </div>
    </Sheet>
  );
}
