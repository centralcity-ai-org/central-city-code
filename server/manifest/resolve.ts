import {
  MANIFEST_LIMITS,
  jsonByteLength,
  manifestIssue,
  parseAgentManifest,
  resolvedAgentManifestSchema,
  zodIssues,
  type AgentManifest,
  type ManifestIssue,
  type ResolvedAgentManifest,
} from '../../shared/manifest.js';
import { canonicalHash } from './canonical.js';
import { builtinTemplates, type TemplateRegistry } from './templates.js';

export class ManifestError extends Error {
  constructor(public readonly issues: ManifestIssue[]) {
    super(
      issues
        .map((issue) => `${issue.code} at ${issue.path || '(root)'}: ${issue.message}`)
        .join('; '),
    );
    this.name = 'ManifestError';
  }
}

/** A stored agent revision supplied by the caller for `extends: agent:<uuid>@<revision>`. */
export interface LoadedAgent {
  manifest: ResolvedAgentManifest;
  /** True when the forking account owns the source agent. Computed by the loader. */
  sameOwner: boolean;
}
/**
 * Synchronous by design: the caller preloads (and authorizes) the revision so that resolution
 * stays deterministic and free of I/O. Return undefined when missing or not visible to the caller.
 */
export type AgentLoader = (agentId: string, revision: number) => LoadedAgent | undefined;

export interface ResolvedManifest {
  manifest: ResolvedAgentManifest;
  /** `sha256:<hex>` of the JCS-canonical resolved manifest. */
  manifestHash: string;
  base: { kind: 'none' } | { kind: 'template' | 'agent'; ref: string; sameOwner: boolean };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Override rules: objects merge key by key, arrays and scalars in the override replace the base,
 * absent keys inherit. `spec.runtime` is replaced wholesale when the override names a different
 * runtime mode, because model/endpoint settings do not carry across modes.
 */
export function mergeManifest(base: Json, override: Json): Json {
  const merged = deepMerge(base, override) as Json;
  const baseRuntime = (base.spec as Json | undefined)?.runtime as Json | undefined;
  const overRuntime = (override.spec as Json | undefined)?.runtime as Json | undefined;
  if (overRuntime?.mode !== undefined && baseRuntime?.mode !== overRuntime.mode)
    (merged.spec as Json).runtime = structuredClone(overRuntime);
  return merged;
}
function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return structuredClone(base);
  if (isObject(base) && isObject(override)) {
    const out: Json = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(override)]))
      out[key] = deepMerge(base[key], override[key]);
    return out;
  }
  return structuredClone(override);
}

const REF = /^(template|agent):([^@]+)@(.+)$/;

export function resolveManifest(
  input: unknown,
  registry: TemplateRegistry = builtinTemplates,
  loadAgent?: AgentLoader,
): ResolvedManifest {
  const parsed = parseAgentManifest(input);
  if (!parsed.ok) throw new ManifestError(parsed.issues);
  const manifest: AgentManifest = parsed.value;
  const ref = manifest.spec.extends;
  let baseDocument: Json | null = null;
  let base: ResolvedManifest['base'] = { kind: 'none' };
  let forkParent: ResolvedAgentManifest | null = null;
  if (ref) {
    const [, kind, id, version] = REF.exec(ref)!;
    if (kind === 'template') {
      const template = registry.get(id!, version!);
      if (!template)
        throw new ManifestError([
          manifestIssue(
            'TEMPLATE_NOT_FOUND',
            'spec.extends',
            'The template does not exist.',
            'List templates and use an exact template:<id>@<version> reference.',
          ),
        ]);
      if (template.kind !== 'Agent')
        throw new ManifestError([
          manifestIssue(
            'TEMPLATE_KIND_MISMATCH',
            'spec.extends',
            `The template is a ${template.kind} template.`,
            'Agents can only extend Agent templates; plan Team templates with planTeam.',
          ),
        ]);
      baseDocument = template.manifest as unknown as Json;
      base = { kind: 'template', ref, sameOwner: true };
    } else {
      if (!loadAgent)
        throw new ManifestError([
          manifestIssue(
            'AGENT_LOADER_UNAVAILABLE',
            'spec.extends',
            'Forks require an agent loader.',
            'Resolve forks through the server, which loads the source revision.',
          ),
        ]);
      const loaded = loadAgent(id!, Number(version));
      if (!loaded)
        throw new ManifestError([
          manifestIssue(
            'AGENT_NOT_FOUND',
            'spec.extends',
            'The agent revision is unavailable.',
            'Check the agent id and revision, and that it is visible to you.',
          ),
        ]);
      if (!loaded.sameOwner && loaded.manifest.spec.visibility === 'private')
        throw new ManifestError([
          manifestIssue(
            'FORK_NOT_PERMITTED',
            'spec.extends',
            'Private agents of another owner cannot be forked.',
            'Ask the owner to publish the agent with org or public visibility.',
          ),
        ]);
      baseDocument = loaded.manifest as unknown as Json;
      base = { kind: 'agent', ref, sameOwner: loaded.sameOwner };
      if (!loaded.sameOwner) forkParent = loaded.manifest;
    }
  }
  const merged = baseDocument
    ? mergeManifest(baseDocument, manifest as unknown as Json)
    : (structuredClone(manifest) as unknown as Json);
  const metadata = merged.metadata as Json;
  metadata.name = manifest.metadata.name;
  if (metadata.displayName === undefined) metadata.displayName = manifest.metadata.name;
  // The child's own reference is the provenance recorded in the resolved document.
  if (ref) (merged.spec as Json).extends = ref;
  const result = resolvedAgentManifestSchema.safeParse(merged);
  if (!result.success) throw new ManifestError(zodIssues(result.error));
  const resolved = result.data;
  if (forkParent) {
    const loosened = policyLoosening(forkParent, resolved);
    if (loosened.length) throw new ManifestError(loosened);
  }
  const bytes = jsonByteLength(resolved);
  if (bytes === null || bytes > MANIFEST_LIMITS.manifestBytes)
    throw new ManifestError([
      manifestIssue('MANIFEST_TOO_LARGE', '', 'The resolved manifest exceeds the size limit.'),
    ]);
  return { manifest: resolved, manifestHash: hashManifest(resolved), base };
}

export const hashManifest = (manifest: ResolvedAgentManifest) => canonicalHash(manifest);

const domainCovered = (domain: string, parents: string[]) =>
  parents.some((parent) =>
    parent.startsWith('*.')
      ? domain === parent || domain.endsWith(parent.slice(1))
      : domain === parent,
  );

/**
 * Forking another owner's agent may only tighten its policy and tool surface: budget, children
 * and depth cannot grow, allowed domains must stay within the parent's, approvals cannot be
 * dropped and MCP servers cannot be added (matched by URL). Returns one issue per loosening.
 */
export function policyLoosening(
  parent: ResolvedAgentManifest,
  child: ResolvedAgentManifest,
): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const p = parent.spec.policy;
  const c = child.spec.policy;
  const hint = "Forks of another owner's agent may only tighten its policy.";
  for (const key of ['budgetUsd', 'maxChildren', 'maxDepth'] as const)
    if (c[key] > p[key])
      issues.push(
        manifestIssue(
          'POLICY_LOOSENED',
          `spec.policy.${key}`,
          `${key} exceeds the parent's ${p[key]}.`,
          hint,
        ),
      );
  c.allowedDomains.forEach((domain, index) => {
    if (!domainCovered(domain, p.allowedDomains))
      issues.push(
        manifestIssue(
          'POLICY_LOOSENED',
          `spec.policy.allowedDomains[${index}]`,
          'The domain is not allowed by the parent.',
          hint,
        ),
      );
  });
  for (const action of p.approvalRequiredFor)
    if (!c.approvalRequiredFor.includes(action))
      issues.push(
        manifestIssue(
          'POLICY_LOOSENED',
          'spec.policy.approvalRequiredFor',
          `Approval for ${action} cannot be removed.`,
          hint,
        ),
      );
  const parentUrls = new Set(parent.spec.tools.mcpServers.map((server) => server.url));
  child.spec.tools.mcpServers.forEach((server, index) => {
    if (!parentUrls.has(server.url))
      issues.push(
        manifestIssue(
          'TOOLS_EXPANDED',
          `spec.tools.mcpServers[${index}]`,
          'The MCP server is not configured on the parent.',
          hint,
        ),
      );
  });
  return issues;
}
