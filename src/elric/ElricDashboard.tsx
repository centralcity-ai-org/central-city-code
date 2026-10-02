import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, AtSign, Check, SquarePen, X } from 'lucide-react';
import { api, ApiError } from '../api';
import { CityMark } from '../brand';
import { createHttpRoomsClient, type RoomMessage } from '../rooms/api';
import { MessageBoundary } from '../rooms/markdown/Boundary';
import { withoutBidiControls } from '../rooms/markdown/format';
import {
  ELRIC_AI_NOTICE,
  ELRIC_AI_TAG,
  ELRIC_NAME,
  elricProfileTitle,
  elricReplyTag,
  elricTooltip,
} from '../../shared/elric-copy';
import { ThinkingDots } from './ThinkingDots';
import './dashboard.css';

/**
 * The /elric dashboard: a private chat with the owner's Elric (docs/ELRIC.md "Dashboard chat").
 * Everything comes from the server: the chat room (GET /api/elric/chat), its messages (the room
 * read route), pending actions Elric proposed (GET /api/elric/pending, the owner approves or
 * rejects) and the "@ room" picker (GET /api/elric/rooms + POST /api/elric/ask). A message is
 * posted as the owner's person member with an "@Elric" prefix, so every Elric rule applies.
 */

const Markdown = lazy(() =>
  import('../rooms/markdown/Markdown').then((module) => ({ default: module.Markdown })),
);

type Chat = {
  room_id: string;
  person_member_id: string;
  status: 'active' | 'paused';
  latest_seq: number;
  waking: boolean;
  pending_count: number;
};
type Message = RoomMessage & { auto_reply?: { model?: string | null } | null };
type Pending = {
  id: string;
  summary: string;
  args_hash: string;
  room: { id: string; name: string } | null;
};
type PickerRoom = { id: string; name: string; elric_member: boolean };
type Phase = 'loading' | 'ready' | 'none' | 'error';

const SUGGESTIONS = ['Summarize my latest room', 'Draft a short task', 'Explain a term'];
const MENTION = '@Elric ';
/**
 * How long the dots wait for a reply before giving up (a failed or refused turn posts nothing):
 * the server's 55 s run budget plus a few seconds for the reply to arrive.
 */
const THINKING_TIMEOUT_MS = 60_000;
const rooms = createHttpRoomsClient();

/** The person's text without the "@Elric" prefix the dashboard adds. */
const shown = (text: string) => text.replace(/^@Elric\s+/i, '');

function Reply({ message }: { message: Message }) {
  const clean = withoutBidiControls(message.text);
  const plain = <p className="elx-plain">{clean}</p>;
  const tag = elricReplyTag(message.auto_reply?.model);
  return (
    <div className="elx-turn elx-turn-elric" data-testid="elric-reply">
      <div className="elx-reply">
        <MessageBoundary fallback={plain}>
          <Suspense fallback={plain}>
            <Markdown text={clean} priority={message.seq} />
          </Suspense>
        </MessageBoundary>
      </div>
      <p className="elx-meta elx-byline" title={elricTooltip()}>
        {tag ? (
          <>
            {ELRIC_NAME} <span className="elx-tag">{tag}</span>
          </>
        ) : (
          `${ELRIC_NAME} · automated`
        )}
      </p>
    </div>
  );
}

/** Elric's answer while it forms (GET /api/rooms/:room/elric-drafts), in the reply's place. */
type Draft = { agent_id: string; source_seq: number; text: string; updated_at: number };
/** How often a forming answer is read, and for how long at most (the run budget plus delivery). */
const DRAFT_POLL_MS = 500;
const DRAFT_MAX_MS = 60_000;

function DraftReply({ text }: { text: string }) {
  const clean = withoutBidiControls(text);
  const plain = <p className="elx-plain">{clean}</p>;
  return (
    <div className="elx-turn elx-turn-elric elx-draft" data-testid="elric-draft" aria-busy="true">
      <div className="elx-reply">
        <MessageBoundary fallback={plain}>
          <Suspense fallback={plain}>
            <Markdown text={clean} priority={Number.MAX_SAFE_INTEGER} />
          </Suspense>
        </MessageBoundary>
      </div>
      <p className="elx-meta elx-byline" title={elricTooltip()}>
        {ELRIC_NAME} <span className="elx-tag">{ELRIC_AI_TAG}</span>
        <span className="visually-hidden"> is writing</span>
      </p>
    </div>
  );
}

/**
 * Elric's profile/about sheet: the name and version (elricProfileTitle), the AI disclosure and
 * one button. Escape or the scrim closes it; focus moves in and goes back to the opener.
 */
function AboutSheet({ onClose }: { onClose: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    button.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      // One focusable control: Tab stays on it.
      if (event.key === 'Tab') {
        event.preventDefault();
        button.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="elx-scrim" onClick={onClose}>
      <div
        className="elx-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="elx-about-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="elx-about-title">{elricProfileTitle()}</h2>
        <p>{ELRIC_AI_NOTICE}</p>
        <button ref={button} type="button" className="elx-primary" onClick={onClose}>
          OK
        </button>
      </div>
    </div>
  );
}

/**
 * Signed in, no Elric yet: one inline step. A verified adult starts with one click; otherwise the
 * date of birth is asked once (POST /api/elric/age, the server alone decides 18+), then Elric is
 * created (POST /api/elric) and the chat opens. Elric needs a linked Google account first.
 */
function ElricSetup({ onReady }: { onReady: () => void }) {
  const [eligible, setEligible] = useState<boolean | null>(null);
  const [dob, setDob] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState<'form' | 'adults' | 'google'>('form');
  useEffect(() => {
    let live = true;
    void api<{ eligible?: boolean }>('/api/elric', undefined, 'GET')
      .then((value) => live && setEligible(value.eligible === true))
      .catch(() => live && setEligible(false));
    return () => {
      live = false;
    };
  }, []);
  async function start(event?: { preventDefault: () => void }) {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (!eligible) await api('/api/elric/age', { date_of_birth: dob });
      await api('/api/elric', { name: ELRIC_NAME });
      onReady();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === 'elric_age_under_18') setState('adults');
      else if (code === 'google_link_required') setState('google');
      else if (code === 'invalid_date_of_birth') setError('Enter a valid date.');
      else setError(err instanceof Error ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  }
  if (eligible === null) return null;
  if (state === 'adults')
    return (
      <div className="elx-empty" role="status">
        <h2>Elric is for adults</h2>
        <p>Elric is available from age 18.</p>
      </div>
    );
  if (state === 'google')
    return (
      <div className="elx-empty">
        <h2>Elric needs Google sign-in</h2>
        <p>Link your Google account, then come back.</p>
        <a className="elx-primary" href="/settings/account">
          Link Google
        </a>
      </div>
    );
  return (
    <div className="elx-empty elx-setup">
      <h2>What can I help with?</h2>
      {eligible ? (
        <button type="button" className="elx-primary" disabled={busy} onClick={() => void start()}>
          Start chatting
        </button>
      ) : (
        <>
          <p>Elric is for adults. Enter your date of birth once.</p>
          <form onSubmit={(event) => void start(event)}>
            <input
              type="date"
              required
              value={dob}
              aria-label="Date of birth"
              onChange={(event) => setDob(event.target.value)}
            />
            <button type="submit" className="elx-primary" disabled={busy || !dob}>
              Continue
            </button>
          </form>
        </>
      )}
      {error ? (
        <p className="elx-auth-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ElricDashboard() {
  const [phase, setPhase] = useState<Phase>('loading');
  // Bumped after the inline setup creates Elric: the chat loads again.
  const [loadKey, setLoadKey] = useState(0);
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [fromSeq, setFromSeq] = useState(0);
  const [pending, setPending] = useState<Pending[]>([]);
  const [initial, setInitial] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [picker, setPicker] = useState<PickerRoom[] | null>(null);
  const [target, setTarget] = useState<PickerRoom | null>(null);
  const [sentSeq, setSentSeq] = useState<number | null>(null);
  // When the current wait began (for the dots' quiet lines), the last text sent, and what Try
  // again resends after a turn that never answered.
  const [sentAt, setSentAt] = useState(0);
  const lastText = useRef('');
  const [retry, setRetry] = useState<string | null>(null);
  // The answer forming for the person's last post (text '' until the first words arrive).
  const [forming, setForming] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [about, setAbout] = useState(false);
  const closeAbout = useCallback(() => setAbout(false), []);
  const latest = useRef(0);
  const pendingCount = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);

  const merge = useCallback((list: Message[]) => {
    if (!list.length) return;
    setMessages((current) => {
      const bySeq = new Map(current.map((item) => [item.seq, item]));
      for (const item of list) bySeq.set(item.seq, item);
      return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    });
    latest.current = Math.max(latest.current, ...list.map((item) => item.seq));
  }, []);

  const loadPending = useCallback(async () => {
    try {
      setPending((await api<{ pending: Pending[] }>('/api/elric/pending')).pending);
    } catch {
      // The approvals list is best effort; the chat keeps working without it.
    }
  }, []);

  // First visit: the chat room (created once on the server), its messages, the person's initial.
  useEffect(() => {
    let live = true;
    void api<{ operator: { name?: string } | null }>('/api/session', undefined, 'GET')
      .then((value) => live && setInitial((value.operator?.name ?? '').trim().charAt(0)))
      .catch(() => undefined);
    void (async () => {
      try {
        const value = await api<Chat>('/api/elric/chat', undefined, 'GET');
        if (!live) return;
        setChat(value);
        const page = await rooms.read({ room_id: value.room_id, limit: 50 });
        if (!live) return;
        merge(page.messages as Message[]);
        setPhase('ready');
        if (value.pending_count) void loadPending();
      } catch (err) {
        if (!live) return;
        setPhase(err instanceof ApiError && err.code === 'elric_not_found' ? 'none' : 'error');
      }
    })();
    return () => {
      live = false;
    };
  }, [merge, loadPending, loadKey]);

  // Poll: every 2 s while Elric is working, backing off to 60 s when idle; never while hidden.
  const waking = chat?.waking ?? false;
  const awaiting = sentSeq !== null;
  useEffect(() => {
    if (!chat) return;
    let live = true;
    let delay = waking || awaiting ? 2_000 : 10_000;
    let timer = 0;
    const tick = async () => {
      if (!live) return;
      if (document.visibilityState === 'visible') {
        try {
          const state = await api<Chat>(
            `/api/elric/chat?since=${latest.current}`,
            undefined,
            'GET',
          );
          if (!live) return;
          if (state.latest_seq > latest.current) {
            const page = await rooms.read({ room_id: chat.room_id, since: latest.current });
            if (live) merge(page.messages as Message[]);
          }
          if (state.pending_count !== pendingCount.current) void loadPending();
          pendingCount.current = state.pending_count;
          setChat((current) =>
            current && (current.waking !== state.waking || current.status !== state.status)
              ? { ...current, waking: state.waking, status: state.status }
              : current,
          );
          delay = state.waking || awaiting ? 2_000 : Math.min(delay * 2, 60_000);
        } catch {
          delay = Math.min(delay * 2, 60_000);
        }
      }
      if (live) timer = window.setTimeout(tick, delay);
    };
    timer = window.setTimeout(tick, delay);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [chat?.room_id, waking, awaiting, merge, loadPending]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whether the person wrote this message. Elric's replies carry own:true for its owner (Elric
  // belongs to them), so the sender decides, not `own`.
  const mine = useCallback(
    (item: Message) => item.sender_agent_id === chat?.person_member_id && !item.auto_reply,
    [chat?.person_member_id],
  );

  // The dots end on an Elric reply after the person's post, or after the run budget with a
  // plain error and Try again (a failed or refused turn posts nothing); that also ends the fast
  // polling.
  useEffect(() => {
    if (sentSeq === null) return;
    if (messages.some((item) => item.seq > sentSeq && !mine(item))) {
      setSentSeq(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setSentSeq(null);
      setRetry(lastText.current);
      setError('Elric didn’t answer.');
    }, THINKING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [messages, sentSeq, mine]);

  // Streamed answers: while waiting for Elric's reply to the person's post, read the forming
  // answer every 500 ms (up to the run budget). When the draft goes away the final message is
  // fetched at once, so it replaces the draft in place.
  useEffect(() => {
    if (sentSeq === null || !chat) {
      setForming(null);
      return;
    }
    let live = true;
    let seen = false;
    let timer = 0;
    const started = Date.now();
    const tick = async () => {
      if (!live) return;
      try {
        const { drafts } = await api<{ drafts: Draft[] }>(
          `/api/rooms/${encodeURIComponent(chat.room_id)}/elric-drafts`,
          undefined,
          'GET',
        );
        if (!live) return;
        const mine = drafts.find((item) => item.source_seq === sentSeq);
        if (mine) {
          seen = true;
          setForming(mine.text);
        } else if (seen) {
          // Done (or refused): pull the final message now instead of at the next slow poll.
          setForming(null);
          const page = await rooms.read({ room_id: chat.room_id, since: latest.current });
          if (live) merge(page.messages as Message[]);
        }
      } catch {
        // Drafts are a preview; the final message still arrives through the normal poll.
      }
      if (live && Date.now() - started < DRAFT_MAX_MS)
        timer = window.setTimeout(tick, DRAFT_POLL_MS);
    };
    timer = window.setTimeout(tick, DRAFT_POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [sentSeq, chat?.room_id, merge]); // eslint-disable-line react-hooks/exhaustive-deps

  // The composer grows (a long draft, a notice, the room picker): the thread's bottom padding and
  // the page's scroll padding follow its measured height, so no reply hides behind it.
  // Stick to the bottom: while the reader is at the end, any growth (the composer, a reply whose
  // Markdown renders late, a new message) keeps the end in view; scrolling up releases it.
  const root = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLElement>(null);
  const thread = useRef<HTMLElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const element = dock.current;
    if (!element) return;
    const page = document.documentElement;
    const toEnd = () => window.scrollTo({ top: page.scrollHeight, behavior: 'instant' });
    const onScroll = () => {
      stick.current = window.innerHeight + window.scrollY >= page.scrollHeight - 48;
    };
    const apply = () => {
      const height = `${Math.ceil(element.getBoundingClientRect().height)}px`;
      root.current?.style.setProperty('--elx-dock-h', height);
      page.style.scrollPaddingBottom = height;
      if (stick.current) toEnd();
    };
    apply();
    window.addEventListener('scroll', onScroll, { passive: true });
    if (typeof ResizeObserver === 'undefined')
      return () => window.removeEventListener('scroll', onScroll);
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    if (thread.current) observer.observe(thread.current);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
      page.style.scrollPaddingBottom = '';
    };
  }, [phase]);

  const visible = messages.filter((item) => item.seq > fromSeq);
  useLayoutEffect(() => {
    // A new message or the person's own post: back to the end.
    // The page's real end (it includes the composer's padding), not the last element, so the
    // newest reply never starts under the composer.
    stick.current = true;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
  }, [visible.length, sentSeq, pending.length]);

  // The composer grows with its text up to a few lines.
  useLayoutEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 200)}px`;
  }, [draft]);

  async function send(text = draft) {
    const body = text.trim();
    if (!chat || !body || sending) return;
    setSending(true);
    setError('');
    setRetry(null);
    setNotice('');
    try {
      if (target) {
        // A question in a shared room is public there: the server checks both memberships first.
        const check = await api<{ room_id: string; person_member_id: string }>('/api/elric/ask', {
          room_id: target.id,
        });
        await rooms.post({
          room_id: check.room_id,
          text: `${MENTION}${body}`,
          agent_id: check.person_member_id,
          idempotency_key: crypto.randomUUID(),
        });
        setNotice(`Posted in ${target.name}. Elric replies there.`);
      } else {
        const message = (await rooms.post({
          room_id: chat.room_id,
          text: `${MENTION}${body}`,
          agent_id: chat.person_member_id,
          idempotency_key: crypto.randomUUID(),
        })) as Message & { elric_notice?: { text?: string } };
        merge([message]);
        lastText.current = body;
        setSentAt(Date.now());
        setSentSeq(message.seq);
        if (message.elric_notice?.text) {
          setNotice(message.elric_notice.text);
          setSentSeq(null);
        }
      }
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your message wasn’t sent. Try again.');
    } finally {
      setSending(false);
      input.current?.focus();
    }
  }

  async function decide(item: Pending, decision: 'approve' | 'reject') {
    if (deciding) return;
    setDeciding(item.id);
    setError('');
    try {
      await api(
        `/api/elric/pending/${encodeURIComponent(item.id)}/${decision}`,
        decision === 'approve' ? { args_hash: item.args_hash } : {},
      );
      setPending((list) => list.filter((entry) => entry.id !== item.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t work. Try again.');
    } finally {
      setDeciding(null);
    }
  }

  async function openPicker() {
    if (picker) {
      setPicker(null);
      return;
    }
    try {
      setPicker((await api<{ rooms: PickerRoom[] }>('/api/elric/rooms')).rooms);
    } catch {
      setPicker([]);
    }
  }

  const paused = chat?.status === 'paused';
  const empty = phase === 'ready' && !visible.length && !pending.length;

  return (
    <div className="elx" ref={root}>
      <header className="elx-header">
        <a className="elx-home" href="/" aria-label="Central City home">
          <CityMark small />
        </a>
        <div className="elx-title">
          <h1>
            <button
              type="button"
              className="elx-name"
              title={elricTooltip()}
              aria-haspopup="dialog"
              onClick={() => setAbout(true)}
            >
              {ELRIC_NAME}
            </button>
          </h1>
          <span className="elx-tag">{ELRIC_AI_TAG}</span>
        </div>
        <div className="elx-actions">
          <button
            type="button"
            className="elx-icon"
            aria-label="New chat"
            title="New chat"
            disabled={phase !== 'ready'}
            onClick={() => {
              setFromSeq(latest.current);
              setSentSeq(null);
              setNotice('');
              setError('');
              input.current?.focus();
            }}
          >
            <SquarePen size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <a className="elx-avatar" href="/" aria-label="Your account">
            {initial.toUpperCase() || '·'}
          </a>
        </div>
      </header>

      <main className="elx-main" ref={thread} aria-busy={phase === 'loading'}>
        <div className="elx-column">
          {phase === 'none' ? (
            <ElricSetup onReady={() => setLoadKey((key) => key + 1)} />
          ) : phase === 'error' ? (
            <div className="elx-empty" role="alert">
              <h2>Elric couldn’t load</h2>
              <button type="button" className="elx-primary" onClick={() => location.reload()}>
                Try again
              </button>
            </div>
          ) : empty ? (
            <div className="elx-empty">
              <h2>What can I help with?</h2>
              <div className="elx-chips">
                {SUGGESTIONS.map((text) => (
                  <button
                    key={text}
                    type="button"
                    className="elx-chip"
                    onClick={() => {
                      setDraft(text);
                      input.current?.focus();
                    }}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="elx-thread" aria-live="polite">
              {fromSeq > 0 && messages.some((item) => item.seq <= fromSeq) && (
                <button type="button" className="elx-link" onClick={() => setFromSeq(0)}>
                  Show earlier messages
                </button>
              )}
              {visible.map((message) =>
                mine(message) ? (
                  <div key={message.id} className="elx-turn elx-turn-you">
                    <p className="elx-bubble">{shown(message.text)}</p>
                  </div>
                ) : (
                  <Reply key={message.id} message={message} />
                ),
              )}
              {pending.map((item) => (
                <div key={item.id} className="elx-card" data-testid="elric-pending">
                  <p className="elx-card-label">Waiting for your approval</p>
                  <p className="elx-card-title">{item.summary}</p>
                  {item.room && <p className="elx-meta">{item.room.name}</p>}
                  <div className="elx-card-actions">
                    <button
                      type="button"
                      className="elx-primary"
                      disabled={deciding !== null}
                      onClick={() => decide(item, 'approve')}
                    >
                      <Check size={18} strokeWidth={1.75} aria-hidden="true" />
                      Approve
                    </button>
                    <button
                      type="button"
                      className="elx-secondary"
                      disabled={deciding !== null}
                      onClick={() => decide(item, 'reject')}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
              {sentSeq !== null && forming ? (
                <DraftReply text={forming} />
              ) : sentSeq !== null || chat?.waking ? (
                <ThinkingDots
                  className="elx-turn elx-turn-elric"
                  {...(sentSeq !== null ? { since: sentAt } : {})}
                />
              ) : null}
            </div>
          )}
        </div>
      </main>

      {phase === 'ready' && (
        <footer className="elx-dock" ref={dock}>
          <div className="elx-column">
            {(notice || error || paused) && (
              <p className={`elx-notice ${error ? 'is-error' : ''}`} role="status">
                {error || notice || (
                  <>
                    Elric is paused. <a href="/">Resume it in Manage Elric</a> (your console).
                  </>
                )}
                {error && retry ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="elx-retry"
                      onClick={() => {
                        const text = retry;
                        setRetry(null);
                        void send(text);
                      }}
                    >
                      Try again
                    </button>
                  </>
                ) : null}
              </p>
            )}
            {picker && (
              <div className="elx-picker" role="listbox" aria-label="Ask in a room">
                {picker.length === 0 ? (
                  <p className="elx-meta">Elric isn’t in any room yet.</p>
                ) : (
                  picker.map((room) => (
                    <button
                      key={room.id}
                      type="button"
                      role="option"
                      aria-selected={target?.id === room.id}
                      className="elx-option"
                      disabled={!room.elric_member}
                      onClick={() => {
                        setTarget(room);
                        setPicker(null);
                        input.current?.focus();
                      }}
                    >
                      <span>{room.name}</span>
                      {!room.elric_member && <span className="elx-meta">Elric isn’t here</span>}
                    </button>
                  ))
                )}
              </div>
            )}
            <form
              className="elx-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <button
                type="button"
                className={`elx-icon ${target ? 'is-on' : ''}`}
                aria-label="Ask in a room"
                aria-expanded={!!picker}
                onClick={openPicker}
              >
                <AtSign size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {target && (
                <span className="elx-target">
                  {target.name}
                  <button
                    type="button"
                    aria-label={`Stop asking in ${target.name}`}
                    onClick={() => setTarget(null)}
                  >
                    <X size={14} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </span>
              )}
              <textarea
                ref={input}
                rows={1}
                value={draft}
                maxLength={4000}
                placeholder="Message Elric"
                aria-label="Message Elric"
                disabled={paused}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <button
                type="submit"
                className="elx-send"
                aria-label="Send"
                disabled={!draft.trim() || sending || paused}
              >
                <ArrowUp size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </form>
          </div>
        </footer>
      )}
      {about && <AboutSheet onClose={closeAbout} />}
    </div>
  );
}

export default ElricDashboard;
