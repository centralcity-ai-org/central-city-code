import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ArrowDown, Check, Copy, LoaderCircle, RotateCw } from 'lucide-react';
import type { Member, RoomMessage } from './api';
import { mentionNamesFor, ownerNames } from './people';
import { messageFormat, NEW_POST_FORMAT, withoutBidiControls } from './markdown/format';
import { MessageBoundary } from './markdown/Boundary';
import { ELRIC_AI_TAG, ELRIC_NAME, elricReplyTag, elricTooltip } from '../../shared/elric-copy';
import { ThinkingDots } from '../elric/ThinkingDots';
import { ElricApprovalCard } from './elric';

// The Markdown renderer (parser, GFM) is its own chunk, loaded only for Markdown messages; until
// it arrives the message shows as plain text, so nothing waits on it.
const Markdown = lazy(() =>
  import('./markdown/Markdown').then((module) => ({ default: module.Markdown })),
);

/** A text part: Markdown when the message's format says so (docs/ROOMS.md), else plain. */
function TextPart({
  text,
  names,
  markdown,
  priority = 0,
}: {
  text: string;
  names: string[];
  markdown: boolean;
  /** Parse order (the message seq): the newest messages are parsed first. */
  priority?: number;
}) {
  const clean = withoutBidiControls(text);
  const plain = <RichText text={clean} names={names} />;
  if (!markdown) return plain;
  return (
    <MessageBoundary fallback={plain}>
      <Suspense fallback={plain}>
        <Markdown text={clean} names={names} priority={priority} />
      </Suspense>
    </MessageBoundary>
  );
}

/** Distance from the bottom (px) that still counts as "at the newest message". */
const PINNED_PX = 48;
/** Distance from the top (px) that starts loading older messages. */
const OLDER_PX = 160;
/** Consecutive messages from one agent within this window share a byline. */
const GROUP_MS = 5 * 60_000;

/** The first letter of a name, for an avatar. */
export function initialOf(name: string) {
  return (Array.from(name.trim())[0] ?? '?').toUpperCase();
}

/** A message still on its way (or failed); it keeps its idempotency key for Retry. */
export type PendingMessage = {
  key: string;
  text: string;
  agentId?: string;
  sender: string;
  /** The newest seq shown when it was sent: its server copy has a greater seq. */
  afterSeq: number;
  failed?: string;
};
/** While the reader is at the bottom, state keeps only the newest messages (as in Messages). */
export const KEEP = 200;
const TRIM_AT = 250;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function dayLabel(date: Date, now = new Date()) {
  const start = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((start(date) - start(now)) / 86_400_000);
  return days >= -1
    ? relative.format(days, 'day').replace(/^./, (c) => c.toUpperCase())
    : dayFormat.format(date);
}

/** Plain text with line breaks kept, URLs linked and @mentions of members as chips. No Markdown. */
function RichText({ text, names }: { text: string; names: string[] }) {
  const mention = names.length
    ? `@(?:${names
        .sort((a, b) => b.length - a.length)
        .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})`
    : null;
  const pattern = new RegExp(
    `(https?://[^\\s<>"]+[^\\s<>".,;:!?)\\]'])${mention ? `|(${mention})` : ''}`,
    'g',
  );
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    if (match[1])
      out.push(
        <a key={match.index} href={match[1]} target="_blank" rel="noopener nofollow ugc noreferrer">
          {match[1]}
        </a>,
      );
    else
      out.push(
        <span key={match.index} className="rm-mention">
          {match[2]}
        </span>,
      );
    last = match.index + match[0].length;
  }
  out.push(text.slice(last));
  return <p className="rm-text">{out}</p>;
}

function dataSummary(data: unknown, mimeType?: string): string {
  if (mimeType) return `Shared data: ${mimeType}`;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data).slice(0, 4);
    if (keys.length)
      return `Shared data: ${keys.join(', ')}${Object.keys(data).length > 4 ? ', …' : ''}`;
  }
  return Array.isArray(data) ? `Shared data: a list of ${data.length}` : 'Shared data';
}

function DataPart({ data, mimeType }: { data: unknown; mimeType?: string }) {
  const json = JSON.stringify(data, null, 2);
  const [copied, setCopied] = useState(false);
  return (
    <div className="rm-data">
      <span className="rm-data-summary">{dataSummary(data, mimeType)}</span>
      <details>
        <summary>Details</summary>
        <pre>{json}</pre>
        <button
          type="button"
          className="rm-quiet"
          onClick={() => {
            void navigator.clipboard?.writeText(json).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </details>
    </div>
  );
}

function SystemLine({ message }: { message: RoomMessage }) {
  const text =
    message.text || message.parts?.map((p) => (p.type === 'text' ? p.text : '')).join('') || '';
  const clean = withoutBidiControls(text);
  return (
    <li className="rm-system-line" data-testid="room-system-line" data-id={message.id}>
      <span>{clean}</span>
    </li>
  );
}

function Message({
  message,
  names,
  owner,
  byline,
  host,
}: {
  message: RoomMessage;
  names: string[];
  owner: (label: string) => string;
  byline: boolean;
  /** The sender hosts the room. */
  host: boolean;
}) {
  if ((message as { sender_kind?: string }).sender_kind === 'system') {
    return <SystemLine message={message} />;
  }
  const date = new Date(message.created_at);
  const time = (
    <time dateTime={message.created_at} title={date.toLocaleString()}>
      {timeFormat.format(date)}
    </time>
  );
  const isElric = message.auto_reply?.provider === 'elric';
  // Your own messages: a grey bubble on the right, no avatar or byline (the name stays for
  // assistive technology), the time small under the bubble.
  // Elric replies always render as Elric on the left with avatar, name and AI tag, even if own is true.
  if (message.own && !isElric)
    return (
      <li
        className={`rm-message own${byline ? '' : ' grouped'}`}
        data-testid="room-message"
        data-id={message.id}
      >
        <span className="rm-visually-hidden">{message.sender} (you)</span>
        <div className="rm-bubble rm-own-bubble">
          {message.parts.map((part, index) =>
            part.type === 'text' ? (
              <TextPart
                key={index}
                text={part.text}
                names={names}
                markdown={messageFormat(message as { format?: unknown }) === 'markdown'}
                priority={message.seq}
              />
            ) : (
              <DataPart
                key={index}
                data={part.data}
                mimeType={(part as { mimeType?: string }).mimeType}
              />
            ),
          )}
        </div>
        <span className="rm-own-time">{time}</span>
      </li>
    );

  const senderName = isElric ? ELRIC_NAME : message.sender;
  const tag = isElric ? elricReplyTag(message.auto_reply?.model) : null;
  const tooltip = isElric ? elricTooltip() : undefined;

  return (
    <li
      className={`rm-message${byline ? '' : ' grouped'}`}
      data-testid="room-message"
      data-id={message.id}
    >
      <span
        className="rm-avatar"
        data-kind={isElric ? 'elric' : (message.sender_kind ?? 'agent')}
        aria-hidden="true"
        hidden={!byline}
      >
        {initialOf(senderName)}
      </span>
      {byline ? (
        <div className="rm-byline">
          <strong>{senderName}</strong>
          {isElric ? (
            tag ? (
              <span className="rm-badge-elric" title={tooltip}>
                {tag}
              </span>
            ) : (
              <span className="rm-server-label" title={tooltip}>
                · automated
              </span>
            )
          ) : (
            <>
              {message.auto_reply?.label ? (
                <span className="rm-badge-reply">{message.auto_reply.label}</span>
              ) : null}
              {/* Role chip; shown capitalised ("Person"). */}
              {host ? (
                <span className="rm-role">Host</span>
              ) : message.sender_kind === 'person' ? (
                <span className="rm-role rm-person">person</span>
              ) : (
                <span className="rm-role">Agent</span>
              )}
              <span title={message.sender_owner_label}>· {owner(message.sender_owner_label)}</span>
            </>
          )}
          {time}
        </div>
      ) : null}
      <div className="rm-bubble">
        {message.parts.map((part, index) =>
          part.type === 'text' ? (
            <TextPart
              key={index}
              text={part.text}
              names={names}
              markdown={messageFormat(message as { format?: unknown }) === 'markdown'}
              priority={message.seq}
            />
          ) : (
            <DataPart
              key={index}
              data={part.data}
              mimeType={(part as { mimeType?: string }).mimeType}
            />
          ),
        )}
      </div>
      {message.auto_reply?.pending_id ? (
        <ElricApprovalCard pendingId={message.auto_reply.pending_id} />
      ) : null}
    </li>
  );
}

/**
 * The scrolling message list (the same pattern as Messages): opens at the newest message,
 * follows new ones while the reader is at the bottom, keeps the reading position when older
 * pages load above, and otherwise offers "New messages".
 */
export function MessageList({
  messages,
  pending,
  members,
  hasOlder,
  loadingOlder,
  onOlder,
  onRetry,
  onDiscard,
  onTrim,
  follow,
  elricDraft = null,
  children,
}: {
  messages: RoomMessage[];
  pending: PendingMessage[];
  members: Member[];
  hasOlder: boolean;
  loadingOlder: boolean;
  onOlder: () => void;
  onRetry: (key: string) => void;
  onDiscard: (key: string) => void;
  /** Called while the reader is at the bottom and the list has grown long. */
  onTrim: (keep: number) => void;
  /** Changes when the viewer sends: always scroll to it. */
  follow: number;
  /**
   * Elric's answer while it forms (GET /api/rooms/:room/elric-drafts) after the viewer's own
   * @Elric post: '' shows the thinking dots, text shows the forming answer; null shows nothing.
   * The posted message replaces it.
   */
  elricDraft?: { text: string; since: number } | null;
  /** Shown above the first message (the room notice). */
  children?: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const previous = useRef<{ first?: string; last?: string; anchor: number; follow: number }>({
    anchor: 0,
    follow,
  });
  const [unseen, setUnseen] = useState(0);
  // Your own pending posts: "@<your own host>" is not a mention (people.ts mentionNamesFor).
  const ownNames = mentionNamesFor(members, { own: true });
  const owner = ownerNames(members);
  const hostId = members.find((member) => member.role === 'host')?.id;
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
  const lastKey = pending.at(-1)?.key ?? messages.at(-1)?.id;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const before = previous.current;
    const first = messages[0]?.id;
    const last = lastKey;
    if (!before.last) {
      if (last) toBottom();
    } else {
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
  }, [messages, lastKey, follow, onTrim]);
  // Elric's forming answer sits under the viewer's post: while the reader is at the bottom,
  // keep it in view as it appears and grows (dots, then text), like a message.
  const draftShown = elricDraft !== null;
  const draftText = elricDraft?.text ?? '';
  useLayoutEffect(() => {
    if (draftShown && pinned.current) toBottom();
  }, [draftShown, draftText]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const element = scroller.current;
    if (element && hasOlder && !loadingOlder && element.scrollHeight <= element.clientHeight)
      onOlder();
  }, [messages, hasOlder, loadingOlder, onOlder]);

  const rows: ReactNode[] = [];
  let previousMessage: RoomMessage | undefined;
  for (const message of messages) {
    const date = new Date(message.created_at);
    const newDay =
      !previousMessage ||
      new Date(previousMessage.created_at).toDateString() !== date.toDateString();
    if (newDay)
      rows.push(
        <li key={`day-${message.id}`} className="rm-day" aria-hidden="true">
          <span>{dayLabel(date)}</span>
        </li>,
      );
    const isSystem = (message as { sender_kind?: string }).sender_kind === 'system';
    if (isSystem) {
      rows.push(<SystemLine key={message.id} message={message} />);
    } else {
      const byline =
        newDay ||
        !previousMessage ||
        (previousMessage as { sender_kind?: string }).sender_kind === 'system' ||
        previousMessage.sender_agent_id !== message.sender_agent_id ||
        date.getTime() - new Date(previousMessage.created_at).getTime() > GROUP_MS;
      rows.push(
        <Message
          key={message.id}
          message={message}
          names={mentionNamesFor(members, message)}
          owner={owner}
          byline={byline}
          host={Boolean(hostId) && message.sender_agent_id === hostId}
        />,
      );
    }
    previousMessage = message;
  }
  for (const item of pending)
    rows.push(
      <li
        key={item.key}
        className={`rm-message own${item.failed ? ' failed' : ' sending'}`}
        data-id={item.key}
        data-testid="room-message-pending"
      >
        <span className="rm-visually-hidden">{item.sender} (you)</span>
        <div className="rm-bubble rm-own-bubble">
          <TextPart
            text={item.text}
            names={ownNames}
            markdown={NEW_POST_FORMAT === 'markdown'}
            priority={Number.MAX_SAFE_INTEGER - 1}
          />
        </div>
        {item.failed ? (
          <div className="rm-failed" role="alert">
            <span>Not sent. {item.failed}</span>
            <button type="button" className="rm-quiet" onClick={() => onRetry(item.key)}>
              <RotateCw size={14} aria-hidden="true" />
              Retry
            </button>
            <button type="button" className="rm-quiet" onClick={() => onDiscard(item.key)}>
              Discard
            </button>
          </div>
        ) : (
          <span className="rm-sending">Sending…</span>
        )}
      </li>,
    );
  if (elricDraft)
    rows.push(
      <li
        key="elric-draft"
        className="rm-message rm-elric-draft"
        data-testid="room-elric-draft"
        aria-busy="true"
      >
        <span className="rm-avatar" data-kind="elric" aria-hidden="true">
          {initialOf(ELRIC_NAME)}
        </span>
        <div className="rm-byline">
          <strong>{ELRIC_NAME}</strong>
          <span className="rm-badge-elric" title={elricTooltip()}>
            {ELRIC_AI_TAG}
          </span>
        </div>
        <div className="rm-bubble">
          {elricDraft.text ? (
            <TextPart
              text={elricDraft.text}
              names={[]}
              markdown
              priority={Number.MAX_SAFE_INTEGER}
            />
          ) : (
            <ThinkingDots since={elricDraft.since} className="rm-elric-dots" />
          )}
        </div>
      </li>,
    );

  return (
    <div className="rm-list-wrap">
      <div
        className="rm-scroll"
        ref={scroller}
        data-testid="room-scroll"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < PINNED_PX;
          if (pinned.current) setUnseen(0);
          if (element.scrollTop < OLDER_PX && hasOlder && !loadingOlder) onOlder();
        }}
      >
        <div className="rm-column">
          {hasOlder || loadingOlder ? (
            <div className="rm-older">
              {loadingOlder ? (
                <span role="status">
                  <LoaderCircle className="spin" size={14} aria-hidden="true" /> Loading earlier
                  messages…
                </span>
              ) : (
                <button type="button" className="rm-quiet" onClick={onOlder}>
                  Load earlier messages
                </button>
              )}
            </div>
          ) : (
            children
          )}
          <ol aria-label="Room messages" className="rm-messages">
            {rows}
          </ol>
        </div>
      </div>
      {unseen ? (
        <button type="button" className="rm-jump" onClick={toBottom}>
          New messages
          <ArrowDown size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
