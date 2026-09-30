import {
  KNOWN_CAPABILITIES,
  MANIFEST_API_VERSION,
  PAID_MODEL_PROVIDERS,
  manifestIssue,
  parseTeamManifest,
  type AgentManifest,
  type ManifestIssue,
  type ResolvedAgentManifest,
  type TeamManifest,
} from '../../shared/manifest.js';
import { canonicalHash, canonicalize } from './canonical.js';
import { ManifestError, resolveManifest, type AgentLoader } from './resolve.js';
import { builtinTemplates, type TemplateRegistry } from './templates.js';

/** Agent already in the workspace. `name` is the manifest slug it was applied under. */
export interface ExistingManifestAgent {
  id: string;
  name: string;
  /** Hash recorded when the agent was applied from a manifest; null for hand-made agents. */
  manifestHash: string | null;
  revoked?: boolean;
  /** Optional previously applied resolved manifest, used to list changed fields. */
  manifest?: ResolvedAgentManifest;
}
export interface ExistingConnection {
  fromAgentId: string;
  toAgentId: string;
}
export interface PlanContext {
  existingAgents: readonly ExistingManifestAgent[];
  existingConnections?: readonly ExistingConnection[];
  limits: { agentsPerWorkspace: number; connectionsPerWorkspace?: number };
  quotas?: { remaining?: { agents?: number; connections?: number; budgetUsd?: number } };
  registry?: TemplateRegistry;
  loadAgent?: AgentLoader;
}
export interface PlannedAgent {
  action: 'create' | 'update' | 'noop';
  name: string;
  /** Existing agent id for update/noop; null for create. */
  agentId: string | null;
  manifest: ResolvedAgentManifest;
  manifestHash: string;
  previousHash: string | null;
  /** Dotted paths (depth 2) that differ from the previously applied manifest, when known. */
  changes: string[];
  requiresApproval: boolean;
  approvalReasons: ManifestIssue[];
}
export interface PlannedConnection {
  action: 'create' | 'noop';
  from: string;
  to: string;
  fromAgentId: string | null;
  toAgentId: string | null;
}
export interface TeamPlan {
  /** False when any error exists; apply must refuse a plan that is not ok. */
  ok: boolean;
  team: { name: string; displayName: string; teamHash: string | null } | null;
  agents: PlannedAgent[];
  connections: PlannedConnection[];
  errors: ManifestIssue[];
  warnings: ManifestIssue[];
  requiresApproval: boolean;
  approvals: ManifestIssue[];
  quota: {
    agentsToCreate: number;
    agentsAfter: number;
    agentsLimit: number;
    connectionsToCreate: number;
    connectionsAfter: number;
    connectionsLimit: number | null;
    budgetUsdRequested: number;
  };
  summary: { create: number; update: number; noop: number; connectionsToCreate: number };
}

interface MemberInput {
  name: string;
  input: unknown;
  /** Path prefix of the member manifest inside the submitted document. */
  path: string;
  /** For `ref` members, issues about `spec.extends` point at this path instead. */
  refPath?: string;
}

const cents = (value: number) => Math.round(value * 100);

function diffPaths(before: ResolvedAgentManifest, after: ResolvedAgentManifest): string[] {
  const out: string[] = [];
  for (const section of ['metadata', 'spec'] as const) {
    const a = before[section] as Record<string, unknown>;
    const b = after[section] as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
      if (canonicalize(a[key] ?? null) !== canonicalize(b[key] ?? null))
        out.push(`${section}.${key}`);
  }
  return out;
}

function agentApprovals(manifest: ResolvedAgentManifest, path: string): ManifestIssue[] {
  const reasons: ManifestIssue[] = [];
  if (manifest.spec.policy.budgetUsd > 0)
    reasons.push(
      manifestIssue(
        'BUDGET_NONZERO',
        `${path}spec.policy.budgetUsd`,
        `Budget of $${manifest.spec.policy.budgetUsd.toFixed(2)} may incur charges.`,
        'Confirm the spend with the account owner, or set budgetUsd to 0 for zero-cost agents.',
      ),
    );
  const provider = manifest.spec.runtime.model?.provider;
  if (provider && PAID_MODEL_PROVIDERS.includes(provider))
    reasons.push(
      manifestIssue(
        'PAID_MODEL',
        `${path}spec.runtime.model.provider`,
        `Model provider "${provider}" is not zero-cost.`,
        'Confirm paid model use with the account owner, or use the platform demo model.',
      ),
    );
  return reasons;
}

function prefixIssues(issues: ManifestIssue[], member: MemberInput): ManifestIssue[] {
  return issues.map((issue) => ({
    ...issue,
    path:
      member.refPath && issue.path.startsWith('spec.extends')
        ? member.refPath
        : `${member.path}${issue.path}`.replace(/\.$/, ''),
  }));
}

interface Graph {
  names: string[];
  edges: Array<{ from: string; to: string }>;
}

/** Validates edges, then reports cycles, depth and fan-out. Mutates `errors` and `warnings`. */
function checkGraph(
  graph: Graph,
  coordinator: string | null,
  teamMaxDepth: number | null,
  resolved: Map<string, { manifest: ResolvedAgentManifest; path: string }>,
  errors: ManifestIssue[],
  warnings: ManifestIssue[],
): Array<{ from: string; to: string }> {
  const known = new Set(graph.names);
  const valid: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  graph.edges.forEach((edge, index) => {
    const path = `spec.connections[${index}]`;
    for (const end of ['from', 'to'] as const)
      if (!known.has(edge[end]))
        return errors.push(
          manifestIssue(
            'UNKNOWN_MEMBER',
            `${path}.${end}`,
            `Connection references unknown member "${edge[end]}".`,
            'Connect only names listed in spec.members.',
          ),
        );
    if (edge.from === edge.to)
      return errors.push(
        manifestIssue(
          'SELF_CONNECTION',
          path,
          `Member "${edge.from}" cannot connect to itself.`,
          'Remove the self-connection.',
        ),
      );
    const key = `${edge.from}\u0000${edge.to}`;
    if (seen.has(key))
      return errors.push(
        manifestIssue(
          'DUPLICATE_CONNECTION',
          path,
          `Connection ${edge.from} → ${edge.to} is listed twice.`,
          'List each directional connection once.',
        ),
      );
    seen.add(key);
    valid.push(edge);
  });
  const adjacency = new Map<string, string[]>(graph.names.map((name) => [name, []]));
  for (const edge of valid) adjacency.get(edge.from)!.push(edge.to);

  // Cycle detection (iterative order is deterministic: member order, then connection order).
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let cyclic = false;
  const visit = (node: string) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node)!) {
      if (state.get(next) === 1) {
        cyclic = true;
        const cycle = [...stack.slice(stack.indexOf(next)), next].join(' → ');
        errors.push(
          manifestIssue(
            'CONNECTION_CYCLE',
            'spec.connections',
            `Connections form a cycle: ${cycle}.`,
            'Delegation must be acyclic; remove one connection in the cycle.',
          ),
        );
      } else if (!state.get(next)) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const name of graph.names) if (!state.get(name)) visit(name);

  for (const name of graph.names) {
    const member = resolved.get(name);
    const out = adjacency.get(name)!.length;
    if (member && out > member.manifest.spec.policy.maxChildren)
      errors.push(
        manifestIssue(
          'CHILDREN_EXCEEDED',
          `${member.path}spec.policy.maxChildren`,
          `"${name}" connects to ${out} members but maxChildren is ${member.manifest.spec.policy.maxChildren}.`,
          'Raise spec.policy.maxChildren for this member or remove connections.',
        ),
      );
  }
  if (cyclic) return valid;
  const depthMemo = new Map<string, number>();
  const depth = (node: string): number => {
    if (depthMemo.has(node)) return depthMemo.get(node)!;
    const value = Math.max(0, ...adjacency.get(node)!.map((next) => depth(next) + 1));
    depthMemo.set(node, value);
    return value;
  };
  for (const name of graph.names) {
    const member = resolved.get(name);
    if (member && depth(name) > member.manifest.spec.policy.maxDepth)
      errors.push(
        manifestIssue(
          'DEPTH_EXCEEDED',
          `${member.path}spec.policy.maxDepth`,
          `Delegation below "${name}" is ${depth(name)} deep; maxDepth is ${member.manifest.spec.policy.maxDepth}.`,
          'Raise the member maxDepth (at most 3) or shorten the chain.',
        ),
      );
  }
  if (coordinator && known.has(coordinator)) {
    if (teamMaxDepth !== null && depth(coordinator) > teamMaxDepth)
      errors.push(
        manifestIssue(
          'DEPTH_EXCEEDED',
          'spec.policy.maxDepth',
          `Delegation from the coordinator is ${depth(coordinator)} deep; the team maxDepth is ${teamMaxDepth}.`,
          'Shorten the chain or raise spec.policy.maxDepth (at most 3).',
        ),
      );
    const reachable = new Set<string>([coordinator]);
    const queue = [coordinator];
    while (queue.length)
      for (const next of adjacency.get(queue.shift()!)!)
        if (!reachable.has(next)) reachable.add(next) && queue.push(next);
    graph.names.forEach((name, index) => {
      if (!reachable.has(name))
        warnings.push(
          manifestIssue(
            'UNREACHABLE_MEMBER',
            `spec.members[${index}]`,
            `"${name}" cannot be reached from the coordinator.`,
            'Connect the member or remove it from the team.',
          ),
        );
    });
  }
  return valid;
}

function planMembers(
  members: MemberInput[],
  edges: Graph['edges'],
  team: {
    manifest: TeamManifest | null;
    coordinator: string | null;
    budgetUsd: number | null;
    maxDepth: number | null;
  },
  context: PlanContext,
  errors: ManifestIssue[],
): TeamPlan {
  const warnings: ManifestIssue[] = [];
  const registry = context.registry ?? builtinTemplates;
  const active = context.existingAgents.filter((agent) => !agent.revoked);
  const existingByName = new Map<string, ExistingManifestAgent>();
  for (const agent of active) {
    if (existingByName.has(agent.name))
      warnings.push(
        manifestIssue(
          'AMBIGUOUS_EXISTING',
          '',
          `Several workspace agents are named "${agent.name}"; the first is used.`,
          'Rename or revoke duplicate agents.',
        ),
      );
    else existingByName.set(agent.name, agent);
  }
  const resolved = new Map<string, { manifest: ResolvedAgentManifest; path: string }>();
  const agents: PlannedAgent[] = [];
  for (const member of members) {
    let result;
    try {
      result = resolveManifest(member.input, registry, context.loadAgent);
    } catch (error) {
      if (error instanceof ManifestError) {
        errors.push(...prefixIssues(error.issues, member));
        continue;
      }
      throw error;
    }
    const { manifest, manifestHash } = result;
    const capabilities = manifest.spec.capabilities;
    const known = (capability: string) =>
      (KNOWN_CAPABILITIES as readonly string[]).includes(capability);
    const unsupported =
      manifest.spec.runtime.mode === 'hosted'
        ? capabilities.findIndex((capability) => !known(capability))
        : known(capabilities[0]!)
          ? -1
          : 0;
    if (unsupported >= 0)
      errors.push(
        manifestIssue(
          'CAPABILITY_UNSUPPORTED',
          `${member.path}spec.capabilities[${unsupported}]`,
          `Capability "${capabilities[unsupported]}" is not supported here yet.`,
          `Hosted agents support ${KNOWN_CAPABILITIES.join(', ')}; other runtimes must list one of them first.`,
        ),
      );
    if (manifest.spec.runtime.mode === 'a2a')
      warnings.push(
        manifestIssue(
          'RUNTIME_PENDING',
          `${member.path}spec.runtime.mode`,
          'Outbound a2a runtimes are declared but not yet executable.',
          'Use mode "external" until outbound A2A calls are enabled.',
        ),
      );
    resolved.set(member.name, { manifest, path: member.path });
    const existing = existingByName.get(member.name);
    if (existing && existing.manifestHash === null) {
      errors.push(
        manifestIssue(
          'NAME_CONFLICT',
          `${member.path}metadata.name`,
          `Agent "${member.name}" exists but was not created from a manifest.`,
          'Choose another member name or revoke the existing agent.',
        ),
      );
      continue;
    }
    const action = !existing
      ? 'create'
      : existing.manifestHash === manifestHash
        ? 'noop'
        : 'update';
    const approvalReasons = action === 'noop' ? [] : agentApprovals(manifest, member.path);
    agents.push({
      action,
      name: member.name,
      agentId: existing?.id ?? null,
      manifest,
      manifestHash,
      previousHash: existing?.manifestHash ?? null,
      changes:
        action === 'update' && existing?.manifest ? diffPaths(existing.manifest, manifest) : [],
      requiresApproval: approvalReasons.length > 0,
      approvalReasons,
    });
  }

  const valid = checkGraph(
    { names: members.map((member) => member.name), edges },
    team.coordinator,
    team.maxDepth,
    resolved,
    errors,
    warnings,
  );
  const agentId = (name: string) => agents.find((agent) => agent.name === name)?.agentId ?? null;
  const existingEdges = new Set(
    (context.existingConnections ?? []).map((edge) => `${edge.fromAgentId}\u0000${edge.toAgentId}`),
  );
  const connections: PlannedConnection[] = valid.map((edge) => {
    const fromAgentId = agentId(edge.from);
    const toAgentId = agentId(edge.to);
    const exists =
      fromAgentId !== null &&
      toAgentId !== null &&
      existingEdges.has(`${fromAgentId}\u0000${toAgentId}`);
    return {
      action: exists ? 'noop' : 'create',
      from: edge.from,
      to: edge.to,
      fromAgentId,
      toAgentId,
    };
  });

  // Budgets are compared in integer cents to avoid floating point drift.
  const memberBudgetCents = [...resolved.values()].reduce(
    (sum, member) => sum + cents(member.manifest.spec.policy.budgetUsd),
    0,
  );
  if (team.budgetUsd !== null && memberBudgetCents > cents(team.budgetUsd))
    errors.push(
      manifestIssue(
        'TEAM_BUDGET_EXCEEDED',
        'spec.policy.budgetUsd',
        `Member budgets total $${(memberBudgetCents / 100).toFixed(2)}, above the team budget of $${team.budgetUsd.toFixed(2)}.`,
        'Raise the team budget or lower member budgets.',
      ),
    );

  const count = (action: PlannedAgent['action']) =>
    agents.filter((agent) => agent.action === action).length;
  const agentsToCreate = count('create');
  const connectionsToCreate = connections.filter((edge) => edge.action === 'create').length;
  const existingConnectionCount = context.existingConnections?.length ?? 0;
  const connectionsLimit = context.limits.connectionsPerWorkspace ?? null;
  const remaining = context.quotas?.remaining ?? {};
  const budgetUsdRequested =
    agents
      .filter((agent) => agent.action !== 'noop')
      .reduce((sum, agent) => sum + cents(agent.manifest.spec.policy.budgetUsd), 0) / 100;
  const quotaError = (message: string, hint: string) =>
    errors.push(manifestIssue('QUOTA_EXCEEDED', 'spec.members', message, hint));
  if (active.length + agentsToCreate > context.limits.agentsPerWorkspace)
    quotaError(
      `Creating ${agentsToCreate} agents would exceed the workspace limit of ${context.limits.agentsPerWorkspace} (currently ${active.length}).`,
      'Revoke unused agents or plan fewer members.',
    );
  if (remaining.agents !== undefined && agentsToCreate > remaining.agents)
    quotaError(
      `Creating ${agentsToCreate} agents exceeds the remaining quota of ${remaining.agents}.`,
      'Plan fewer members or wait for quota to reset.',
    );
  if (connectionsLimit !== null && existingConnectionCount + connectionsToCreate > connectionsLimit)
    quotaError(
      `Creating ${connectionsToCreate} connections would exceed the workspace limit of ${connectionsLimit}.`,
      'Remove unused connections or plan fewer.',
    );
  if (remaining.connections !== undefined && connectionsToCreate > remaining.connections)
    quotaError(
      `Creating ${connectionsToCreate} connections exceeds the remaining quota of ${remaining.connections}.`,
      'Plan fewer connections.',
    );
  if (remaining.budgetUsd !== undefined && cents(budgetUsdRequested) > cents(remaining.budgetUsd))
    quotaError(
      `Requested budgets of $${budgetUsdRequested.toFixed(2)} exceed the remaining $${remaining.budgetUsd.toFixed(2)}.`,
      'Lower budgets or request more budget from the account owner.',
    );

  const changed = agents.some((agent) => agent.action !== 'noop') || connectionsToCreate > 0;
  const approvals = agents.flatMap((agent) => agent.approvalReasons);
  if (changed && team.budgetUsd !== null && team.budgetUsd > 0)
    approvals.push(
      manifestIssue(
        'BUDGET_NONZERO',
        'spec.policy.budgetUsd',
        `Team budget of $${team.budgetUsd.toFixed(2)} may incur charges.`,
        'Confirm the spend with the account owner, or set the team budget to 0.',
      ),
    );
  const teamHash =
    team.manifest && errors.length === 0
      ? canonicalHash({
          apiVersion: MANIFEST_API_VERSION,
          kind: 'Team',
          metadata: team.manifest.metadata,
          spec: {
            coordinator: team.manifest.spec.coordinator,
            policy: team.manifest.spec.policy,
            connections: team.manifest.spec.connections,
            members: agents.map((agent) => ({
              name: agent.name,
              manifestHash: agent.manifestHash,
            })),
          },
        })
      : null;
  return {
    ok: errors.length === 0,
    team: team.manifest
      ? {
          name: team.manifest.metadata.name,
          displayName: team.manifest.metadata.displayName ?? team.manifest.metadata.name,
          teamHash,
        }
      : null,
    agents,
    connections,
    errors,
    warnings,
    requiresApproval: approvals.length > 0,
    approvals,
    quota: {
      agentsToCreate,
      agentsAfter: active.length + agentsToCreate,
      agentsLimit: context.limits.agentsPerWorkspace,
      connectionsToCreate,
      connectionsAfter: existingConnectionCount + connectionsToCreate,
      connectionsLimit,
      budgetUsdRequested,
    },
    summary: {
      create: agentsToCreate,
      update: count('update'),
      noop: count('noop'),
      connectionsToCreate,
    },
  };
}

function emptyPlan(errors: ManifestIssue[], context: PlanContext): TeamPlan {
  return planMembers(
    [],
    [],
    { manifest: null, coordinator: null, budgetUsd: null, maxDepth: null },
    context,
    errors,
  );
}

/**
 * Dry-run plan for a Team manifest. Pure and deterministic: the same document and context always
 * produce the same plan. Planning a team whose agents already carry the resolved hashes yields
 * only no-ops. The caller applies creates/updates/connections atomically and records each agent's
 * `manifestHash`.
 */
export function planTeam(input: unknown, context: PlanContext): TeamPlan {
  const parsed = parseTeamManifest(input);
  if (!parsed.ok) return emptyPlan(parsed.issues, context);
  const manifest = parsed.value;
  const errors: ManifestIssue[] = [];
  if (!manifest.spec.members.some((member) => member.name === manifest.spec.coordinator))
    errors.push(
      manifestIssue(
        'COORDINATOR_MISSING',
        'spec.coordinator',
        `Coordinator "${manifest.spec.coordinator}" is not a team member.`,
        'Set spec.coordinator to one of the member names.',
      ),
    );
  const members: MemberInput[] = manifest.spec.members.map((member, index) =>
    member.manifest
      ? { name: member.name, input: member.manifest, path: `spec.members[${index}].manifest.` }
      : {
          name: member.name,
          input: {
            apiVersion: MANIFEST_API_VERSION,
            kind: 'Agent',
            metadata: { name: member.name },
            spec: { extends: member.ref },
          } satisfies AgentManifest,
          path: `spec.members[${index}].manifest.`,
          refPath: `spec.members[${index}].ref`,
        },
  );
  return planMembers(
    members,
    manifest.spec.connections,
    {
      manifest,
      coordinator: manifest.spec.coordinator,
      budgetUsd: manifest.spec.policy.budgetUsd,
      maxDepth: manifest.spec.policy.maxDepth,
    },
    context,
    errors,
  );
}

/** Dry-run plan for a single Agent manifest (same semantics as a one-member team). */
export function planAgent(input: unknown, context: PlanContext): TeamPlan {
  const name =
    typeof (input as { metadata?: { name?: unknown } } | null)?.metadata?.name === 'string'
      ? (input as { metadata: { name: string } }).metadata.name
      : '';
  return planMembers(
    [{ name, input, path: '' }],
    [],
    { manifest: null, coordinator: null, budgetUsd: null, maxDepth: null },
    context,
    [],
  );
}
