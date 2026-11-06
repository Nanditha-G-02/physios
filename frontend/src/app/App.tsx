import { Component, Suspense, lazy } from 'react';
import type { ReactNode } from 'react';
import { ErrorState, Loading, ToastProvider } from '@/design/ui';
import { RouterProvider, match, useRouter } from './router';
import { Shell } from './Shell';
import { SystemProvider } from './system';

const Dashboard = lazy(() => import('@/modules/dashboard/Dashboard'));
const Planning = lazy(() => import('@/modules/planning/PlanningStudio'));
const Recording = lazy(() => import('@/modules/recording/RecordingStudio'));
const Datasets = lazy(() => import('@/modules/datasets/DatasetLibrary'));
const Training = lazy(() => import('@/modules/training/TrainingStudio'));
const Optimization = lazy(() => import('@/modules/optimization/OptimizationStudio'));
const Evaluation = lazy(() => import('@/modules/evaluation/EvaluationStudio'));
const Inference = lazy(() => import('@/modules/inference/InferenceStudio'));
const Rollout = lazy(() => import('@/modules/rollout/RolloutStudio'));
const Robots = lazy(() => import('@/modules/robots/RobotManagement'));
const Settings = lazy(() => import('@/modules/settings/Settings'));

const ROUTES: [string, (p: Record<string, string>) => ReactNode][] = [
  ['/', () => <Dashboard />],
  ['/planning', () => <Planning />],
  ['/planning/:id', (p) => <Planning planId={p.id} />],
  ['/recording', () => <Recording />],
  ['/datasets', () => <Datasets />],
  ['/datasets/:owner/:name', (p) => <Datasets datasetId={`${p.owner}/${p.name}`} />],
  ['/training', () => <Training />],
  ['/training/new', () => <Training view="new" />],
  ['/training/runs/:id', (p) => <Training runId={p.id} />],
  ['/optimization', () => <Optimization />],
  ['/optimization/runs/:runId', (p) => <Optimization runId={p.runId} />],
  ['/optimization/sessions/:sid', (p) => <Optimization sessionId={p.sid} />],
  ['/evaluation', () => <Evaluation />],
  ['/inference', () => <Inference />],
  ['/rollout', () => <Rollout />],
  ['/robots', () => <Robots />],
  ['/robots/new', () => <Robots view="new" />],
  ['/robots/:id', (p) => <Robots robotId={p.id} />],
  ['/settings', () => <Settings />],
];

function Routes() {
  const { loc } = useRouter();
  for (const [pattern, render] of ROUTES) {
    const m = match(pattern, loc.path);
    if (m) return <Boundary key={loc.path}><Suspense fallback={<Loading />}>{render(m)}</Suspense></Boundary>;
  }
  return <div className="page"><ErrorState title="Not found" error={new Error(`No page at ${loc.path}`)} /></div>;
}

class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  componentDidCatch(error: unknown) { console.error(error); }
  render() {
    if (this.state.error) return <div className="page"><ErrorState title="This page crashed" error={this.state.error} onRetry={() => this.setState({ error: null })} /></div>;
    return this.props.children;
  }
}

export function App() {
  return (
    <RouterProvider>
      <ToastProvider>
        <SystemProvider>
          <Shell><Routes /></Shell>
        </SystemProvider>
      </ToastProvider>
    </RouterProvider>
  );
}
