import { randomBytes } from 'node:crypto';
import { benchIp, OwnerSession, type LoadClient } from './client.js';

export interface AgentHandle {
  id: string;
  name: string;
  mode: 'external' | 'hosted';
  /** Runtime credential (external agents only). Held in memory only; never reported. */
  token?: string;
  ip: string;
  sequence: number;
}
export interface OwnerWorld {
  session: OwnerSession;
  operatorId: string;
  externals: AgentHandle[];
  hosted: AgentHandle[];
  /** Directional external→external connections used for owner-submitted jobs. */
  pairs: Array<[AgentHandle, AgentHandle]>;
  /** external agent id → hosted provider it may request work from. */
  hostedLinks: Map<string, AgentHandle>;
}

/** Allocates distinct synthetic client addresses for one run. */
export class IpPool {
  private next: number;
  constructor(start = 1) {
    this.next = start;
  }
  take(): string {
    return benchIp(this.next++);
  }
}

export const ownerName = (runId: string, index: number, prefix = 'o') =>
  `load-${runId}-${prefix}${String(index).padStart(4, '0')}`;

const password = () => `load-${randomBytes(18).toString('base64url')}`;

function check(label: string, response: { status: number; body: any }, expected: number): void {
  if (response.status !== expected)
    throw new Error(
      `Seed step ${label} returned ${response.status}: ${response.body?.error ?? 'no message'}`,
    );
}

export async function registerOwner(
  client: LoadClient,
  name: string,
  ip: string,
): Promise<{ session: OwnerSession; operatorId: string }> {
  const session = new OwnerSession(name, ip);
  const response = await client.send({
    method: 'POST',
    path: '/api/auth/register',
    body: { name, password: password() },
    ip,
    owner: session,
  });
  check('register', response, 201);
  if (!session.cookie) throw new Error('Register did not set a session cookie.');
  return { session, operatorId: response.body.operator.id };
}

export async function createAgent(
  client: LoadClient,
  session: OwnerSession,
  name: string,
  mode: 'external' | 'hosted',
  capability: 'research' | 'extract' | 'verify',
  ip: string,
): Promise<AgentHandle> {
  const response = await client.send({
    method: 'POST',
    path: '/api/agents',
    route: 'POST /api/agents',
    body: { name, description: 'Synthetic load-test agent.', capability, mode },
    ip: session.ip,
    owner: session,
  });
  check('create agent', response, 201);
  return {
    id: response.body.agent.id,
    name,
    mode,
    ...(response.body.token ? { token: response.body.token as string } : {}),
    ip,
    sequence: 0,
  };
}

export async function connect(
  client: LoadClient,
  session: OwnerSession,
  from: AgentHandle,
  to: AgentHandle,
): Promise<void> {
  const response = await client.send({
    method: 'POST',
    path: '/api/connections',
    route: 'POST /api/connections',
    body: { fromAgentId: from.id, toAgentId: to.id },
    ip: session.ip,
    owner: session,
  });
  check('connect', response, 201);
}

export async function heartbeat(client: LoadClient, agent: AgentHandle) {
  agent.sequence++;
  return client.send({
    method: 'POST',
    path: '/api/runtime/heartbeat',
    route: 'POST /api/runtime/heartbeat',
    body: { sequence: agent.sequence },
    ip: agent.ip,
    runtimeToken: agent.token!,
  });
}

const CAPABILITIES = ['research', 'extract', 'verify'] as const;

/**
 * Builds one owner: `externalCount` external runtimes paired E0→E1, E2→E3 …, plus `hostedCount`
 * hosted demonstration providers each external agent may request work from, then first
 * heartbeats so every external agent is reachable.
 */
export async function seedOwner(
  client: LoadClient,
  name: string,
  ips: IpPool,
  externalCount: number,
  hostedCount: number,
): Promise<OwnerWorld> {
  const { session, operatorId } = await registerOwner(client, name, ips.take());
  const externals: AgentHandle[] = [];
  const hosted: AgentHandle[] = [];
  for (let index = 0; index < externalCount; index++)
    externals.push(
      await createAgent(
        client,
        session,
        `E${index}`,
        'external',
        CAPABILITIES[index % 3]!,
        ips.take(),
      ),
    );
  for (let index = 0; index < hostedCount; index++)
    hosted.push(
      await createAgent(
        client,
        session,
        `H${index}`,
        'hosted',
        CAPABILITIES[index % 3]!,
        session.ip,
      ),
    );
  const pairs: Array<[AgentHandle, AgentHandle]> = [];
  for (let index = 0; index + 1 < externals.length; index += 2) {
    await connect(client, session, externals[index]!, externals[index + 1]!);
    pairs.push([externals[index]!, externals[index + 1]!]);
  }
  const hostedLinks = new Map<string, AgentHandle>();
  if (hosted.length)
    for (const [index, agent] of externals.entries()) {
      const provider = hosted[index % hosted.length]!;
      await connect(client, session, agent, provider);
      hostedLinks.set(agent.id, provider);
    }
  for (const agent of externals) check('first heartbeat', await heartbeat(client, agent), 200);
  return { session, operatorId, externals, hosted, pairs, hostedLinks };
}

export interface SeedOptions {
  runId: string;
  owners: number;
  agentsPerOwner: number;
  hostedPerOwner: number;
  concurrency?: number;
}

export async function seed(
  client: LoadClient,
  ips: IpPool,
  options: SeedOptions,
): Promise<OwnerWorld[]> {
  const worlds: OwnerWorld[] = new Array(options.owners);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(options.concurrency ?? 4, options.owners) },
    async () => {
      while (next < options.owners) {
        const index = next++;
        worlds[index] = await seedOwner(
          client,
          ownerName(options.runId, index + 1),
          ips,
          options.agentsPerOwner - options.hostedPerOwner,
          options.hostedPerOwner,
        );
      }
    },
  );
  await Promise.all(workers);
  return worlds;
}
