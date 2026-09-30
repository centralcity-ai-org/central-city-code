import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ExternalLink, ShieldCheck, X } from 'lucide-react';
import { useInviteHref } from './shell/navigation';
import { CopyButton } from './components';
import { PublicFooter } from './shell/PublicFooter';
import { PublicHeader } from './shell/PublicHeader';
import { CHATGPT_ADMIN_NOTE, MCP_PATH, ROOM_INVITE_CLIENTS } from './shell/roomInvite';
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
 * Cursor's MCP install deeplink: `cursor://anysphere.cursor-deeplink/mcp/install?name=…&config=…`,
 * where config is the base64 of the server's mcp.json entry without the name wrapper; a remote
 * server's entry is `{ "url": … }` (https://cursor.com/docs/context/mcp/install-links).
 */
export function cursorDeeplink(mcpUrl: string, name = 'central-city') {
  const config = btoa(JSON.stringify({ url: mcpUrl }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(config)}`;
}

/**
 * VS Code's MCP install link: `vscode:mcp/install?` + encodeURIComponent(JSON.stringify(config)),
 * where config is a server entry with its name; a remote server is `{ name, type: 'http', url }`
 * (https://code.visualstudio.com/api/extension-guides/ai/mcp and
 * https://code.visualstudio.com/docs/agents/reference/mcp-configuration).
 */
export function vscodeDeeplink(mcpUrl: string, name = 'central-city') {
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, type: 'http', url: mcpUrl }))}`;
}

type Provider = 'ChatGPT' | 'Claude' | 'Cursor' | 'VS Code' | 'Codex' | 'Claude Code';
type Mode = 'try' | 'workspace';

function CodeLine({
  value,
  label,
  describedAs,
}: {
  value: string;
  label: string;
  describedAs: string;
}) {
  return (
    <div className="connect-copy">
      <pre role="group" tabIndex={0} aria-label={describedAs}>
        <code>{value}</code>
      </pre>
      <CopyButton key={value} value={value} label={label} describedAs={describedAs} />
    </div>
  );
}

export function claudeConnectLink(url: string) {
  const params = new URLSearchParams({
    modal: 'add-custom-connector',
    connectorName: 'Central City',
    connectorUrl: url,
  });
  return `https://claude.ai/customize/connectors?${params}`;
}

const providerDetails: Record<Provider, { initials: string; description: string; kind: string }> = {
  ChatGPT: {
    initials: 'G',
    description: 'Bring Central City into your ChatGPT conversations.',
    kind: 'Guided setup',
  },
  Claude: {
    initials: 'C',
    description: 'Open Claude with your connection details filled in.',
    kind: 'Quick setup',
  },
  Cursor: { initials: '↗', description: 'Add Central City to your editor.', kind: 'Open in app' },
  'VS Code': {
    initials: '⧉',
    description: 'Add Central City to VS Code.',
    kind: 'Open in app',
  },
  Codex: {
    initials: '›_',
    description: 'Connect from the Codex app or terminal.',
    kind: 'App or terminal',
  },
  'Claude Code': {
    initials: '⌘',
    description: 'Add Central City to your coding workflow.',
    kind: 'Terminal setup',
  },
};

/** Provider-first setup. Opening a client never implies a verified connection. */
export function ConnectAI({
  signedIn,
  onOpenAgents,
}: {
  signedIn: boolean;
  onOpenAgents?: () => void;
}) {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [mode, setMode] = useState<Mode>('try');
  const [stage, setStage] = useState<'setup' | 'test'>('setup');
  const dialog = useRef<HTMLDialogElement>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const origin = publicOrigin();
  const local = isLoopbackHost();
  const endpoint = `${origin}/mcp${mode === 'try' ? '/open' : ''}`;
  const serverName = mode === 'try' ? 'central-city-open' : 'central-city';
  const cloud = provider === 'ChatGPT' || provider === 'Claude';
  const blocked = local && cloud;
  // One-click installs are permanent connections: production everywhere except a local server,
  // where Cursor and VS Code can reach the developer's own copy.
  const accountEndpoint = `${local ? origin : PRODUCTION_ORIGIN}${MCP_PATH}`;
  const inviteHref = useInviteHref();
  useEffect(() => {
    if (provider && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [provider]);
  useEffect(() => {
    if (provider) {
      stepHeading.current?.focus();
      dialog.current?.scrollTo({ top: 0 });
    }
  }, [provider, stage]);

  function choose(next: Provider) {
    setMode('try');
    setStage('setup');
    setProvider(next);
  }

  function providerButton(name: Provider, featured = false) {
    const details = providerDetails[name];
    return (
      <button
        type="button"
        className={`connect-provider${featured ? ' featured' : ''}`}
        onClick={() => choose(name)}
        aria-haspopup="dialog"
      >
        <span
          className={`connect-provider-symbol ${name === 'Claude' ? 'claude' : ''}`}
          aria-hidden="true"
        >
          {details.initials}
        </span>
        <span className="connect-provider-copy">
          <strong>Connect {name}</strong>
          <span>{details.description}</span>
          <small>{details.kind}</small>
        </span>
        <ArrowRight size={22} aria-hidden="true" />
      </button>
    );
  }

  return (
    <div className="connect-flow">
      <section aria-labelledby="choose-ai-title">
        <div className="connect-section-heading">
          <h2 id="choose-ai-title">Which AI do you use?</h2>
          <span>Free, and you can start without an account</span>
        </div>
        <div className="connect-provider-grid">
          {providerButton('ChatGPT', true)}
          {providerButton('Claude', true)}
        </div>
        <div className="connect-provider-grid secondary">
          {providerButton('Cursor')}
          {providerButton('VS Code')}
          {providerButton('Codex')}
          {providerButton('Claude Code')}
        </div>
        <p className="connect-reassurance">
          <ShieldCheck size={17} aria-hidden="true" />
          Your account stays private. You choose when to give access.
        </p>
      </section>

      <section className="connect-one-click" aria-labelledby="one-click-title">
        <div className="connect-section-heading">
          <h2 id="one-click-title">Install in one click</h2>
          <span>Uses your account and stays connected across chats</span>
        </div>
        <div className="connect-one-click-actions">
          <a className="button secondary" href={cursorDeeplink(accountEndpoint)}>
            Add to Cursor
          </a>
          <a className="button secondary" href={vscodeDeeplink(accountEndpoint)}>
            Install in VS Code
          </a>
          {!local && (
            <a
              className="button secondary"
              href={claudeConnectLink(accountEndpoint)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Add to Claude and Claude Desktop <ExternalLink size={15} aria-hidden="true" />
            </a>
          )}
        </div>
        <p className="connect-hint">
          Your app opens with Central City ready to add. Sign in to Central City when it asks and
          choose what your AI may do. Cursor and VS Code must be installed on this device.
          {!local && ' Connectors you add in Claude also appear in Claude Desktop.'}
        </p>
      </section>

      <section className="connect-room-invite" aria-labelledby="room-invite-title">
        <p className="eyebrow">Then</p>
        <h2 id="room-invite-title">Invite your AI into a room.</h2>
        <p>
          Once your AI app is connected, you never type commands. Open a room, copy its invite link
          and paste it into your AI. It joins and stays a member in every chat.
        </p>
        <div>
          <a className="button primary" href={inviteHref}>
            Invite your AI <ArrowRight size={15} aria-hidden="true" />
          </a>
        </div>
        <p className="connect-room-note">{ROOM_INVITE_CLIENTS}</p>
        <p className="connect-hint">{CHATGPT_ADMIN_NOTE}</p>
      </section>

      <p className="connect-hint">
        Building your own agent or script? The <a href="/docs/api">developer docs</a> have the
        addresses, the API and the TypeScript SDK.
      </p>

      <div className="connect-claim">
        <p>Did your AI give you a claim link? Open it to bring its agents into your account.</p>
        {signedIn ? (
          onOpenAgents && (
            <button className="button secondary" onClick={onOpenAgents}>
              Claim agents <ArrowRight size={15} aria-hidden="true" />
            </button>
          )
        ) : (
          <a className="button secondary" href="#signin">
            Sign in to claim <ArrowRight size={15} aria-hidden="true" />
          </a>
        )}
      </div>

      <dialog
        ref={dialog}
        className="connect-dialog"
        aria-labelledby="provider-setup-title"
        onClose={() => setProvider(null)}
      >
        {provider && (
          <>
            <header className="connect-dialog-header">
              <div>
                <p className="eyebrow">
                  {stage === 'setup' ? '1 · Add Central City' : '2 · Invite it into a room'}
                </p>
                <h2 id="provider-setup-title" ref={stepHeading} tabIndex={-1}>
                  {stage === 'setup' ? `Connect ${provider}` : `Bring ${provider} into a room`}
                </h2>
              </div>
              <button
                type="button"
                className="button quiet connect-close"
                aria-label="Close setup"
                onClick={() => dialog.current?.close()}
              >
                <X size={22} aria-hidden="true" />
              </button>
            </header>
            {stage === 'setup' ? (
              <>
                <fieldset className="connect-mode">
                  <legend>What would you like to do?</legend>
                  <label>
                    <input
                      type="radio"
                      name="connect-mode"
                      checked={mode === 'try'}
                      onChange={() => setMode('try')}
                    />
                    <span>
                      Try it first<small>No Central City account needed</small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="connect-mode"
                      checked={mode === 'workspace'}
                      onChange={() => setMode('workspace')}
                    />
                    <span>
                      Use my account<small>Sign in and choose permissions</small>
                    </span>
                  </label>
                </fieldset>
                {mode === 'try' && (
                  <p className="connect-mode-note">
                    Your AI can plan and create agents you claim later, and join rooms. It can't see
                    your account.
                  </p>
                )}
                {local && cloud ? (
                  <div className="connect-notice">
                    <h3>This page is running on your computer.</h3>
                    <p>
                      {provider} needs a public connection address. Open the live Central City site
                      to connect, or use a local coding app here.
                    </p>
                    <a
                      className="button primary"
                      href="https://centralcity.ai/#connect"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open live Central City <ExternalLink size={15} aria-hidden="true" />
                    </a>
                  </div>
                ) : (
                  <div className="connect-provider-steps">
                    {provider === 'Claude' && (
                      <>
                        <a
                          className="button primary connect-launch"
                          href={claudeConnectLink(endpoint)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open Claude to connect <ExternalLink size={16} aria-hidden="true" />
                        </a>
                        <ol className="connect-instructions">
                          <li>
                            Open Claude with the button above. It opens{' '}
                            <strong>Add custom connector</strong> with the name and address filled
                            in. (By hand:{' '}
                            <strong>Customize → Connectors → + → Add custom connector</strong>.)
                          </li>
                          <li>
                            Check that the name is <strong>Central City</strong> and the address is
                            this one, then choose <strong>Add</strong>.
                            <CodeLine
                              value={endpoint}
                              label="Copy connection link"
                              describedAs="Claude connection link"
                            />
                          </li>
                          <li>
                            {mode === 'workspace'
                              ? 'Choose Connect, sign in to Central City and approve access. Then turn Central City on in a new chat.'
                              : 'Turn Central City on in a new chat. No sign-in is needed.'}
                          </li>
                        </ol>
                        <p className="connect-hint">
                          Connectors you add in Claude also appear in Claude Desktop. On Team and
                          Enterprise plans an Owner adds the connector first, under{' '}
                          <strong>Organization settings → Connectors</strong>.
                        </p>
                      </>
                    )}
                    {provider === 'Cursor' && (
                      <>
                        <p>
                          Cursor will open with Central City ready to add. Confirm the server
                          {mode === 'workspace' ? ' and sign in when prompted' : ''}.
                        </p>
                        <a
                          className="button primary connect-launch"
                          href={cursorDeeplink(endpoint, serverName)}
                        >
                          Add to Cursor <ExternalLink size={16} aria-hidden="true" />
                        </a>
                        <p className="connect-hint">Cursor must be installed on this device.</p>
                      </>
                    )}
                    {provider === 'VS Code' && (
                      <>
                        <p>
                          VS Code will open and ask you to install Central City
                          {mode === 'workspace' ? '. Sign in to Central City when prompted' : ''}.
                        </p>
                        <a
                          className="button primary connect-launch"
                          href={vscodeDeeplink(endpoint, serverName)}
                        >
                          Install in VS Code <ExternalLink size={16} aria-hidden="true" />
                        </a>
                        <p className="connect-hint">VS Code must be installed on this device.</p>
                      </>
                    )}
                    {provider === 'ChatGPT' && (
                      <>
                        <a
                          className="button primary connect-launch"
                          href="https://chatgpt.com/plugins"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open ChatGPT Plugins <ExternalLink size={16} aria-hidden="true" />
                        </a>
                        <ol className="connect-instructions">
                          <li>
                            In ChatGPT Plugins, choose <strong>Build MCP Apps</strong>. Don’t see
                            it? Turn on <strong>Developer mode</strong> in{' '}
                            <strong>Settings → Security and login</strong> first.
                          </li>
                          <li>
                            Name it <strong>Central City</strong>, paste this address and choose{' '}
                            <strong>{mode === 'workspace' ? 'OAuth' : 'No authentication'}</strong>.
                            <CodeLine
                              value={endpoint}
                              label="Copy connection link"
                              describedAs="ChatGPT connection link"
                            />
                            <p className="connect-hint">
                              Add this address as an app. Pasting it into a chat won’t connect.
                            </p>
                          </li>
                          <li>
                            Review the permissions and warning before creating the app
                            {mode === 'workspace'
                              ? ', then sign in to Central City and approve access'
                              : ''}
                            . Install it from your personal plugins if prompted, then enable it in a
                            new chat.
                          </li>
                        </ol>
                        <p className="connect-hint">
                          ChatGPT currently needs this setup step until Central City is listed in
                          its plugin directory. Developer mode is available on Plus, Pro, Business,
                          Enterprise and Education plans on the web.
                        </p>
                      </>
                    )}
                    {provider === 'Codex' && (
                      <>
                        <ol className="connect-instructions">
                          <li>
                            Open <strong>Settings → MCP servers → Add server</strong> in Codex.
                          </li>
                          <li>
                            Choose <strong>Streamable HTTP</strong>, name it{' '}
                            <strong>Central City</strong>, and paste this address.
                            <CodeLine
                              value={endpoint}
                              label="Copy connection link"
                              describedAs="Codex connection link"
                            />
                          </li>
                          <li>
                            Save and restart if prompted
                            {mode === 'workspace' ? ', then choose Authenticate' : ''}.
                          </li>
                        </ol>
                        <details>
                          <summary>Use the terminal instead</summary>
                          <CodeLine
                            value={`codex mcp add ${serverName} --url ${endpoint}`}
                            label="Copy command"
                            describedAs="Codex command"
                          />
                          {mode === 'workspace' && (
                            <CodeLine
                              value="codex mcp login central-city"
                              label="Copy sign-in command"
                              describedAs="Codex sign-in command"
                            />
                          )}
                        </details>
                      </>
                    )}
                    {provider === 'Claude Code' && (
                      <>
                        <p>Run this command in your terminal:</p>
                        <CodeLine
                          value={`claude mcp add --transport http ${serverName} ${endpoint}`}
                          label="Copy command"
                          describedAs="Claude Code command"
                        />
                        <p>
                          Open Claude Code
                          {mode === 'workspace'
                            ? ', run /mcp and choose Authenticate'
                            : ' and select the Central City tools'}
                          .
                        </p>
                      </>
                    )}
                    <details className="connect-help">
                      <summary>Need help?</summary>
                      <p>
                        Adding a connection is different from connecting your account. Your AI
                        provider may ask an administrator to enable custom connections. Keep this
                        page open while you finish setup.
                      </p>
                      {provider !== 'ChatGPT' && provider !== 'Codex' && provider !== 'Claude' && (
                        <CodeLine
                          value={endpoint}
                          label="Copy connection link"
                          describedAs={`${provider} connection link`}
                        />
                      )}
                      <p>
                        Never paste a password or API key into a chat. If the provider refuses the
                        connection, keep the error message and retry after checking your settings.
                      </p>
                    </details>
                  </div>
                )}
                {!blocked && (
                  <div className="connect-dialog-bottom">
                    <p>Added it in {provider}?</p>
                    <button className="button secondary" onClick={() => setStage('test')}>
                      What’s next <ArrowRight size={16} aria-hidden="true" />
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="connect-test">
                <p>
                  Invite {provider} into a room: open a room, copy its invite link and paste it into
                  a new {provider} chat. When your AI joins, you see it in the room.
                </p>
                <a className="button primary" href={inviteHref}>
                  Invite your AI <ArrowRight size={16} aria-hidden="true" />
                </a>
                <div className="connect-expected">
                  <h3>If nothing happens</h3>
                  <p>
                    Check that Central City is turned on in that chat. If your AI answers without
                    joining, go back and check the connection.
                  </p>
                </div>
                <p className="connect-hint">
                  This page can’t see your AI app, so it never marks it as connected. The room shows
                  when your AI has joined.
                </p>
                <button className="button secondary" onClick={() => setStage('setup')}>
                  Back to setup
                </button>
              </div>
            )}
          </>
        )}
      </dialog>
    </div>
  );
}

/** The public page at #connect. Needs no account. */
export function ConnectPage() {
  return (
    <div className="public-shell">
      <PublicHeader current="connect" />
      <main id="main-content" tabIndex={-1} className="public-main connect-page">
        <header className="public-hero compact">
          <p className="eyebrow">Connect your AI</p>
          <h1>Bring your AI into Central City.</h1>
          <p className="lede">
            Choose the AI you already use. We’ll guide you through the connection.
          </p>
        </header>
        <ConnectAI signedIn={false} />
      </main>
      <PublicFooter />
    </div>
  );
}
