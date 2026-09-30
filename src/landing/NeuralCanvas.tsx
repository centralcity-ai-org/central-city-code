import { useEffect, useRef } from 'react';
import {
  SCENES,
  createState,
  drawFrame,
  readPalette,
  type Palette,
  type Pointer,
  type SceneId,
} from './neuralScenes';

/*
 * One "Built for real AI agents" visual (v8 landing). Decorative: hidden from assistive
 * technology, the card's text says the same thing.
 *
 * - prefers-reduced-motion: one still frame, redrawn only on resize or theme change.
 * - Off screen (IntersectionObserver) or in a hidden tab: the animation loop stops.
 * - Theme: colours come from the --lp-net-* variables in landing.css, which follow the app's
 *   theme (html[data-theme]); they are re-read when it changes.
 * - Unmount cancels the frame and disconnects every observer and listener.
 */
const FRAME_MS = 1000 / 60;

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function NeuralCanvas({ scene: sceneId }: { scene: SceneId }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const scene = SCENES[sceneId];
    const state = createState(scene);

    let palette: Palette = readPalette(() => '');
    let motion = !prefersReducedMotion();
    let onScreen = true;
    let frame = 0;
    let last = 0;
    let pointer: Pointer = null;
    let size = { width: 0, height: 0, dpr: 0 };

    const readTheme = () => {
      const style = getComputedStyle(canvas);
      palette = readPalette((name) => style.getPropertyValue(name), style.fontFamily);
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = rect.width || 360;
      const height = rect.height || 230;
      if (width !== size.width || height !== size.height || dpr !== size.dpr) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        size = { width, height, dpr };
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const paint = (step: number) => {
      resize();
      drawFrame(ctx, scene, state, palette, {
        width: size.width,
        height: size.height,
        motion,
        step,
        pointer,
      });
    };

    const running = () => motion && onScreen && !document.hidden;

    const tick = (now: number) => {
      const step = last ? (now - last) / FRAME_MS : 1;
      last = now;
      paint(step);
      frame = running() ? requestAnimationFrame(tick) : 0;
      if (!frame) canvas.dataset.animating = 'false';
    };

    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
    };

    /** Starts the loop when it should run, or paints one still frame when it should not. */
    const update = () => {
      if (running()) {
        if (!frame) frame = requestAnimationFrame(tick);
      } else {
        stop();
        paint(0);
      }
      // Exposed for the e2e checks (reduced motion, off-screen pause).
      canvas.dataset.animating = running() ? 'true' : 'false';
    };

    readTheme();
    paint(0);
    update();

    // Theme: html[data-theme] set by the toggle (light unless the visitor picked dark).
    const refreshTheme = () => {
      readTheme();
      if (!frame) paint(0);
    };
    const themeObserver = new MutationObserver(refreshTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });

    const motionQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    const onMotionChange = () => {
      motion = !prefersReducedMotion();
      update();
    };
    motionQuery?.addEventListener('change', onMotionChange);

    let intersection: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      intersection = new IntersectionObserver(([entry]) => {
        onScreen = Boolean(entry?.isIntersecting);
        update();
      });
      intersection.observe(canvas);
    }

    let resizeObserver: ResizeObserver | null = null;
    const onResize = () => {
      if (!frame) paint(0);
    };
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(canvas);
    } else window.addEventListener('resize', onResize);

    document.addEventListener('visibilitychange', update);

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (!frame) paint(0);
    };
    const onPointerLeave = () => {
      pointer = null;
      if (!frame) paint(0);
    };
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);

    return () => {
      stop();
      themeObserver.disconnect();
      motionQuery?.removeEventListener('change', onMotionChange);
      intersection?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', update);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [sceneId]);

  return (
    <canvas
      ref={ref}
      className="cc-lp-net"
      data-neural={sceneId}
      aria-hidden="true"
      width={380}
      height={230}
    />
  );
}
