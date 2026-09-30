/// <reference lib="webworker" />
/*
 * Parses room Markdown off the main thread. The page gives each parse a hard time budget and
 * terminates this worker when it is exceeded (workerClient.ts), so no parser worst case can
 * freeze the room.
 */
import { parseSafely } from './parse';

type Request = { id: number; text: string };
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<Request>) => {
  const { id, text } = event.data;
  scope.postMessage({ id, result: parseSafely(text) });
};
scope.postMessage({ ready: true });
