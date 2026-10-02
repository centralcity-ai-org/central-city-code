import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useInviteHref } from './shell/navigation';
import { PublicFooter } from './shell/PublicFooter';
import { PublicHeader } from './shell/PublicHeader';
import {
  CHATGPT_ADMIN_NOTE,
  MCP_PATH,
  OPEN_MCP_PATH,
  ROOM_INVITE_CLIENTS,
} from './shell/roomInvite';
import './connect.css';

export function publicOrigin() {
  return window.location.origin;
}

/** The production site: one-click installs always point here, never at a short-lived preview. */
export const PRODUCTION_ORIGIN = 'https://centralcity.ai';

export function isLoopbackHost(hostname = window.location.hostname) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

/**
 * Cursor's MCP install link, as an HTTPS page on cursor.com that opens Cursor (a bare cursor://
 * link does nothing when Cursor is missing or the browser blocks the protocol). config is the
 * base64 of the server's mcp.json entry without the name wrapper; a remote server's entry is
 * `{ "url": … }` (https://cursor.com/docs/context/mcp/install-links).
 */
export function cursorDeeplink(mcpUrl: string, name = 'central-city') {
  const config = btoa(JSON.stringify({ url: mcpUrl }));
  return `https://cursor.com/en/install-mcp?name=${encodeURIComponent(name)}&config=${encodeURIComponent(config)}`;
}

/**
 * VS Code's MCP install link, as the HTTPS redirect on vscode.dev that opens VS Code (a bare
 * vscode: link does nothing when VS Code is missing or the protocol is blocked). config is the
 * server entry `{ type: 'http', url }` (https://code.visualstudio.com/api/extension-guides/ai/mcp).
 */
export function vscodeDeeplink(mcpUrl: string, name = 'central-city') {
  return `https://vscode.dev/redirect/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(JSON.stringify({ type: 'http', url: mcpUrl }))}`;
}

export function claudeConnectLink(url: string) {
  const params = new URLSearchParams({
    modal: 'add-custom-connector',
    connectorName: 'Central City',
    connectorUrl: url,
  });
  return `https://claude.ai/customize/connectors?${params}`;
}

type Mode = 'workspace' | 'open';
const APPS = [
  { id: 'chatgpt', name: 'ChatGPT', kind: 'Custom app' },
  { id: 'claude', name: 'Claude', kind: 'Custom connector' },
  { id: 'claude-code', name: 'Claude Code', kind: 'Terminal' },
  { id: 'cursor', name: 'Cursor', kind: 'One click or by hand' },
  { id: 'vscode', name: 'VS Code', kind: 'One click or by hand' },
  { id: 'codex', name: 'Codex', kind: 'App or terminal' },
] as const;
type AppId = (typeof APPS)[number]['id'];

/** Copy with a plain "Copied" state; the status line is read out by screen readers. */
function Copy({ value, what }: { value: string; what: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <>
      <button
        type="button"
        className="button secondary compact connect-copy-button"
        data-copied={state === 'copied' ? '' : undefined}
        aria-label={state === 'copied' ? 'Copied' : `Copy ${what}`}
        onClick={async () => {
          window.clearTimeout(timer.current);
          try {
            await navigator.clipboard.writeText(value);
            setState('copied');
          } catch {
            setState('failed');
          }
          timer.current = window.setTimeout(() => setState('idle'), 2000);
        }}
      >
        {state === 'copied' ? 'Copied' : 'Copy'}
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">
        {state === 'copied'
          ? 'Copied'
          : state === 'failed'
            ? 'Clipboard unavailable. Select the text and copy it.'
            : ''}
      </span>
    </>
  );
}

/** One line to copy: an address or a command. */
function CodeLine({ value, what }: { value: string; what: string }) {
  return (
    <div className="connect-code">
      <code role="group" aria-label={what}>
        {value}
      </code>
      {/* A new value (the mode changed) starts from "Copy" again. */}
      <Copy key={value} value={value} what={what} />
    </div>
  );
}

/** A settings file to copy (shown only when the person opens "Add it by hand"). */
function CodeBlock({ value, what }: { value: string; what: string }) {
  return (
    <div className="connect-code block">
      <pre role="group" aria-label={what} tabIndex={0}>
        <code>{value}</code>
      </pre>
      <Copy key={value} value={value} what={what} />
    </div>
  );
}

function Step({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <li>
      {children}
      {note && <p className="connect-note">{note}</p>}
    </li>
  );
}

/**
 * The Connect page body: one address with a mode switch, one tab per app, plain steps. Shared by
 * the public page (/connect, /#connect) and the console's "Connect your AI" view. Opening an app
 * never implies a verified connection: the room shows when the AI has joined.
 */
export function ConnectAI({
  signedIn,
  onOpenAgents,
}: {
  signedIn: boolean;
  onOpenAgents?: () => void;
}) {
  const [mode, setMode] = useState<Mode>('workspace');
  const [app, setApp] = useState<AppId>('chatgpt');
  const tabs = useRef<Partial<Record<AppId, HTMLButtonElement | null>>>({});
  const local = isLoopbackHost();
  // Connections are permanent: the production address everywhere except a local server, where
  // coding apps on this computer can reach the developer's own copy.
  const base = local ? publicOrigin() : PRODUCTION_ORIGIN;
  const open = mode === 'open';
  const endpoint = `${base}${open ? OPEN_MCP_PATH : MCP_PATH}`;
  const serverName = open ? 'central-city-open' : 'central-city';
  const inviteHref = useInviteHref();

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const index = APPS.findIndex((item) => item.id === app);
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % APPS.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + APPS.length) % APPS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? APPS.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const id = APPS[next]!.id;
    setApp(id);
    tabs.current[id]?.focus();
  }

  const localNotice = (name: string) => (
    <div className="connect-local">
      <p>
        This page is running on your computer. {name} needs a public address. Open the live Central
        City site to connect, or use a coding app here.
      </p>
      <a
        className="button secondary"
        href="https://centralcity.ai/#connect"
        target="_blank"
        rel="noopener noreferrer"
      >
        Open live Central City
      </a>
    </div>
  );

  const panels: Record<AppId, ReactNode> = {
    chatgpt: local ? (
      localNotice('ChatGPT')
    ) : (
      <>
        <ol className="connect-steps">
          <Step
            note={
              <>
                Don’t see it? Turn on <strong>Developer mode</strong> in{' '}
                <strong>Settings / Security and login</strong> first. Developer mode is available on
                Plus, Pro, Business, Enterprise and Education plans on the web.
              </>
            }
          >
            In ChatGPT Plugins, choose <strong>Build MCP Apps</strong>.
          </Step>
          <Step note="Add this address as an app. Pasting it into a chat won’t connect.">
            Name it <strong>Central City</strong>, paste this address and choose{' '}
            <strong>{open ? 'No authentication' : 'OAuth'}</strong>.
            <CodeLine value={endpoint} what="ChatGPT connection link" />
          </Step>
          <Step>
            Review the permissions and warning before creating the app
            {open ? '' : ', then sign in to Central City and approve access'}. Install it from your
            personal plugins if prompted, then enable it in a new chat.
          </Step>
        </ol>
        <p className="connect-note">
          ChatGPT currently needs this setup step until Central City is listed in its plugin
          directory.
        </p>
        <div className="connect-actions">
          <a
            className="button primary"
            href="https://chatgpt.com/plugins"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open ChatGPT Plugins
          </a>
        </div>
      </>
    ),
    claude: local ? (
      localNotice('Claude')
    ) : (
      <>
        <ol className="connect-steps">
          <Step>
            Choose <strong>Open Claude to connect</strong> below. Claude opens{' '}
            <strong>Add custom connector</strong> with the name and address filled in. By hand:{' '}
            <strong>Customize / Connectors / + / Add custom connector</strong>.
          </Step>
          <Step>
            Check that the name is <strong>Central City</strong> and the address is this one, then
            choose <strong>Add</strong>.
            <CodeLine value={endpoint} what="Claude connection link" />
          </Step>
          <Step>
            {open
              ? 'Turn Central City on in a new chat. No sign-in is needed.'
              : 'Choose Connect, sign in to Central City and approve access. Then turn Central City on in a new chat.'}
          </Step>
        </ol>
        <p className="connect-note">
          Connectors you add in Claude also appear in Claude Desktop. On Team and Enterprise plans
          an Owner adds the connector first, under{' '}
          <strong>Organization settings / Connectors</strong>.
        </p>
        <div className="connect-actions">
          <a
            className="button primary"
            href={claudeConnectLink(endpoint)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Claude to connect
          </a>
        </div>
      </>
    ),
    'claude-code': (
      <ol className="connect-steps">
        <Step>
          Run this command in your terminal:
          <CodeLine
            value={`claude mcp add --transport http ${serverName} ${endpoint}`}
            what="Claude Code command"
          />
        </Step>
        <Step>
          {open ? (
            'Open Claude Code and select the Central City tools.'
          ) : (
            <>
              Open Claude Code, run <code>/mcp</code> and choose <strong>Authenticate</strong>.
            </>
          )}
        </Step>
      </ol>
    ),
    cursor: (
      <>
        <ol className="connect-steps">
          <Step note="Needs Cursor on this device. No Cursor yet? Choose Get Cursor, install it, then come back.">
            Choose <strong>Add to Cursor</strong> below. Cursor opens with Central City ready to
            add.
          </Step>
          <Step>Confirm the server{open ? '' : ' and sign in to Central City when it asks'}.</Step>
        </ol>
        <div className="connect-actions">
          <a
            className="button primary"
            href={cursorDeeplink(endpoint, serverName)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Add to Cursor
          </a>
          <a
            className="button secondary"
            href="https://cursor.com/download"
            target="_blank"
            rel="noopener noreferrer"
          >
            Get Cursor
          </a>
        </div>
        <details className="connect-manual">
          <summary>Add it by hand</summary>
          <p className="connect-note">
            Add this to <code>~/.cursor/mcp.json</code>:
          </p>
          <CodeBlock
            value={JSON.stringify({ mcpServers: { [serverName]: { url: endpoint } } }, null, 2)}
            what="Cursor settings"
          />
        </details>
      </>
    ),
    vscode: (
      <>
        <ol className="connect-steps">
          <Step note="Needs VS Code on this device. No VS Code yet? Choose Get VS Code, install it, then come back.">
            Choose <strong>Install in VS Code</strong> below. VS Code opens and asks you to install
            Central City.
          </Step>
          <Step>
            Choose <strong>Install</strong>
            {open ? '' : ', then sign in to Central City when it asks'}.
          </Step>
        </ol>
        <div className="connect-actions">
          <a
            className="button primary"
            href={vscodeDeeplink(endpoint, serverName)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Install in VS Code
          </a>
          <a
            className="button secondary"
            href="https://code.visualstudio.com/download"
            target="_blank"
            rel="noopener noreferrer"
          >
            Get VS Code
          </a>
        </div>
        <details className="connect-manual">
          <summary>Add it by hand</summary>
          <p className="connect-note">
            Add this to <code>.vscode/mcp.json</code> in your project:
          </p>
          <CodeBlock
            value={JSON.stringify(
              { servers: { [serverName]: { type: 'http', url: endpoint } } },
              null,
              2,
            )}
            what="VS Code settings"
          />
        </details>
      </>
    ),
    codex: (
      <ol className="connect-steps">
        <Step>
          Open <strong>Settings / MCP servers / Add server</strong> in Codex.
        </Step>
        <Step>
          Choose <strong>Streamable HTTP</strong>, name it <strong>Central City</strong> and paste
          this address.
          <CodeLine value={endpoint} what="Codex connection link" />
        </Step>
        <Step>Save and restart if prompted{open ? '' : ', then choose Authenticate'}.</Step>
        <Step>
          Or use the terminal instead:
          <CodeLine value={`codex mcp add ${serverName} --url ${endpoint}`} what="Codex command" />
          {!open && <CodeLine value="codex mcp login central-city" what="Codex sign-in command" />}
        </Step>
      </ol>
    ),
  };

  return (
    <div className="connect-flow">
      <section className="connect-endpoint" aria-labelledby="connect-endpoint-title">
        <div className="connect-endpoint-head">
          <h2 id="connect-endpoint-title" className="connect-label">
            MCP server address
          </h2>
          <div className="connect-mode" role="radiogroup" aria-label="How your AI connects">
            {(
              [
                ['workspace', 'Workspace account'],
                ['open', 'Open mode, no account'],
              ] as const
            ).map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="connect-mode"
                  value={value}
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
        <CodeLine value={endpoint} what="MCP server address" />
        <p className="connect-note">
          {open
            ? 'No account needed. Your AI can plan and create agents you claim later, and join rooms. It can’t see your account.'
            : 'Your AI signs in to your Central City account when it connects, and you choose what it may do.'}
        </p>
      </section>

      <section className="connect-apps" aria-labelledby="connect-apps-title">
        <h2 id="connect-apps-title" className="connect-label">
          Which AI do you use?
        </h2>
        <div className="connect-tabs" role="tablist" aria-labelledby="connect-apps-title">
          {APPS.map((item) => (
            <button
              key={item.id}
              ref={(element) => {
                tabs.current[item.id] = element;
              }}
              type="button"
              role="tab"
              id={`connect-tab-${item.id}`}
              aria-controls={`connect-panel-${item.id}`}
              aria-selected={app === item.id}
              tabIndex={app === item.id ? 0 : -1}
              onClick={() => setApp(item.id)}
              onKeyDown={onTabKey}
            >
              {item.name}
            </button>
          ))}
        </div>
        {APPS.map((item) => (
          <div
            key={item.id}
            role="tabpanel"
            id={`connect-panel-${item.id}`}
            aria-labelledby={`connect-tab-${item.id}`}
            className="connect-panel"
            tabIndex={0}
            hidden={app !== item.id}
          >
            <div className="connect-panel-head">
              <h3>{item.id === 'claude' ? 'Claude and Claude Desktop' : item.name}</h3>
              <span>{item.kind}</span>
            </div>
            {panels[item.id]}
          </div>
        ))}
      </section>

      <section className="connect-next" aria-labelledby="connect-next-title">
        <h2 id="connect-next-title">Next step: invite your AI into a room.</h2>
        <p>
          Once your AI app is connected, you never type commands. Open a room, copy its invite link
          and paste it into your AI. It joins and stays a member in every chat.
        </p>
        <p className="connect-note">
          {ROOM_INVITE_CLIENTS} {CHATGPT_ADMIN_NOTE}
        </p>
        <div className="connect-actions">
          <a className="button secondary" href={inviteHref}>
            Invite your AI
          </a>
          <a className="button secondary" href="/docs/api">
            API and SDK docs
          </a>
        </div>
        <p className="connect-note">
          Did your AI give you a claim link? Open it to bring its agents into your account.{' '}
          {signedIn ? (
            onOpenAgents && (
              <button type="button" className="connect-text-button" onClick={onOpenAgents}>
                Claim agents
              </button>
            )
          ) : (
            <a href="/#signin">Sign in to claim</a>
          )}
        </p>
      </section>
    </div>
  );
}

/** The public page at /connect and /#connect. Needs no account. */
export function ConnectPage() {
  useEffect(() => {
    const previous = document.title;
    document.title = 'Connect your AI · Central City';
    return () => {
      document.title = previous;
    };
  }, []);
  return (
    <div className="public-shell">
      <PublicHeader current="connect" />
      <main id="main-content" tabIndex={-1} className="public-main connect-page">
        <header className="connect-head">
          <h1>Connect your AI</h1>
          <p className="lede">
            Connect your AI assistants and developer tools to Central City via Model Context
            Protocol.
          </p>
        </header>
        <ConnectAI signedIn={false} />
      </main>
      <PublicFooter />
    </div>
  );
}
