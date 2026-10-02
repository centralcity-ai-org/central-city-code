import type { ElricKind } from './config.js';

/**
 * Elric's router (docs/ELRIC.md). Tier 0 is plain code: lookups answered from the database with
 * no model call and zero cost units. Otherwise a simple rule picks the model tier: an explicit
 * summary request or a tool task goes to Tier 2 (the larger model), everything else to Tier 1.
 */
export type ElricRoute =
  | { tier: 0; handler: 'members' | 'tasks' }
  | { tier: 1; kind: 'short'; complex?: true }
  | { tier: 2; kind: Exclude<ElricKind, 'short'> };

/** The request text without @mentions, folded for matching. */
export function requestText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/@"[^"]*"|@\S+/g, ' ')
    .replace(/[^\p{L}\p{N}'’ ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const MEMBERS =
  /^(?:(?:please )?(?:who(?:'s| is| are)? (?:here|in (?:this|the) room|in here)|list (?:the )?members|members|who(?:'s| is) (?:online|around)))$/;
const TASKS =
  /^(?:(?:please )?(?:(?:list|show)(?: me)? (?:the )?)?(?:open|current) tasks|(?:what are the |which )?open tasks(?: are there)?|tasks)$/;
const SUMMARY = /\b(?:summar(?:y|ise|ize|ising|izing)|recap|tl ?dr|riassum\w*|riepilog\w*)\b/;
const TOOL = /\b(?:create|add|open|make|file|new)\b.*\btask\b|\btask\b.*\b(?:create|add|for)\b/;

/**
 * A Tier 1 question that deserves extended thinking: long, or asking for reasoning, code, maths,
 * writing or a plan. Still the "short" allowance; only the thinking changes.
 */
const COMPLEX =
  /\b(?:why|explain|compare|pros and cons|trade ?offs?|plan|strategy|design|architect\w*|prove|proof|derive|calculat\w*|solve|equation|math\w*|algorithm|code|debug|bug|function|script|sql|regex|write|draft|essay|step by step|analy[sz]\w*|evaluate|optimi[sz]\w*)\b/;
export function complexRequest(text: string): boolean {
  const request = requestText(text);
  return request.length > 280 || COMPLEX.test(request);
}

export function route(text: string): ElricRoute {
  const request = requestText(text).replace(/[?.!]+$/, '');
  if (MEMBERS.test(request)) return { tier: 0, handler: 'members' };
  if (TASKS.test(request)) return { tier: 0, handler: 'tasks' };
  if (SUMMARY.test(request)) return { tier: 2, kind: 'summary' };
  if (TOOL.test(request)) return { tier: 2, kind: 'tool' };
  return complexRequest(text)
    ? { tier: 1, kind: 'short', complex: true }
    : { tier: 1, kind: 'short' };
}
