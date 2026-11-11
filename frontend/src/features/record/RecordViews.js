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

// Original / Processed / Simulation / Multi-panel layouts for Record.
// "Original" is the unchanged ImageGrid (web_video_server MJPEG tiles).

import React, { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import ImageGrid from '../../components/ImageGrid';
import ProcessedCameraView from './ProcessedCameraView';
import SimulationView from './SimulationView';
import { Select } from '../../components/ui';

export const VIEW_OPTIONS = [
  { value: 'original', label: 'Original' },
  { value: 'processed', label: 'Processed' },
  { value: 'simulation', label: 'Simulation' },
  { value: 'multi', label: 'Multi-panel' },
];

function useProcessedTopic() {
  const topicList = useSelector((s) => s.ros.imageTopicList);
  const topics = useMemo(() => topicList || [], [topicList]);
  const [topic, setTopic] = useState(() => {
    try {
      return window.localStorage.getItem('pam.processed.topic') || '';
    } catch (e) {
      return '';
    }
  });
  useEffect(() => {
    if ((!topic || !topics.includes(topic)) && topics.length) {
      const main = topics.find((t) => !/gripper|wrist/i.test(t)) || topics[0];
      setTopic(main);
    }
  }, [topics, topic]);
  useEffect(() => {
    try {
      if (topic) window.localStorage.setItem('pam.processed.topic', topic);
    } catch (e) {
      /* ignore */
    }
  }, [topic]);
  return [topic, setTopic, topics];
}

function TopicPicker({ topic, setTopic, topics }) {
  if (topics.length <= 1) return null;
  return (
    <div className="absolute right-2 bottom-2 z-10 w-[240px]">
      <Select value={topic} onChange={setTopic} options={topics} className="bg-white/95 text-[12px] py-1" aria-label="Camera for processed view" />
    </div>
  );
}

export default function RecordViews({ view, isActive, items, plan, episode }) {
  const rosHost = useSelector((s) => s.ros.rosHost);
  const [topic, setTopic, topics] = useProcessedTopic();

  if (view === 'processed') {
    return (
      <div className="relative h-full w-full border border-ink">
        <ProcessedCameraView topic={topic} items={items} rosHost={rosHost} active={isActive} />
        <TopicPicker topic={topic} setTopic={setTopic} topics={topics} />
      </div>
    );
  }
  if (view === 'simulation') {
    return (
      <div className="h-full w-full border border-ink">
        <SimulationView plan={plan} episode={episode} active={isActive} />
      </div>
    );
  }
  if (view === 'multi') {
    return (
      <div className="h-full w-full grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] grid-rows-2 gap-2">
        <div className="row-span-2 min-h-0 flex items-center justify-center overflow-hidden border border-rule bg-white">
          <ImageGrid isActive={isActive} />
        </div>
        <div className="relative min-h-0 border border-ink">
          <ProcessedCameraView topic={topic} items={items} rosHost={rosHost} active={isActive} compact />
          <TopicPicker topic={topic} setTopic={setTopic} topics={topics} />
        </div>
        <div className="min-h-0 border border-ink">
          <SimulationView plan={plan} episode={episode} active={isActive} compact />
        </div>
      </div>
    );
  }
  return <ImageGrid isActive={isActive} />;
}
