// Settings: effective configuration (read-only; edit physios/configuration/physios.env),
// service connections, appearance, environments and where data lives.
import { gateway } from '@/api/gateway';
import { trainer } from '@/api/trainer';
import { useAvailability, useSystem } from '@/app/system';
import { I } from '@/design/icons';
import { Badge, Button, Callout, CodeBlock, KV, Loading, Panel, StatusBadge, fmt } from '@/design/ui';
import { useLoad } from '@/hooks/data';
import { Page } from '../shared';

export default function Settings() {
  const { health, refreshHealth, rosLink } = useSystem();
  const av = useAvailability();
  const cfg = useLoad(() => gateway.config(), []);
  const envs = useLoad(() => trainer.envs(), [av.trainer], 0, av.trainer);
  const tsys = useLoad(() => trainer.system(), [av.trainer], 0, av.trainer);
  const c = cfg.data;
  return (
    <Page label="Settings" title="Settings" intro="PHYSIOS reads its configuration from the environment and physios/configuration/physios.env at start-up. Values shown here are the ones in effect.">
      <div className="grid g2">
        <div className="stack">
          <Panel title="Service connections" actions={<Button size="sm" icon={<I.refresh />} onClick={refreshHealth}>Check now</Button>}>
            {!health ? <Loading rows={3} /> : (
              <div className="stack-sm">
                {Object.entries(health.services).map(([k, s]) => <div key={k} className="row-between small"><span>{k.replace('_', ' ')}</span><span className="row"><span className="muted tiny ellipsis" style={{ maxWidth: 280 }}>{s.detail}</span><StatusBadge status={s.status} /></span></div>)}
                <div className="row-between small"><span>Browser ↔ ROS WebSocket (/ros)</span><StatusBadge status={rosLink === 'open' ? 'connected' : rosLink} /></div>
              </div>
            )}
          </Panel>
          <Panel title="Python environments" sub="Discovered by the training service">
            {!av.trainer ? <span className="small muted">Training service offline.</span> : !envs.data ? <Loading rows={2} /> : (
              <div className="stack-sm">{(envs.data.envs || []).map((e: any) => (
                <div key={e.name} className="row-between small"><span><b style={{ fontWeight: 500 }}>{e.name}</b> <span className="mono tiny muted">{e.prefix}</span></span><span className="row">{e.packages?.lerobot && <Badge>LeRobot {e.packages.lerobot}</Badge>}{e.lerobot_train ? <Badge tone="ok">can train</Badge> : <Badge>no lerobot-train</Badge>}</span></div>
              ))}</div>
            )}
          </Panel>
        </div>
        <div className="stack">
          <Panel title="Effective configuration">
            {!c ? <Loading rows={4} /> : (
              <KV items={[
                ['Gateway', `http://${c.host}:${c.port}${c.allow_remote ? ' (remote allowed)' : ''}`], ['Version', `${c.version} · up ${fmt.dur(c.uptime_s)}`],
                ['Training service', c.trainer_url], ['rosbridge', c.rosbridge_url], ['Camera server', c.camera_url],
                ['Dataset folders', <div className="mono tiny">{c.dataset_roots.map((r: string) => <div key={r}>{r}</div>)}</div>],
                ['Repository', <span className="mono tiny">{c.repo_root}</span>], ['Frontend', <span className="mono tiny">{c.frontend_dist}</span>],
                ['Config file', c.config_file ? <span className="mono tiny">{c.config_file}</span> : 'none (defaults + environment)'],
              ]} />
            )}
          </Panel>
          <Panel title="Training data locations">
            {!tsys.data ? <span className="small muted">{av.trainer ? 'Loading…' : 'Training service offline.'}</span> : <KV items={[['Runs and logs', <span className="mono tiny">{tsys.data.data_dir}</span>], ['Checkpoints', <span className="mono tiny">{tsys.data.output_root}</span>], ['Dataset roots', <div className="mono tiny">{(tsys.data.dataset_roots || []).map((r: string) => <div key={r}>{r}</div>)}</div>]]} />}
          </Panel>
          <Callout tone="info" title="Changing settings">Edit <code>physios/configuration/physios.env</code> (see <code>physios.env.example</code>) and restart with <code>./stop_physios.sh && ./start_physios.sh</code>.</Callout>
          <Panel title="API"><div className="small text-2">All PHYSIOS functions are available over HTTP. Contract: <code>physios/documentation/03-API.md</code>.</div><div className="mt"><CodeBlock text={`curl -s http://${c?.host || '127.0.0.1'}:${c?.port || 8700}/api/v1/health`} /></div></Panel>
        </div>
      </div>
    </Page>
  );
}
