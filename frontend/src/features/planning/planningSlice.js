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

// UI-side state shared between Planning, Record and Data. The plans themselves
// live on the server (/planning/command) so they survive restarts.

import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  editingPlanId: null, // plan open in the Planning session
  recordMode: 'plan', // 'plan' (approved plan drives recording) | 'free' (original panel)
  recordState: null, // last record.state result
  selectedEpisodeId: null, // plan episode currently set up in Record
  dataDatasetId: null, // dataset open in the Data session
  dataTab: 'overview',
  rolloutTarget: null, // {run_id, step} handed from Training to Inference (host rollout)
  cameraCheck: null, // last camera match check {at, level, dataset, cameras}
  trainingDatasetPath: null, // host path of the dataset handed from Data to Training
  trainingRunId: null, // run open in the Training session
};

const planningSlice = createSlice({
  name: 'planning',
  initialState,
  reducers: {
    setEditingPlanId: (state, action) => {
      state.editingPlanId = action.payload;
    },
    setRecordMode: (state, action) => {
      state.recordMode = action.payload;
    },
    setRecordState: (state, action) => {
      state.recordState = action.payload;
    },
    setSelectedEpisodeId: (state, action) => {
      state.selectedEpisodeId = action.payload;
    },
    setDataDatasetId: (state, action) => {
      state.dataDatasetId = action.payload;
    },
    setDataTab: (state, action) => {
      state.dataTab = action.payload;
    },
    setRolloutTarget: (state, action) => {
      state.rolloutTarget = action.payload;
    },
    setCameraCheck: (state, action) => {
      state.cameraCheck = action.payload;
    },
    setTrainingDatasetPath: (state, action) => {
      state.trainingDatasetPath = action.payload;
    },
    setTrainingRunId: (state, action) => {
      state.trainingRunId = action.payload;
    },
  },
});

export const {
  setEditingPlanId,
  setRecordMode,
  setRecordState,
  setSelectedEpisodeId,
  setDataDatasetId,
  setDataTab,
  setRolloutTarget,
  setCameraCheck,
  setTrainingDatasetPath,
  setTrainingRunId,
} = planningSlice.actions;

export default planningSlice.reducer;
