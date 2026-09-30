import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { KeyRound, LoaderCircle, RefreshCw } from 'lucide-react';
import { api } from './api';
import { permissionLabel } from './AssistantAccess';
import { CopyButton, formatDate } from './components';
import { ASSISTANT_SCOPES, type AssistantScope, type WorkspaceKey } from '../shared/assistant';

/**
 * Keys of an AI-owned workspace (docs/AI_WORKSPACES.md), for its co-owners. The AI created the
 * first key; co-owners can mint more (shown once) and revoke any of them.
 */
export function WorkspaceKeys({ workspaceName }: { workspaceName: string }) {
  const [keys, setKeys] = useState<WorkspaceKey[] | null>(null);
  const [label, setLabel] = useState('Another AI');
  const [scopes, setScopes] = useState<AssistantScope[]>(['workspace:read']);
  const [issued, setIssued] = useState<{ key: WorkspaceKey; workspace_key: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const value = await api<{ keys: WorkspaceKey[] }>('/api/workspace-keys');
      if (alive.current) setKeys(value.keys);
    } catch (err) {
      if (alive.current)
        setError(err instanceof Error ? err.message : 'The access keys could not be loaded.');
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  async function run(key: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      if (alive.current)
        setError(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      if (alive.current) setBusy('');
    }
  }
  function mint(event: FormEvent) {
    event.preventDefault();
    void run('mint', async () => {
      const result = await api<{ key: WorkspaceKey; workspace_key: string }>(
        '/api/workspace-keys',
        { label, scopes },
      );
      if (alive.current) setIssued(result);
    });
  }

  return (
    <section className="panel assistant-card" aria-labelledby="workspace-keys-title">
      <div className="assistant-list-heading">
        <div className="panel-title">
          <KeyRound size={18} />
          <h2 id="workspace-keys-title">AI access keys</h2>
        </div>
        <button
          className="button secondary"
          disabled={Boolean(busy)}
          onClick={() => void run('refresh', load)}
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      <p>
        <strong>{workspaceName}</strong> belongs to an AI. Each AI that works here has its own
        access key. You co-own this workspace, so you can remove any key; that AI loses access at
        once.
      </p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {issued ? (
        <div className="assistant-issued" role="status">
          <strong>Access key for {issued.key.label} created. It is shown only once.</strong>
          <code className="key-secret">{issued.workspace_key}</code>
          <CopyButton value={issued.workspace_key} label="Copy key" describedAs="Access key" />
          <button className="button secondary" onClick={() => setIssued(null)}>
            I saved it
          </button>
        </div>
      ) : null}
      {!keys ? (
        <p role="status">
          <LoaderCircle size={14} className="spin" /> Loading…
        </p>
      ) : (
        <ul className="assistant-grants" aria-label="AI access keys">
          {keys.map((key) => (
            <li key={key.id}>
              <div>
                <strong>{key.label}</strong>
                <span className="small-tag">{key.revokedAt ? 'Removed' : 'Active'}</span>
                <p>{key.scopes.map(permissionLabel).join(' · ')}</p>
                <small>
                  Created {formatDate(key.createdAt)} ·{' '}
                  {key.lastUsedAt ? `Last used ${formatDate(key.lastUsedAt)}` : 'Never used'}
                </small>
              </div>
              <button
                className="button secondary"
                disabled={Boolean(busy) || Boolean(key.revokedAt)}
                aria-label={`Remove access key ${key.label}`}
                onClick={() =>
                  void run(key.id, async () => {
                    await api(`/api/workspace-keys/${key.id}`, {}, 'DELETE');
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="form-stack" onSubmit={mint}>
        <label>
          New key for
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={64}
            required
          />
        </label>
        <fieldset className="assistant-permissions" disabled={Boolean(busy)}>
          <legend>What this AI may do</legend>
          {ASSISTANT_SCOPES.map((scope) => (
            <label key={scope}>
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                disabled={scope === 'workspace:read'}
                onChange={(event) =>
                  setScopes((current) =>
                    event.target.checked
                      ? [...current, scope]
                      : current.filter((item) => item !== scope),
                  )
                }
              />
              <span>
                <strong>{permissionLabel(scope)}</strong>
              </span>
            </label>
          ))}
        </fieldset>
        <button className="button primary" disabled={Boolean(busy) || Boolean(issued)}>
          <KeyRound size={16} />
          Create key
        </button>
      </form>
    </section>
  );
}
