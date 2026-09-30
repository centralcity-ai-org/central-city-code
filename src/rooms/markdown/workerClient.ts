/*
 * Runs Markdown parses in a dedicated worker with a hard time budget.
 * One parse is in flight at a time; if it takes longer than PARSE_BUDGET_MS the worker is
 * terminated (stopping the parse), that message is shown as plain text, and the next parse gets a
 * fresh worker. Without Worker support, or if the worker cannot start, everything is plain text.
 */
import type { ParseResult } from './parse';

/** Hard budget for one parse, measured from when the ready worker receives it. */
export const PARSE_BUDGET_MS = 200;
/** How long a new worker may take to load before Markdown is given up for this page. */
const BOOT_BUDGET_MS = 10_000;
const CACHE_SIZE = 300;
const PLAIN: ParseResult = { plain: true };

type Job = {
  id: number;
  text: string;
  /** Higher runs first: the newest messages first, and any message on screen before the rest. */
  priority: number;
  resolve: (result: ParseResult) => void;
};

/** Priority for a message on screen: ahead of every newest-first priority (a message seq). */
export const VISIBLE_PRIORITY = Number.MAX_SAFE_INTEGER;

const cache = new Map<string, ParseResult>();
const queue: Job[] = [];
let worker: Worker | null = null;
let ready = false;
let broken = false;
let current: { job: Job; timer: ReturnType<typeof setTimeout> } | null = null;
let bootTimer: ReturnType<typeof setTimeout> | undefined;
let nextId = 1;

function remember(text: string, result: ParseResult) {
  cache.set(text, result);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}

function kill() {
  worker?.terminate();
  worker = null;
  ready = false;
  clearTimeout(bootTimer);
}

function giveUp() {
  kill();
  broken = true;
  if (current) {
    clearTimeout(current.timer);
    current.job.resolve(PLAIN);
    current = null;
  }
  for (const job of queue.splice(0)) job.resolve(PLAIN);
}

function start() {
  try {
    worker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return giveUp();
  }
  bootTimer = setTimeout(giveUp, BOOT_BUDGET_MS);
  worker.onerror = () => giveUp();
  worker.onmessage = (event: MessageEvent<{ ready?: true; id?: number; result?: ParseResult }>) => {
    if (event.data.ready) {
      clearTimeout(bootTimer);
      ready = true;
      pump();
      return;
    }
    if (!current || event.data.id !== current.job.id) return;
    clearTimeout(current.timer);
    const { job } = current;
    current = null;
    const result = event.data.result ?? PLAIN;
    remember(job.text, result);
    job.resolve(result);
    pump();
  };
}

function pump() {
  if (current || broken) return;
  if (!worker) return queue.length ? start() : undefined;
  if (!ready) return;
  if (!queue.length) return;
  // Highest priority first; among equals, the one asked for first.
  let best = 0;
  for (let i = 1; i < queue.length; i++)
    if (
      queue[i]!.priority > queue[best]!.priority ||
      (queue[i]!.priority === queue[best]!.priority && queue[i]!.id < queue[best]!.id)
    )
      best = i;
  const job = queue.splice(best, 1)[0]!;
  current = {
    job,
    timer: setTimeout(() => {
      // Over budget: stop the parse by terminating the worker; this message stays plain.
      const { job: late } = current!;
      current = null;
      kill();
      remember(late.text, PLAIN);
      late.resolve(PLAIN);
      pump();
    }, PARSE_BUDGET_MS),
  };
  worker.postMessage({ id: job.id, text: job.text });
}

/** The cached result for `text`, if it was parsed already on this page. */
export function cachedParse(text: string): ParseResult | undefined {
  return cache.get(text);
}

/** Waiting callers per queued text, so the same text is parsed once. */
const waiting = new Map<string, { job: Job; resolvers: ((result: ParseResult) => void)[] }>();

/**
 * Parses `text` off the main thread; resolves to plain text on timeout or any failure.
 * `priority` orders the queue: pass the message seq, so the newest messages
 * are parsed first, and call `prioritize` when a message comes on screen.
 */
export function parseInWorker(text: string, priority = 0): Promise<ParseResult> {
  const hit = cache.get(text);
  if (hit) return Promise.resolve(hit);
  if (broken || typeof Worker === 'undefined') return Promise.resolve(PLAIN);
  return new Promise((resolve) => {
    const queued = waiting.get(text);
    if (queued) {
      queued.job.priority = Math.max(queued.job.priority, priority);
      queued.resolvers.push(resolve);
      return;
    }
    const entry = { job: undefined as unknown as Job, resolvers: [resolve] };
    entry.job = {
      id: nextId++,
      text,
      priority,
      resolve: (result) => {
        waiting.delete(text);
        for (const done of entry.resolvers) done(result);
      },
    };
    waiting.set(text, entry);
    queue.push(entry.job);
    pump();
  });
}

/** Moves a queued text ahead (a message came on screen). No effect once it is parsing or done. */
export function prioritize(text: string, priority = VISIBLE_PRIORITY): void {
  const queued = waiting.get(text);
  if (queued) queued.job.priority = Math.max(queued.job.priority, priority);
}

/** For tests: the order in which queued texts would be parsed. */
export function queuedOrder(): string[] {
  return [...queue].sort((a, b) => b.priority - a.priority || a.id - b.id).map((job) => job.text);
}
