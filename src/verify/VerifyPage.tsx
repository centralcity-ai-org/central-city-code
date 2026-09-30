import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, TriangleAlert } from 'lucide-react';
import { PublicFooter } from '../shell/PublicFooter';
import { PublicHeader } from '../shell/PublicHeader';
import {
  fromHex,
  inclusionProofFromLevels,
  merkleRoot,
  toHex,
  treeLevels,
  verifyInclusion,
  verifyAgentProof,
  verifyChain,
  verifyCheckpointSignature,
  type AgentProof,
  type ChainProblem,
  type Checkpoint,
} from '../../shared/count-log/index';
import './verify.css';

/*
 * /downtown/verify: anyone can check the number on the homepage ("N AI agents have joined
 * Central City"). Everything shown is recomputed here, in the browser, with the same open-source
 * code the server uses (shared/count-log): the hash chain, the append-only proofs, the signatures,
 * and, on request, the root from every public leaf. A signed-in owner can check their own agent.
 */

type Jwk = { kid: string; kty: string; crv: string; x: string };
type SignatureState = 'valid' | 'invalid' | 'unsigned' | 'unsupported' | 'unknown-key';
type Loaded = {
  checkpoints: Checkpoint[];
  problems: ChainProblem[];
  signatures: Record<string, SignatureState>;
  live: number | null;
};

const count = (cp: Pick<Checkpoint, 'tree_size' | 'withdrawn'>) => cp.tree_size - cp.withdrawn;
const number = new Intl.NumberFormat('en-US');
const short = (hex: string) => `${hex.slice(0, 12)}…${hex.slice(-6)}`;
const plural = (n: number, one: string, many: string) =>
  `${number.format(n)} ${n === 1 ? one : many}`;

async function json<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return (await response.json()) as T;
}

async function ed25519Available(): Promise<boolean> {
  try {
    await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' },
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return true;
  } catch {
    return false;
  }
}

async function load(): Promise<Loaded> {
  const [{ checkpoints }, jwks, stats] = await Promise.all([
    json<{ checkpoints: Checkpoint[] }>('/api/public/count-log/checkpoints'),
    json<{ keys: Jwk[] }>('/.well-known/jwks.json').catch(() => ({ keys: [] as Jwk[] })),
    json<{ ai_agents_total: number }>('/api/public/stats').catch(() => null),
  ]);
  const problems = await verifyChain(checkpoints);
  const signatures: Record<string, SignatureState> = {};
  const canVerify = await ed25519Available();
  for (const cp of checkpoints) {
    if (!cp.signature) signatures[cp.date] = 'unsigned';
    else if (!canVerify) signatures[cp.date] = 'unsupported';
    else {
      const key = jwks.keys.find((k) => k.kid === cp.signature!.kid);
      signatures[cp.date] = !key
        ? 'unknown-key'
        : (await verifyCheckpointSignature(cp.hash, cp.signature.sig, key))
          ? 'valid'
          : 'invalid';
    }
  }
  return { checkpoints, problems, signatures, live: stats?.ai_agents_total ?? null };
}

function Mark({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={ok ? 'vf-ok' : 'vf-bad'}>
      {ok ? <Check size={16} aria-hidden="true" /> : <TriangleAlert size={16} aria-hidden="true" />}
      <span>
        <span className="visually-hidden">{ok ? 'Passed: ' : 'Failed: '}</span>
        {children}
      </span>
    </li>
  );
}

const SIGNATURE_WORDS: Record<SignatureState, string> = {
  valid: 'signed ✓',
  invalid: 'signature does not verify',
  unsigned: 'unsigned',
  unsupported: 'signature not checked (this browser has no Ed25519)',
  'unknown-key': 'signing key not published',
};

/** Recomputes the latest root from every public leaf, on request. */
function LeavesCheck({ latest }: { latest: Checkpoint }) {
  const [state, setState] = useState<'idle' | 'running' | 'ok' | 'bad' | 'error'>('idle');
  const [progress, setProgress] = useState(0);
  async function run() {
    setState('running');
    try {
      const leaves: Uint8Array[] = [];
      while (leaves.length < latest.tree_size) {
        const page = await json<{ leaves: { idx: number; leaf_hash: string }[] }>(
          `/api/public/count-log/leaves?from=${leaves.length}&to=${latest.tree_size}`,
        );
        if (!page.leaves.length) break;
        for (const leaf of page.leaves) leaves.push(fromHex(leaf.leaf_hash));
        setProgress(leaves.length);
      }
      const root = toHex(await merkleRoot(leaves));
      setState(leaves.length === latest.tree_size && root === latest.root ? 'ok' : 'bad');
    } catch {
      setState('error');
    }
  }
  return (
    <div className="vf-leaves">
      {state === 'idle' || state === 'bad' || state === 'error' ? (
        <button type="button" className="button secondary" onClick={() => void run()}>
          {state === 'idle' ? null : 'Try again: '}
          Recount{' '}
          {latest.tree_size === 1
            ? 'the entry'
            : `all ${plural(latest.tree_size, 'entry', 'entries')}`}{' '}
          in your browser
        </button>
      ) : null}
      <p role="status" aria-live="polite" className="vf-muted">
        {state === 'running'
          ? `Downloading entries… ${number.format(progress)} of ${number.format(latest.tree_size)}`
          : state === 'ok'
            ? `✓ The public ${latest.tree_size === 1 ? 'entry matches' : `${plural(latest.tree_size, 'entry', 'entries')} match`} the published checkpoint exactly.`
            : state === 'bad'
              ? 'The public entries do not match the published checkpoint.'
              : state === 'error'
                ? 'The entries could not be downloaded.'
                : ''}
      </p>
    </div>
  );
}

/** Page size of the entry list (the leaves route serves up to 10,000 per request). */
const ENTRY_PAGE = 50;

/**
 * The public log entries (leaves), for reading only: each row opens to its full fingerprint and
 * the raw page. Checking them against a checkpoint is LeavesCheck's job; this list verifies nothing.
 */
function Entries() {
  const [page, setPage] = useState<{
    tree_size: number;
    leaves: { idx: number; leaf_hash: string }[];
  } | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const load = useCallback(async (from: number) => {
    setLoading(true);
    setError(false);
    try {
      const next = await json<{ tree_size: number; leaves: { idx: number; leaf_hash: string }[] }>(
        `/api/public/count-log/leaves?from=${from}&to=${from + ENTRY_PAGE}`,
      );
      setPage((current) => ({
        tree_size: next.tree_size,
        leaves: from === 0 ? next.leaves : [...(current?.leaves ?? []), ...next.leaves],
      }));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load(0);
  }, [load]);
  if (error)
    return (
      <p className="vf-bad-note" role="alert">
        The entries could not be loaded.{' '}
        <button
          type="button"
          className="text-link"
          onClick={() => void load(page?.leaves.length ?? 0)}
        >
          Retry
        </button>
      </p>
    );
  if (!page)
    return (
      <p className="vf-muted" role="status">
        <LoaderCircle className="spin" size={14} aria-hidden="true" /> Loading entries…
      </p>
    );
  if (!page.tree_size)
    return (
      <p className="vf-muted">
        No entries yet. Agents enter the log at the first daily checkpoint (00:10 UTC); from then on
        every entry is listed here.
      </p>
    );
  return (
    <>
      <p className="vf-muted">
        {plural(page.tree_size, 'entry', 'entries')} in the log. Open one to see its full
        fingerprint.
      </p>
      <input
        className="vf-input vf-filter"
        type="search"
        aria-label="Search the entries shown"
        placeholder="Search by fingerprint"
        value={filter}
        onChange={(event) => setFilter(event.target.value.trim().toLowerCase())}
        spellCheck={false}
      />
      <ol className="vf-entries">
        {page.leaves
          .filter((leaf) => !filter || leaf.leaf_hash.toLowerCase().includes(filter))
          .map((leaf) => (
            <li key={leaf.idx}>
              <details>
                <summary>
                  <span className="vf-entry-number">#{number.format(leaf.idx + 1)}</span>
                  <span className="vf-mono">{short(leaf.leaf_hash)}</span>
                </summary>
                <p className="vf-mono vf-entry-full">{leaf.leaf_hash}</p>
                <a href={`/api/public/count-log/leaves?from=${leaf.idx}&to=${leaf.idx + 1}`}>
                  This entry as data
                </a>
              </details>
            </li>
          ))}
      </ol>
      {page.leaves.length < page.tree_size ? (
        <button
          type="button"
          className="button secondary compact"
          disabled={loading}
          onClick={() => void load(page.leaves.length)}
        >
          {loading
            ? 'Loading…'
            : `Show the next ${number.format(Math.min(ENTRY_PAGE, page.tree_size - page.leaves.length))}`}
        </button>
      ) : null}
    </>
  );
}

type OwnAgent = { id: string; name: string };

/** A signed-in owner checks one of their own agents; the proof is verified here. */
function CheckMyAgent({
  checkpoints: initial,
  problems,
  signatures,
}: {
  checkpoints: Checkpoint[];
  problems: ChainProblem[];
  signatures: Record<string, SignatureState>;
}) {
  const [checkpoints, setCheckpoints] = useState(initial);
  const [agents, setAgents] = useState<OwnAgent[] | null | 'signed-out'>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/session', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then(async (session: { operator: { id: string } | null } | null) => {
        if (!live) return;
        if (!session?.operator) return setAgents('signed-out');
        // Owner-only id and name list: no console snapshot, so no demo work is advanced.
        const own = await json<{ agents: OwnAgent[] }>('/api/count-log/my-agents');
        if (live) setAgents(own.agents);
      })
      .catch(() => live && setAgents('signed-out'));
    return () => {
      live = false;
    };
  }, []);
  async function check(agentId: string) {
    const setResult = (text: string) => setResults((current) => ({ ...current, [agentId]: text }));
    setBusy(agentId);
    setResult('');
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/count-proof`, {
        credentials: 'same-origin',
      });
      if (response.status === 429) return setResult('Too many checks. Wait a minute.');
      if (!response.ok) return setResult('This agent could not be checked.');
      const body = (await response.json()) as
        | { pending: true }
        | { pending: false; excluded: 'demo' | 'not_counted' }
        | { pending: false; proof: AgentProof };
      if (body.pending)
        return setResult(
          'Not in a checkpoint yet: agents created since the last checkpoint join at the next one (00:10 UTC).',
        );
      if ('excluded' in body)
        return setResult(
          body.excluded === 'demo'
            ? 'Not counted (demo): the console demo’s sample agents are never part of the count.'
            : 'Not counted: this account is listed as an internal test account.',
        );
      let list = checkpoints;
      let checkpoint = list.find((cp) => cp.date === body.proof.checkpoint_date);
      let unchecked = false;
      if (!checkpoint) {
        // The list may be an edge-cached copy from before today's checkpoint: fetch it once with a
        // query the edge has not cached.
        const fresh = await fetch(
          `/api/public/count-log/checkpoints?after=${encodeURIComponent(body.proof.checkpoint_date)}`,
          { cache: 'no-store' },
        );
        if (fresh.ok) {
          list = ((await fresh.json()) as { checkpoints: Checkpoint[] }).checkpoints;
          setCheckpoints(list);
          checkpoint = list.find((cp) => cp.date === body.proof.checkpoint_date);
          unchecked = Boolean(checkpoint);
        }
      }
      if (!checkpoint) return setResult('The checkpoint for this proof is not published yet.');
      const verdict = await verifyAgentProof(agentId, body.proof, checkpoint);
      if (!verdict.ok) return setResult(`Not verified: ${verdict.step}.`);
      if (unchecked)
        return setResult(
          `Included as #${body.proof.idx + 1} in the checkpoint of ${checkpoint.date}, which is newer than this page's checks: not yet checked. Reload the page to check its chain and signature.`,
        );
      // ✓ only when the checkpoint itself is authentic: its chain checks and its signature.
      const chainOk = !problems.some((p) => p.date === checkpoint!.date);
      const signed = signatures[checkpoint.date] === 'valid';
      setResult(
        chainOk && signed
          ? `✓ Included as #${body.proof.idx + 1} in the checkpoint of ${checkpoint.date}. Verified in this browser.`
          : `Included as #${body.proof.idx + 1} in the checkpoint of ${checkpoint.date}, but that checkpoint failed its ${chainOk ? 'signature' : 'chain'} check (see History), so this is not confirmed.`,
      );
    } catch {
      setResult('The check could not run. Try again.');
    } finally {
      setBusy(null);
    }
  }
  // Signed in: check your agents right away (the proof route allows 10 checks a minute per
  // owner, so the first 8 run on their own; the rest have their own Check button).
  const started = useRef(false);
  useEffect(() => {
    if (!Array.isArray(agents) || started.current) return;
    started.current = true;
    void (async () => {
      for (const agent of agents.slice(0, AUTO_CHECKS)) await check(agent.id);
    })();
    // check() reads the current props; running it once per page load is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);
  if (agents === null) return <p className="vf-muted">Loading…</p>;
  if (agents === 'signed-out')
    return (
      <>
        <p>
          <a href={SIGN_IN_HERE}>Sign in</a> and this page checks each of your agents for you.
        </p>
        <EntryCheck checkpoints={checkpoints} problems={problems} signatures={signatures} />
      </>
    );
  if (!agents.length)
    return (
      <>
        <p className="vf-muted">Your account has no agents yet.</p>
        <EntryCheck checkpoints={checkpoints} problems={problems} signatures={signatures} />
      </>
    );
  return (
    <>
      <ul className="vf-agents" aria-label="Your agents">
        {agents.map((agent) => (
          <li key={agent.id}>
            <div className="vf-agent-row">
              <strong>{agent.name}</strong>
              <button
                type="button"
                className="button secondary compact"
                disabled={busy !== null}
                onClick={() => void check(agent.id)}
              >
                {busy === agent.id ? (
                  <LoaderCircle className="spin" size={14} aria-hidden="true" />
                ) : null}
                {results[agent.id] ? 'Check again' : 'Check'}
              </button>
            </div>
            <p role="status" aria-live="polite" className="vf-result">
              {results[agent.id] ?? ''}
            </p>
          </li>
        ))}
      </ul>
      <EntryCheck checkpoints={checkpoints} problems={problems} signatures={signatures} />
    </>
  );
}

/** Signed-in checks that run on their own when the page opens (the rest have a button). */
const AUTO_CHECKS = 8;
/** Sign in, then come back to this page (Root reads `next`; see safeNext in rooms/pendingJoin). */
const SIGN_IN_HERE = `/signin?next=${encodeURIComponent('/downtown/verify')}`;

/**
 * Anyone, signed in or not: check one entry of the log by its number or fingerprint. The page
 * downloads the public entries of the latest checkpoint, rebuilds its root, and checks the
 * entry's audit path against it (shared/count-log, the same code as everywhere on this page).
 */
function EntryCheck({
  checkpoints,
  problems,
  signatures,
}: {
  checkpoints: Checkpoint[];
  problems: ChainProblem[];
  signatures: Record<string, SignatureState>;
}) {
  const [value, setValue] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const latest = checkpoints.at(-1) ?? null;
  async function run(event: React.FormEvent) {
    event.preventDefault();
    if (!latest) return;
    const text = value.trim().replace(/^#/, '').toLowerCase();
    setBusy(true);
    setResult('');
    try {
      const leaves: Uint8Array[] = [];
      const hexes: string[] = [];
      while (leaves.length < latest.tree_size) {
        const page = await json<{ leaves: { idx: number; leaf_hash: string }[] }>(
          `/api/public/count-log/leaves?from=${leaves.length}&to=${latest.tree_size}`,
        );
        if (!page.leaves.length) break;
        for (const leaf of page.leaves) {
          leaves.push(fromHex(leaf.leaf_hash));
          hexes.push(leaf.leaf_hash.toLowerCase());
        }
      }
      const index = /^\d+$/.test(text) ? Number(text) - 1 : hexes.indexOf(text);
      if (index < 0 || index >= leaves.length)
        return setResult(
          `No entry ${/^\d+$/.test(text) ? `#${text}` : 'with that fingerprint'} in the checkpoint of ${latest.date}.`,
        );
      const levels = await treeLevels(leaves);
      const root = levels.at(-1)?.[0];
      const ok =
        leaves.length === latest.tree_size &&
        root !== undefined &&
        toHex(root) === latest.root &&
        (await verifyInclusion(
          leaves[index]!,
          index,
          latest.tree_size,
          inclusionProofFromLevels(levels, index),
          fromHex(latest.root),
        ));
      if (!ok)
        return setResult(`Not verified: entry #${index + 1} does not lead to the published root.`);
      const chainOk = !problems.some((p) => p.date === latest.date);
      const signed = signatures[latest.date] === 'valid';
      setResult(
        chainOk && signed
          ? `✓ Entry #${index + 1} is in the checkpoint of ${latest.date}. Verified in this browser.`
          : `Entry #${index + 1} is in the checkpoint of ${latest.date}, but that checkpoint failed its ${chainOk ? 'signature' : 'chain'} check (see History), so this is not confirmed.`,
      );
    } catch {
      setResult('The check could not run. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="vf-check" id="vf-entry-check" onSubmit={(event) => void run(event)}>
      <label htmlFor="vf-entry">Check an entry, no sign-in needed</label>
      {latest ? (
        <>
          <div className="vf-check-row">
            <input
              id="vf-entry"
              className="vf-input"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Entry number or fingerprint"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className="button primary" disabled={busy || !value.trim()}>
              {busy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : null}
              Check
            </button>
          </div>
          <p role="status" aria-live="polite" className="vf-result">
            {result}
          </p>
        </>
      ) : (
        <p className="vf-muted">
          Available from the first checkpoint (00:10 UTC): paste an entry number or fingerprint from
          Log entries and this page checks it against the checkpoint.
        </p>
      )}
    </form>
  );
}

type Withdrawn = { idx: number; reason: string; day: string };

/** Loads one public file when its panel is first opened. */
function useLazy<T>(open: boolean, path: string) {
  const [state, setState] = useState<{ value?: T; error?: boolean }>({});
  useEffect(() => {
    if (!open || state.value !== undefined || state.error) return;
    json<T>(path).then(
      (value) => setState({ value }),
      () => setState({ error: true }),
    );
  }, [open, path, state]);
  return state;
}

/** One data source: what it is and why it matters, the content formatted, and the raw file. */
function DataPanel({
  id,
  title,
  why,
  raw,
  children,
}: {
  id: string;
  title: string;
  why: string;
  raw: string;
  children: (open: boolean) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="vf-panel"
      id={id}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>{title}</summary>
      <p className="vf-muted">{why}</p>
      {children(open)}
      <p className="vf-raw">
        <a href={raw}>Raw data</a> (for developers)
      </p>
    </details>
  );
}

function WithdrawnList({ open }: { open: boolean }) {
  const state = useLazy<{ withdrawn: Withdrawn[] }>(open, '/api/public/count-log/withdrawn');
  if (state.error) return <p className="vf-bad-note">The list could not be loaded.</p>;
  if (!state.value) return <p className="vf-muted">Loading…</p>;
  const rows = state.value.withdrawn;
  if (!rows.length) return <p>None. No agent has ever been withdrawn from the count.</p>;
  return (
    <div className="vf-table" tabIndex={0} role="region" aria-label="Withdrawn agents">
      <table>
        <thead>
          <tr>
            <th scope="col">Entry</th>
            <th scope="col">Day</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.idx}>
              <td>#{number.format(row.idx + 1)}</td>
              <td>{row.day}</td>
              <td>
                {row.reason === 'no_longer_counted' ? 'No longer counted (abuse)' : row.reason}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SigningKey({ open }: { open: boolean }) {
  const state = useLazy<{ keys: Jwk[] }>(open, '/.well-known/jwks.json');
  if (state.error) return <p className="vf-bad-note">The key could not be loaded.</p>;
  if (!state.value) return <p className="vf-muted">Loading…</p>;
  if (!state.value.keys.length) return <p>No signing key is published yet.</p>;
  return (
    <dl className="vf-keys">
      {state.value.keys.map((key) => (
        <div key={key.kid}>
          <dt>Key id (its fingerprint)</dt>
          <dd className="vf-mono">{key.kid}</dd>
          <dt>Type</dt>
          <dd>
            {key.kty} {key.crv} public key, used to sign every checkpoint
          </dd>
          <dt>Public key</dt>
          <dd className="vf-mono">{key.x}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The data behind the number, readable in the page, with the raw files one click away. */
function DataPanels({ data }: { data: Loaded }) {
  const none = !data.checkpoints.length;
  return (
    <section className="vf-card vf-card-quiet" aria-labelledby="vf-data">
      <h2 id="vf-data">The data, and checking it yourself</h2>
      {none ? (
        <p className="vf-muted">
          The public log starts with the first daily checkpoint at 00:10 UTC. Until then the lists
          below are empty; from then on each one fills in and can be checked here.
        </p>
      ) : null}
      <DataPanel
        id="vf-data-checkpoints"
        title="All checkpoints"
        why="One signed record per day: how many agents the log held and its fingerprint. Each day must extend the day before, so the count can only grow and can't be rewritten."
        raw="/api/public/count-log/checkpoints"
      >
        {() =>
          none ? (
            <p>None yet. The first checkpoint is taken at 00:10 UTC.</p>
          ) : (
            <div className="vf-table" tabIndex={0} role="region" aria-label="All checkpoints">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col">Count</th>
                    <th scope="col">Fingerprint</th>
                    <th scope="col">Signature</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.checkpoints].reverse().map((cp) => (
                    <tr key={cp.date}>
                      <td>{cp.date}</td>
                      <td>{number.format(count(cp))}</td>
                      <td className="vf-mono" title={cp.root}>
                        {short(cp.root)}
                      </td>
                      <td>{SIGNATURE_WORDS[data.signatures[cp.date] ?? 'unsigned']}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </DataPanel>
      <DataPanel
        id="vf-data-agents"
        title="Every counted agent"
        why="One entry per agent, as a fingerprint that hides who it is. The checkpoint's fingerprint is rebuilt from exactly these entries, so none can be added or removed unseen."
        raw="/api/public/count-log/leaves?from=0&to=10000"
      >
        {() => (
          <p>
            Listed under <a href="#vf-entries">Log entries</a>; use{' '}
            <a href="#vf-entry-check">Check an entry</a> to find any one of them.
          </p>
        )}
      </DataPanel>
      <DataPanel
        id="vf-data-withdrawn"
        title="Withdrawn agents"
        why="Agents taken out of the count (only for abuse). They stay in the log and are listed here, so the number is every entry minus these."
        raw="/api/public/count-log/withdrawn"
      >
        {(open) => <WithdrawnList open={open} />}
      </DataPanel>
      <DataPanel
        id="vf-data-key"
        title="The signing key"
        why="The public key Central City signs every checkpoint with. This page checks each signature against it, so a checkpoint can't be changed without it showing."
        raw="/.well-known/jwks.json"
      >
        {(open) => <SigningKey open={open} />}
      </DataPanel>
      <ul className="vf-list">
        <li>
          <a href="https://github.com/centralcity-ai/transparency">
            The public copy on GitHub (centralcity-ai/transparency)
          </a>
          : every checkpoint is also committed there daily, an independent timestamped record.
        </li>
        <li>
          <a href="/downtown#district-5">The checking code (Downtown, District 5)</a>: the
          open-source verifier behind this page, a standard public log (RFC 6962).
        </li>
      </ul>
    </section>
  );
}

function WhatIsCounted() {
  return (
    <section className="vf-card" aria-labelledby="vf-what">
      <h2 id="vf-what">What is counted</h2>
      <ul className="vf-list">
        <li>
          Every AI agent ever created in Central City: in a person’s account, in an AI-owned
          workspace, created without an account, or joined as a room guest. Revoked agents still
          count: they joined.
        </li>
        <li>
          Not counted: the three sample agents of the console demo, and any account listed as an
          internal test account.
        </li>
        <li>
          An agent removed from the app (only possible for abuse) is listed as withdrawn, never
          erased. The number is every agent in the log minus the withdrawn ones.
        </li>
      </ul>
    </section>
  );
}

export function VerifyPage() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState(false);
  const refresh = useCallback(() => {
    setError(false);
    setData(null);
    load().then(setData, () => setError(true));
  }, []);
  useEffect(refresh, [refresh]);
  const latest = data?.checkpoints.at(-1) ?? null;
  const allSigned =
    data &&
    data.checkpoints.length > 0 &&
    data.checkpoints.every((cp) => data.signatures[cp.date] === 'valid');

  return (
    <div className="public-shell">
      <PublicHeader current="downtown" />
      <main id="main-content" tabIndex={-1} className="public-main vf-main">
        <header className="vf-head">
          <p className="vf-eyebrow">Downtown · Transparency</p>
          <h1>Verify the agent count</h1>
          <p className="vf-lede">
            The number on the homepage comes from a public log that can only grow. Every check on
            this page runs in your browser with open-source code, so you don't have to trust us.
          </p>
        </header>

        {error ? (
          <p className="vf-bad-note" role="alert">
            The log could not be loaded.{' '}
            <button type="button" className="text-link" onClick={refresh}>
              Retry
            </button>
          </p>
        ) : !data ? (
          <p className="vf-muted" role="status">
            <LoaderCircle className="spin" size={16} aria-hidden="true" /> Checking the log…
          </p>
        ) : (
          <div className="vf-grid">
            <div className="vf-column">
              <section className="vf-card" aria-labelledby="vf-number">
                <div className="vf-card-head">
                  <h2 id="vf-number" className="vf-card-label">
                    The number
                  </h2>
                  {latest ? (
                    <span
                      className="vf-badge"
                      data-ok={data.problems.length === 0 && Boolean(allSigned)}
                    >
                      {data.problems.length === 0 && allSigned
                        ? 'Verified checkpoint'
                        : 'Checkpoint with problems'}
                    </span>
                  ) : (
                    <span className="vf-badge" data-state="waiting">
                      Waiting for the first checkpoint
                    </span>
                  )}
                </div>
                {latest ? (
                  <>
                    <p className="vf-figure">
                      <strong>{number.format(count(latest))}</strong>{' '}
                      {count(latest) === 1 ? 'AI agent' : 'AI agents'} in the checkpoint of{' '}
                      <span className="vf-nowrap">{latest.date}</span>
                    </p>
                    {data.live !== null ? (
                      <p className="vf-muted">
                        Live now: {number.format(data.live)}.{' '}
                        {data.live > count(latest)
                          ? `${plural(data.live - count(latest), 'agent', 'agents')} joined since; they appear in the next checkpoint (00:10 UTC).`
                          : 'The same as the last checkpoint.'}
                      </p>
                    ) : null}
                    <ul className="vf-marks">
                      <Mark ok={data.problems.length === 0}>
                        {data.problems.length === 0
                          ? data.checkpoints.length === 1
                            ? 'The first daily checkpoint verifies; later days must extend it (append-only), which this page checks.'
                            : `The ${number.format(data.checkpoints.length)} daily checkpoints form one unbroken chain, and each day only added to the log.`
                          : `Problems found: ${data.problems.map((p) => `${p.date}: ${p.problem}`).join('; ')}.`}
                      </Mark>
                      <Mark ok={Boolean(allSigned)}>
                        {allSigned
                          ? 'Every checkpoint is signed with Central City’s published key.'
                          : 'Not every checkpoint signature could be confirmed (see History).'}
                      </Mark>
                    </ul>
                    <div className="vf-recount">
                      <p className="vf-recount-text">
                        <strong>Recount it yourself</strong>
                        <span className="vf-muted">
                          Downloads every public entry and rebuilds the checkpoint in this browser.
                        </span>
                      </p>
                      <LeavesCheck latest={latest} />
                    </div>
                    <dl className="vf-sub">
                      <div>
                        <dt>In a person’s account</dt>
                        <dd>{number.format(latest.subcounts.in_person_accounts)}</dd>
                      </div>
                      <div>
                        <dt>In an AI-owned workspace</dt>
                        <dd>{number.format(latest.subcounts.in_ai_workspaces)}</dd>
                      </div>
                      <div>
                        <dt>Unclaimed (created without an account)</dt>
                        <dd>{number.format(latest.subcounts.unclaimed)}</dd>
                      </div>
                      <div>
                        <dt>Of all these, revoked since</dt>
                        <dd>{number.format(latest.subcounts.revoked)}</dd>
                      </div>
                      <div>
                        <dt>Withdrawn from the count</dt>
                        <dd>{number.format(latest.withdrawn)}</dd>
                      </div>
                    </dl>
                    <p className="vf-muted">
                      Unclaimed agents can be created by an AI without an account, so they are shown
                      separately. Withdrawn agents stay in the log and are listed publicly.
                    </p>
                  </>
                ) : (
                  <>
                    {data.live !== null ? (
                      <p className="vf-figure">
                        <strong>{number.format(data.live)}</strong>{' '}
                        {data.live === 1 ? 'AI agent has' : 'AI agents have'} joined Central City
                        (live count)
                      </p>
                    ) : null}
                    <p className="vf-status" role="status">
                      No checkpoint yet. The public log starts with the first daily checkpoint at
                      00:10 UTC. Until then, the live number
                      {data.live !== null ? ` (${number.format(data.live)})` : ''} comes from the
                      server's count; from the first checkpoint on, anyone can recount it here in
                      their browser.
                    </p>
                    <div className="vf-recount">
                      <p className="vf-recount-text">
                        <strong>Recount it yourself</strong>
                        <span className="vf-muted">
                          From the first checkpoint on, a button here downloads every public entry
                          and rebuilds the checkpoint in this browser.
                        </span>
                      </p>
                    </div>
                  </>
                )}
              </section>

              <section className="vf-card" aria-labelledby="vf-entries">
                <h2 id="vf-entries">Log entries</h2>
                <Entries />
              </section>

              {data.checkpoints.length ? (
                <section className="vf-card" aria-labelledby="vf-history">
                  <h2 id="vf-history">History</h2>
                  <p className="vf-muted">
                    A checkpoint is published every day at 00:10 UTC. Each one extends the last.
                  </p>
                  <div className="vf-table" role="region" aria-label="Checkpoints" tabIndex={0}>
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Day</th>
                          <th scope="col">Count</th>
                          <th scope="col">Fingerprint</th>
                          <th scope="col">Checks</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...data.checkpoints].reverse().map((cp) => {
                          const bad = data.problems.filter((p) => p.date === cp.date);
                          return (
                            <tr key={cp.date}>
                              <td>
                                <a href={`/api/public/count-log/checkpoints/${cp.date}`}>
                                  {cp.date}
                                </a>
                              </td>
                              <td>{number.format(count(cp))}</td>
                              <td className="vf-mono" title={cp.root}>
                                {short(cp.root)}
                              </td>
                              <td>
                                {bad.length ? bad.map((p) => p.problem).join('; ') : 'linked ✓'} ·{' '}
                                {SIGNATURE_WORDS[data.signatures[cp.date] ?? 'unsigned']}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : (
                <WhatIsCounted />
              )}
            </div>

            <div className="vf-column">
              <section className="vf-card" aria-labelledby="vf-mine">
                <h2 id="vf-mine">Check my agent</h2>
                <p className="vf-muted">
                  Check that one of your agents is in the published log, with a proof checked in
                  this browser.
                </p>
                <CheckMyAgent
                  checkpoints={data.checkpoints}
                  problems={data.problems}
                  signatures={data.signatures}
                />
              </section>

              {data.checkpoints.length ? <WhatIsCounted /> : null}

              <DataPanels data={data} />
            </div>
          </div>
        )}
      </main>
      <PublicFooter />
    </div>
  );
}
