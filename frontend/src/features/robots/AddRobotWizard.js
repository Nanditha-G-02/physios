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

// "Add Custom Robot": details -> files -> validation. The profile is saved as a draft as soon as
// the details are submitted, so an interrupted upload can be resumed from the library.
// Registering (Stage 1) happens on the robot's page after the report has been reviewed.

import React, { useRef, useState } from 'react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Callout, Field, Select, Sheet, Spinner, TextInput } from '../../components/ui';
import { ROBOT_TYPE_LABELS, createRobot, uploadFiles, validateRobot } from './robotsApi';

export function FilePicker({ onFiles, disabled }) {
  const fileRef = useRef(null);
  const dirRef = useRef(null);
  const [drag, setDrag] = useState(false);
  return (
    <div
      className={clsx(
        'rounded-2xl border border-dashed p-5 text-center transition-colors',
        drag ? 'border-sky-ink bg-sky-50' : 'border-paper-3 bg-white/60'
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (!disabled && e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files));
      }}
      data-file-picker
    >
      <div className="text-[13px] font-semibold">Drop a ZIP, a URDF / Xacro, or meshes here</div>
      <div className="text-[12px] text-ink-3 mt-1">
        Accepted: .zip · .urdf · .xacro · .stl · .dae · .obj (+ textures). Keep the folder layout the URDF refers to
        (e.g. <span className="font-mono">meshes/link1.stl</span>) — a ZIP of the robot&apos;s package is easiest.
      </div>
      <div className="mt-3 flex justify-center gap-2">
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => fileRef.current.click()}>
          Choose files…
        </button>
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => dirRef.current.click()}>
          Choose a folder…
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        accept=".zip,.urdf,.xacro,.xml,.stl,.dae,.obj,.mtl,.png,.jpg,.jpeg"
        onChange={(e) => {
          if (e.target.files.length) onFiles(Array.from(e.target.files));
          e.target.value = '';
        }}
        data-file-input
      />
      <input
        ref={dirRef}
        type="file"
        hidden
        webkitdirectory=""
        directory=""
        onChange={(e) => {
          if (e.target.files.length) onFiles(Array.from(e.target.files));
          e.target.value = '';
        }}
      />
    </div>
  );
}

export async function uploadAndValidate(id, files, setProgress) {
  const up = await uploadFiles(id, files, (i, n, name) => setProgress && setProgress({ i, n, name }));
  if (up.skipped.length) {
    toast(`Skipped ${up.skipped.length} file(s): ${up.skipped.slice(0, 3).join(', ')}${up.skipped.length > 3 ? '…' : ''}`, {
      icon: '!',
    });
  }
  try {
    return { profile: await validateRobot(id), uploaded: up.files };
  } catch (e) {
    if (e.status === 409 && /Several/.test(e.message)) return { needsEntry: e.message, uploaded: up.files };
    throw e;
  }
}

export default function AddRobotWizard({ onCancel, onCreated }) {
  const [meta, setMeta] = useState({ name: '', description: '', manufacturer: '', type: 'arm' });
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const set = (k) => (v) => setMeta((m) => ({ ...m, [k]: v }));

  const submit = async () => {
    setError('');
    if (!meta.name.trim()) {
      setError('Give the robot a name.');
      return;
    }
    if (!files.length) {
      setError('Add the robot description files (a ZIP or a URDF/Xacro with its meshes).');
      return;
    }
    setBusy(true);
    let created = null;
    try {
      created = await createRobot(meta);
      const r = await uploadAndValidate(created.id, files, setProgress);
      toast.success(r.needsEntry ? 'Uploaded — choose the main URDF file' : 'Uploaded and validated');
      onCreated(created.id);
    } catch (e) {
      setError(e.message);
      if (created) {
        toast.error('The draft was saved; finish the upload from the library.');
        onCreated(created.id);
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const hasDesc = files.some((f) => /\.(zip|urdf|xacro)$/i.test(f.name));
  return (
    <div data-add-robot>
    <Sheet title="Add custom robot" code="R+">
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="label">1 · Details</div>
          <Field label="Name" hint="Shown in the robot library. Must be unique.">
            <TextInput value={meta.name} onChange={set('name')} placeholder="e.g. Lab arm v2" data-field="name" maxLength={80} />
          </Field>
          <Field label="Description">
            <textarea
              className="input min-h-[72px]"
              value={meta.description}
              onChange={(e) => set('description')(e.target.value)}
              maxLength={1000}
              data-field="description"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Manufacturer">
              <TextInput value={meta.manufacturer} onChange={set('manufacturer')} data-field="manufacturer" maxLength={80} />
            </Field>
            <Field label="Robot type">
              <Select
                value={meta.type}
                onChange={set('type')}
                options={Object.entries(ROBOT_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
                data-field="type"
              />
            </Field>
          </div>
        </div>
        <div className="space-y-3">
          <div className="label">2 · Robot description files</div>
          <FilePicker onFiles={(f) => setFiles((old) => [...old, ...f])} disabled={busy} />
          {files.length > 0 && (
            <div className="rounded-2xl bg-paper px-3 py-2 text-[12px] max-h-[140px] overflow-y-auto scroll-thin" data-selected-files>
              <div className="flex items-center justify-between mb-1">
                <span className="label">{files.length} file(s) selected</span>
                <button className="btn-ghost text-[11.5px]" onClick={() => setFiles([])} disabled={busy}>
                  Clear
                </button>
              </div>
              {files.slice(0, 40).map((f, i) => (
                <div key={`${f.name}-${i}`} className="font-mono truncate">
                  {f.webkitRelativePath || f.name} <span className="text-ink-4">· {(f.size / 1024).toFixed(0)} KB</span>
                </div>
              ))}
              {files.length > 40 && <div className="text-ink-3">… and {files.length - 40} more</div>}
            </div>
          )}
          {files.length > 0 && !hasDesc && (
            <Callout tone="warn">No .zip, .urdf or .xacro selected yet — meshes alone cannot be validated.</Callout>
          )}
          <Callout tone="info" title="What happens next">
            The files are checked on this PC: nothing in them is run. Xacro is expanded by a restricted built-in expander (no
            Python, no <span className="font-mono">$(env)</span>). You then get a validation report and a 3D view. Adding a robot does
            not change the SO-101 setup and does not move any hardware.
          </Callout>
        </div>
      </div>
      {error && <div className="mt-4 rounded-xl bg-signal-errbg px-3 py-2 text-[12.5px]" data-wizard-error>{error}</div>}
      <div className="mt-4 flex items-center justify-end gap-2">
        {progress && (
          <span className="text-[12px] text-ink-3 mr-auto">
            Uploading {Math.min(progress.i + 1, progress.n)} / {progress.n} {progress.name}
          </span>
        )}
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn-primary" onClick={submit} disabled={busy} data-action="create-robot">
          {busy && <Spinner className="border-paper border-t-transparent" />}
          Upload & validate
        </button>
      </div>
    </Sheet>
    </div>
  );
}
