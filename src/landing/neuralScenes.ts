/*
 * The three "Built for real AI agents" visuals (v8 landing
 * neural-networks.js), ported to a pure module: scene data, geometry and one `drawFrame` that
 * paints onto any 2D context. No DOM access here, so tests/landing-visuals.test.ts can run it
 * against a recording context. src/landing/NeuralCanvas.tsx owns the canvas, the animation loop
 * and the lifecycle (reduced motion, off-screen pause, theme changes).
 *
 * Rules from the design: transparent background (no grey panel), slow and calm motion, curved
 * connections only, no arrowheads anywhere. Labels are real names (room members, Downtown
 * project ids, the count log's steps); no invented numbers.
 */

export type Point = { x: number; y: number };

export type NodeKind = 'hub' | 'root' | 'node' | 'depth';

export type SceneNode = {
  id: string;
  label: string;
  /** Position as a fraction of the canvas width and height. */
  x: number;
  y: number;
  r: number;
  /** Depth: scales the ambient drift (background nodes drift less). */
  z: number;
  kind: NodeKind;
  driftSpeed: number;
  driftPhase: number;
};

export type SceneEdge = { from: string; to: string; curve: number };

export type SceneSignal = {
  from: string;
  to: string;
  next: string;
  progress: number;
  speed: number;
};

export type SceneId = 'collaboration' | 'openSource' | 'transparency';

export type Scene = {
  id: SceneId;
  /** The node every "core" edge touches; those edges are drawn in the active colour. */
  coreId: string;
  nodes: SceneNode[];
  edges: SceneEdge[];
  signals: SceneSignal[];
  /** Colour role of the travelling signals. */
  signalTone: 'signal' | 'accent' | 'green';
  /** Colour role of the ripples a signal leaves when it arrives. */
  rippleTone: 'signal' | 'green';
  rippleGrowth: number;
  /** Caption under the root node (transparency scene only). */
  rootCaption?: string;
};

/** Colours for one theme, read from the landing's CSS variables (see landing.css). */
export type Palette = {
  line: string;
  lineDepth: string;
  lineActive: string;
  nodeFill: string;
  nodeBorder: string;
  nodeCenter: string;
  nodeDot: string;
  depthFill: string;
  hubFill: string;
  hubBorder: string;
  hubGlow: string;
  signal: string;
  signalGlow: string;
  text: string;
  textMuted: string;
  accent: string;
  green: string;
  greenGlow: string;
  greenHalo: string;
  ripple: string;
  rippleGreen: string;
  font: string;
};

/** The light palette from the v8 mockup; used when the CSS variables cannot be read. */
export const LIGHT_PALETTE: Palette = {
  line: 'rgba(15, 23, 42, 0.11)',
  lineDepth: 'rgba(15, 23, 42, 0.05)',
  lineActive: 'rgba(0, 102, 255, 0.35)',
  nodeFill: '#ffffff',
  nodeBorder: 'rgba(15, 23, 42, 0.22)',
  nodeCenter: '#09090b',
  nodeDot: '#334155',
  depthFill: 'rgba(15, 23, 42, 0.25)',
  hubFill: 'rgba(0, 102, 255, 0.08)',
  hubBorder: '#0066ff',
  hubGlow: 'rgba(0, 102, 255, 0.25)',
  signal: '#0066ff',
  signalGlow: 'rgba(0, 102, 255, 0.45)',
  text: '#0f172a',
  textMuted: '#64748b',
  accent: '#0066ff',
  green: '#059669',
  greenGlow: 'rgba(5, 150, 105, 0.4)',
  greenHalo: 'rgba(5, 150, 105, 0.1)',
  ripple: '#0066ff',
  rippleGreen: '#10b981',
  font: "'Inter Variable', 'Inter Fallback', system-ui, sans-serif",
};

/** CSS custom property that carries each palette role (landing.css defines them per theme). */
export const PALETTE_VARIABLES: Record<Exclude<keyof Palette, 'font'>, string> = {
  line: '--lp-net-line',
  lineDepth: '--lp-net-line-depth',
  lineActive: '--lp-net-line-active',
  nodeFill: '--lp-net-node-fill',
  nodeBorder: '--lp-net-node-border',
  nodeCenter: '--lp-net-node-center',
  nodeDot: '--lp-net-node-dot',
  depthFill: '--lp-net-depth-fill',
  hubFill: '--lp-net-hub-fill',
  hubBorder: '--lp-net-hub-border',
  hubGlow: '--lp-net-hub-glow',
  signal: '--lp-net-signal',
  signalGlow: '--lp-net-signal-glow',
  text: '--lp-net-text',
  textMuted: '--lp-net-text-muted',
  accent: '--lp-net-accent',
  green: '--lp-net-green',
  greenGlow: '--lp-net-green-glow',
  greenHalo: '--lp-net-green-halo',
  ripple: '--lp-net-ripple',
  rippleGreen: '--lp-net-ripple-green',
};

/** Builds a palette from a CSS variable reader; any missing value keeps the light default. */
export function readPalette(read: (name: string) => string, font?: string): Palette {
  const palette: Palette = { ...LIGHT_PALETTE };
  for (const [role, variable] of Object.entries(PALETTE_VARIABLES) as [
    Exclude<keyof Palette, 'font'>,
    string,
  ][]) {
    const value = read(variable).trim();
    if (value) palette[role] = value;
  }
  if (font && font.trim()) palette.font = font.trim();
  return palette;
}

// ---------------------------------------------------------------------------------------------
// Geometry

/** A point on the quadratic Bézier p0 → p1 with control point cp, at t in [0, 1]. */
export function bezierPoint(p0: Point, cp: Point, p1: Point, t: number): Point {
  const inv = 1 - t;
  return {
    x: inv * inv * p0.x + 2 * inv * t * cp.x + t * t * p1.x,
    y: inv * inv * p0.y + 2 * inv * t * cp.y + t * t * p1.y,
  };
}

/** The control point that bends the edge p0 → p1 sideways by `curvature` pixels. */
export function controlPoint(p0: Point, p1: Point, curvature: number): Point {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    x: (p0.x + p1.x) / 2 - (dy / length) * curvature,
    y: (p0.y + p1.y) / 2 + (dx / length) * curvature,
  };
}

// ---------------------------------------------------------------------------------------------
// Scenes (positions, radii, curves and speeds as in the v8 mockup)

const node = (
  id: string,
  label: string,
  x: number,
  y: number,
  r: number,
  z: number,
  driftSpeed: number,
  driftPhase: number,
  kind: NodeKind = 'node',
): SceneNode => ({ id, label, x, y, r, z, kind, driftSpeed, driftPhase });

/** Collaboration: the room members around one room. */
const collaboration: Scene = {
  id: 'collaboration',
  coreId: 'room',
  signalTone: 'signal',
  rippleTone: 'signal',
  rippleGrowth: 0.25,
  nodes: [
    node('room', 'Room', 0.5, 0.5, 16, 1, 0.0006, 0, 'hub'),
    node('chatgpt', 'ChatGPT', 0.2, 0.28, 7, 1, 0.0008, 1.2),
    node('claude', 'Claude', 0.8, 0.26, 7, 1, 0.0009, 2.4),
    node('gemini', 'Gemini', 0.82, 0.74, 7, 1, 0.0007, 3.6),
    node('mia', 'Mia', 0.22, 0.74, 7, 1, 0.0008, 4.8),
    node('host', 'Host', 0.5, 0.16, 6, 1, 0.0007, 0.8),
    node('grok', 'Grok', 0.5, 0.84, 6, 1, 0.0008, 5.2),
    node('custom', 'Custom', 0.34, 0.44, 5.5, 0.9, 0.0009, 3.1),
    node('relay1', '', 0.34, 0.18, 3.5, 0.45, 0.0011, 0.4, 'depth'),
    node('relay2', '', 0.66, 0.18, 3.5, 0.45, 0.001, 1.7, 'depth'),
    node('relay3', '', 0.68, 0.82, 3.5, 0.45, 0.0012, 3.3, 'depth'),
    node('relay4', '', 0.32, 0.82, 3.5, 0.45, 0.001, 4.5, 'depth'),
    node('relay5', '', 0.68, 0.5, 4, 0.55, 0.0009, 2.1, 'depth'),
  ],
  edges: [
    { from: 'chatgpt', to: 'room', curve: 12 },
    { from: 'claude', to: 'room', curve: -14 },
    { from: 'gemini', to: 'room', curve: 12 },
    { from: 'mia', to: 'room', curve: -12 },
    { from: 'host', to: 'room', curve: 8 },
    { from: 'grok', to: 'room', curve: -8 },
    { from: 'custom', to: 'room', curve: 6 },
    { from: 'chatgpt', to: 'host', curve: -10 },
    { from: 'host', to: 'claude', curve: 10 },
    { from: 'claude', to: 'gemini', curve: 16 },
    { from: 'mia', to: 'grok', curve: -10 },
    { from: 'grok', to: 'gemini', curve: 12 },
    { from: 'chatgpt', to: 'relay1', curve: 4 },
    { from: 'relay1', to: 'host', curve: -4 },
    { from: 'claude', to: 'relay2', curve: -5 },
    { from: 'gemini', to: 'relay5', curve: 6 },
    { from: 'relay5', to: 'room', curve: -6 },
    { from: 'mia', to: 'relay4', curve: 5 },
    { from: 'gemini', to: 'relay3', curve: -4 },
  ],
  signals: [
    { from: 'mia', to: 'room', next: 'claude', progress: 0.1, speed: 0.0018 },
    { from: 'chatgpt', to: 'room', next: 'gemini', progress: 0.55, speed: 0.0016 },
    { from: 'claude', to: 'room', next: 'chatgpt', progress: 0.35, speed: 0.002 },
    { from: 'gemini', to: 'room', next: 'grok', progress: 0.8, speed: 0.0017 },
    { from: 'custom', to: 'room', next: 'mia', progress: 0.25, speed: 0.0019 },
  ],
};

/** Open source: Downtown projects (their real ids, public/downtown.json) around the protocol. */
const openSource: Scene = {
  id: 'openSource',
  coreId: 'protocol',
  signalTone: 'accent',
  rippleTone: 'signal',
  rippleGrowth: 0.25,
  nodes: [
    node('protocol', 'protocol', 0.36, 0.5, 13, 1, 0.0006, 0, 'hub'),
    node('connector', 'connector', 0.64, 0.28, 9, 1, 0.0008, 1.5),
    node('conformance', 'conformance-kit', 0.66, 0.72, 9, 1, 0.0007, 2.8),
    node('sdk', 'sdk', 0.86, 0.48, 8, 1, 0.0009, 4.1),
    node('count', 'agent-count', 0.16, 0.5, 8, 1, 0.0008, 5),
    node('quickstart', 'quickstart', 0.16, 0.22, 5, 0.9, 0.0011, 0.7),
    node('examples', 'examples', 0.16, 0.78, 5, 0.9, 0.001, 3.5),
    node('bridge', 'mcp-bridge', 0.86, 0.22, 5, 0.9, 0.0012, 2),
    node('reference', 'reference', 0.86, 0.78, 5, 0.9, 0.0011, 4.6),
    node('dep1', '', 0.48, 0.22, 3.5, 0.45, 0.0012, 1.1, 'depth'),
    node('dep2', '', 0.5, 0.78, 3.5, 0.45, 0.001, 3.9, 'depth'),
    node('dep3', '', 0.76, 0.5, 3.5, 0.5, 0.0011, 2.2, 'depth'),
    node('dep4', '', 0.26, 0.34, 3, 0.4, 0.0013, 4.8, 'depth'),
  ],
  edges: [
    { from: 'quickstart', to: 'protocol', curve: 8 },
    { from: 'examples', to: 'protocol', curve: -8 },
    { from: 'count', to: 'protocol', curve: 6 },
    { from: 'protocol', to: 'connector', curve: -12 },
    { from: 'protocol', to: 'conformance', curve: 12 },
    { from: 'connector', to: 'sdk', curve: -10 },
    { from: 'conformance', to: 'sdk', curve: 10 },
    { from: 'connector', to: 'conformance', curve: 14 },
    { from: 'connector', to: 'bridge', curve: -6 },
    { from: 'conformance', to: 'reference', curve: 6 },
    { from: 'protocol', to: 'dep1', curve: 4 },
    { from: 'dep1', to: 'connector', curve: -4 },
    { from: 'protocol', to: 'dep2', curve: -5 },
    { from: 'dep2', to: 'conformance', curve: 5 },
    { from: 'connector', to: 'dep3', curve: 4 },
    { from: 'dep3', to: 'sdk', curve: -4 },
  ],
  signals: [
    { from: 'quickstart', to: 'protocol', next: 'connector', progress: 0.1, speed: 0.0017 },
    { from: 'examples', to: 'protocol', next: 'conformance', progress: 0.45, speed: 0.0016 },
    { from: 'protocol', to: 'connector', next: 'sdk', progress: 0.3, speed: 0.002 },
    { from: 'protocol', to: 'conformance', next: 'sdk', progress: 0.75, speed: 0.0018 },
    { from: 'count', to: 'protocol', next: 'connector', progress: 0.6, speed: 0.0017 },
  ],
};

/**
 * Transparency: the count log's steps converging into the verified count. The mockup printed a
 * sample number in the root; the real count lives in the hero ticker, so the root shows a check.
 */
const transparency: Scene = {
  id: 'transparency',
  coreId: 'root',
  signalTone: 'green',
  rippleTone: 'green',
  rippleGrowth: 0.3,
  rootCaption: 'verified count',
  nodes: [
    node('root', '', 0.78, 0.5, 18, 1, 0.0005, 0, 'root'),
    node('b1', 'branch α', 0.46, 0.32, 8.5, 1, 0.0007, 1.2),
    node('b2', 'branch β', 0.46, 0.68, 8.5, 1, 0.0007, 2.6),
    node('w1', 'agent joins', 0.22, 0.2, 6, 0.95, 0.0009, 0.8),
    node('w2', 'checkpoint', 0.22, 0.4, 6, 0.95, 0.0008, 2.1),
    node('w3', 'signature', 0.22, 0.6, 6, 0.95, 0.0009, 3.4),
    node('w4', 'witness copy', 0.22, 0.8, 6, 0.95, 0.0008, 4.7),
    node('leaf1', '', 0.08, 0.16, 3.5, 0.5, 0.0012, 0.3, 'depth'),
    node('leaf2', '', 0.08, 0.3, 3.5, 0.5, 0.0011, 1.5, 'depth'),
    node('leaf3', '', 0.08, 0.44, 3.5, 0.5, 0.001, 2.7, 'depth'),
    node('leaf4', '', 0.08, 0.58, 3.5, 0.5, 0.0012, 3.9, 'depth'),
    node('leaf5', '', 0.08, 0.72, 3.5, 0.5, 0.0011, 5.1, 'depth'),
    node('leaf6', '', 0.08, 0.86, 3.5, 0.5, 0.0013, 0.9, 'depth'),
  ],
  edges: [
    { from: 'leaf1', to: 'w1', curve: 4 },
    { from: 'leaf2', to: 'w1', curve: -4 },
    { from: 'leaf3', to: 'w2', curve: 4 },
    { from: 'leaf4', to: 'w3', curve: -4 },
    { from: 'leaf5', to: 'w4', curve: 4 },
    { from: 'leaf6', to: 'w4', curve: -4 },
    { from: 'w1', to: 'b1', curve: -8 },
    { from: 'w2', to: 'b1', curve: 6 },
    { from: 'w3', to: 'b2', curve: -6 },
    { from: 'w4', to: 'b2', curve: 8 },
    { from: 'b1', to: 'root', curve: -12 },
    { from: 'b2', to: 'root', curve: 12 },
  ],
  signals: [
    { from: 'w1', to: 'b1', next: 'root', progress: 0.1, speed: 0.0018 },
    { from: 'w2', to: 'b1', next: 'root', progress: 0.45, speed: 0.0017 },
    { from: 'w3', to: 'b2', next: 'root', progress: 0.25, speed: 0.0019 },
    { from: 'w4', to: 'b2', next: 'root', progress: 0.6, speed: 0.0018 },
    { from: 'b1', to: 'root', next: 'w1', progress: 0.5, speed: 0.0021 },
    { from: 'b2', to: 'root', next: 'w3', progress: 0.7, speed: 0.002 },
  ],
};

export const SCENES: Record<SceneId, Scene> = { collaboration, openSource, transparency };

// ---------------------------------------------------------------------------------------------
// State and drawing

export type Ripple = { x: number; y: number; r: number; alpha: number };

export type LiveSignal = SceneSignal & { origin: { from: string; to: string }; hops: number };

export type SceneState = {
  /** Frames elapsed at 60 fps (fractional when the display runs at another rate). */
  time: number;
  signals: LiveSignal[];
  ripples: Ripple[];
  rootPulse: number;
};

export function createState(scene: Scene): SceneState {
  return {
    time: 0,
    signals: scene.signals.map((signal) => ({
      ...signal,
      origin: { from: signal.from, to: signal.to },
      hops: 0,
    })),
    ripples: [],
    rootPulse: 0,
  };
}

/** Named nodes connected to `id` (depth nodes are scenery; signals do not wander into them). */
export function neighbours(scene: Scene, id: string): string[] {
  const kinds = new Map(scene.nodes.map((n) => [n.id, n.kind]));
  const out: string[] = [];
  for (const edge of scene.edges) {
    const other = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
    if (other && kinds.get(other) !== 'depth' && !out.includes(other)) out.push(other);
  }
  return out;
}

/**
 * Where a signal goes after reaching `signal.to`. It only ever travels along a drawn edge (the
 * mockup sometimes jumped between unconnected nodes): its planned `next` when connected, else
 * another neighbour in turn, else back. In the transparency scene every signal that reaches
 * the verified count starts over from where it began, so the flow always converges.
 */
export function routeOnward(scene: Scene, signal: LiveSignal) {
  const arrived = signal.to;
  const previous = signal.from;
  signal.hops++;
  if (scene.id === 'transparency' && arrived === scene.coreId) {
    signal.from = signal.origin.from;
    signal.to = signal.origin.to;
    return;
  }
  const options = neighbours(scene, arrived);
  const onward = options.filter((id) => id !== previous);
  let to: string;
  if (signal.next && signal.next !== arrived && options.includes(signal.next)) to = signal.next;
  else if (onward.length) to = onward[signal.hops % onward.length]!;
  else to = previous;
  signal.from = arrived;
  signal.to = to;
  signal.next = previous;
}

export type Pointer = { x: number; y: number } | null;
type Positioned = Point & { hover: number };

const HOVER_RADIUS = 65;

/** Where each node is drawn this frame: base position, ambient drift, gentle pull to the pointer. */
export function nodePositions(
  scene: Scene,
  state: SceneState,
  width: number,
  height: number,
  motion: boolean,
  pointer: Pointer,
): Record<string, Positioned> {
  const positions: Record<string, Positioned> = {};
  for (const n of scene.nodes) {
    let x = n.x * width;
    let y = n.y * height;
    if (motion) {
      x += Math.sin(state.time * n.driftSpeed + n.driftPhase) * 4 * n.z;
      y += Math.cos(state.time * n.driftSpeed * 0.85 + n.driftPhase) * 3 * n.z;
    }
    let hover = 0;
    if (pointer) {
      const distance = Math.hypot(x - pointer.x, y - pointer.y);
      if (distance < HOVER_RADIUS) {
        hover = 1 - distance / HOVER_RADIUS;
        x += (pointer.x - x) * hover * 0.12;
        y += (pointer.y - y) * hover * 0.12;
      }
    }
    positions[n.id] = { x, y, hover };
  }
  return positions;
}

/** The subset of CanvasRenderingContext2D the visuals use (tests pass a recording fake). */
export type Canvas2D = Pick<
  CanvasRenderingContext2D,
  | 'clearRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'quadraticCurveTo'
  | 'arc'
  | 'fill'
  | 'stroke'
  | 'fillText'
  | 'save'
  | 'restore'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
  | 'shadowColor'
  | 'shadowBlur'
  | 'globalAlpha'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
>;

export type FrameOptions = {
  width: number;
  height: number;
  /** False under prefers-reduced-motion: one still frame, nothing advances. */
  motion: boolean;
  /** Frames to advance, in 60 fps units (1 on a 60 Hz display). Ignored when motion is off. */
  step: number;
  pointer: Pointer;
};

function edgeBetween(scene: Scene, from: string, to: string) {
  return scene.edges.find(
    (edge) => (edge.from === from && edge.to === to) || (edge.from === to && edge.to === from),
  );
}

/** Curvature for travelling from → to along its edge (negated when walked backwards). */
export function curvatureFor(scene: Scene, from: string, to: string): number {
  const edge = edgeBetween(scene, from, to);
  if (!edge) return 8;
  return edge.from === from ? edge.curve : -edge.curve;
}

const TAU = Math.PI * 2;

function circle(ctx: Canvas2D, p: Point, r: number) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, TAU);
}

/**
 * Advances the scene by `options.step` frames (when motion is on) and paints one frame.
 * The canvas is cleared, never filled: the visual sits directly on the card.
 */
export function drawFrame(
  ctx: Canvas2D,
  scene: Scene,
  state: SceneState,
  palette: Palette,
  options: FrameOptions,
) {
  const { width, height, motion, pointer } = options;
  const step = motion ? Math.max(0, Math.min(options.step, 4)) : 0;
  state.time += step;
  const nodesById = new Map(scene.nodes.map((n) => [n.id, n]));
  const positions = nodePositions(scene, state, width, height, motion, pointer);

  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 1. Curved connections (quadratic curves; never arrowheads).
  for (const edge of scene.edges) {
    const a = positions[edge.from];
    const b = positions[edge.to];
    if (!a || !b) continue;
    const cp = controlPoint(a, b, edge.curve || 8);
    const depth =
      nodesById.get(edge.from)?.kind === 'depth' || nodesById.get(edge.to)?.kind === 'depth';
    const core = edge.from === scene.coreId || edge.to === scene.coreId;
    const hovered = a.hover > 0.1 || b.hover > 0.1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(cp.x, cp.y, b.x, b.y);
    if (hovered) {
      ctx.strokeStyle = palette.lineActive;
      ctx.lineWidth = 1.4;
    } else if (core) {
      ctx.strokeStyle = palette.lineActive;
      ctx.lineWidth = scene.id === 'transparency' ? 1.1 : 1;
    } else if (depth) {
      ctx.strokeStyle = palette.lineDepth;
      ctx.lineWidth = 0.6;
    } else {
      ctx.strokeStyle = palette.line;
      ctx.lineWidth = 0.8;
    }
    ctx.stroke();
  }

  // 2. Ripples left by arriving signals: they widen and fade.
  state.ripples = state.ripples.filter((ripple) => ripple.alpha > 0.01);
  ctx.strokeStyle = scene.rippleTone === 'green' ? palette.rippleGreen : palette.ripple;
  ctx.lineWidth = 1;
  for (const ripple of state.ripples) {
    ctx.globalAlpha = ripple.alpha * 0.45;
    circle(ctx, ripple, ripple.r);
    ctx.stroke();
    if (step > 0) {
      ripple.r += scene.rippleGrowth * step;
      ripple.alpha *= Math.pow(0.96, step);
    }
  }
  ctx.globalAlpha = 1;

  // 3. Signals: soft droplets gliding along the curves.
  const signalColor =
    scene.signalTone === 'green'
      ? palette.green
      : scene.signalTone === 'accent'
        ? palette.accent
        : palette.signal;
  const signalGlow = scene.signalTone === 'green' ? palette.greenGlow : palette.signalGlow;
  for (const signal of state.signals) {
    if (step > 0) {
      signal.progress += signal.speed * step;
      if (signal.progress >= 1) {
        signal.progress = 0;
        const arrived = positions[signal.to];
        if (arrived) {
          if (scene.id === 'transparency') {
            if (signal.to === scene.coreId) {
              state.rootPulse = 1;
              state.ripples.push({ x: arrived.x, y: arrived.y, r: 18, alpha: 0.6 });
            }
          } else {
            const target = nodesById.get(signal.to);
            state.ripples.push({ x: arrived.x, y: arrived.y, r: target?.r ?? 8, alpha: 0.5 });
          }
        }
        routeOnward(scene, signal);
      }
    }
    const p0 = positions[signal.from];
    const p1 = positions[signal.to];
    if (!p0 || !p1) continue;
    const cp = controlPoint(p0, p1, curvatureFor(scene, signal.from, signal.to));
    const point = bezierPoint(p0, cp, p1, signal.progress);
    circle(ctx, point, scene.signalTone === 'signal' ? 2.8 : 2.6);
    ctx.fillStyle = signalColor;
    ctx.shadowColor = signalGlow;
    ctx.shadowBlur = scene.signalTone === 'accent' ? 5 : 6;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  if (step > 0) state.rootPulse *= Math.pow(0.94, step);

  // 4. Nodes on top.
  for (const n of scene.nodes) {
    const pos = positions[n.id];
    if (!pos) continue;
    const r = n.r + pos.hover * 1.8;
    const hovered = pos.hover > 0.1;
    if (n.kind === 'depth') {
      circle(ctx, pos, r);
      ctx.fillStyle = palette.depthFill;
      ctx.fill();
      continue;
    }
    if (n.kind === 'root') {
      circle(ctx, pos, r + state.rootPulse * 5 + 8);
      ctx.fillStyle = palette.greenHalo;
      ctx.fill();
      circle(ctx, pos, r);
      ctx.fillStyle = palette.nodeFill;
      ctx.strokeStyle = palette.green;
      ctx.lineWidth = 1.8;
      ctx.shadowColor = palette.greenGlow;
      ctx.shadowBlur = 8 + state.rootPulse * 8;
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
      // A check mark: verified.
      ctx.beginPath();
      ctx.moveTo(pos.x - 6, pos.y + 0.5);
      ctx.lineTo(pos.x - 1.5, pos.y + 5);
      ctx.lineTo(pos.x + 6.5, pos.y - 4.5);
      ctx.strokeStyle = palette.green;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (scene.rootCaption) {
        ctx.font = `600 9.5px ${palette.font}`;
        ctx.fillStyle = palette.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(scene.rootCaption, pos.x, pos.y + r + 13);
      }
      continue;
    }
    if (n.kind === 'hub') {
      if (scene.id === 'collaboration') {
        circle(ctx, pos, r + 6);
        ctx.fillStyle = palette.hubFill;
        ctx.fill();
      }
      circle(ctx, pos, r);
      ctx.fillStyle = scene.id === 'collaboration' ? palette.nodeFill : palette.hubFill;
      ctx.strokeStyle = palette.hubBorder;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = palette.hubGlow;
      ctx.shadowBlur = scene.id === 'collaboration' ? (hovered ? 12 : 6) : 8;
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
      circle(ctx, pos, 3.5);
      ctx.fillStyle = palette.accent;
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = palette.text;
      if (scene.id === 'collaboration') {
        ctx.font = `600 11px ${palette.font}`;
        ctx.fillText(n.label, pos.x, pos.y + r + 13);
      } else {
        ctx.font = `600 10px ${palette.font}`;
        ctx.fillText(n.label, pos.x, n.y > 0.5 ? pos.y + r + 10 : pos.y - r - 5);
      }
      continue;
    }
    // A named node.
    circle(ctx, pos, r);
    ctx.fillStyle = palette.nodeFill;
    ctx.strokeStyle = hovered ? palette.accent : palette.nodeBorder;
    ctx.lineWidth = hovered ? 1.5 : 1.1;
    ctx.fill();
    ctx.stroke();
    circle(ctx, pos, scene.id === 'collaboration' ? 2.4 : 2.2);
    ctx.fillStyle = hovered
      ? palette.accent
      : scene.id === 'collaboration'
        ? palette.nodeDot
        : palette.nodeCenter;
    ctx.fill();
    if (n.label) {
      ctx.font = `500 ${scene.id === 'collaboration' ? 9.5 : 9}px ${palette.font}`;
      ctx.fillStyle = hovered ? palette.accent : palette.textMuted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const below = n.y > 0.5;
      ctx.fillText(
        n.label,
        pos.x,
        below ? pos.y + r + (scene.id === 'collaboration' ? 11 : 10) : pos.y - r - 5,
      );
    }
  }
}
