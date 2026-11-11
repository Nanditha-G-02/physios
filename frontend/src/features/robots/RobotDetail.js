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

// One custom robot: 3D model, validation report, files and history, management actions, and
// (when present) the configuration and readiness tabs.

import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Callout, Field, KeyValue, Modal, Segmented, Select, Sheet, Spinner, TextInput } from '../../components/ui';
import UrdfViewer from './UrdfViewer';
import ValidationReport from './ValidationReport';
import { FilePicker, uploadAndValidate } from './AddRobotWizard';
import {
  ROBOT_TYPE_LABELS,
  deleteRobot,
  fetchResolvedUrdf,
  getRobot,
  registerRobot,
  replaceRobotFiles,
  updateRobot,
  validateRobot,
} from './robotsApi';

export const STAGE_NAMES = ['Draft', 'URDF registered', 'ROS verified', 'Hardware verified', 'Data & training ready'];

export function StageBadge({ stage, state }) {
  const s = state === 'registered' ? stage || 1 : 0;
  const cls = s >= 4 ? 'chip-ok' : s >= 1 ? 'chip-sky' : 'chip-warn';
  return (
    <span className={`${cls} text-[10.5px]`} data-stage={s}>
      {s === 0 ? 'Draft' : `Stage ${s} · ${STAGE_NAMES[s]}`}
    </span>
  );
}

function EditModal({ robot, onClose, onSaved }) {
  const [m, setM] = useState({
    name: robot.name,
    description: robot.description || '',
    manufacturer: robot.manufacturer || '',
    type: robot.type,
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await updateRobot(robot.id, m);
      toast.success('Saved');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title="Edit details"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy}>Save</button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name"><TextInput value={m.name} onChange={(v) => setM({ ...m, name: v })} maxLength={80} /></Field>
        <Field label="Description">
          <textarea className="input min-h-[72px]" value={m.description} onChange={(e) => setM({ ...m, description: e.target.value })} maxLength={1000} />
        </Field>
        <Field label="Manufacturer"><TextInput value={m.manufacturer} onChange={(v) => setM({ ...m, manufacturer: v })} maxLength={80} /></Field>
        <Field label="Type">
          <Select value={m.type} onChange={(v) => setM({ ...m, type: v })} options={Object.entries(ROBOT_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
        </Field>
      </div>
    </Modal>
  );
}

function ReplaceModal({ robot, onClose, onDone }) {
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const later = robot.state === 'registered';
  const go = async () => {
    setBusy(true);
    try {
      await replaceRobotFiles(robot.id);
      const r = await uploadAndValidate(robot.id, files);
      toast.success(r.needsEntry ? 'Uploaded — choose the main URDF file' : 'Replaced and validated');
      onDone();
      onClose();
    } catch (e) {
      toast.error(e.message);
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title="Replace URDF"
      onClose={() => !busy && onClose()}
      width="max-w-xl"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-danger" onClick={go} disabled={busy || !files.length} data-action="confirm-replace">
            {busy && <Spinner />} Replace files
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Callout tone="warn" title="All current files are removed">
          The robot returns to Draft. {later ? 'Its registration and every later verification stage (ROS, hardware, data) are reset and must be done again, because they were checked against the old model.' : ''}
          {' '}The configuration (topics, mapping) is kept.
        </Callout>
        <FilePicker onFiles={(f) => setFiles((o) => [...o, ...f])} disabled={busy} />
        {files.length > 0 && <div className="text-[12px] text-ink-3">{files.length} file(s) selected: {files.slice(0, 5).map((f) => f.name).join(', ')}{files.length > 5 ? '…' : ''}</div>}
      </div>
    </Modal>
  );
}

function DeleteModal({ robot, onClose, onDeleted }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await deleteRobot(robot.id, typed);
      toast.success(`${robot.name} deleted`);
      onDeleted();
    } catch (e) {
      toast.error(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title="Delete robot"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-danger" onClick={go} disabled={busy || typed !== robot.name} data-action="confirm-delete">
            Delete permanently
          </button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <p>
          This removes the profile, its uploaded files, configuration and verification history from this PC. Datasets and trained
          models are not touched. This cannot be undone.
        </p>
        <Field label={`Type "${robot.name}" to confirm`}>
          <TextInput value={typed} onChange={setTyped} data-field="confirm-name" />
        </Field>
      </div>
    </Modal>
  );
}

export default function RobotDetail({ robotId, onBack, onChanged, extraTabs = [] }) {
  const [robot, setRobot] = useState(null);
  const [urdf, setUrdf] = useState(null);
  const [tab, setTab] = useState('model');
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await getRobot(robotId);
      setRobot(r);
      setError('');
      if (r.validation && r.validation.summary && r.validation.summary.links) {
        try {
          setUrdf(await fetchResolvedUrdf(robotId));
        } catch (e) {
          setUrdf(null);
        }
      } else {
        setUrdf(null);
      }
    } catch (e) {
      setError(e.message);
    }
  }, [robotId]);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = async () => {
    await load();
    if (onChanged) onChanged();
  };

  const run = async (key, fn, ok) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
      refresh();
    }
  };

  if (error && !robot) {
    return (
      <Sheet title="Robot">
        <Callout tone="err" title="Could not load this robot">{error}</Callout>
        <button className="btn mt-3" onClick={onBack}>Back to library</button>
      </Sheet>
    );
  }
  if (!robot) {
    return (
      <div className="p-8 flex justify-center">
        <Spinner />
      </div>
    );
  }

  const v = robot.validation;
  const canRegister = robot.state !== 'registered' && v && v.status !== 'errors';
  const tabs = [
    { value: 'model', label: '3D model' },
    { value: 'validation', label: v ? `Validation · ${v.status}` : 'Validation' },
    ...extraTabs.map((t) => ({ value: t.value, label: t.label, disabled: t.disabled })),
    { value: 'files', label: 'Files & history' },
  ];
  const extra = extraTabs.find((t) => t.value === tab);

  return (
    <div className="grid gap-4" data-robot-detail={robot.id}>
      <Sheet
        title={robot.name}
        code="R"
        actions={
          <>
            <button className="btn btn-sm" onClick={onBack}>← Library</button>
            <button className="btn btn-sm" onClick={() => setModal('edit')}>Edit</button>
            <button className="btn btn-sm" onClick={() => setModal('replace')} data-action="replace">Replace URDF</button>
            <button className="btn btn-sm" onClick={() => run('validate', () => validateRobot(robot.id, robot.entry), 'Validated')} disabled={!!busy} data-action="revalidate">
              {busy === 'validate' && <Spinner />} Revalidate
            </button>
            <button className="btn-danger btn-sm" onClick={() => setModal('delete')} data-action="delete">Delete</button>
          </>
        }
      >
        <div className="flex items-start gap-6 flex-wrap">
          <div className="space-y-2 min-w-[260px] flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <StageBadge stage={robot.stage} state={robot.state} />
              <span className="chip text-[10.5px]">{ROBOT_TYPE_LABELS[robot.type] || robot.type}</span>
              {robot.connected && <span className="chip-ok text-[10.5px]">connected</span>}
              {robot.source && <span className="chip text-[10.5px]">{robot.source === 'xacro' ? 'from Xacro' : 'URDF'}</span>}
            </div>
            {robot.description && <p className="text-[13px] text-ink-2">{robot.description}</p>}
            <KeyValue
              rows={[
                ['Manufacturer', robot.manufacturer || '—'],
                ['Main file', robot.entry ? <span className="font-mono">{robot.entry}</span> : '—'],
                ['Profile id', <span className="font-mono">{robot.id}</span>],
              ]}
            />
          </div>
          <div className="min-w-[260px]">
            {robot.entry_candidates && !robot.entry && (
              <Callout tone="warn" title="Choose the main URDF / Xacro file">
                <div className="flex flex-col gap-1 mt-1">
                  {robot.entry_candidates.map((c) => (
                    <button key={c} className="btn btn-sm justify-start font-mono" onClick={() => run('validate', () => validateRobot(robot.id, c), 'Validated')}>
                      {c}
                    </button>
                  ))}
                </div>
              </Callout>
            )}
            {robot.state !== 'registered' ? (
              <Callout
                tone={canRegister ? 'info' : 'warn'}
                title={canRegister ? 'Ready to register (Stage 1)' : 'Not registered'}
                action={
                  canRegister ? (
                    <button className="btn-primary btn-sm" onClick={() => run('register', () => registerRobot(robot.id), 'Registered')} disabled={!!busy} data-action="register">
                      Register
                    </button>
                  ) : null
                }
              >
                {canRegister
                  ? 'Registering records this URDF as the robot model. Nothing is sent to hardware.'
                  : v
                  ? 'Fix the validation errors, then revalidate.'
                  : 'Upload the robot files to validate them.'}
              </Callout>
            ) : (
              <Callout tone="ok" title="URDF registered">
                Stage 1 is complete. {robot.stage >= 4 ? 'All stages are verified.' : 'Continue with configuration and readiness.'}
              </Callout>
            )}
          </div>
        </div>
      </Sheet>

      <Segmented size="sm" value={tab} onChange={setTab} options={tabs} />

      {tab === 'model' && (
        <Sheet title="3D model">
          {urdf ? (
            <UrdfViewer robotId={robot.id} urdfText={urdf} meshMap={v.summary.mesh_map || {}} tree={v.tree} />
          ) : (
            <div className="text-[13px] text-ink-3 py-6 text-center">The model is shown once a URDF has been read successfully.</div>
          )}
        </Sheet>
      )}
      {tab === 'validation' && (
        <Sheet title="Validation report">
          {v ? <ValidationReport report={v} /> : <div className="text-[13px] text-ink-3">Not validated yet.</div>}
        </Sheet>
      )}
      {extra && extra.render({ robot, refresh })}
      {tab === 'files' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Sheet title={`Files (${(robot.files || []).length})`}>
            <div className="max-h-[360px] overflow-y-auto scroll-thin text-[12px] font-mono space-y-0.5" data-file-list>
              {(robot.files || []).map((f) => (
                <div key={f} className={f === robot.entry ? 'font-semibold' : ''}>{f}{f === robot.entry ? '  ← main' : ''}</div>
              ))}
              {!(robot.files || []).length && <div className="text-ink-3 font-sans">No files.</div>}
            </div>
          </Sheet>
          <Sheet title="History">
            <div className="max-h-[360px] overflow-y-auto scroll-thin text-[12px] space-y-1" data-history>
              {(robot.history || []).slice().reverse().map((h, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-ink-4 font-mono shrink-0">{new Date(h.t).toLocaleString()}</span>
                  <span>{h.text}</span>
                </div>
              ))}
            </div>
          </Sheet>
        </div>
      )}

      {modal === 'edit' && <EditModal robot={robot} onClose={() => setModal(null)} onSaved={refresh} />}
      {modal === 'replace' && <ReplaceModal robot={robot} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'delete' && (
        <DeleteModal
          robot={robot}
          onClose={() => setModal(null)}
          onDeleted={() => {
            setModal(null);
            if (onChanged) onChanged();
            onBack();
          }}
        />
      )}
    </div>
  );
}
