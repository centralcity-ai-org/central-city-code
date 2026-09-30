import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIGHT_PALETTE,
  PALETTE_VARIABLES,
  SCENES,
  bezierPoint,
  controlPoint,
  createState,
  drawFrame,
  neighbours,
  readPalette,
  type Canvas2D,
  type Scene,
} from '../src/landing/neuralScenes.js';
import {
  SHOWCASE_MEMBERS,
  SHOWCASE_MESSAGES,
  SHOWCASE_LABEL,
} from '../src/landing/RoomShowcase.js';

/*
 * The v8 landing visuals (src/landing/neuralScenes.ts) and the room picture's sample data.
 * The canvas drawing runs against a recording context, so no browser is needed.
 */

type Call = { name: string; args: unknown[]; state: Record<string, unknown> };

/** A 2D context that records every call and the style that was current for it. */
function recorder() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    shadowColor: '',
    shadowBlur: 0,
    globalAlpha: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
  };
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => calls.push({ name: key, args, state: { ...target } });
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as Canvas2D;
  return { ctx, calls };
}

const size = { width: 360, height: 230 };

test('every scene is well formed: unique nodes, edges and signals between existing nodes', () => {
  for (const scene of Object.values(SCENES)) {
    const ids = scene.nodes.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length, `${scene.id}: duplicate node ids`);
    assert.ok(ids.includes(scene.coreId), `${scene.id}: core node exists`);
    for (const edge of scene.edges) {
      assert.ok(ids.includes(edge.from) && ids.includes(edge.to), `${scene.id}: ${edge.from}`);
      assert.notEqual(edge.from, edge.to);
    }
    for (const signal of scene.signals) {
      assert.ok(neighbours(scene, signal.from).includes(signal.to), `${scene.id} signal edge`);
      assert.ok(signal.speed > 0 && signal.speed <= 0.0025, 'slow, calm motion');
    }
    for (const n of scene.nodes) {
      assert.ok(n.x > 0 && n.x < 1 && n.y > 0 && n.y < 1, `${scene.id}/${n.id} inside`);
      assert.ok(n.driftSpeed <= 0.0015, 'gentle drift');
    }
  }
});

test('labels are real names: room members, Downtown projects, no sample numbers', () => {
  const labels = Object.values(SCENES).flatMap((scene) => scene.nodes.map((n) => n.label));
  for (const label of labels) assert.doesNotMatch(label, /\d{2,}/, label);
  const members = new Set(['Room', 'Host', 'Custom', ...SHOWCASE_MEMBERS.map((m) => m.name)]);
  for (const n of SCENES.collaboration.nodes)
    if (n.label) assert.ok(members.has(n.label), `${n.label} is a room member`);
});

test('Bézier helpers: endpoints, midpoint bend and a straight edge with no curve', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };
  const cp = controlPoint(a, b, 10);
  assert.deepEqual(cp, { x: 50, y: 10 });
  assert.deepEqual(bezierPoint(a, cp, b, 0), a);
  assert.deepEqual(bezierPoint(a, cp, b, 1), b);
  assert.deepEqual(bezierPoint(a, cp, b, 0.5), { x: 50, y: 5 });
  assert.deepEqual(controlPoint(a, b, 0), { x: 50, y: 0 });
  // Degenerate edge: no division by zero.
  const same = controlPoint(a, a, 8);
  assert.ok(Number.isFinite(same.x) && Number.isFinite(same.y));
});

test('connections are curves on a transparent canvas, with no arrowheads', () => {
  for (const scene of Object.values(SCENES)) {
    const { ctx, calls } = recorder();
    drawFrame(ctx, scene, createState(scene), LIGHT_PALETTE, {
      ...size,
      motion: true,
      step: 1,
      pointer: null,
    });
    // Cleared, never painted over with a panel.
    assert.deepEqual(calls[0], {
      name: 'clearRect',
      args: [0, 0, 360, 230],
      state: calls[0]!.state,
    });
    assert.equal(calls.filter((c) => c.name === 'fillRect' || c.name === 'rect').length, 0);
    assert.equal(calls.filter((c) => c.name === 'quadraticCurveTo').length, scene.edges.length);
    assert.equal(calls.filter((c) => c.name === 'bezierCurveTo').length, 0);
    // Straight segments are only the check mark inside the verified count (3 points).
    const lines = calls.filter((c) => c.name === 'lineTo').length;
    assert.equal(lines, scene.id === 'transparency' ? 2 : 0, scene.id);
    // Every labelled node's name is drawn.
    const texts = calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
    for (const n of scene.nodes) if (n.label) assert.ok(texts.includes(n.label), n.label);
  }
});

test('reduced motion paints one still frame: nothing drifts or advances', () => {
  for (const scene of Object.values(SCENES)) {
    const state = createState(scene);
    const before = JSON.stringify(state);
    const first = recorder();
    drawFrame(first.ctx, scene, state, LIGHT_PALETTE, {
      ...size,
      motion: false,
      step: 5,
      pointer: null,
    });
    assert.equal(JSON.stringify(state), before, `${scene.id}: state unchanged`);
    const second = recorder();
    drawFrame(second.ctx, scene, state, LIGHT_PALETTE, {
      ...size,
      motion: false,
      step: 5,
      pointer: null,
    });
    assert.deepEqual(
      second.calls.map((c) => [c.name, c.args]),
      first.calls.map((c) => [c.name, c.args]),
      `${scene.id}: identical frames`,
    );
  }
});

test('with motion, signals glide slowly and only ever along drawn edges', () => {
  for (const scene of Object.values(SCENES)) {
    const state = createState(scene);
    const start = state.signals.map((s) => s.progress);
    const { ctx } = recorder();
    drawFrame(ctx, scene, state, LIGHT_PALETTE, { ...size, motion: true, step: 1, pointer: null });
    state.signals.forEach((signal, index) => {
      const moved = signal.progress - start[index]!;
      assert.ok(moved > 0 && moved < 0.003, `${scene.id}: calm step ${moved}`);
    });
    // Ten minutes at 60 fps: every hop follows an edge; no signal wanders off.
    for (let frame = 0; frame < 36_000; frame += 4) {
      drawFrame(ctx, scene, state, LIGHT_PALETTE, {
        ...size,
        motion: true,
        step: 4,
        pointer: null,
      });
      for (const signal of state.signals)
        assert.ok(
          neighbours(scene, signal.from).includes(signal.to),
          `${scene.id}: ${signal.from} → ${signal.to} has no edge`,
        );
    }
    assert.ok(
      state.signals.every((s) => s.hops > 0),
      `${scene.id}: signals keep travelling`,
    );
    // Ripples fade away instead of piling up.
    assert.ok(state.ripples.length < 40, `${scene.id}: ${state.ripples.length} ripples`);
  }
});

test('a long frame gap (background tab) is clamped, so nothing jumps', () => {
  const scene: Scene = SCENES.collaboration;
  const state = createState(scene);
  const { ctx } = recorder();
  drawFrame(ctx, scene, state, LIGHT_PALETTE, { ...size, motion: true, step: 600, pointer: null });
  assert.equal(state.time, 4);
});

test('palette: read from the CSS variables, light defaults for anything missing', () => {
  const dark: Record<string, string> = {
    '--lp-net-line': ' rgba(255, 255, 255, 0.12) ',
    '--lp-net-node-fill': '#0d131f',
  };
  const palette = readPalette((name) => dark[name] ?? '', '"Inter Variable", sans-serif');
  assert.equal(palette.line, 'rgba(255, 255, 255, 0.12)');
  assert.equal(palette.nodeFill, '#0d131f');
  assert.equal(palette.accent, LIGHT_PALETTE.accent);
  assert.equal(palette.font, '"Inter Variable", sans-serif');
  assert.deepEqual(
    readPalette(() => ''),
    LIGHT_PALETTE,
  );
  // Every role has its own variable.
  const names = Object.values(PALETTE_VARIABLES);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((name) => name.startsWith('--lp-net-')));
});

test('the drawing uses the palette it is given (theme switch)', () => {
  const scene = SCENES.openSource;
  const palette = { ...LIGHT_PALETTE, line: 'LINE', lineActive: 'ACTIVE', textMuted: 'MUTED' };
  const { ctx, calls } = recorder();
  drawFrame(ctx, scene, createState(scene), palette, {
    ...size,
    motion: false,
    step: 0,
    pointer: null,
  });
  const strokes = calls.filter((c) => c.name === 'stroke').map((c) => c.state.strokeStyle);
  assert.ok(strokes.includes('LINE') && strokes.includes('ACTIVE'));
  const labels = calls.filter((c) => c.name === 'fillText').map((c) => c.state.fillStyle);
  assert.ok(labels.includes('MUTED'));
});

test('room picture: seven members, one message each, no model versions', () => {
  assert.deepEqual(
    SHOWCASE_MEMBERS.map((m) => m.name),
    ['Mia', 'Host agent', 'ChatGPT', 'Claude', 'Gemini', 'Grok', 'Custom Agent'],
  );
  assert.equal(SHOWCASE_MEMBERS.filter((m) => m.host).length, 1);
  assert.deepEqual(
    [...SHOWCASE_MESSAGES.map((m) => m.from)].sort(),
    [...SHOWCASE_MEMBERS.map((m) => m.name)].sort(),
  );
  for (const member of SHOWCASE_MEMBERS)
    assert.doesNotMatch(member.name, /\d|gpt-|sonnet|opus|flash|pro\b/i);
  assert.match(SHOWCASE_LABEL, /^Example of a room/);
});
