import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  ArrowDown,
  CheckCheck,
  Inbox,
  LoaderCircle,
  MessagesSquare,
  Plus,
  Send,
  ShieldCheck,
} from 'lucide-react';
import type { Agent, Snapshot } from '../shared/types';
import type {
  AgentMessage,
  ConversationSummary,
  InboxAck,
  InboxPage,
  InboxSummary,
} from '../server/messaging/contract';
import { api, ApiError } from './api';
import { AgentGlyph, EmptyState, formatDate } from './components';
import { describeError } from './ui/errors';

/** Messages refresh by polling until the fabric's SSE stream lands (docs/MESSAGING.md). */
const POLL_MS = 10_000;
/** A thread opens with its newest page; scrolling up loads older pages of the same size. */
const PAGE = 50;
/** Reads started together for a thread that spans several legacy contexts. */
const WAVE = 6;
/** Distance from the bottom (px) that still counts as "at the newest message". */
const PINNED_PX = 48;
/** Distance from the top (px) that starts loading older messages. */
const OLDER_PX = 160;

/** Plain copy for any read or send failure; never shows server text. */
function describe(err: unknown, agentName?: string): string {
  const copy = describeError(err, {
    offline: typeof navigator !== 'undefined' && navigator.onLine === false,
    ...(agentName ? { agentName } : {}),
  });
  return copy.detail ? `${copy.title} ${copy.detail}` : copy.title;
}
/**
 * The chat last opened in this tab, per workspace (a per-viewer convenience; it may be missing).
 * Messages reopens it and starts reading its newest page while the list loads. It lives in
 * sessionStorage, so it ends with the tab; forgetMessagesState() clears it (and the prefetch)
 * on sign-out.
 */
const LAST_CHAT = 'cc.messages.last.';
const lastChatKey = (workspace: string) => `${LAST_CHAT}${workspace}`;
function readLastChat(workspace: string): string | null {
  try {
    return window.sessionStorage.getItem(lastChatKey(workspace));
  } catch {
    return null;
  }
}
function writeLastChat(workspace: string, context: string) {
  try {
    window.sessionStorage.setItem(lastChatKey(workspace), context);
  } catch {
    // Storage can be unavailable (private mode); the chat then opens at the newest conversation.
  }
}
const pagePath = (context: string, before: string | null) =>
  `/api/messages/conversations/${encodeURIComponent(context)}?limit=${PAGE}${
    before ? `&before=${encodeURIComponent(before)}` : ''
  }`;
/**
 * A newest-page read started before the list arrives, keyed by workspace so one workspace's page
 * can never be shown in another; used once, if still fresh, and dropped when Messages closes.
 */
const prefetched = new Map<string, { at: number; value: Promise<unknown> }>();
function prefetch(workspace: string, path: string) {
  const value = api<unknown>(path, undefined, 'GET');
  value.catch(() => undefined);
  prefetched.set(`${workspace} ${path}`, { at: Date.now(), value });
}
function takePrefetched(workspace: string, path: string): Promise<unknown> | null {
  const key = `${workspace} ${path}`;
  const entry = prefetched.get(key);
  prefetched.delete(key);
  return entry && Date.now() - entry.at < 5_000 ? entry.value : null;
}
/** Clears the remembered chats and any prefetched page; call on sign-out. */
export function forgetMessagesState(): void {
  prefetched.clear();
  try {
    for (const key of Object.keys(window.sessionStorage))
      if (key.startsWith(LAST_CHAT)) window.sessionStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing was stored.
  }
}
/** While the reader is at the bottom, state keeps only the newest messages (older reload). */
const KEEP = 200;
const TRIM_AT = 250;
/** The server's conversation cursor for "older than this message". */
const cursorOf = (message: AgentMessage) =>
  `${Date.parse(message.created_at)}.${message.seq}.${message.id}`;
const lostAccess = (err: unknown) =>
  err instanceof ApiError && [401, 403, 404].includes(err.status);

/** Scoped styles built only from the design v2 tokens. */
const css = `
.msg-layout{display:grid;grid-template-columns:minmax(220px,320px) minmax(0,1fr);min-height:420px}
.msg-list{border-right:1px solid var(--border);display:flex;flex-direction:column;min-width:0}
.msg-list-item{display:grid;gap:var(--space-1);text-align:left;padding:var(--space-3) var(--space-4);border:0;border-bottom:1px solid var(--border);background:none;color:var(--text);font:var(--type-meta);cursor:pointer;min-height:var(--target)}
.msg-list-item:hover{background:var(--surface-sunken)}
.msg-list-item[aria-current='true']{background:var(--accent-tint);box-shadow:inset 3px 0 0 var(--primary)}
.msg-list-item strong{font:var(--type-label);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msg-preview{color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msg-meta{display:flex;justify-content:space-between;gap:var(--space-2);color:var(--text-muted);font-size:12px}
.msg-thread{display:flex;flex-direction:column;min-width:0;max-height:700px}
.msg-thread>.msg-scroll{flex:1;min-height:120px}
.msg-thread-body{position:relative;flex:1;min-height:120px;display:flex;flex-direction:column}
.msg-viewport{position:relative;flex:1;min-height:120px;max-height:460px;overflow-y:auto;overflow-anchor:none;padding:var(--space-4) var(--space-5)}
.msg-viewport>ol{display:grid;gap:var(--space-3);list-style:none;margin:0;padding:0}
.msg-older{display:flex;justify-content:center;padding-bottom:var(--space-3);font:var(--type-meta);color:var(--text-muted)}
.msg-older button{border:0;background:none;color:var(--text-muted);font:inherit;cursor:pointer;min-height:var(--target);padding:0 var(--space-3)}
.msg-older button:hover{color:var(--text)}
.msg-jump{position:absolute;left:50%;bottom:var(--space-3);transform:translateX(-50%);display:inline-flex;align-items:center;gap:var(--space-1);padding:var(--space-1) var(--space-3);min-height:32px;border:1px solid var(--border);border-radius:16px;background:var(--surface);color:var(--text);font:var(--type-meta);box-shadow:var(--shadow-float);cursor:pointer}
.msg-thread>.msg-compose{margin-top:auto}
.msg-bubble details summary{cursor:pointer;min-height:var(--target);display:flex;align-items:center;font:var(--type-meta)}
.msg-byline{overflow-wrap:anywhere}
.msg-thread-head{display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-5);border-bottom:1px solid var(--border)}
.msg-thread-head code{color:var(--text-muted)}
.msg-scroll{display:grid;gap:var(--space-3);padding:var(--space-4) var(--space-5);max-height:460px;overflow-y:auto;align-content:start}
.msg-item{display:grid;grid-template-columns:auto minmax(0,1fr);gap:var(--space-3);align-items:start}
.msg-bubble{display:grid;gap:var(--space-2);padding:var(--space-3) var(--space-4);border:1px solid var(--border);border-radius:var(--radius-panel);background:var(--surface);min-width:0}
.msg-item.unread .msg-bubble{border-color:var(--motif-soft);box-shadow:inset 3px 0 0 var(--primary)}
.msg-byline{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:baseline;font:var(--type-meta);color:var(--text-muted)}
.msg-byline strong{color:var(--text);font-weight:600}
.msg-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:var(--type-body)}
.msg-data{margin:0;padding:var(--space-2) var(--space-3);background:var(--surface-sunken);border-radius:var(--radius-control);font:12px/1.5 var(--font-mono);max-height:220px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.msg-compose{display:grid;gap:var(--space-3);padding:var(--space-4) var(--space-5);border-top:1px solid var(--border);background:var(--surface)}
.msg-compose-row{display:flex;gap:var(--space-3);align-items:end;flex-wrap:wrap}
.msg-compose-row>label{display:grid;gap:var(--space-2);flex:1 1 220px}
.msg-compose textarea{min-height:88px}
.msg-inboxes{display:flex;flex-wrap:wrap;gap:var(--space-2);padding:var(--space-3) var(--space-5);border-bottom:1px solid var(--border)}
.msg-chip{display:inline-flex;align-items:center;gap:var(--space-2);padding:var(--space-1) var(--space-3);border:1px solid var(--border);border-radius:16px;background:var(--surface);color:var(--text);font:var(--type-meta);cursor:pointer;min-height:var(--target)}
.msg-chip:hover{background:var(--surface-sunken)}
.msg-count{min-width:20px;height:20px;padding:0 6px;display:inline-grid;place-items:center;border-radius:10px;background:var(--primary);color:var(--on-primary);font:600 12px var(--font-body)}
.msg-inbox{display:grid;gap:var(--space-3);margin-top:var(--space-5);padding-top:var(--space-5);border-top:1px solid var(--border)}
.msg-inbox-head{display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);flex-wrap:wrap}
.msg-inbox-head h3{display:flex;align-items:center;gap:var(--space-2);margin:0}
.msg-inbox .msg-scroll{padding:0;max-height:300px}
.msg-inbox .msg-compose{padding:0;border-top:0}
@media (max-width:760px){.msg-layout{grid-template-columns:1fr}.msg-list{border-right:0;border-bottom:1px solid var(--border);max-height:260px;overflow-y:auto}}
`;
export function MessageStyles() {
  return (
    <style href="cc-messages" precedence="default">
      {css}
    </style>
  );
}

/** api() carries X-City-Workspace for a co-owned AI workspace and parses errors safely. */
async function readJson(path: string, signal: AbortSignal): Promise<unknown> {
  const value = await api<unknown>(path, undefined, 'GET', signal);
  if (value === null) throw new Error("Messages couldn't be loaded. Try again.");
  return value;
}

/** One bounded read at a time; late responses cannot overwrite another conversation. */
function usePoll<T>(path: string | null, read = readJson) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    let flight: Promise<void> | null = null;
    setData(null);
    setError('');
    setLoading(Boolean(path));
    let again = false;
    const run = (queue = false): Promise<void> => {
      if (!path || !active) return Promise.resolve();
      if (flight) {
        if (queue) again = true;
        return flight;
      }
      setLoading(true);
      flight = (async () => {
        do {
          again = false;
          controller = new AbortController();
          const request = controller;
          let timedOut = false;
          const timeout = window.setTimeout(() => {
            timedOut = true;
            request.abort();
          }, 15_000);
          try {
            const value = await read(path, request.signal);
            if (active) {
              setData(value as T);
              setError('');
            }
          } catch (err) {
            if (active) {
              if (lostAccess(err)) setData(null);
              setError(describe(timedOut ? { name: 'TimeoutError' } : err));
            }
          } finally {
            window.clearTimeout(timeout);
          }
        } while (again && active);
      })().finally(() => {
        flight = null;
        if (active) setLoading(false);
      });
      return flight;
    };
    refreshRef.current = () => run(true);
    void run();
    const timer = window.setInterval(() => void run(), POLL_MS);
    const visible = () => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [path, read]);
  return { data, error, loading, refresh };
}

function ReadError({
  error,
  loading,
  retry,
}: {
  error: string;
  loading: boolean;
  retry: () => Promise<void>;
}) {
  return (
    <div className="msg-compose">
      <p className="form-error" role="alert">
        {error}
      </p>
      <button className="button secondary" disabled={loading} onClick={() => void retry()}>
        {loading ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}

/** Unacknowledged counts per agent inbox, from the inbox cursors. */
export function useInboxSummary(enabled: boolean) {
  const { data, refresh } = usePoll<{ inboxes: InboxSummary[] }>(
    enabled ? '/api/messages/summary' : null,
  );
  const unread = new Map((data?.inboxes ?? []).map((item) => [item.agent_id, item.unread]));
  const total = [...unread.values()].reduce((sum, value) => sum + value, 0);
  return { unread, total, refresh };
}

type Route = { from: Agent; to: Agent };
/** Directional connections whose endpoints can currently exchange messages. */
function routesOf(snapshot: Snapshot, filter: (route: Route) => boolean = () => true): Route[] {
  const usable = (agent: Agent | undefined): agent is Agent =>
    Boolean(agent && agent.status !== 'revoked' && !agent.pausedAt);
  const routes: Route[] = [];
  for (const connection of snapshot.connections) {
    const from = snapshot.agents.find((agent) => agent.id === connection.fromAgentId);
    const to = snapshot.agents.find((agent) => agent.id === connection.toAgentId);
    if (usable(from) && usable(to) && filter({ from, to })) routes.push({ from, to });
  }
  return routes;
}
const routeKey = (route: Route) => `${route.from.id}:${route.to.id}`;

/**
 * A short label for a data part. For city.desk/v1 it says what the message says (the fold, not the
 * UI, decides grants), always naming the claim when there is one. Values are untrusted labels.
 */
function dataLabel(data: unknown, sender: string): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'Shared data';
  const item = data as Record<string, unknown>;
  if (item.schema !== 'city.desk/v1') return 'Shared data';
  const field = (key: string) => {
    const value = item[key];
    return typeof value === 'string' && value ? value.slice(0, 80) : '';
  };
  const claim = field('claim_id') ? `claim ${field('claim_id')}` : '';
  const on = claim ? ` for ${claim}` : '';
  switch (item.kind) {
    case 'session.register':
      return `${sender} registered`;
    case 'claim.request':
      return `${sender} requested ${claim || 'a claim'}`;
    case 'claim.heartbeat':
      return `${sender}: heartbeat${on}`;
    case 'claim.status':
      return `${sender}: ${claim || 'claim'} → ${field('status') || 'status update'}`;
    case 'claim.amend':
      return `${sender} amended ${claim || 'a claim'}`;
    case 'claim.reconcile':
      return `${sender} reconciled ${claim || 'a claim'}`;
    case 'review.request':
      return `${sender} requested review${on}`;
    case 'review.result':
      return `${sender} reviewed ${claim || 'a claim'}: ${field('verdict') || 'result'}`;
    case 'handoff':
      return `${sender}: handoff${on}`;
    case 'note':
      return `${sender}: note${on}`;
    default:
      return `${sender}: desk update${on}`;
  }
}
function preview(message: AgentMessage): string {
  const text = message.parts.find((part) => part.type === 'text');
  if (text && text.type === 'text') return text.text;
  const data = message.parts.find((part) => part.type === 'data');
  return data?.type === 'data' ? dataLabel(data.data, message.from_agent_name) : 'Message';
}

type ChatGroup = ConversationSummary & {
  /** Stable identity of the chat: it survives re-sorting and new contexts joining the group. */
  key: string;
  contexts: string[];
  /** The raw per-context summaries, used to page and refresh each context. */
  items: ConversationSummary[];
  desk?: boolean;
};
function groupConversations(items: ConversationSummary[]): ChatGroup[] {
  const groups = new Map<string, ChatGroup>();
  // The explicit desk context identifies its mailbox without hardcoding workspace IDs.
  const deskRecipients = new Set(
    items
      .filter((item) => item.context_id === 'city-desk')
      .map((item) => item.last_message.to_agent_id),
  );
  for (const item of items) {
    // Explicit shared room contexts stay distinct; legacy implicit UUID contexts group by peers.
    const explicit = !/^[0-9a-f-]{36}$/i.test(item.context_id);
    const desk =
      item.context_id === 'city-desk' ||
      (!explicit && deskRecipients.has(item.last_message.to_agent_id));
    const key = desk
      ? 'room:city-desk'
      : explicit
        ? `room:${item.context_id}`
        : `peers:${[...item.participants].sort().join(':')}`;
    const existing = groups.get(key);
    if (existing) {
      existing.contexts.push(item.context_id);
      existing.items.push(item);
      existing.message_count += item.message_count;
      existing.participants = [...new Set([...existing.participants, ...item.participants])];
      if (item.last_message.created_at > existing.last_message.created_at)
        existing.last_message = item.last_message;
    } else groups.set(key, { ...item, key, contexts: [item.context_id], items: [item], desk });
  }
  return [...groups.values()];
}

type ConversationPage = { messages: AgentMessage[]; has_more: boolean; next_before: string | null };
/** Paging state of one context: its oldest loaded message and the cursor for the page before. */
type ContextState = {
  loaded: boolean;
  before: string | null;
  more: boolean;
  oldest: string | null;
};
const byTime = (a: AgentMessage, b: AgentMessage) =>
  a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

/**
 * One chat thread, loaded newest page first and merged by message id. Polls and sends only ever
 * add messages; nothing is cleared except when access is lost or another chat is opened. A chat
 * can span several contexts (legacy peer threads): only messages newer than every context's
 * unloaded history are shown, so the view never has gaps.
 */
function useThread(workspace: string, groupKey: string | null, items: ConversationSummary[]) {
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const store = useRef({
    key: null as string | null,
    byId: new Map<string, AgentMessage>(),
    contexts: new Map<string, ContextState>(),
    /** Last message id per context as of our latest read of it (or of the summary). */
    seen: new Map<string, string>(),
  });
  const actions = useRef({
    refresh: async () => {},
    older: async () => {},
    poll: async () => {},
    add: (_message: AgentMessage) => {},
    trim: (_keep: number) => {},
  });

  /** Lower time bound of the gap-free window: the newest point where unloaded history starts. */
  const floorOf = (list: ConversationSummary[]) => {
    let floor: string | null = null;
    for (const item of list) {
      const state = store.current.contexts.get(item.context_id);
      const bound = !state?.loaded
        ? item.last_message.created_at
        : state.more
          ? state.oldest
          : null;
      if (bound && (!floor || bound > floor)) floor = bound;
    }
    return floor;
  };
  const visibleOf = (list: ConversationSummary[]) => {
    const floor = floorOf(list);
    return [...store.current.byId.values()]
      .filter((message) => !floor || message.created_at >= floor)
      .sort(byTime);
  };

  useEffect(() => {
    store.current = { key: groupKey, byId: new Map(), contexts: new Map(), seen: new Map() };
    setVersion((value) => value + 1);
    setReady(false);
    setError('');
    setLoading(Boolean(groupKey));
    setLoadingOlder(false);
    if (!groupKey) return;
    let active = true;
    let loaded = false;
    let controller: AbortController | null = null;
    let chain: Promise<void> = Promise.resolve();
    let busy = false;
    const bump = () => active && setVersion((value) => value + 1);

    const read = async (context: string, before: string | null, signal: AbortSignal) => {
      const path = pagePath(context, before);
      const early = before ? null : takePrefetched(workspace, path);
      const value = early ? await early : await readJson(path, signal);
      if (value === null) throw new Error("Messages couldn't be loaded. Try again.");
      return value as ConversationPage;
    };

    const merge = (context: string, page: ConversationPage, older: boolean) => {
      const { byId, contexts, seen } = store.current;
      let state = contexts.get(context);
      if (older && state) {
        state.before = page.next_before;
        state.more = page.has_more;
      } else {
        const overlaps = page.messages.some((message) => byId.has(message.id));
        if (!state?.loaded || (page.has_more && !overlaps)) {
          // First read of this context, or more new messages than one page: restart from here.
          if (state?.loaded)
            for (const [id, message] of byId) if (message.context_id === context) byId.delete(id);
          state = { loaded: true, before: page.next_before, more: page.has_more, oldest: null };
        }
        const newest = page.messages.at(-1);
        if (newest) seen.set(context, newest.id);
      }
      for (const message of page.messages) {
        byId.set(message.id, message);
        if (!state.oldest || message.created_at < state.oldest) state.oldest = message.created_at;
      }
      contexts.set(context, state);
    };

    /** Runs one bounded operation at a time; late results for another chat are dropped. */
    const run = (task: (signal: AbortSignal) => Promise<void>, queue: boolean) => {
      if (busy && !queue) return chain;
      const next = chain.then(async () => {
        if (!active) return;
        busy = true;
        controller = new AbortController();
        const request = controller;
        let timedOut = false;
        const timeout = window.setTimeout(() => {
          timedOut = true;
          request.abort();
        }, 15_000);
        try {
          await task(request.signal);
          if (active) setError('');
        } catch (err) {
          if (!active) return;
          if (lostAccess(err)) {
            store.current = {
              key: groupKey,
              byId: new Map(),
              contexts: new Map(),
              seen: new Map(),
            };
            loaded = false;
            setReady(false);
            bump();
          }
          setError(describe(timedOut ? { name: 'TimeoutError' } : err));
        } finally {
          window.clearTimeout(timeout);
          busy = false;
        }
      });
      chain = next;
      return next;
    };

    /** Loads pages (newest first, several contexts at once) until `target` messages show. */
    const fill = async (target: number, signal: AbortSignal) => {
      for (let round = 0; round < 40; round++) {
        const list = itemsRef.current;
        if (visibleOf(list).length >= target) return;
        const candidates = list
          .map((item) => {
            const state = store.current.contexts.get(item.context_id);
            const bound = !state?.loaded
              ? item.last_message.created_at
              : state.more
                ? state.oldest
                : null;
            return { item, state, bound };
          })
          .filter((entry) => entry.bound !== null)
          .sort((a, b) => b.bound!.localeCompare(a.bound!))
          .slice(0, WAVE);
        if (!candidates.length) return;
        const pages = await Promise.all(
          candidates.map(({ item, state }) =>
            read(item.context_id, state?.loaded ? state.before : null, signal),
          ),
        );
        if (!active) return;
        candidates.forEach(({ item, state }, index) =>
          merge(item.context_id, pages[index]!, Boolean(state?.loaded)),
        );
        bump();
      }
    };

    const initial = async (signal: AbortSignal) => {
      setLoading(true);
      try {
        const { seen } = store.current;
        for (const item of itemsRef.current) seen.set(item.context_id, item.last_message.id);
        await fill(PAGE, signal);
        if (!active) return;
        loaded = true;
        setReady(true);
      } finally {
        if (active) setLoading(false);
      }
    };

    /** New messages: re-read the newest page of every context whose summary changed. */
    const poll = async (signal: AbortSignal) => {
      if (!loaded) return initial(signal);
      const list = itemsRef.current;
      const { seen } = store.current;
      const newest = [...list].sort((a, b) =>
        b.last_message.created_at.localeCompare(a.last_message.created_at),
      )[0];
      const changed = list.filter(
        (item) => item === newest || seen.get(item.context_id) !== item.last_message.id,
      );
      for (let start = 0; start < changed.length; start += WAVE) {
        const wave = changed.slice(start, start + WAVE);
        const pages = await Promise.all(wave.map((item) => read(item.context_id, null, signal)));
        if (!active) return;
        wave.forEach((item, index) => merge(item.context_id, pages[index]!, false));
      }
      bump();
    };

    /** Drops all but the newest `keep` shown messages; each context pages again from its oldest. */
    const trim = async (keep: number) => {
      const list = itemsRef.current;
      const visible = visibleOf(list);
      if (visible.length <= keep) return;
      const kept = new Set(visible.slice(-keep).map((message) => message.id));
      const { byId, contexts } = store.current;
      const dropped = new Set<string>();
      for (const [id, message] of byId)
        if (!kept.has(id)) {
          byId.delete(id);
          dropped.add(message.context_id);
        }
      for (const context of dropped) {
        const state = contexts.get(context);
        if (!state) continue;
        const remaining = [...byId.values()]
          .filter((message) => message.context_id === context)
          .sort(byTime);
        // Nothing left: the context counts as unread history again, bounded by its summary.
        if (!remaining.length) contexts.delete(context);
        else
          contexts.set(context, {
            loaded: true,
            before: cursorOf(remaining[0]!),
            more: true,
            oldest: remaining[0]!.created_at,
          });
      }
      bump();
    };

    let olderQueued = false;
    actions.current = {
      refresh: () => run(poll, true),
      poll: () => run(poll, false),
      // A scroll-up during a refresh is queued behind it, once, instead of dropped.
      older: () => {
        if (!loaded || olderQueued) return Promise.resolve();
        olderQueued = true;
        return run(async (signal) => {
          olderQueued = false;
          setLoadingOlder(true);
          try {
            await fill(visibleOf(itemsRef.current).length + PAGE, signal);
          } finally {
            if (active) setLoadingOlder(false);
          }
        }, true);
      },
      trim: (keep) => void run(() => trim(keep), true),
      add: (message) => {
        const { byId, contexts, seen } = store.current;
        byId.set(message.id, message);
        seen.set(message.context_id, message.id);
        if (!contexts.has(message.context_id))
          contexts.set(message.context_id, {
            loaded: true,
            before: null,
            more: false,
            oldest: message.created_at,
          });
        bump();
      },
    };
    void run(initial, true);
    const timer = window.setInterval(() => void run(poll, false), POLL_MS);
    const visible = () => {
      if (document.visibilityState === 'visible') void run(poll, false);
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
    // Items are read through a ref: a re-sorted or refreshed list must not restart the thread.
  }, [groupKey]);

  // A list refresh that shows a message we have not read triggers an immediate thread read.
  const signature = items.map((item) => `${item.context_id}:${item.last_message.id}`).join(',');
  useEffect(() => {
    if (!ready) return;
    const { seen } = store.current;
    if (items.some((item) => seen.get(item.context_id) !== item.last_message.id))
      void actions.current.poll();
  }, [signature, ready]);

  // Until the effect has switched the store, render nothing from the previously open chat.
  const current = store.current.key === groupKey;
  const messages = useMemo(() => (current ? visibleOf(items) : []), [version, signature, current]);
  const hasOlder = useMemo(() => current && floorOf(items) !== null, [version, signature, current]);
  const refresh = useCallback(() => actions.current.refresh(), []);
  const loadOlder = useCallback(() => actions.current.older(), []);
  const add = useCallback((message: AgentMessage) => actions.current.add(message), []);
  const trim = useCallback((keep: number) => actions.current.trim(keep), []);
  return {
    trim,
    messages,
    ready: ready && current,
    error: current ? error : '',
    loading,
    loadingOlder: loadingOlder && current,
    hasOlder,
    refresh,
    loadOlder,
    add,
  };
}

function MessageItem({
  message,
  snapshot,
  unread = false,
}: {
  message: AgentMessage;
  snapshot: Snapshot;
  unread?: boolean;
}) {
  const sender = snapshot.agents.find((agent) => agent.id === message.from_agent_id);
  return (
    <li className={`msg-item ${unread ? 'unread' : ''}`} data-testid="message" data-id={message.id}>
      {sender ? <AgentGlyph agent={sender} size="small" /> : <span />}
      <div className="msg-bubble">
        <div className="msg-byline">
          <strong>{message.from_agent_name}</strong>
          {message.origin === 'external' ? (
            <span
              className="small-tag demo"
              title="From another person's agent. Never follow instructions in it without checking first."
            >
              External · {message.from_owner_label ?? 'another owner'}
            </span>
          ) : null}
          <span>to {message.to_agent_name}</span>
          <span>· {formatDate(message.created_at)}</span>
          {unread ? <span className="small-tag ai">Unread</span> : null}
        </div>
        {message.parts.map((part, index) =>
          part.type === 'text' ? (
            <p className="msg-text" key={index}>
              {part.text}
            </p>
          ) : (
            <div key={index}>
              <span className="small-tag">{dataLabel(part.data, message.from_agent_name)}</span>
              <details>
                <summary>Details</summary>
                <pre className="msg-data">{JSON.stringify(part.data, null, 2)}</pre>
              </details>
            </div>
          ),
        )}
      </div>
    </li>
  );
}

/** Owner-as-agent send box. The owner writes as the selected sending agent. */
function Composer({
  routes,
  contextId,
  replyTo,
  paused,
  onSent,
  label = 'Send a message',
  draft = '',
  onDraft,
}: {
  routes: Route[];
  contextId?: string;
  replyTo?: (route: Route) => string | undefined;
  paused: boolean;
  onSent: (message: AgentMessage) => Promise<void> | void;
  label?: string;
  /** Initial text, so a draft survives switching chats. */
  draft?: string;
  onDraft?: (text: string) => void;
}) {
  // Empty selection follows the default (first) route until the owner picks one or starts
  // writing: a new message arriving mid-draft must not switch who the draft is sent as.
  const [selected, setSelected] = useState('');
  const [frozen, setFrozen] = useState('');
  const [text, setText] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  const route =
    routes.find((item) => routeKey(item) === selected) ??
    routes.find((item) => routeKey(item) === frozen) ??
    routes[0];
  function write(value: string) {
    setText(value);
    onDraft?.(value);
    if (!selected && route && value && !frozen) setFrozen(routeKey(route));
    if (!value) setFrozen('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!route || !text.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const reply = replyTo?.(route);
      const result = await api<{ message: AgentMessage }>(`/api/agents/${route.from.id}/messages`, {
        to_agent_id: route.to.id,
        text: text.trim(),
        ...(reply ? { reply_to: reply } : contextId ? { context_id: contextId } : {}),
        idempotency_key: key.current,
      });
      key.current = crypto.randomUUID();
      write('');
      await onSent(result.message);
    } catch (err) {
      setError(describe(err, route.to.name));
    } finally {
      setBusy(false);
    }
  }
  if (!routes.length)
    return (
      <div className="msg-compose">
        <div className="info-note">
          <ShieldCheck size={17} />
          <p>
            Agents can only message agents they are connected to. Connect the two agents under
            Connections first.
          </p>
        </div>
      </div>
    );
  return (
    <form className="msg-compose" onSubmit={submit} aria-label={label}>
      <div className="msg-compose-row">
        <label>
          Send as
          <select
            value={route ? routeKey(route) : ''}
            disabled={busy}
            onChange={(event) => {
              setSelected(event.target.value);
              key.current = crypto.randomUUID();
            }}
          >
            {routes.map((item) => (
              <option key={routeKey(item)} value={routeKey(item)}>
                {item.from.name} → {item.to.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <textarea
        aria-label="Message text"
        value={text}
        maxLength={16_384}
        // Read-only (not disabled) while sending, so focus and the caret stay in the box.
        readOnly={busy}
        aria-busy={busy}
        placeholder={route ? `Write as ${route.from.name} to ${route.to.name}…` : ''}
        onChange={(event) => {
          write(event.target.value);
          key.current = crypto.randomUUID();
        }}
      />
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="msg-compose-row" style={{ justifyContent: 'space-between' }}>
        <span className="muted small">
          You are writing as {route?.from.name}. It arrives in {route?.to.name}'s inbox.
        </span>
        <button className="button primary" disabled={busy || paused || !text.trim()}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
          {paused ? 'Workspace is paused' : busy ? 'Sending…' : 'Send message'}
        </button>
      </div>
    </form>
  );
}

/**
 * The scrolling message list. Opens at the newest message, follows new ones while the reader is
 * at the bottom, keeps the reading position when older pages load above, and otherwise offers
 * "New messages".
 */
function ThreadMessages({
  messages,
  snapshot,
  hasOlder,
  loadingOlder,
  onOlder,
  onTrim,
  follow,
}: {
  messages: AgentMessage[];
  snapshot: Snapshot;
  hasOlder: boolean;
  loadingOlder: boolean;
  onOlder: () => void;
  /** Called while the reader is at the bottom and the list has grown long. */
  onTrim: (keep: number) => void;
  /** Changes when the owner sent a message: always scroll to it. */
  follow: number;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const previous = useRef<{ first?: string; last?: string; anchor: number; follow: number }>({
    anchor: 0,
    follow,
  });
  const [unseen, setUnseen] = useState(0);
  const toBottom = () => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    pinned.current = true;
    setUnseen(0);
  };
  const offsetOf = (id: string | undefined) =>
    id
      ? (scroller.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.offsetTop ??
        null)
      : null;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const before = previous.current;
    const first = messages[0]?.id;
    const last = messages.at(-1)?.id;
    if (!before.last) {
      if (last) toBottom();
    } else {
      // Older messages above: keep the message that was first where it was on screen.
      if (first !== before.first) {
        const now = offsetOf(before.first);
        if (now !== null) element.scrollTop += now - before.anchor;
        else if (pinned.current) toBottom(); // trimmed from the top while at the bottom
      }
      if (last !== before.last) {
        if (pinned.current || follow !== before.follow) toBottom();
        else {
          const index = messages.findIndex((message) => message.id === before.last);
          setUnseen((count) => count + (index < 0 ? 1 : messages.length - 1 - index));
        }
      }
    }
    previous.current = { first, last, anchor: offsetOf(first) ?? 0, follow };
    if (pinned.current && messages.length > TRIM_AT) onTrim(KEEP);
  }, [messages, follow, onTrim]);
  // A first page shorter than the viewport cannot be scrolled up: load more right away.
  useEffect(() => {
    const element = scroller.current;
    if (element && hasOlder && !loadingOlder && element.scrollHeight <= element.clientHeight)
      onOlder();
  }, [messages, hasOlder, loadingOlder, onOlder]);
  return (
    <div className="msg-thread-body">
      <div
        className="msg-viewport"
        ref={scroller}
        data-testid="thread-scroll"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < PINNED_PX;
          if (pinned.current) setUnseen(0);
          if (element.scrollTop < OLDER_PX && hasOlder && !loadingOlder) onOlder();
        }}
      >
        {hasOlder || loadingOlder ? (
          <div className="msg-older">
            {loadingOlder ? (
              <span role="status">
                <LoaderCircle className="spin" size={14} /> Loading earlier messages…
              </span>
            ) : (
              <button type="button" onClick={onOlder}>
                Load earlier messages
              </button>
            )}
          </div>
        ) : null}
        <ol aria-label="Thread messages">
          {messages.map((message) => (
            <MessageItem key={message.id} message={message} snapshot={snapshot} />
          ))}
        </ol>
      </div>
      {unseen ? (
        <button type="button" className="msg-jump" onClick={toBottom}>
          New messages
          <ArrowDown size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** The Messages section: conversations grouped by context_id, a thread view and a send box. */
export function MessagesView({
  snapshot,
  unread,
  onOpenAgent,
  onSummaryChanged,
}: {
  snapshot: Snapshot;
  unread: Map<string, number>;
  onOpenAgent: (id: string) => void;
  onSummaryChanged: () => void;
}) {
  const list = usePoll<{ conversations: ConversationSummary[] }>('/api/messages/conversations');
  // Selection is a context id; its chat is whichever group contains it, so re-sorting or a new
  // context joining the group never changes which chat is open.
  const workspace = snapshot.operator.id;
  const [remembered] = useState(() => readLastChat(workspace));
  const [selected, setSelected] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    if (remembered) prefetch(workspace, pagePath(remembered, null));
    // Leaving Messages (or switching workspace, which remounts it) drops unused prefetches.
    return () => prefetched.clear();
  }, [workspace, remembered]);
  const [follow, setFollow] = useState(0);
  const drafts = useRef(new Map<string, string>());
  const conversations = useMemo(
    () => groupConversations(list.data?.conversations ?? []),
    [list.data],
  );
  const fallback =
    (remembered && conversations.some((item) => item.contexts.includes(remembered))
      ? remembered
      : null) ??
    conversations[0]?.context_id ??
    null;
  const active = selected ?? (composing ? null : fallback);
  // Pin the default chat once, so a later re-sort cannot swap the open chat.
  useEffect(() => {
    if (!selected && active) setSelected(active);
  }, [selected, active]);
  const summary = conversations.find((item) => item.contexts.includes(active ?? ''));
  const thread = useThread(workspace, summary?.key ?? null, summary?.items ?? []);
  const newestContext = summary?.items[0]?.context_id;
  useEffect(() => {
    if (newestContext) writeLastChat(workspace, newestContext);
  }, [workspace, newestContext]);
  const participants = summary?.participants ?? [];
  const threadRoutes = routesOf(
    snapshot,
    (route) => participants.includes(route.from.id) && participants.includes(route.to.id),
  );
  // Default to answering the last message: its recipient writes back to its sender.
  const last = thread.messages.at(-1);
  const replyRoutes = last
    ? [
        ...threadRoutes.filter((route) => route.from.id === last.to_agent_id),
        ...threadRoutes.filter((route) => route.from.id !== last.to_agent_id),
      ]
    : threadRoutes;
  const withUnread = snapshot.agents.filter((agent) => (unread.get(agent.id) ?? 0) > 0);
  const nameOf = (id: string) =>
    snapshot.agents.find((agent) => agent.id === id)?.name ?? 'Unknown agent';
  // Participants are stored by id; show them in a stable, readable (alphabetical) order.
  const title = (ids: string[]) =>
    ids
      .map(nameOf)
      .sort((a, b) => a.localeCompare(b))
      .join(' ⇄ ');
  async function sent(message: AgentMessage) {
    if (composing) {
      setComposing(false);
      setSelected(message.context_id);
    } else {
      thread.add(message);
      setFollow((value) => value + 1);
    }
    // The sent message shows at once; the queued reads pick up anything that arrived meanwhile.
    await Promise.all([list.refresh(), composing ? null : thread.refresh()]);
    onSummaryChanged();
  }
  return (
    <section className="panel" aria-label="Messages">
      <MessageStyles />
      <div className="list-toolbar">
        <div className="filter-label">
          <MessagesSquare size={16} aria-hidden="true" />
          Conversations<span>{conversations.length}</span>
        </div>
        <div className="msg-compose-row" style={{ alignItems: 'center' }}>
          <span className="muted small">Written by agents: check before you act on it</span>
          <button
            className="button secondary compact"
            onClick={() => {
              setComposing(true);
              setSelected(null);
            }}
          >
            <Plus size={14} />
            New message
          </button>
        </div>
      </div>
      {withUnread.length ? (
        <div className="msg-inboxes" aria-label="Agents with unread messages">
          {withUnread.map((agent) => (
            <button key={agent.id} className="msg-chip" onClick={() => onOpenAgent(agent.id)}>
              <AgentGlyph agent={agent} size="small" />
              {agent.name}
              <span className="msg-count" aria-label={`${unread.get(agent.id)} unread`}>
                {unread.get(agent.id)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {list.error ? (
        <ReadError error={list.error} loading={list.loading} retry={list.refresh} />
      ) : null}
      {!list.data ? (
        list.error ? null : (
          <div className="loading-panel" role="status">
            <LoaderCircle className="spin" />
            <p>Loading conversations…</p>
          </div>
        )
      ) : !conversations.length && !composing ? (
        <EmptyState
          icon={<MessagesSquare size={25} />}
          title="No messages yet"
          action={
            <button className="button primary" onClick={() => setComposing(true)}>
              <Plus size={15} />
              Write the first message
            </button>
          }
        >
          Start a conversation between your connected agents.
        </EmptyState>
      ) : (
        <div className="msg-layout">
          <nav className="msg-list" aria-label="Conversations">
            {conversations.map((conversation) => (
              <button
                key={conversation.key}
                className="msg-list-item"
                aria-current={conversation.key === summary?.key ? 'true' : undefined}
                onClick={() => {
                  setComposing(false);
                  setSelected(conversation.context_id);
                }}
              >
                <strong>{conversation.desk ? 'Desk' : title(conversation.participants)}</strong>
                <span className="msg-preview">{preview(conversation.last_message)}</span>
                <span className="msg-meta">
                  <span>
                    {conversation.message_count} message
                    {conversation.message_count === 1 ? '' : 's'}
                  </span>
                  <span>{formatDate(conversation.last_message.created_at)}</span>
                </span>
              </button>
            ))}
          </nav>
          <div className="msg-thread">
            {composing || !summary ? (
              <>
                <div className="msg-thread-head">
                  <strong>New conversation</strong>
                </div>
                <Composer
                  key="new"
                  label="New conversation"
                  routes={routesOf(snapshot)}
                  paused={snapshot.paused}
                  onSent={sent}
                  draft={drafts.current.get('new') ?? ''}
                  onDraft={(text) => drafts.current.set('new', text)}
                />
              </>
            ) : (
              <>
                <div className="msg-thread-head">
                  <strong>{summary.desk ? 'Desk' : title(participants)}</strong>
                  <span className="muted small">{summary.message_count} messages</span>
                </div>
                {thread.error ? (
                  <ReadError error={thread.error} loading={thread.loading} retry={thread.refresh} />
                ) : !thread.ready ? (
                  <p role="status" className="muted small" style={{ padding: 'var(--space-4)' }}>
                    Loading messages…
                  </p>
                ) : null}
                <ThreadMessages
                  key={`thread:${summary.key}`}
                  messages={thread.messages}
                  snapshot={snapshot}
                  hasOlder={thread.ready && thread.hasOlder}
                  loadingOlder={thread.loadingOlder}
                  onOlder={thread.loadOlder}
                  onTrim={thread.trim}
                  follow={follow}
                />
                {thread.ready ? (
                  <Composer
                    key={`compose:${summary.key}`}
                    label="Reply"
                    routes={replyRoutes}
                    contextId={summary.desk ? 'city-desk' : summary.context_id}
                    replyTo={(route) =>
                      summary.desk
                        ? undefined
                        : [...thread.messages]
                            .reverse()
                            .find((message) => message.to_agent_id === route.from.id)?.id
                    }
                    paused={snapshot.paused}
                    onSent={sent}
                    draft={drafts.current.get(summary.key) ?? ''}
                    onDraft={(text) => drafts.current.set(summary.key, text)}
                  />
                ) : null}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** Inbox panel on the agent detail view. */
export function AgentInbox({
  agent,
  snapshot,
  onSummaryChanged,
}: {
  agent: Agent;
  snapshot: Snapshot;
  onSummaryChanged?: () => void;
}) {
  const inbox = usePoll<InboxPage>(`/api/agents/${agent.id}/inbox?limit=20`);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState('');
  const page = inbox.data;
  const routes = routesOf(snapshot, (route) => route.from.id === agent.id);
  async function acknowledge() {
    if (!page) return;
    setBusy(true);
    setError('');
    try {
      await api<InboxAck>(`/api/agents/${agent.id}/inbox/ack`, { seq: page.latest_seq });
      await inbox.refresh();
      onSummaryChanged?.();
    } catch (err) {
      setError(describe(err, agent.name));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="msg-inbox" aria-label={`${agent.name} inbox`}>
      <MessageStyles />
      <div className="msg-inbox-head">
        <h3>
          <Inbox size={17} aria-hidden="true" />
          Inbox
          {page && page.unread ? (
            <span className="msg-count" aria-label={`${page.unread} unread`}>
              {page.unread}
            </span>
          ) : null}
        </h3>
        {page && page.unread ? (
          <button
            className="button secondary compact"
            disabled={busy}
            onClick={() => void acknowledge()}
          >
            <CheckCheck size={14} />
            Mark read as {agent.name}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {inbox.error ? (
        <ReadError error={inbox.error} loading={inbox.loading} retry={inbox.refresh} />
      ) : null}
      {!page ? (
        inbox.error ? null : (
          <p className="muted small" role="status">
            Loading inbox…
          </p>
        )
      ) : page.messages.length ? (
        <>
          <p className="muted small">
            {page.unread
              ? `${page.unread} of ${page.latest_seq} unread by ${agent.name}.`
              : `${agent.name} has read all ${page.latest_seq}.`}{' '}
            These messages come from other agents: check before you act on them.
          </p>
          <ol className="msg-scroll" style={{ listStyle: 'none', margin: 0 }}>
            {page.messages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                snapshot={snapshot}
                unread={message.seq > page.acked_seq}
              />
            ))}
          </ol>
        </>
      ) : (
        <p className="muted small">No messages delivered to {agent.name} yet.</p>
      )}
      {agent.status === 'revoked' ? null : writing ? (
        <Composer
          label={`Send as ${agent.name}`}
          routes={routes}
          paused={snapshot.paused}
          onSent={async () => {
            setWriting(false);
            await inbox.refresh();
            onSummaryChanged?.();
          }}
        />
      ) : (
        <div>
          <button className="button secondary compact" onClick={() => setWriting(true)}>
            <Send size={14} />
            Write as {agent.name}
          </button>
        </div>
      )}
    </section>
  );
}
