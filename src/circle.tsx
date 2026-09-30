import type { Agent, Capability, Connection, Job, Workflow } from '../shared/types';

/*
 * Circle geometry: Central City's system motif for equivalent exchange.
 * An agent is a node glyph (a sigil): an outer ring, one inner ring per lineage level and an
 * inscribed figure for its capability. A permitted route is an arc inscribed in the city circle.
 * An exchange is a circle with a given half and a returned half that closes only on acceptance.
 * All geometry is original; nothing here reproduces third-party artwork or symbols.
 */

const figureSides: Record<Capability, number> = { research: 3, extract: 4, verify: 6 };
export const capabilityFigure: Record<Capability, string> = {
  research: 'triangle',
  extract: 'square',
  verify: 'hexagon',
};

function polygon(sides: number, radius: number, cx = 0, cy = 0) {
  const offset = sides === 4 ? Math.PI / 4 : -Math.PI / 2;
  return Array.from({ length: sides }, (_, index) => {
    const angle = offset + (index * Math.PI * 2) / sides;
    return `${(cx + Math.cos(angle) * radius).toFixed(2)},${(cy + Math.sin(angle) * radius).toFixed(2)}`;
  }).join(' ');
}

export type SigilAgent = Pick<Agent, 'capability'> &
  Partial<Pick<Agent, 'createdBy' | 'depth' | 'parentAgentId' | 'status' | 'pausedAt'>>;

export function aiCreated(agent: Pick<Agent, 'createdBy'>) {
  return Boolean(agent.createdBy && agent.createdBy.kind !== 'owner');
}

export function lineageDepth(agent: Partial<Pick<Agent, 'depth' | 'parentAgentId'>>) {
  return Math.min(3, Math.max(agent.depth ?? 0, agent.parentAgentId ? 1 : 0));
}

/** Sigil shapes centred on 0,0 with an outer radius of 21 units. */
export function SigilShapes({ agent }: { agent: SigilAgent }) {
  const depth = lineageDepth(agent);
  const rings = [17.5, 15, 12.5].slice(0, depth);
  const figureRadius = depth ? 12.5 - depth * 1.2 : 12;
  return (
    <g className="sigil-shapes">
      <circle r="21" className="sigil-outer" pathLength={1} />
      {rings.map((radius) => (
        <circle key={radius} r={radius} className="sigil-lineage" pathLength={1} />
      ))}
      <polygon
        points={polygon(figureSides[agent.capability], figureRadius)}
        className="sigil-figure"
        pathLength={1}
      />
      <circle r="2" className="sigil-core" />
      {aiCreated(agent) ? <circle cy="-21" r="3.2" className="sigil-seal" /> : null}
    </g>
  );
}

export function AgentSigil({
  agent,
  size = 'medium',
  transmuting = false,
}: {
  agent: SigilAgent;
  size?: 'small' | 'medium' | 'large';
  transmuting?: boolean;
}) {
  const status = agent.pausedAt ? 'paused' : agent.status;
  return (
    <span
      className={`sigil sigil-${size} ${status ? `sigil-${status}` : ''} ${transmuting ? 'transmuting' : ''}`}
      aria-hidden="true"
    >
      <svg viewBox="-24 -24 48 48" focusable="false">
        <SigilShapes agent={agent} />
      </svg>
    </span>
  );
}

export type ExchangeState =
  'requested' | 'in_progress' | 'review' | 'accepted' | 'failed' | 'canceled';

export const exchangeLabels: Record<ExchangeState, string> = {
  requested: 'Waiting to start',
  in_progress: 'In progress',
  review: 'Needs your review',
  accepted: 'Accepted',
  failed: 'Failed',
  canceled: 'Canceled',
};

export function jobExchangeState(job: Pick<Job, 'status' | 'acceptance'>): ExchangeState {
  if (job.acceptance === 'accepted') return 'accepted';
  if (job.status === 'queued') return 'requested';
  if (job.status === 'running') return 'in_progress';
  if (job.status === 'completed') return 'review';
  return job.status;
}

export function workflowExchangeState(status: Workflow['status']): ExchangeState {
  if (status === 'briefing' || status === 'checking') return 'in_progress';
  if (status === 'awaiting_review' || status === 'completed') return 'review';
  return status;
}

/** What was given for a job. Hosted demos and zero-cost agents never move money. */
export function budgetLabel(job: Pick<Job, 'costCents' | 'isDemo'>) {
  if (job.costCents === null) return job.isDemo ? 'Free demo' : 'Cost not tracked';
  if (job.costCents === 0) return 'Free';
  return `$${(job.costCents / 100).toFixed(2)} recorded`;
}

/**
 * The exchange circle. The left half is what was given; the right half is what came back.
 * Only an owner's acceptance joins the two halves into a closed circle.
 */
export function ExchangeCircle({
  state,
  size = 'medium',
  label,
}: {
  state: ExchangeState;
  size?: 'small' | 'medium' | 'large';
  label?: string;
}) {
  const r = 26;
  // Returned half: from the bottom (32,58) clockwise back up towards the top (32,6).
  const returned =
    state === 'review'
      ? // Stops short of the top: the circle waits for a decision.
        `M32 58 A${r} ${r} 0 0 0 ${(32 + r * Math.sin((42 * Math.PI) / 180)).toFixed(2)} ${(32 - r * Math.cos((42 * Math.PI) / 180)).toFixed(2)}`
      : state === 'failed'
        ? `M32 58 A${r} ${r} 0 0 0 ${(32 + r * Math.sin((120 * Math.PI) / 180)).toFixed(2)} ${(32 - r * Math.cos((120 * Math.PI) / 180)).toFixed(2)}`
        : `M32 58 A${r} ${r} 0 0 0 32 6`;
  return (
    <span
      className={`exchange-circle exchange-${size} exchange-state-${state}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox="0 0 64 64" focusable="false">
        <line x1="32" y1="10" x2="32" y2="54" className="exchange-axis" />
        <path d={`M32 6 A${r} ${r} 0 0 0 32 58`} className="exchange-given" />
        {state === 'canceled' ? null : (
          <path d={returned} className="exchange-returned" pathLength={1} />
        )}
        {state === 'failed' ? (
          <path
            d="M50.5 42.5 l5 5 m0 -5 l-5 5"
            className="exchange-break"
            transform="translate(0 -4)"
          />
        ) : null}
        {state === 'accepted' ? <circle cx="32" cy="32" r="17" className="exchange-seal" /> : null}
        <circle cx="6" cy="32" r="3" className="exchange-node given" />
        <circle cx="58" cy="32" r="3" className="exchange-node returned" />
        <circle cx="32" cy="32" r="2.5" className="exchange-core" />
      </svg>
    </span>
  );
}

/** The city circle: agents placed on one ring, permitted routes as arcs inscribed within it. */
export function CityCircle({
  agents,
  connections,
  selectedId,
  onSelect,
  fresh,
  labels,
}: {
  agents: Agent[];
  connections: Connection[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  fresh: Set<string>;
  labels: (agent: Agent) => { name: string; detail: string; aria: string };
}) {
  const visible = agents.filter((agent) => !agent.revokedAt).slice(0, 24);
  const cx = 450,
    cy = 270,
    R = visible.length > 12 ? 215 : 195;
  const positions = new Map(
    visible.map((agent, index) => {
      const angle =
        visible.length === 1 ? -Math.PI / 2 : -Math.PI / 2 + (index * Math.PI * 2) / visible.length;
      return [agent.id, { x: cx + Math.cos(angle) * R, y: cy + Math.sin(angle) * R, angle }];
    }),
  );
  const routes = connections.filter(
    (item) => positions.has(item.fromAgentId) && positions.has(item.toAgentId),
  );
  const showLabels = visible.length <= 12;
  return (
    <svg
      className="city-circle"
      viewBox="0 0 900 540"
      role="group"
      aria-label={`Agent map: ${visible.length} ${visible.length === 1 ? 'agent' : 'agents'} and ${routes.length} ${routes.length === 1 ? 'connection' : 'connections'}. Arrows point the way work may travel.`}
    >
      <defs>
        <marker
          id="route-head"
          markerWidth="9"
          markerHeight="9"
          refX="7.5"
          refY="4"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0,0 L8,4 L0,8" className="route-head" />
        </marker>
      </defs>
      <circle cx={cx} cy={cy} r={R + 16} className="circle-ring outer" />
      <circle cx={cx} cy={cy} r={R} className="circle-ring" />
      <circle cx={cx} cy={cy} r={R * 0.42} className="circle-ring inner" />
      {visible.length >= 3 ? (
        <polygon
          points={visible
            .map((agent) => {
              const p = positions.get(agent.id)!;
              return `${(cx + (p.x - cx) * 0.42).toFixed(1)},${(cy + (p.y - cy) * 0.42).toFixed(1)}`;
            })
            .join(' ')}
          className="circle-figure"
        />
      ) : null}
      {visible.map((agent) => {
        const p = positions.get(agent.id)!;
        return (
          <line
            key={`tick-${agent.id}`}
            x1={cx + Math.cos(p.angle) * (R + 8)}
            y1={cy + Math.sin(p.angle) * (R + 8)}
            x2={cx + Math.cos(p.angle) * (R + 24)}
            y2={cy + Math.sin(p.angle) * (R + 24)}
            className="circle-tick"
          />
        );
      })}
      {routes.map((connection) => {
        const a = positions.get(connection.fromAgentId)!,
          b = positions.get(connection.toAgentId)!;
        const mx = (a.x + b.x) / 2,
          my = (a.y + b.y) / 2;
        // Pull the control point towards the centre so every route is inscribed in the circle.
        const qx = cx + (mx - cx) * 0.3,
          qy = cy + (my - cy) * 0.3;
        const trim = (from: { x: number; y: number }, to: { x: number; y: number }) => {
          const d = Math.hypot(to.x - from.x, to.y - from.y) || 1;
          return { x: from.x + ((to.x - from.x) / d) * 34, y: from.y + ((to.y - from.y) / d) * 34 };
        };
        const start = trim(a, { x: qx, y: qy }),
          end = trim(b, { x: qx, y: qy });
        return (
          <path
            key={connection.id}
            d={`M${start.x.toFixed(1)} ${start.y.toFixed(1)} Q${qx.toFixed(1)} ${qy.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`}
            className="circle-route"
            markerEnd="url(#route-head)"
          />
        );
      })}
      <text x={cx} y={cy - 6} textAnchor="middle" className="circle-center-count">
        {visible.length.toString().padStart(2, '0')}
      </text>
      <text x={cx} y={cy + 16} textAnchor="middle" className="circle-center-label">
        {visible.length === 1 ? 'AGENT' : 'AGENTS'} · {routes.length}{' '}
        {routes.length === 1 ? 'CONNECTION' : 'CONNECTIONS'}
      </text>
      {visible.map((agent) => {
        const p = positions.get(agent.id)!;
        const text = labels(agent);
        const lx = cx + Math.cos(p.angle) * (R + 50),
          ly = cy + Math.sin(p.angle) * (R + 44) - (Math.sin(p.angle) < -0.5 ? 18 : 0);
        const anchor = Math.abs(lx - cx) < 40 ? 'middle' : lx > cx ? 'start' : 'end';
        const status = agent.pausedAt ? 'paused' : agent.status;
        return (
          <g
            key={agent.id}
            className={`circle-node sigil-${status} ${selectedId === agent.id ? 'selected' : ''} ${fresh.has(agent.id) ? 'transmuting' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={text.aria}
            onClick={() => onSelect(agent.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(agent.id);
              }
            }}
          >
            <circle cx={p.x} cy={p.y} r="31" className="node-plate" />
            <g transform={`translate(${p.x} ${p.y}) scale(1.2)`}>
              <SigilShapes agent={agent} />
            </g>
            <circle
              cx={p.x + 22}
              cy={p.y - 22}
              r="5"
              className={`node-presence presence-${status}`}
            />
            {showLabels ? (
              <>
                <text x={lx} y={ly} textAnchor={anchor} className="node-label">
                  {text.name}
                </text>
                <text x={lx} y={ly + 20} textAnchor={anchor} className="node-detail">
                  {text.detail}
                </text>
              </>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** A static illustration of the motif for brand entry points. It depicts no live activity. */
export function CourtIllustration({ className = '' }: { className?: string }) {
  const cx = 200,
    cy = 200,
    R = 150;
  const nodes = [0, 1, 2, 3, 4].map((index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / 5;
    return { x: cx + Math.cos(angle) * R, y: cy + Math.sin(angle) * R };
  });
  const shapes: Capability[] = ['research', 'extract', 'verify', 'research', 'verify'];
  const arcs: [number, number][] = [
    [0, 2],
    [2, 3],
    [1, 4],
  ];
  return (
    <svg className={`court-illustration ${className}`} viewBox="0 0 400 400" aria-hidden="true">
      <circle cx={cx} cy={cy} r={R + 18} className="circle-ring outer" />
      <circle cx={cx} cy={cy} r={R} className="circle-ring" />
      <circle cx={cx} cy={cy} r={62} className="circle-ring inner" />
      <polygon
        points={nodes.map((n) => `${cx + (n.x - cx) * 0.41},${cy + (n.y - cy) * 0.41}`).join(' ')}
        className="circle-figure"
      />
      {arcs.map(([from, to]) => {
        const a = nodes[from]!,
          b = nodes[to]!;
        const qx = cx + ((a.x + b.x) / 2 - cx) * 0.3,
          qy = cy + ((a.y + b.y) / 2 - cy) * 0.3;
        return (
          <path
            key={`${from}-${to}`}
            d={`M${a.x} ${a.y} Q${qx} ${qy} ${b.x} ${b.y}`}
            className="circle-route"
          />
        );
      })}
      {nodes.map((n, index) => (
        <g key={index} transform={`translate(${n.x} ${n.y})`} className="circle-node static">
          <circle r="27" className="node-plate" />
          <SigilShapes agent={{ capability: shapes[index]!, depth: index === 3 ? 1 : 0 }} />
        </g>
      ))}
      <g transform="translate(168 168)">
        <path d="M32 6 A26 26 0 0 0 32 58" className="exchange-given" />
        <path d="M32 58 A26 26 0 0 0 32 6" className="exchange-returned" />
        <circle cx="32" cy="32" r="17" className="exchange-seal" />
      </g>
    </svg>
  );
}
