import {
  verifyChain,
  verifyCheckpointSignature,
  type ChainProblem,
  type Checkpoint,
} from '../../shared/count-log/index';

/*
 * The public count log as the browser reads it (/downtown/verify and /downtown/log): fetch,
 * checkpoints with their chain and signature checks, and the small formatters both pages share.
 */

export type Jwk = { kid: string; kty: string; crv: string; x: string };
export type SignatureState = 'valid' | 'invalid' | 'unsigned' | 'unsupported' | 'unknown-key';
export type Loaded = {
  checkpoints: Checkpoint[];
  problems: ChainProblem[];
  signatures: Record<string, SignatureState>;
  live: number | null;
};

export const count = (cp: Pick<Checkpoint, 'tree_size' | 'withdrawn'>) =>
  cp.tree_size - cp.withdrawn;
export const number = new Intl.NumberFormat('en-US');
export const short = (hex: string) => `${hex.slice(0, 12)}…${hex.slice(-6)}`;
export const plural = (n: number, one: string, many: string) =>
  `${number.format(n)} ${n === 1 ? one : many}`;

export async function json<T>(path: string): Promise<T> {
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

export async function load(): Promise<Loaded> {
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

export const SIGNATURE_WORDS: Record<SignatureState, string> = {
  valid: 'signed ✓',
  invalid: 'signature does not verify',
  unsigned: 'unsigned',
  unsupported: 'signature not checked (this browser has no Ed25519)',
  'unknown-key': 'signing key not published',
};
