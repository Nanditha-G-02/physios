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

// Development server only (npm start): mirrors the two routes nginx.conf adds
// in the production image.
//   /camera-stream/* -> web_video_server on :8080 (same-origin for the Processed view)
//   /lerobot-data/*  -> local LeRobot datasets (read-only, for episode videos)
//   /train-api/*     -> host training service (physios_trainer) on :8766
// Set LEROBOT_DATA_DIR to the dataset folder (default: ~/.cache/huggingface/lerobot).

const path = require('path');
const os = require('os');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function setupProxy(app) {
  const videoHost = process.env.WEB_VIDEO_SERVER || 'http://127.0.0.1:8080';
  app.use(
    '/camera-stream',
    createProxyMiddleware({ target: videoHost, changeOrigin: true, pathRewrite: { '^/camera-stream': '' } })
  );
  app.use(
    '/train-api',
    createProxyMiddleware({
      target: process.env.PAM_TRAINER || 'http://127.0.0.1:8766',
      changeOrigin: true,
      pathRewrite: { '^/train-api': '/api' },
    })
  );
  const dataDir =
    process.env.LEROBOT_DATA_DIR || path.join(os.homedir(), '.cache', 'huggingface', 'lerobot');
  app.use('/lerobot-data', express.static(dataDir, { dotfiles: 'deny', index: false, fallthrough: false }));
};
