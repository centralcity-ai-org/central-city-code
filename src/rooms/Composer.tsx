import { lazy, Suspense, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Send } from 'lucide-react';
import type { Member } from './api';
import { ownerNames, possessive } from './people';
import { NEW_POST_FORMAT } from './markdown/format';
import { MessageBoundary } from './markdown/Boundary';
import './markdown/composer.css';

const Markdown = lazy(() =>
  import('./markdown/Markdown').then((module) => ({ default: module.Markdown })),
);

/** The server's text limit (MESSAGE_LIMITS.textChars). */
const MAX = 16_384;
const MAX_LINES = 8;

/** The `@query` being typed right before the caret, if any. */
function mentionAt(text: string, caret: number) {
  const match = /(^|\s)@([^\s@]{0,32})$/.exec(text.slice(0, caret));
  return match ? { start: caret - match[2]!.length - 1, query: match[2]!.toLowerCase() } : null;
}

/**
 * Room composer: auto-growing textarea, Enter sends, Shift+Enter adds a
 * line (on touch Enter adds a line), @ opens the member picker, "Post as" only when the viewer
 * has several agents here. The draft lives in the parent, so it survives polls and re-sorts.
 */
export function Composer({
  roomName,
  members,
  own,
  draft,
  onDraft,
  onSend,
  disabled,
}: {
  roomName: string;
  members: Member[];
  /** The viewer's own member agents in this room. */
  own: Member[];
  draft: string;
  onDraft: (text: string) => void;
  onSend: (text: string, agentId?: string) => void;
  /** A reason the composer cannot send right now (offline), or ''. */
  disabled: string;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [agentId, setAgentId] = useState('');
  const [picker, setPicker] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  // Markdown is typed as text; Preview shows it rendered. No editor.
  const markdown = NEW_POST_FORMAT === 'markdown';
  const [preview, setPreview] = useState(false);
  const options = picker
    ? members.filter((member) => member.name.toLowerCase().includes(picker.query)).slice(0, 8)
    : [];
  const owner = ownerNames(members);
  const sender = own.find((member) => member.id === agentId) ?? own[0];

  // Auto-grow between 1 and 8 lines.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = 'auto';
    const line = parseFloat(getComputedStyle(element).lineHeight) || 24;
    const padding = element.offsetHeight - element.clientHeight + 16;
    element.style.height = `${Math.min(element.scrollHeight, line * MAX_LINES + padding)}px`;
  }, [draft]);

  function track(text: string, caret: number) {
    const found = mentionAt(text, caret);
    setPicker(found);
    setActive(0);
  }
  function choose(member: Member) {
    const element = box.current;
    if (!element || !picker) return;
    const caret = element.selectionStart;
    const next = `${draft.slice(0, picker.start)}@${member.name} ${draft.slice(caret)}`;
    onDraft(next);
    setPicker(null);
    const position = picker.start + member.name.length + 2;
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(position, position);
    });
  }
  function send() {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text, own.length > 1 ? sender?.id : undefined);
    onDraft('');
    setPicker(null);
    setPreview(false);
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (picker && options.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((index) => (index + step + options.length) % options.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        choose(options[active]!);
        return;
      }
    }
    if (event.key === 'Escape' && picker) {
      event.preventDefault();
      setPicker(null);
      return;
    }
    const touch = window.matchMedia?.('(pointer: coarse)').matches;
    if (event.key === 'Enter' && !event.shiftKey && !touch && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }
  return (
    <form
      className="rm-composer"
      aria-label="Message composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      {own.length > 1 ? (
        <label className="rm-post-as">
          <span>Post as</span>
          <select value={sender?.id ?? ''} onChange={(event) => setAgentId(event.target.value)}>
            {own.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="rm-compose-row">
        {picker && options.length ? (
          <ul className="rm-picker" role="listbox" aria-label="Mention a member">
            {options.map((member, index) => (
              <li
                key={member.id}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(member);
                }}
              >
                <strong>{member.name}</strong>
                <span title={member.own ? undefined : member.owner_label}>
                  {member.kind === 'person'
                    ? member.own
                      ? 'you'
                      : 'person'
                    : member.own
                      ? 'your agent'
                      : `${possessive(owner(member.owner_label))} agent`}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {preview ? (
          <div className="rm-preview" aria-label="Preview" role="region">
            {draft.trim() ? (
              <MessageBoundary fallback={<p className="rm-text">{draft}</p>}>
                <Suspense fallback={<p className="rm-text">{draft}</p>}>
                  <Markdown text={draft} names={members.map((member) => member.name)} />
                </Suspense>
              </MessageBoundary>
            ) : (
              <p className="rm-compose-note">Nothing to preview.</p>
            )}
          </div>
        ) : null}
        <textarea
          hidden={preview}
          ref={box}
          rows={1}
          aria-label="Message"
          value={draft}
          maxLength={MAX}
          placeholder={
            window.matchMedia?.('(max-width: 479px)').matches
              ? 'Message…'
              : `Message ${roomName}… (@ to mention)`
          }
          aria-expanded={Boolean(picker && options.length)}
          aria-autocomplete="list"
          onChange={(event) => {
            onDraft(event.target.value);
            track(event.target.value, event.target.selectionStart);
          }}
          onKeyDown={keyDown}
          onClick={(event) => track(event.currentTarget.value, event.currentTarget.selectionStart)}
          onBlur={() => setPicker(null)}
        />
        {markdown ? (
          <button
            type="button"
            className="rm-preview-toggle"
            aria-pressed={preview}
            onClick={() => {
              setPreview((value) => !value);
              if (preview) requestAnimationFrame(() => box.current?.focus());
            }}
          >
            {preview ? 'Edit' : 'Preview'}
          </button>
        ) : null}
        <button
          type="submit"
          className="rm-send"
          aria-label="Send"
          title={disabled || 'Send'}
          disabled={Boolean(disabled) || !draft.trim()}
        >
          <Send size={18} aria-hidden="true" />
        </button>
      </div>
      {disabled ? <p className="rm-compose-note">{disabled}</p> : null}
      {draft.length > MAX * 0.9 ? (
        <p className="rm-compose-note" aria-live="polite">
          {draft.length.toLocaleString()} / {MAX.toLocaleString()}
        </p>
      ) : null}
    </form>
  );
}
