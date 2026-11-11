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

// Custom robot profiles on the host service (/train-api/robots). Uploaded files are sent as
// raw bytes and checked on the server; nothing in them is ever executed.

import { TRAINER_BASE, TrainerOffline, trainerFetch } from '../../hooks/useTrainer';

export const ROBOT_TYPE_LABELS = {
  arm: 'Robot arm',
  mobile_manipulator: 'Mobile manipulator',
  gripper: 'Gripper / end effector',
  humanoid: 'Humanoid',
  other: 'Other',
};

export const listRobots = () => trainerFetch('/robots');
export const getRobot = (id) => trainerFetch(`/robots/${id}`);
export const createRobot = (meta) => trainerFetch('/robots', { method: 'POST', body: meta });
const act = (id, action, body) => trainerFetch(`/robots/${id}/${action}`, { method: 'POST', body: body || {} });
export const updateRobot = (id, meta) => act(id, 'update', meta);
export const validateRobot = (id, entry) => act(id, 'validate', entry ? { entry } : {});
export const registerRobot = (id) => act(id, 'register');
export const replaceRobotFiles = (id) => act(id, 'replace');
export const connectRobot = (id, connected) => act(id, 'connect', { connected });
export const deleteRobot = (id, confirmName) => act(id, 'delete', { confirm_name: confirmName });

export const assetUrl = (id, path) =>
  `${TRAINER_BASE}/robots/${id}/asset/${path.split('/').map(encodeURIComponent).join('/')}`;

export async function fetchResolvedUrdf(id) {
  const res = await fetch(assetUrl(id, 'resolved.urdf'), { cache: 'no-store' });
  if (!res.ok) throw new Error('The resolved URDF is not available yet.');
  return res.text();
}

async function uploadRaw(id, query, blob) {
  let res;
  try {
    res = await fetch(`${TRAINER_BASE}/robots/${id}/upload?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
  } catch (e) {
    throw new TrainerOffline('The training service is not reachable.');
  }
  if (res.status === 413) throw new Error('The upload is too large.');
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    throw new TrainerOffline('Unexpected answer from /train-api.');
  }
  if (!res.ok) throw new Error((data && data.error) || `Upload failed (${res.status})`);
  return data;
}

// files: FileList/array. ZIPs are unpacked on the server; other files keep their folder path
// (webkitRelativePath when a folder was chosen) so mesh references still resolve.
export async function uploadFiles(id, files, onProgress) {
  const out = { files: [], skipped: [] };
  const list = Array.from(files || []);
  for (let i = 0; i < list.length; i += 1) {
    const f = list[i];
    const isZip = /\.zip$/i.test(f.name);
    const q = isZip ? 'kind=zip' : `path=${encodeURIComponent(f.webkitRelativePath || f.relPath || f.name)}`;
    if (onProgress) onProgress(i, list.length, f.name);
    const r = await uploadRaw(id, q, f);
    out.files.push(...(r.files || []));
    out.skipped.push(...(r.skipped || []));
  }
  if (onProgress) onProgress(list.length, list.length, '');
  return out;
}
