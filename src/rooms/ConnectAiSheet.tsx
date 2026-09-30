import { useEffect, useRef } from 'react';
import { ArrowRight, ExternalLink, X } from 'lucide-react';
import { CopyButton } from '../components';
import {
  claudeConnectLink,
  cursorDeeplink,
  isLoopbackHost,
  PRODUCTION_ORIGIN,
  vscodeDeeplink,
} from '../Connect';
import { CHATGPT_ADMIN_NOTE, MCP_PATH } from '../shell/roomInvite';

/** The server name the Connect page uses for a signed-in connection. */
const SERVER = 'central-city';

/** A copyable line (address or command), as on the Connect page. */
function CopyLine({ value, describedAs }: { value: string; describedAs: string }) {
  return (
    <div className="rm-copy-line">
      <code tabIndex={0} role="group" aria-label={describedAs}>
        {value}
      </code>
      <CopyButton key={value} value={value} label="Copy" describedAs={describedAs} />
    </div>
  );
}

/**
 * "Connect AI": how to bring your own AI into this room. The same connection details as the
 * Connect page's one-click installs (signed-in address, production unless this is a local
 * server), shortened to one step per app, then the room's invite link.
 */
export function ConnectAiSheet({
  host,
  onInvite,
  onClose,
}: {
  /** The viewer hosts the room, so they can open its invite link. */
  host: boolean;
  onInvite: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const local = isLoopbackHost();
  const endpoint = `${local ? window.location.origin : PRODUCTION_ORIGIN}${MCP_PATH}`;

  // Focus the dialog, trap Tab inside it, close on Escape.
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      if (event.key !== 'Tab' || !element) return;
      const focusable = [
        ...element.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, summary, [href], [tabindex="0"]',
        ),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('keydown', keys);
      previous?.focus?.();
    };
  }, []);

  return (
    <div
      className="rm-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="rm-sheet rm-connect"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rm-connect-title"
        aria-describedby="rm-connect-lede"
        tabIndex={-1}
        ref={dialog}
      >
        <div className="rm-sheet-head">
          <div>
            <h2 id="rm-connect-title">Connect your AI</h2>
            <p id="rm-connect-lede" className="rm-meta">
              Bring your own AI into this room.
            </p>
          </div>
          <button type="button" className="rm-icon" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="rm-instruction">
          1. Connect your AI app to Central City once. When it asks, sign in and choose what your AI
          may do.
        </p>
        <ul className="rm-connect-list">
          <li className="rm-connect-card">
            <div className="rm-connect-name">
              <span className="rm-role">Claude</span>
              <span className="rm-meta">Web and Desktop connector</span>
            </div>
            {local ? (
              <p className="rm-meta">
                Claude needs a public address. Connect it from the live Central City site.
              </p>
            ) : (
              <>
                <p>
                  Open Claude with the connector filled in, then choose <strong>Add</strong>.
                </p>
                <a
                  className="rm-connect-link"
                  href={claudeConnectLink(endpoint)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Add to Claude <ExternalLink size={14} aria-hidden="true" />
                </a>
                <CopyLine value={endpoint} describedAs="Claude connection link" />
              </>
            )}
          </li>
          <li className="rm-connect-card">
            <div className="rm-connect-name">
              <span className="rm-role">ChatGPT</span>
              <span className="rm-meta">App in ChatGPT Plugins</span>
            </div>
            {local ? (
              <p className="rm-meta">
                ChatGPT needs a public address. Connect it from the live Central City site.
              </p>
            ) : (
              <>
                <p>
                  In ChatGPT Plugins choose <strong>Build MCP Apps</strong>, name it{' '}
                  <strong>Central City</strong>, paste this address and choose{' '}
                  <strong>OAuth</strong>.
                </p>
                <a
                  className="rm-connect-link"
                  href="https://chatgpt.com/plugins"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open ChatGPT Plugins <ExternalLink size={14} aria-hidden="true" />
                </a>
                <CopyLine value={endpoint} describedAs="ChatGPT connection link" />
                <p className="rm-meta">{CHATGPT_ADMIN_NOTE}</p>
              </>
            )}
          </li>
          <li className="rm-connect-card">
            <div className="rm-connect-name">
              <span className="rm-role">Claude Code</span>
              <span className="rm-meta">Terminal</span>
            </div>
            <p>
              Run this in your terminal, then open Claude Code, run <code>/mcp</code> and choose
              Authenticate.
            </p>
            <CopyLine
              value={`claude mcp add --transport http ${SERVER} ${endpoint}`}
              describedAs="Claude Code command"
            />
          </li>
          <li className="rm-connect-card">
            <div className="rm-connect-name">
              <span className="rm-role">Codex</span>
              <span className="rm-meta">Terminal</span>
            </div>
            <p>Run these in your terminal:</p>
            <CopyLine
              value={`codex mcp add ${SERVER} --url ${endpoint}`}
              describedAs="Codex command"
            />
            <CopyLine value={`codex mcp login ${SERVER}`} describedAs="Codex sign-in command" />
          </li>
          <li className="rm-connect-card">
            <div className="rm-connect-name">
              <span className="rm-role">Cursor and VS Code</span>
              <span className="rm-meta">Open in app</span>
            </div>
            <p className="rm-connect-links">
              <a className="rm-connect-link" href={cursorDeeplink(endpoint)}>
                Add to Cursor <ExternalLink size={14} aria-hidden="true" />
              </a>
              <a className="rm-connect-link" href={vscodeDeeplink(endpoint)}>
                Install in VS Code <ExternalLink size={14} aria-hidden="true" />
              </a>
            </p>
          </li>
        </ul>
        <p className="rm-instruction">
          2.{' '}
          {host
            ? "Copy this room's invite link and paste it into your AI. It joins this room as a member."
            : "Paste this room's invite link into your AI. The host can share it with you."}
        </p>
        <div className="rm-connect-foot">
          <a className="rm-connect-link" href="/#connect">
            All connection options <ArrowRight size={14} aria-hidden="true" />
          </a>
          {host ? (
            <button type="button" className="rm-primary" onClick={onInvite}>
              Get the invite link
            </button>
          ) : (
            <button type="button" className="rm-outline" onClick={onClose}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
