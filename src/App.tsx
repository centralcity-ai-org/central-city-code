import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  CheckCheck,
  CircleHelp,
  Download,
  DoorOpen,
  FileText,
  Layers3,
  Link2,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MessagesSquare,
  Network,
  Pause,
  Play,
  Plug,
  Plus,
  Radio,
  RefreshCw,
  Scale,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Unplug,
  X,
} from 'lucide-react';
import type { Agent, Capability, Job, Operator, Snapshot, WorkspaceExport } from '../shared/types';
import { api, selectWorkspace } from './api';
import { useSnapshot } from './useSnapshot';
import { Workflows } from './Workflows';
import { AssistantAccess, permissionLabel } from './AssistantAccess';

import { CrossWorkspaceConnections } from './Connections';
import { WorkspaceKeys } from './WorkspaceKeys';
import { AutoReplySection } from './responder';
import type { WorkspaceMembership } from '../shared/assistant';
import { AgentInbox, forgetMessagesState, MessagesView, useInboxSummary } from './Messages';
import { INVITE_ROOMS_PATH, navigate } from './shell/navigation';
import {
  AgentGlyph,
  capabilityLabels,
  CopyButton,
  creatorLabel,
  EmptyState,
  formatDate,
  formatTime,
  Modal,
  SectionHeading,
  Status,
  TextLink,
} from './components';
import { CityMark, Lockup, SkipLink, ThemeToggle } from './brand';
import { FormError } from './Auth';
import {
  aiCreated,
  budgetLabel,
  capabilityFigure,
  CityCircle,
  CourtIllustration,
  ExchangeCircle,
  exchangeLabels,
  jobExchangeState,
  lineageDepth,
  type ExchangeState,
} from './circle';
import { ConnectAI } from './Connect';
import { AppHeader } from './shell/AppHeader';
import { codeFromPaste, eventTypeLabel, plainEvent } from './ui/plainText';
import { ReadableData } from './ui/ReadableData';
import { PublicFooter } from './shell/PublicFooter';
import { PublicHeader } from './shell/PublicHeader';

/** Its own chunk: only owners on a server with Elric open it. */
const ElricActivity = lazy(() =>
  import('./elric/ElricActivity').then((module) => ({ default: module.ElricActivity })),
);

type View =
  | 'network'
  | 'connect'
  | 'agents'
  | 'jobs'
  | 'connections'
  | 'activity'
  | 'collaborations'
  | 'messages'
  | 'assistants'
  | 'elric';
type Dialog =
  | { kind: 'create' }
  | { kind: 'connection' }
  | { kind: 'job'; connectionId?: string }
  | { kind: 'agent'; id: string }
  | { kind: 'result'; id: string }
  | { kind: 'export' }
  | { kind: 'token'; token: string; agent: Agent; rotated?: boolean }
  | null;
const navigation = [
  { id: 'network', label: 'Overview', icon: Network },
  { id: 'connect', label: 'Connect your AI', icon: Plug },
  { id: 'agents', label: 'Agents', icon: Layers3 },
  { id: 'jobs', label: 'Exchanges', icon: Scale },
  { id: 'collaborations', label: 'Collaborations', icon: FileText },
  { id: 'messages', label: 'Messages', icon: MessagesSquare },
  { id: 'connections', label: 'Connections', icon: Link2 },
  { id: 'assistants', label: 'AI connections', icon: Sparkles },
  // Shown only when the server has Elric (GET /api/elric answers; CITY_ELRIC=1).
  { id: 'elric', label: 'Elric', icon: Bot },
  { id: 'activity', label: 'Activity', icon: Activity },
] as const;

/**
 * The person's own workspace plus the AI-owned workspaces they co-own (docs/AI_WORKSPACES.md).
 * Switching remounts the console for the selected workspace; every request then carries
 * X-City-Workspace, which the server honors only for co-owned workspaces.
 */
export function Workspaces({ person, onLogout }: { person: Operator; onLogout: () => void }) {
  const own: WorkspaceMembership = {
    id: person.id,
    name: person.name,
    kind: 'owner',
    role: 'owner',
  };
  const [memberships, setMemberships] = useState<WorkspaceMembership[]>([own]);
  const [activeId, setActiveId] = useState(person.id);
  const reload = useCallback(async () => {
    try {
      const value = await api<{ workspaces: WorkspaceMembership[] }>('/api/workspaces');
      setMemberships(value.workspaces);
    } catch {
      // The console reports connectivity problems itself; keep the current list.
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const active = memberships.find((item) => item.id === activeId) ?? own;
  function switchTo(id: string) {
    selectWorkspace(id === person.id ? null : id);
    setActiveId(id);
  }
  return (
    <Console
      key={active.id}
      operator={{ id: active.id, name: active.name }}
      kind={active.kind}
      workspaces={memberships}
      onSwitch={switchTo}
      onWorkspacesChanged={() => void reload()}
      onLogout={() => {
        selectWorkspace(null);
        onLogout();
      }}
    />
  );
}

const headings: Record<View, { title: ReactNode; lede: string }> = {
  network: {
    title: (
      <>
        Everything, <span>at a glance.</span>
      </>
    ),
    lede: 'Your agents, who may work with whom, and the work waiting for your decision.',
  },
  connect: {
    title: 'Connect your AI.',
    lede: 'Add Central City to ChatGPT, Claude, Cursor, VS Code or Codex once. After that, you only paste links.',
  },
  agents: {
    title: 'Your agents.',
    lede: 'Each agent has its own identity here. See who created it and what it does.',
  },
  jobs: {
    title: 'Exchanges.',
    lede: 'Work one agent sent to another, what came back, and whether you accepted it.',
  },
  collaborations: {
    title: 'Collaborations.',
    lede: 'One agent drafts a brief from your source, a second checks it, and you decide.',
  },
  messages: {
    title: 'Messages.',
    lede: 'Conversations between your agents, one thread at a time.',
  },
  assistants: {
    title: 'AI connections.',
    lede: 'The AI apps that can act in your account. Remove their access at any time.',
  },
  connections: {
    title: 'Connections.',
    lede: 'Choose which agents may send work to each other, and in which direction.',
  },
  elric: {
    title: 'Elric.',
    lede: 'What your Elric did, and what it may do.',
  },
  activity: {
    title: 'Activity.',
    lede: 'Everything that happened in your account, newest first.',
  },
};

/** Tracks agents that appear after the first snapshot so they can be drawn into the city. */
function useTransmutations(snapshot: Snapshot | null) {
  const known = useRef<Set<string> | null>(null);
  const timers = useRef<number[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  useEffect(() => {
    if (!snapshot) return;
    if (!known.current) {
      known.current = new Set(snapshot.agents.map((agent) => agent.id));
      return;
    }
    const added = snapshot.agents.filter((agent) => !known.current!.has(agent.id));
    if (!added.length) return;
    for (const agent of added) known.current.add(agent.id);
    setFresh((current) => new Set([...current, ...added.map((agent) => agent.id)]));
    const claimed = added.every((agent) => agent.claimedAt);
    const byAi = added.some(aiCreated);
    const subject = added.length === 1 ? added[0]!.name : `${added.length} agents`;
    setAnnouncement(
      claimed
        ? `${subject} claimed into your account.`
        : `${subject} added${byAi ? ' by an AI app' : ''}.`,
    );
    timers.current.push(
      window.setTimeout(() => {
        setFresh((current) => {
          const next = new Set(current);
          for (const agent of added) next.delete(agent.id);
          return next;
        });
      }, 2600),
    );
  }, [snapshot]);
  return { fresh, announcement };
}

function Console({
  operator,
  kind,
  workspaces,
  onSwitch,
  onWorkspacesChanged,
  onLogout,
}: {
  operator: Operator;
  kind: 'owner' | 'ai';
  workspaces: WorkspaceMembership[];
  onSwitch: (id: string) => void;
  onWorkspacesChanged: () => void;
  onLogout: () => void;
}) {
  const { snapshot, error, streamLive, refreshing, refresh } = useSnapshot(
    true,
    operator.id,
    onLogout,
  );
  // A claim link (#claim=<token>) opens the agents view with the token prefilled.
  const [view, setView] = useState<View>(() =>
    window.location.hash.startsWith('#claim=')
      ? 'agents'
      : window.location.hash === '#connect'
        ? 'connect'
        : 'network',
  );
  useEffect(() => {
    if (['#signin', '#create', '#connect'].includes(window.location.hash))
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  // Elric lives in the person's own workspace, and only when the server has it.
  const [elricOn, setElricOn] = useState(false);
  useEffect(() => {
    if (kind === 'ai') return;
    let active = true;
    api('/api/elric')
      .then(() => active && setElricOn(true))
      .catch(() => active && setElricOn(false));
    return () => {
      active = false;
    };
  }, [kind]);
  const shownNavigation = navigation.filter((item) => item.id !== 'elric' || elricOn);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState('');
  const noticeTimer = useRef<number | undefined>(undefined);
  const { fresh, announcement } = useTransmutations(snapshot);
  const inboxes = useInboxSummary(true);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  function notify(message: string) {
    setNotice(message);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 6500);
  }
  async function action(key: string, fn: () => Promise<unknown>, message?: string) {
    if (busy) return;
    setBusy(key);
    setActionError('');
    try {
      await fn();
      await refresh();
      if (message) notify(message);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'That action could not be completed.');
    } finally {
      setBusy('');
    }
  }
  function changeView(next: View) {
    setView(next);
    setQuery('');
    setMobileNav(false);
  }
  const activeJobs =
    snapshot?.jobs.filter((job) => job.status === 'running' || job.status === 'queued') || [];
  const reviewJobs =
    snapshot?.jobs.filter((job) => job.status === 'completed' && job.acceptance !== 'accepted') ||
    [];
  const hasAgents = Boolean(snapshot?.agents.some((agent) => agent.status !== 'revoked'));
  const selected = snapshot?.agents.find((agent) => agent.id === selectedAgent);
  const agents =
    snapshot?.agents.filter((agent) =>
      `${agent.name} ${agent.description} ${agent.capability}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) || [];
  const nameOf = (id: string) => snapshot?.agents.find((agent) => agent.id === id)?.name || 'Agent';
  const maybeName = (id: string) => snapshot?.agents.find((agent) => agent.id === id)?.name;
  const openAgent = (id: string) => {
    setSelectedAgent(id);
    setDialog({ kind: 'agent', id });
  };
  const heading = headings[view];
  return (
    <div className="app-shell">
      <SkipLink />
      {mobileNav ? (
        <button
          className="nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      ) : null}
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <Lockup onClick={() => changeView('network')} label="Central City overview" />
        <div className="workspace-switch">
          <span className="workspace-avatar" aria-hidden="true">
            {operator.name.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{operator.name}</strong>
            <span>{kind === 'ai' ? 'AI workspace · you co-own it' : 'Private workspace'}</span>
          </div>
          <LockKeyhole size={13} aria-hidden="true" />
          {workspaces.length > 1 ? (
            <select
              className="workspace-select"
              aria-label="Switch workspace"
              value={operator.id}
              onChange={(event) => onSwitch(event.target.value)}
            >
              {workspaces.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.kind === 'ai' ? `${item.name} (AI workspace)` : `${item.name} (yours)`}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <p className="nav-label">Workspace</p>
        <nav aria-label="Workspace">
          <a
            className="nav-item"
            href="/rooms"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
              event.preventDefault();
              navigate('/rooms');
            }}
          >
            <DoorOpen size={18} strokeWidth={1.6} aria-hidden="true" />
            <span>Rooms</span>
          </a>
          {shownNavigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? 'active' : ''} ${item.id === 'connect' ? 'nav-connect' : ''}`}
              aria-current={view === item.id ? 'page' : undefined}
              aria-describedby={
                item.id === 'jobs' && activeJobs.length + reviewJobs.length
                  ? 'exchange-count'
                  : undefined
              }
              onClick={() => changeView(item.id)}
            >
              <item.icon size={18} strokeWidth={1.6} aria-hidden="true" />
              <span>{item.label}</span>
              {item.id === 'messages' && inboxes.total ? (
                <span className="nav-count" aria-label={`${inboxes.total} unread messages`}>
                  {inboxes.total}
                </span>
              ) : null}
              {item.id === 'jobs' && activeJobs.length + reviewJobs.length ? (
                <>
                  <span className="nav-count" aria-hidden="true">
                    {activeJobs.length + reviewJobs.length}
                  </span>
                  <span id="exchange-count" className="visually-hidden" aria-hidden="true">
                    {activeJobs.length} open, {reviewJobs.length} to review
                  </span>
                </>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <AgentGlyph agent={{ capability: 'research' }} />
          <h3>Work with your AI.</h3>
          <p>Invite it into a room, or add an agent of your own.</p>
          <a
            className="text-link"
            href={INVITE_ROOMS_PATH}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
              event.preventDefault();
              navigate(INVITE_ROOMS_PATH);
            }}
          >
            Invite your AI
            <ArrowUpRight size={14} />
          </a>
          <button className="text-link" onClick={() => setDialog({ kind: 'create' })}>
            Add an agent
            <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-account">
            <span>Theme</span>
            <ThemeToggle />
          </div>
          <button className="signout" disabled={refreshing} onClick={() => void refresh()}>
            <RefreshCw size={15} className={refreshing ? 'spin' : ''} aria-hidden="true" />
            Refresh
          </button>
          <button
            className="signout"
            disabled={Boolean(busy)}
            onClick={() =>
              void action('logout', async () => {
                await api('/api/auth/logout', {});
                // Cached conversations and the prefetch stay on this device otherwise.
                forgetMessagesState();
                onLogout();
              })
            }
          >
            <LogOut size={15} aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>
      <div className="workspace-content">
        <AppHeader
          title={navigation.find((item) => item.id === view)?.label ?? 'Workspace'}
          live={streamLive}
          onOpenNavigation={() => setMobileNav(true)}
        />
        <main id="main-content" tabIndex={-1} className="main-content">
          <div className="page-heading">
            <div>
              <p className="page-kicker">
                Central City / {kind === 'ai' ? 'AI workspace' : 'Private workspace'}
              </p>
              <h1>{heading.title}</h1>
              <p>{heading.lede}</p>
            </div>
            <div className="page-actions">
              {view === 'connections' ? (
                <button
                  className="button primary"
                  onClick={() => setDialog({ kind: 'connection' })}
                  disabled={!hasAgents}
                >
                  <Plus size={16} />
                  New connection
                </button>
              ) : view === 'jobs' ? (
                <button
                  className="button primary"
                  onClick={() => setDialog({ kind: 'job' })}
                  disabled={!hasAgents || snapshot?.paused}
                >
                  <Plus size={16} />
                  Send work
                </button>
              ) : view === 'collaborations' ||
                view === 'messages' ||
                view === 'assistants' ||
                view === 'elric' ||
                view === 'connect' ? null : (
                <>
                  <button className="button secondary" onClick={() => changeView('jobs')}>
                    <Scale size={16} />
                    Exchanges
                  </button>
                  <button className="button primary" onClick={() => setDialog({ kind: 'create' })}>
                    <Plus size={16} />
                    Add agent
                  </button>
                </>
              )}
            </div>
          </div>
          {error || actionError ? (
            <div className="error-banner" role="alert">
              <CircleHelp size={17} aria-hidden="true" />
              <span>{actionError || error}</span>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => {
                  setActionError('');
                  void refresh();
                }}
              >
                <X size={15} />
              </button>
            </div>
          ) : null}
          {snapshot?.paused ? (
            <div className="pause-banner">
              <Pause size={16} aria-hidden="true" />
              <span>
                <strong>Workspace paused.</strong> No new work starts. Agents on your own computers
                may keep running, but their results wait until you resume.
              </span>
              <button
                className="button secondary compact"
                onClick={() =>
                  void action(
                    'resume',
                    () => api('/api/workspace/pause', { paused: false }),
                    'Workspace resumed.',
                  )
                }
                disabled={Boolean(busy)}
              >
                Resume workspace
                <Play size={14} />
              </button>
            </div>
          ) : null}
          {view === 'connect' ? (
            <ConnectAI signedIn onOpenAgents={() => changeView('agents')} />
          ) : !snapshot ? (
            <div className="loading-panel" role="status">
              <LoaderCircle className="spin" />
              <p>Loading your agents…</p>
            </div>
          ) : (
            <>
              {view === 'network' ? (
                <>
                  <div className="stats-grid">
                    <Stat
                      label="Agents online"
                      value={snapshot.stats.reachable}
                      icon={<Radio size={17} />}
                      detail={`${snapshot.stats.registered} in your workspace`}
                    />
                    <Stat
                      label="Work in progress"
                      value={activeJobs.length}
                      icon={<Scale size={17} />}
                      detail={`${reviewJobs.length} waiting for your review`}
                    />
                    <Stat
                      label="Accepted results"
                      value={snapshot.stats.accepted}
                      icon={<CheckCheck size={17} />}
                      detail="Accepted by you, demos included"
                    />
                    <Stat
                      label="Connections"
                      value={snapshot.connections.length}
                      icon={<Link2 size={17} />}
                      detail="One-way routes you allowed"
                    />
                  </div>
                  <div className="network-layout">
                    <section className="panel network-panel" aria-labelledby="circle-title">
                      <div className="panel-heading">
                        <div className="panel-title">
                          <h2 id="circle-title">Agent map</h2>
                          <span className="small-tag">Private</span>
                        </div>
                        <div className="graph-tools">
                          <button
                            className="icon-button"
                            onClick={() => setDialog({ kind: 'connection' })}
                            disabled={!hasAgents}
                            aria-label="Add connection"
                          >
                            <Link2 size={16} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label="View all agents"
                            onClick={() => changeView('agents')}
                          >
                            <ArrowUpRight size={17} />
                          </button>
                        </div>
                      </div>
                      {snapshot.agents.some((agent) => !agent.revokedAt) ? (
                        <CityCircle
                          agents={snapshot.agents}
                          connections={snapshot.connections}
                          selectedId={selected?.id || null}
                          onSelect={openAgent}
                          fresh={fresh}
                          labels={(agent) => ({
                            name:
                              agent.name.length > 18 ? `${agent.name.slice(0, 17)}…` : agent.name,
                            detail: `${capabilityLabels[agent.capability]}${agent.isDemo ? ' · demo' : ''}`,
                            aria: `${agent.name}, ${agent.pausedAt ? 'paused' : agent.status}, ${capabilityLabels[agent.capability]}. ${creatorLabel(agent, maybeName)}. View agent.`,
                          })}
                        />
                      ) : (
                        <div className="graph-empty">
                          <CourtIllustration />
                          <p>Start with one agent.</p>
                          <span>Add an agent, connect your AI, or start the demo.</span>
                        </div>
                      )}
                      <div className="graph-legend">
                        <span>
                          <AgentGlyph agent={{ capability: 'research' }} size="small" /> Research
                        </span>
                        <span>
                          <AgentGlyph agent={{ capability: 'extract' }} size="small" /> Extraction
                        </span>
                        <span>
                          <AgentGlyph agent={{ capability: 'verify' }} size="small" /> Verification
                        </span>
                        <span>
                          <span className="legend-line" aria-hidden="true" />
                          Connection
                        </span>
                        <span className="graph-limit">
                          {snapshot.agents.filter((agent) => !agent.revokedAt).length > 24
                            ? 'First 24 agents shown'
                            : 'Inner rings: created by another agent · Seal: created by an AI'}
                        </span>
                      </div>
                      <div className="network-footer">
                        <span>
                          <ShieldCheck size={14} aria-hidden="true" />
                          Online means the agent checked in during the last 90 seconds.
                        </span>
                      </div>
                    </section>
                    <section className="panel activity-panel" aria-labelledby="activity-title">
                      <div className="panel-heading">
                        <div className="panel-title">
                          <Activity size={16} aria-hidden="true" />
                          <h2 id="activity-title">Recent activity</h2>
                        </div>
                      </div>
                      <EventList
                        snapshot={snapshot}
                        limit={5}
                        compact
                        onJob={(id) => setDialog({ kind: 'result', id })}
                      />
                      <div className="panel-bottom">
                        <TextLink onClick={() => changeView('activity')}>All activity</TextLink>
                      </div>
                    </section>
                  </div>
                  <div className="lower-layout">
                    <section className="panel roster-panel">
                      <SectionHeading
                        eyebrow="Agents"
                        title="Your agents"
                        action={<TextLink onClick={() => changeView('agents')}>View all</TextLink>}
                      />
                      {snapshot.agents.length ? (
                        <AgentRows
                          agents={snapshot.agents.slice(0, 4)}
                          onSelect={openAgent}
                          fresh={fresh}
                        />
                      ) : (
                        <div className="first-agents">
                          <div className="stacked-glyphs" aria-hidden="true">
                            <AgentGlyph agent={{ capability: 'research' }} />
                            <AgentGlyph agent={{ capability: 'extract' }} />
                            <AgentGlyph agent={{ capability: 'verify' }} />
                          </div>
                          <div>
                            <h3>Meet your first collaborators.</h3>
                            <p>Start three demo agents and watch a task move between them.</p>
                            <span className="field-note">Scripted demo. No AI model is used.</span>
                          </div>
                          <button
                            className="button secondary"
                            disabled={Boolean(busy)}
                            onClick={() =>
                              void action(
                                'demo',
                                () => api('/api/demo/start', {}),
                                'The three demo agents are ready. Send them some work to begin.',
                              )
                            }
                          >
                            <Play size={14} />
                            {busy === 'demo' ? 'Starting…' : 'Start the demo'}
                          </button>
                        </div>
                      )}
                    </section>
                    <section className="next-step-panel" aria-labelledby="next-step-title">
                      <p className="eyebrow">Next step</p>
                      <h2 id="next-step-title">Bring your AI in.</h2>
                      <p>
                        Connect ChatGPT, Claude, Cursor or Codex once. Your AI can join rooms, plan
                        teams and create agents; you make the decisions.
                      </p>
                      <button className="button primary" onClick={() => changeView('connect')}>
                        <Plug size={16} />
                        Connect your AI
                      </button>
                    </section>
                  </div>
                </>
              ) : null}
              {view === 'agents' ? (
                <section className="panel" aria-label="Agents">
                  <div className="list-toolbar">
                    <div className="filter-label">
                      <Layers3 size={16} aria-hidden="true" />
                      All agents<span>{snapshot.agents.length}</span>
                    </div>
                    <label className="search-field">
                      <Search size={16} aria-hidden="true" />
                      <input
                        aria-label="Search agents"
                        placeholder="Search agents…"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </label>
                  </div>
                  {agents.length ? (
                    <div className="agent-card-grid">
                      {agents.map((agent) => (
                        <AgentCard
                          key={agent.id}
                          agent={agent}
                          transmuting={fresh.has(agent.id)}
                          parentName={
                            agent.parentAgentId ? maybeName(agent.parentAgentId) : undefined
                          }
                          provenance={creatorLabel(agent, maybeName)}
                          onOpen={() => openAgent(agent.id)}
                        />
                      ))}
                    </div>
                  ) : (
                    <EmptyState title={query ? 'No matching agents' : 'Add your first agent'}>
                      {query
                        ? 'Try a different name or capability.'
                        : 'Start from a template, connect your AI, or run an agent on your own computer.'}
                    </EmptyState>
                  )}
                  <div className="list-panel-footer">
                    <span>Demo agents follow a script. No AI model is used.</span>
                    <button
                      className="text-link"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void action(
                          'demo',
                          () => api('/api/demo/start', {}),
                          'The demo agents are ready.',
                        )
                      }
                    >
                      Start the demo
                      <Play size={13} />
                    </button>
                  </div>
                  <ClaimAgents
                    busy={Boolean(busy)}
                    onClaim={(token) =>
                      token.startsWith('ccwclaim_')
                        ? action(
                            'claim',
                            async () => {
                              await api('/api/workspaces/claim', { claim_token: token });
                              onWorkspacesChanged();
                            },
                            'AI workspace claimed. You now co-own it; switch to it from the menu at the top left.',
                          )
                        : action(
                            'claim',
                            () => api('/api/agents/claim', { claim_token: token }),
                            'The agents are now in your workspace.',
                          )
                    }
                  />
                </section>
              ) : null}
              {view === 'collaborations' ? (
                <Workflows snapshot={snapshot} refresh={refresh} />
              ) : null}
              {view === 'messages' ? (
                <MessagesView
                  snapshot={snapshot}
                  unread={inboxes.unread}
                  onOpenAgent={openAgent}
                  onSummaryChanged={() => void inboxes.refresh()}
                />
              ) : null}
              {view === 'elric' && elricOn ? (
                <Suspense fallback={null}>
                  <ElricActivity />
                </Suspense>
              ) : null}
              {view === 'assistants' ? (
                <>
                  {kind === 'ai' ? <WorkspaceKeys workspaceName={operator.name} /> : null}
                  <AssistantAccess key={operator.id} onConnect={() => changeView('connect')} />
                </>
              ) : null}
              {view === 'connections' ? (
                <>
                  <section className="panel" aria-label="Connections">
                    <div className="list-toolbar">
                      <div className="filter-label">
                        <Link2 size={16} aria-hidden="true" />
                        Connections<span>{snapshot.connections.length}</span>
                      </div>
                      <span className="muted small">
                        A connection lets one agent send work to another. It shares no tools or
                        passwords.
                      </span>
                    </div>
                    {snapshot.connections.length ? (
                      <div className="connection-list">
                        {snapshot.connections.map((connection) => {
                          const from = snapshot.agents.find(
                            (agent) => agent.id === connection.fromAgentId,
                          );
                          const to = snapshot.agents.find(
                            (agent) => agent.id === connection.toAgentId,
                          );
                          return (
                            <div className="connection-row" key={connection.id}>
                              <div className="connection-path">
                                <span>
                                  {from ? <AgentGlyph agent={from} /> : null}
                                  <strong>{nameOf(connection.fromAgentId)}</strong>
                                </span>
                                <svg className="route-arc" viewBox="0 0 64 24" aria-hidden="true">
                                  <path d="M4 18 Q32 -2 58 16" />
                                  <path d="M52 11 L58 16 L51 19" />
                                </svg>
                                <span className="visually-hidden">sends work to</span>
                                <span>
                                  {to ? <AgentGlyph agent={to} /> : null}
                                  <strong>{nameOf(connection.toAgentId)}</strong>
                                </span>
                              </div>
                              <span className="connection-capability">
                                {to ? capabilityLabels[to.capability] : ''}
                              </span>
                              <div className="row-actions">
                                <button
                                  className="button secondary compact"
                                  disabled={snapshot.paused}
                                  onClick={() =>
                                    setDialog({ kind: 'job', connectionId: connection.id })
                                  }
                                >
                                  Send work
                                  <ArrowUpRight size={14} />
                                </button>
                                <button
                                  className="icon-button danger-text"
                                  disabled={Boolean(busy)}
                                  aria-label={`Remove connection from ${nameOf(connection.fromAgentId)} to ${nameOf(connection.toAgentId)}`}
                                  onClick={() =>
                                    void action(
                                      connection.id,
                                      () => api(`/api/connections/${connection.id}`, {}, 'DELETE'),
                                      'Connection removed. No new work can be sent this way.',
                                    )
                                  }
                                >
                                  <Unplug size={16} />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <EmptyState
                        icon={<Link2 size={25} />}
                        title="Connect two agents"
                        action={
                          <button
                            className="button primary"
                            disabled={!hasAgents}
                            onClick={() => setDialog({ kind: 'connection' })}
                          >
                            <Plus size={15} />
                            New connection
                          </button>
                        }
                      >
                        Choose which agent asks and which one does the work. Work only travels in
                        the direction you allow.
                      </EmptyState>
                    )}
                  </section>
                  <CrossWorkspaceConnections
                    agents={snapshot.agents}
                    onChanged={() => void refresh()}
                  />
                </>
              ) : null}
              {view === 'jobs' ? (
                <ExchangeLedger
                  snapshot={snapshot}
                  nameOf={nameOf}
                  onOpen={(id) => setDialog({ kind: 'result', id })}
                  empty={
                    <EmptyState
                      icon={<ExchangeCircle state="requested" />}
                      title="No exchanges yet"
                      action={
                        <button
                          className="button primary"
                          disabled={!hasAgents || snapshot.paused}
                          onClick={() => setDialog({ kind: 'job' })}
                        >
                          <Plus size={15} />
                          Send work
                        </button>
                      }
                    >
                      Send some text from one connected agent to another. Check what comes back,
                      then decide whether to accept it.
                    </EmptyState>
                  }
                />
              ) : null}
              {view === 'activity' ? (
                <section className="panel full-activity" aria-label="Activity">
                  <div className="list-toolbar">
                    <div className="filter-label">
                      <Activity size={16} aria-hidden="true" />
                      Activity<span>{snapshot.events.length}</span>
                    </div>
                    <span className="muted small">
                      The latest 100 events · only you can see them
                    </span>
                  </div>
                  <EventList
                    snapshot={snapshot}
                    onJob={(id) => setDialog({ kind: 'result', id })}
                  />
                </section>
              ) : null}
            </>
          )}
          {snapshot ? (
            <footer className="workspace-footer">
              <span>
                <CityMark small />
                Central City<span className="footer-slash">/</span>Workspace
              </span>
              <a href="/downtown">Downtown · Open Source</a>
              <button className="workspace-pause" onClick={() => setDialog({ kind: 'export' })}>
                <Download size={13} /> Export workspace
              </button>
              <button
                className={`workspace-pause ${snapshot.paused ? 'is-paused' : ''}`}
                disabled={Boolean(busy)}
                onClick={() =>
                  void action(
                    'pause',
                    () => api('/api/workspace/pause', { paused: !snapshot.paused }),
                    snapshot.paused
                      ? 'Workspace resumed.'
                      : 'Workspace paused. No new work starts until you resume.',
                  )
                }
              >
                <span className="status-dot" aria-hidden="true" />
                {snapshot.paused ? 'Workspace paused' : 'Workspace running'}
                {snapshot.paused ? <Play size={12} /> : <Pause size={12} />}
              </button>
            </footer>
          ) : null}
        </main>
      </div>
      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
      <div className="toast-region" aria-live="polite" aria-atomic="true">
        {notice ? (
          <div className="toast">
            <Check size={17} aria-hidden="true" />
            <span>{notice}</span>
            <button
              className="icon-button"
              onClick={() => setNotice('')}
              aria-label="Dismiss notification"
            >
              <X size={15} />
            </button>
          </div>
        ) : null}
      </div>
      {dialog?.kind === 'export' ? (
        <ExportWorkspace onClose={() => setDialog(null)} operatorId={operator.id} />
      ) : dialog && snapshot ? (
        <Dialogs
          dialog={dialog}
          snapshot={snapshot}
          setDialog={setDialog}
          onChanged={async (message) => {
            await refresh();
            if (message) notify(message);
          }}
        />
      ) : null}
    </div>
  );
}

function ExportWorkspace({ onClose, operatorId }: { onClose: () => void; operatorId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [downloaded, setDownloaded] = useState(false);
  async function download() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const data = await api<WorkspaceExport>('/api/workspace/export');
      if (data.operator.id !== operatorId)
        throw new Error('You signed in as someone else. Reload the page.');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `central-city-workspace-${data.exportedAt.slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The export could not be downloaded.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Download your workspace."
      subtitle="A private copy of your records, as one file."
      onClose={onClose}
    >
      <div className="export-content">
        <p>The file contains your agents, connections, exchanges, results and activity.</p>
        <div className="info-note">
          It includes up to 1,000 exchanges and 1,000 activity events. What you sent and got back
          may contain private information, so keep the file somewhere safe.
        </div>
        <p className="muted small">
          Passwords and access tokens are never included. The file is for your records; it can't be
          imported back. Downloading deletes nothing.
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {downloaded ? <p role="status">Your download has started.</p> : null}
        <button className="button primary" onClick={() => void download()} disabled={busy}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
          {busy ? 'Preparing your file…' : 'Download'}
        </button>
      </div>
    </Modal>
  );
}

interface ClaimPreview {
  workspace: { name: string; agents: number };
  active_keys: Array<{ label: string; scopes: string[]; primary: boolean }>;
}
/** The one-time code inside a claim link (#claim=…). */
const CLAIM_CODE = /ccw?claim_[A-Za-z0-9_-]{43}/;

/** Claims agents an AI created without an account, from the claim link it gave the person. */
function ClaimAgents({
  busy,
  onClaim,
}: {
  busy: boolean;
  onClaim: (token: string) => Promise<void>;
}) {
  const [token, setToken] = useState(
    () => /^#claim=(ccw?claim_[A-Za-z0-9_-]{43})$/.exec(window.location.hash)?.[1] ?? '',
  );
  useEffect(() => {
    // Keep the one-time token out of the address bar and history once it has been read.
    if (window.location.hash.startsWith('#claim='))
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);
  const [preview, setPreview] = useState<{ token: string; data: ClaimPreview } | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [previewError, setPreviewError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    // People paste the whole claim link their AI gave them; the one-time code is inside it.
    const value = codeFromPaste(token, CLAIM_CODE);
    if (!value) return;
    // An AI workspace is claimed only after the person has seen which AI keys keep access.
    // The preview is bound to the exact token it was fetched for; a late response for an
    // earlier token is dropped, so a person never confirms a claim they have not previewed.
    if (value.startsWith('ccwclaim_') && preview?.token !== value) {
      setPreviewError('');
      try {
        const data = await api<ClaimPreview>('/api/workspaces/claim/preview', {
          claim_token: value,
        });
        if (codeFromPaste(tokenRef.current, CLAIM_CODE) === value)
          setPreview({ token: value, data });
      } catch (err) {
        setPreviewError(
          err instanceof Error ? err.message : 'This claim link could not be checked.',
        );
      }
      return;
    }
    await onClaim(value);
    setToken('');
    setPreview(null);
  }
  return (
    <form className="claim-form" onSubmit={(event) => void submit(event)}>
      <ExchangeCircle state={token ? 'review' : 'requested'} size="small" />
      <div className="claim-fields">
        <label htmlFor="claim-token">Claim agents your AI created</label>
        <div className="claim-row">
          <input
            id="claim-token"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the claim link your AI gave you"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              setPreview(null);
            }}
          />
          <button className="button primary compact" type="submit" disabled={busy || !token.trim()}>
            {preview && preview.token === codeFromPaste(token, CLAIM_CODE)
              ? 'Confirm claim'
              : 'Claim'}
          </button>
        </div>
        {previewError ? (
          <p className="form-error" role="alert">
            {previewError}
          </p>
        ) : null}
        {preview && preview.token === codeFromPaste(token, CLAIM_CODE) ? (
          <div className="claim-preview" role="status">
            <strong>
              {preview.data.workspace.name}: an AI workspace with {preview.data.workspace.agents}{' '}
              agent
              {preview.data.workspace.agents === 1 ? '' : 's'}
            </strong>
            <p>
              These AIs keep their access after you claim it. Once you co-own it, remove any you
              don't trust under AI connections:
            </p>
            <ul>
              {preview.data.active_keys.map((key, index) => (
                <li key={index}>
                  {key.label}
                  {key.primary ? ' (main key)' : ''} · {key.scopes.map(permissionLabel).join(', ')}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <span className="muted small">
          Moves the agents, their connections and history into this workspace. A claim link for a
          whole AI workspace makes you its co-owner instead. Each link works once.
        </span>
      </div>
    </form>
  );
}

function Stat({
  label,
  value,
  icon,
  detail,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  detail: string;
}) {
  return (
    <div className="stat">
      <div className="stat-top">
        <span>{label}</span>
        <span aria-hidden="true">{icon}</span>
      </div>
      <strong>{value.toString().padStart(2, '0')}</strong>
      <p>{detail}</p>
    </div>
  );
}

/** The ring drawn over a new agent's card before it resolves into the card. */
function TransmuteRing({ capability }: { capability: Capability }) {
  const sides = capabilityFigure[capability];
  return (
    <svg className="transmute-ring" viewBox="-50 -50 100 100" aria-hidden="true">
      <circle r="46" pathLength={1} />
      <circle r="38" pathLength={1} className="inner" />
      <polygon
        pathLength={1}
        points={
          sides === 'triangle'
            ? '0,-38 32.9,19 -32.9,19'
            : sides === 'square'
              ? '26.9,-26.9 26.9,26.9 -26.9,26.9 -26.9,-26.9'
              : '0,-38 32.9,-19 32.9,19 0,38 -32.9,19 -32.9,-19'
        }
      />
    </svg>
  );
}

function AgentCard({
  agent,
  transmuting,
  parentName,
  provenance,
  onOpen,
}: {
  agent: Agent;
  transmuting: boolean;
  parentName?: string;
  provenance: string;
  onOpen: () => void;
}) {
  const depth = lineageDepth(agent);
  return (
    <button className={`agent-card ${transmuting ? 'transmuting' : ''}`} onClick={onOpen}>
      {transmuting ? <TransmuteRing capability={agent.capability} /> : null}
      <div className="agent-card-top">
        <AgentGlyph agent={agent} size="large" transmuting={transmuting} />
        <ArrowUpRight size={17} aria-hidden="true" />
      </div>
      <h3>{agent.name}</h3>
      <p>{agent.description || `${capabilityLabels[agent.capability]} specialist`}</p>
      <div className="agent-card-tags">
        <span className="small-tag">{capabilityLabels[agent.capability]}</span>
        {agent.isDemo ? (
          <span className="small-tag demo">Demo</span>
        ) : (
          <span className="small-tag">Your own</span>
        )}
        {aiCreated(agent) ? <span className="small-tag ai">AI-created</span> : null}
        {agent.pausedAt ? <span className="small-tag">Paused</span> : null}
      </div>
      <dl className="lineage">
        <div>
          <dt>Created</dt>
          <dd>{provenance}</dd>
        </div>
        {agent.parentAgentId ? (
          <div>
            <dt>Under</dt>
            <dd>
              {parentName ?? 'An agent not listed here'} · level {depth}
            </dd>
          </div>
        ) : null}
        {agent.claimedAt ? (
          <div>
            <dt>Claimed</dt>
            <dd>{formatDate(agent.claimedAt)}</dd>
          </div>
        ) : null}
      </dl>
      <div className="agent-card-footer">
        <Status value={agent.pausedAt ? 'paused' : agent.status} />
        <span>{agent.lastSeenAt ? `Seen ${formatTime(agent.lastSeenAt)}` : 'Not seen yet'}</span>
      </div>
    </button>
  );
}

function AgentRows({
  agents,
  onSelect,
  fresh,
}: {
  agents: Agent[];
  onSelect: (id: string) => void;
  fresh: Set<string>;
}) {
  return (
    <div className="agent-rows">
      {agents.map((agent) => (
        <button key={agent.id} className="agent-row" onClick={() => onSelect(agent.id)}>
          <AgentGlyph agent={agent} transmuting={fresh.has(agent.id)} />
          <span className="agent-row-name">
            <strong>{agent.name}</strong>
            <span>{capabilityLabels[agent.capability]}</span>
          </span>
          {agent.isDemo ? (
            <span className="small-tag demo">Demo</span>
          ) : aiCreated(agent) ? (
            <span className="small-tag ai">AI-created</span>
          ) : (
            <span className="small-tag">Your own</span>
          )}
          <Status value={agent.pausedAt ? 'paused' : agent.status} />
          <ArrowUpRight size={16} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

function returnedSummary(job: Job) {
  if (job.acceptance === 'accepted') return 'Result accepted';
  if (job.status === 'completed') return job.output ? 'Result ready' : 'Done';
  if (job.status === 'failed') return job.error ?? 'No result';
  if (job.status === 'canceled') return 'Nothing returned';
  if (job.status === 'running') return 'In progress';
  return 'Not yet';
}

const ledgerStates: ExchangeState[] = [
  'requested',
  'in_progress',
  'review',
  'accepted',
  'failed',
  'canceled',
];

function ExchangeLedger({
  snapshot,
  nameOf,
  onOpen,
  empty,
}: {
  snapshot: Snapshot;
  nameOf: (id: string) => string;
  onOpen: (id: string) => void;
  empty: ReactNode;
}) {
  return (
    <section className="panel ledger" aria-label="Exchanges">
      <div className="list-toolbar">
        <div className="filter-label">
          <Scale size={16} aria-hidden="true" />
          Exchanges<span>{snapshot.jobs.length}</span>
        </div>
        <span className="small muted">The latest 50 · a finished result still needs your OK</span>
      </div>
      <ul className="ledger-legend" aria-label="What each state means">
        {ledgerStates.map((state) => (
          <li key={state}>
            <ExchangeCircle state={state} size="small" />
            {exchangeLabels[state]}
          </li>
        ))}
      </ul>
      {snapshot.jobs.length ? (
        <div className="ledger-list">
          <div className="ledger-head" aria-hidden="true">
            <span />
            <span>Sent</span>
            <span>Came back</span>
            <span>State</span>
            <span>Started</span>
          </div>
          {snapshot.jobs.map((job) => {
            const state = jobExchangeState(job);
            return (
              <button
                className={`exchange-row state-${state}`}
                key={job.id}
                onClick={() => onOpen(job.id)}
              >
                <ExchangeCircle state={state} size="small" />
                <span className="exchange-side given">
                  <strong>
                    {job.input.slice(0, 75)}
                    {job.input.length > 75 ? '…' : ''}
                  </strong>
                  <span>
                    {nameOf(job.requesterId)} · {budgetLabel(job)}
                    {job.isDemo ? <span className="small-tag demo">Demo</span> : null}
                  </span>
                </span>
                <span className="exchange-side returned">
                  <strong>{returnedSummary(job)}</strong>
                  <span>{nameOf(job.providerId)}</span>
                </span>
                <span className={`exchange-state state-${state}`}>{exchangeLabels[state]}</span>
                <span className="job-row-time">{formatDate(job.createdAt)}</span>
              </button>
            );
          })}
        </div>
      ) : (
        empty
      )}
    </section>
  );
}

function EventList({
  snapshot,
  limit,
  compact = false,
  onJob,
}: {
  snapshot: Snapshot;
  limit?: number;
  compact?: boolean;
  onJob: (id: string) => void;
}) {
  const events = limit ? snapshot.events.slice(0, limit) : snapshot.events;
  if (!events.length)
    return (
      <div className="activity-empty">
        <Radio size={25} strokeWidth={1.3} aria-hidden="true" />
        <h3>Nothing yet.</h3>
        <p>New agents, connections and work will appear here as they happen.</p>
      </div>
    );
  return (
    <ol className={`event-list ${compact ? 'compact' : ''}`}>
      {events.map((event) => (
        <li key={event.id}>
          <span
            className={`event-icon ${event.type.includes('job') ? 'exchange' : ''}`}
            aria-hidden="true"
          >
            {event.type.includes('job') ? (
              <Scale size={14} />
            ) : event.type.includes('connection') ? (
              <Link2 size={14} />
            ) : event.type.includes('agent') ? (
              <Layers3 size={14} />
            ) : (
              <Activity size={14} />
            )}
          </span>
          <div className="event-content">
            <p>
              {event.jobId && snapshot.jobs.some((job) => job.id === event.jobId) ? (
                <button onClick={() => onJob(event.jobId!)}>{plainEvent(event.message)}</button>
              ) : (
                plainEvent(event.message)
              )}
            </p>
            <span>
              {formatTime(event.createdAt)}
              <span className="event-type">{eventTypeLabel(event.type)}</span>
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Dialogs({
  dialog,
  snapshot,
  setDialog,
  onChanged,
}: {
  dialog: Exclude<Dialog, null | { kind: 'export' }>;
  snapshot: Snapshot;
  setDialog: (dialog: Dialog) => void;
  onChanged: (message?: string) => Promise<void>;
}) {
  const close = () => setDialog(null);
  if (dialog.kind === 'create')
    return (
      <CreateAgent
        onClose={close}
        onCreate={async (agent, token) => {
          await onChanged(`${agent.name} added to your workspace.`);
          setDialog(token ? { kind: 'token', agent, token } : { kind: 'agent', id: agent.id });
        }}
      />
    );
  if (dialog.kind === 'token')
    return (
      <Modal
        title={
          dialog.rotated
            ? `${dialog.agent.name} has a new access token.`
            : `${dialog.agent.name} is added.`
        }
        subtitle="Save its access token now. It is shown only once."
        onClose={close}
      >
        <div className="token-content">
          <div className="credential-box">
            <label htmlFor="connector-token">Access token</label>
            <textarea
              id="connector-token"
              readOnly
              value={dialog.token}
              spellCheck={false}
              autoComplete="off"
            />
            <CopyButton value={dialog.token} label="Copy token" />
          </div>
          <p className="field-note">
            Anyone with this token can act as this agent. Keep it private and never paste it into a
            chat. You can replace it later in the agent's settings; the agent stays the same.
          </p>
          {dialog.rotated ? (
            <div className="info-note">
              <ShieldCheck size={18} />
              <p>
                The old token no longer works. Put the new one in your agent's setup and restart it.
                Unfinished work for this agent was canceled; its connections and history remain.
              </p>
            </div>
          ) : null}
          {!['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) ? (
            <p className="field-note">
              The setup below is for a copy of Central City running on your own computer. It does
              not connect to centralcity.ai.
            </p>
          ) : null}
          <details className="setup-details">
            <summary>Developer setup</summary>
            <div className="setup-step">
              <span>01</span>
              <div>
                <strong>Start your connector</strong>
                <p>
                  Save the configuration below to .local/my-agent.json in the application directory.
                  Keep the file private, then run this command.
                </p>
                <code>pnpm connector connect .local/my-agent.json</code>
                <label className="connector-config-label" htmlFor="connector-config">
                  Private connector configuration
                </label>
                <textarea
                  id="connector-config"
                  className="connector-config"
                  readOnly
                  spellCheck={false}
                  value={JSON.stringify(
                    {
                      baseUrl: window.location.origin,
                      token: dialog.token,
                      sequenceFile: './my-agent.sequence',
                    },
                    null,
                    2,
                  )}
                />
                <CopyButton
                  value={JSON.stringify(
                    {
                      baseUrl: window.location.origin,
                      token: dialog.token,
                      sequenceFile: './my-agent.sequence',
                    },
                    null,
                    2,
                  )}
                  label="Copy configuration"
                />
              </div>
            </div>
            <div className="setup-step">
              <span>02</span>
              <div>
                <strong>Wait until it shows as online</strong>
                <p>
                  The agent shows as online once it signs in with its token. Keep the connector
                  running so it can take work.
                </p>
              </div>
            </div>
            <div className="detail-pair">
              <span>Agent ID</span>
              <code>{dialog.agent.id}</code>
            </div>
          </details>
          <button className="button primary full" onClick={close}>
            I have saved the token
            <ArrowRight size={15} />
          </button>
        </div>
      </Modal>
    );
  if (dialog.kind === 'connection')
    return (
      <ConnectionForm
        snapshot={snapshot}
        onClose={close}
        onCreated={async () => {
          await onChanged('Connection created.');
          close();
        }}
      />
    );
  if (dialog.kind === 'job')
    return (
      <JobForm
        snapshot={snapshot}
        connectionId={dialog.connectionId}
        onClose={close}
        onCreated={async (job) => {
          await onChanged('Work sent. Follow its progress here.');
          setDialog({ kind: 'result', id: job.id });
        }}
      />
    );
  if (dialog.kind === 'agent') {
    const agent = snapshot.agents.find((item) => item.id === dialog.id);
    return agent ? (
      <AgentDetail
        key={agent.id}
        agent={agent}
        snapshot={snapshot}
        onClose={close}
        onChanged={onChanged}
        onRotated={async (updatedAgent, token) => {
          setDialog({ kind: 'token', agent: updatedAgent, token, rotated: true });
          await onChanged(
            `${updatedAgent.name} has a new access token. Reconnect it with the new token.`,
          );
        }}
      />
    ) : null;
  }
  const job = snapshot.jobs.find((item) => item.id === dialog.id);
  return job ? (
    <JobDetail key={job.id} job={job} snapshot={snapshot} onClose={close} onChanged={onChanged} />
  ) : (
    <Modal title="This exchange is no longer listed" onClose={close}>
      <p className="modal-body">
        Only the latest 50 exchanges are listed here. Refresh to see the latest activity.
      </p>
    </Modal>
  );
}

function CreateAgent({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (agent: Agent, token?: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'hosted' | 'external'>('hosted');
  const [capability, setCapability] = useState<Capability>('research');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ agent: Agent; token?: string }>('/api/agents', {
        name: name.trim(),
        description: description.trim(),
        capability,
        mode,
      });
      await onCreate(result.agent, result.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The agent couldn't be added.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Add an agent."
      subtitle="Start from a template, or connect an agent you run yourself."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="form-stack modal-body" onSubmit={submit}>
        <div className="mode-picker">
          <button
            disabled={busy}
            type="button"
            className={mode === 'hosted' ? 'selected' : ''}
            aria-pressed={mode === 'hosted'}
            onClick={() => setMode('hosted')}
          >
            <Sparkles size={21} />
            <strong>Use a template</strong>
            <span>A free demo that runs here</span>
          </button>
          <button
            disabled={busy}
            type="button"
            className={mode === 'external' ? 'selected' : ''}
            aria-pressed={mode === 'external'}
            onClick={() => setMode('external')}
          >
            <Terminal size={21} />
            <strong>Connect your own</strong>
            <span>Runs on your computer or server</span>
          </button>
        </div>
        <label>
          Agent name
          <input
            autoComplete="off"
            required
            minLength={2}
            maxLength={64}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
            placeholder="e.g. Scout"
          />
        </label>
        <label>
          Description <span className="optional">optional</span>
          <input
            maxLength={300}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={busy}
            placeholder="What does this agent help with?"
          />
        </label>
        <fieldset className="capability-fieldset">
          <legend>What it does</legend>
          <div className="capability-picker">
            {(['research', 'extract', 'verify'] as const).map((value) => {
              return (
                <label key={value} className={capability === value ? 'selected' : ''}>
                  <input
                    disabled={busy}
                    type="radio"
                    name="capability"
                    value={value}
                    checked={capability === value}
                    onChange={() => setCapability(value)}
                  />
                  <AgentGlyph agent={{ capability: value }} size="small" />
                  <strong>{capabilityLabels[value]}</strong>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="info-note">
          <CircleHelp size={17} />
          <p>
            {mode === 'hosted'
              ? 'Template agents show research, extraction or checking on text you give them. They follow a script; no AI model is used.'
              : "You'll get an access token once. The agent can take work as soon as it's running and signed in with that token."}
          </p>
        </div>
        <FormError error={error} />
        <button className="button primary large" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
          {mode === 'hosted' ? 'Add template agent' : 'Add your agent'}
        </button>
      </form>
    </Modal>
  );
}

function ConnectionForm({
  snapshot,
  onClose,
  onCreated,
}: {
  snapshot: Snapshot;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const candidates = snapshot.agents.filter((agent) => !agent.revokedAt);
  const [from, setFrom] = useState(candidates[0]?.id || '');
  const [to, setTo] = useState(candidates[1]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/connections', { fromAgentId: from, toAgentId: to });
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "These agents couldn't be connected.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Create a connection."
      subtitle="Give one agent permission to send work to another."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="form-stack modal-body" onSubmit={submit}>
        {candidates.length < 2 ? (
          <div className="info-note">
            <CircleHelp size={18} />
            <p>Add at least two agents to create a connection.</p>
          </div>
        ) : null}
        <label>
          From · asks for the work
          <select
            disabled={busy}
            required
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              if (to === event.target.value) setTo('');
            }}
          >
            <option value="" disabled>
              Choose an agent
            </option>
            {candidates.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} · {capabilityLabels[agent.capability]}
              </option>
            ))}
          </select>
        </label>
        <div className="form-route-arrow">
          <ArrowDownLeft size={21} />
          One way only
        </div>
        <label>
          To · does the work
          <select
            disabled={busy}
            required
            value={to}
            onChange={(event) => setTo(event.target.value)}
          >
            <option value="" disabled>
              Choose an agent
            </option>
            {candidates
              .filter((agent) => agent.id !== from)
              .map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {capabilityLabels[agent.capability]}
                </option>
              ))}
          </select>
        </label>
        <div className="info-note">
          <ShieldCheck size={18} />
          <p>
            The first agent may send work to the second. No passwords or tools are shared. You can
            remove the connection at any time.
          </p>
        </div>
        <FormError error={error} />
        <button
          className="button primary large"
          disabled={busy || candidates.length < 2 || !from || !to}
        >
          <Link2 size={16} />
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </Modal>
  );
}

function JobForm({
  snapshot,
  connectionId,
  onClose,
  onCreated,
}: {
  snapshot: Snapshot;
  connectionId?: string;
  onClose: () => void;
  onCreated: (job: Job) => Promise<void>;
}) {
  const candidates = snapshot.connections.filter((connection) =>
    [connection.fromAgentId, connection.toAgentId].every((id) =>
      snapshot.agents.some(
        (agent) => agent.id === id && (agent.status === 'online' || agent.status === 'working'),
      ),
    ),
  );
  const [route, setRoute] = useState(connectionId || candidates[0]?.id || '');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  const connection = candidates.find((item) => item.id === route);
  const provider = snapshot.agents.find((agent) => agent.id === connection?.toAgentId);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!connection) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ job: Job }>('/api/jobs', {
        requesterId: connection.fromAgentId,
        providerId: connection.toAgentId,
        input: input.trim(),
        idempotencyKey: key.current,
      });
      await onCreated(result.job);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The work couldn't be sent.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Send work."
      subtitle="Give a connected agent some text to work on."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="form-stack modal-body" onSubmit={submit}>
        <label>
          Connection
          <select
            disabled={busy}
            required
            value={route}
            onChange={(event) => {
              setRoute(event.target.value);
              key.current = crypto.randomUUID();
            }}
          >
            <option value="" disabled>
              Choose a connection
            </option>
            {candidates.map((item) => (
              <option key={item.id} value={item.id}>
                {snapshot.agents.find((agent) => agent.id === item.fromAgentId)?.name} →{' '}
                {snapshot.agents.find((agent) => agent.id === item.toAgentId)?.name}
              </option>
            ))}
          </select>
        </label>
        {!candidates.length ? (
          <div className="info-note">
            <CircleHelp size={18} />
            <p>
              You need two online agents and a connection between them. Start the demo, or connect
              your own agents first.
            </p>
          </div>
        ) : null}
        {provider ? (
          <div className="provider-preview">
            <AgentGlyph agent={provider} />
            <div>
              <strong>{provider.name}</strong>
              <span>
                {capabilityLabels[provider.capability]}
                {provider.isDemo ? ' · demo' : ' · runs on your computer'}
              </span>
            </div>
            <Status value={provider.status} />
          </div>
        ) : null}
        <label>
          Text to work on
          <textarea
            disabled={busy}
            required
            maxLength={12000}
            rows={7}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              key.current = crypto.randomUUID();
            }}
            placeholder="Paste the text you want this agent to work with…"
          />
        </label>
        <div className="sample-input-row">
          <span>No text at hand?</span>
          <button
            type="button"
            className="text-link"
            disabled={busy}
            onClick={() => {
              setInput(
                'Project: Sample observatory\nMilestone: 12 sources indexed\nSource: https://example.com/sample',
              );
              key.current = crypto.randomUUID();
            }}
          >
            Use sample text
            <Sparkles size={13} />
          </button>
        </div>
        <div className="field-counter">
          <span>Only share text you're allowed to share.</span>
          <span>{input.length.toLocaleString()} / 12,000</span>
        </div>
        <div className="info-note">
          <ShieldCheck size={17} />
          <p>
            {provider?.mode === 'external'
              ? 'Review the result before accepting it. Your agent runs on your own computer, so any costs are yours; Central City never moves money.'
              : 'Review the result before accepting it. Demo agents are free: no AI model, no tools, no payments.'}
          </p>
        </div>
        <FormError error={error} />
        <button
          className="button primary large"
          disabled={busy || !connection || snapshot.paused || !input.trim()}
        >
          {busy ? <LoaderCircle className="spin" size={16} /> : <ArrowUpRight size={16} />}
          {snapshot.paused ? 'Workspace is paused' : busy ? 'Sending…' : 'Send work'}
        </button>
      </form>
    </Modal>
  );
}

function AgentDetail({
  agent,
  snapshot,
  onClose,
  onChanged,
  onRotated,
}: {
  agent: Agent;
  snapshot: Snapshot;
  onClose: () => void;
  onChanged: (message?: string) => Promise<void>;
  onRotated: (agent: Agent, token: string) => Promise<void>;
}) {
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connections = snapshot.connections.filter(
    (item) => item.fromAgentId === agent.id || item.toAgentId === agent.id,
  );
  async function revoke() {
    if (!confirmRevoke) {
      setConfirmRotate(false);
      setConfirmRevoke(true);
      return;
    }
    setBusy(true);
    try {
      await api(`/api/agents/${agent.id}/revoke`, {});
      await onChanged(`${agent.name} was removed.`);
      setConfirmRevoke(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The agent couldn't be removed.");
    } finally {
      setBusy(false);
    }
  }
  async function rotate() {
    if (!confirmRotate) {
      setConfirmRevoke(false);
      setConfirmRotate(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api<{ agent: Agent; token: string }>(
        `/api/agents/${agent.id}/rotate-credential`,
        {},
      );
      await onRotated(result.agent, result.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "A new token couldn't be created.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={agent.name}
      subtitle={agent.description || `${capabilityLabels[agent.capability]} specialist`}
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="modal-body detail-body">
        <div className="detail-agent-header">
          <AgentGlyph agent={agent} size="large" />
          <Status value={agent.pausedAt ? 'paused' : agent.status} />
          <span className={`small-tag ${agent.isDemo ? 'demo' : ''}`}>
            {agent.isDemo ? 'Demo' : 'Runs on your computer'}
          </span>
          {aiCreated(agent) ? <span className="small-tag ai">AI-created</span> : null}
        </div>
        <dl className="detail-list lineage-list">
          <div>
            <dt>Origin</dt>
            <dd>
              {creatorLabel(agent, (id) => snapshot.agents.find((item) => item.id === id)?.name)}
            </dd>
          </div>
          <div>
            <dt>Created under</dt>
            <dd>
              {agent.parentAgentId
                ? `${snapshot.agents.find((item) => item.id === agent.parentAgentId)?.name ?? 'an agent not listed here'} (level ${lineageDepth(agent)})`
                : 'No other agent'}
            </dd>
          </div>
          {agent.claimedAt ? (
            <div>
              <dt>Claimed into this workspace</dt>
              <dd>{formatDate(agent.claimedAt)}</dd>
            </div>
          ) : null}
          {agent.manifestName ? (
            <div>
              <dt>Template</dt>
              <dd>
                {agent.manifestName} · version {agent.revision ?? 1} ·{' '}
                <a
                  className="text-link"
                  href={`/a2a/${agent.id}/.well-known/agent-card.json`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Public profile
                </a>
              </dd>
            </div>
          ) : null}
        </dl>
        <dl className="detail-list">
          <div>
            <dt>What it does</dt>
            <dd>{capabilityLabels[agent.capability]}</dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>{agent.lastSeenAt ? formatDate(agent.lastSeenAt) : 'Not yet'}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatDate(agent.createdAt)}</dd>
          </div>
          <div>
            <dt>Connections</dt>
            <dd>{connections.length}</dd>
          </div>
        </dl>
        <details className="setup-details">
          <summary>Agent ID, for developers</summary>
          <p className="mono break">{agent.id}</p>
        </details>
        {agent.isDemo ? (
          <div className="info-note">
            <Sparkles size={18} />
            <p>
              This demo agent works on the text you give it. It follows a script; no AI model is
              used.
            </p>
          </div>
        ) : (
          <div className="info-note">
            <Radio size={18} />
            <p>
              Online means the agent checked in recently. It says nothing about the quality of its
              answers.
            </p>
          </div>
        )}
        <AgentInbox agent={agent} snapshot={snapshot} />
        {/* Owner-only Auto-reply; renders nothing unless the server offers it. */}
        <AutoReplySection agent={agent} />
        <FormError error={error} />
        {agent.revokedAt ? (
          <div className="info-note danger">
            <Unplug size={17} />
            <p>This agent was removed. It can't reconnect.</p>
          </div>
        ) : (
          <div className="revoke-section">
            <h3>Agent access</h3>
            {agent.mode === 'external' ? (
              <>
                <p>Replace the access token if it may have leaked. The agent stays the same.</p>
                {confirmRotate ? (
                  <p className="danger-text">
                    Stop the agent first. The old token stops working at once and unfinished work
                    for this agent is canceled.
                  </p>
                ) : null}
                <button className="button secondary" disabled={busy} onClick={() => void rotate()}>
                  <RefreshCw size={15} />
                  {confirmRotate ? 'Yes, replace the token' : 'Replace token'}
                </button>
                {confirmRotate ? (
                  <button
                    className="button ghost"
                    disabled={busy}
                    onClick={() => setConfirmRotate(false)}
                  >
                    Keep current token
                  </button>
                ) : null}
              </>
            ) : null}
            <p>Removing the agent ends its access and stops all future work.</p>
            {confirmRevoke ? (
              <p className="danger-text">
                This can't be undone. You would need to add a new agent.
              </p>
            ) : null}
            <button className="button danger" disabled={busy} onClick={() => void revoke()}>
              <Unplug size={15} />
              {confirmRevoke ? 'Yes, remove it' : 'Remove agent'}
            </button>
            {confirmRevoke ? (
              <button
                className="button ghost"
                disabled={busy}
                onClick={() => setConfirmRevoke(false)}
              >
                Keep agent
              </button>
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  );
}

function JobDetail({
  job,
  snapshot,
  onClose,
  onChanged,
}: {
  job: Job;
  snapshot: Snapshot;
  onClose: () => void;
  onChanged: (message?: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requester = snapshot.agents.find((agent) => agent.id === job.requesterId);
  const provider = snapshot.agents.find((agent) => agent.id === job.providerId);
  const state = jobExchangeState(job);
  async function mutate(kind: 'accept' | 'cancel') {
    setBusy(true);
    setError('');
    try {
      await api(`/api/jobs/${job.id}/${kind}`, {});
      await onChanged(
        kind === 'accept' ? 'Result accepted. Your decision is recorded.' : 'Work canceled.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Exchange"
      subtitle={`${requester?.name || 'An agent'} → ${provider?.name || 'another agent'}`}
      onClose={onClose}
      wide
    >
      <div className="modal-body detail-body">
        <div className="job-detail-status">
          <ExchangeCircle state={state} size="large" label={`Exchange ${exchangeLabels[state]}`} />
          <div>
            <span className={`exchange-state state-${state}`}>{exchangeLabels[state]}</span>
            <div className="job-detail-tags">
              {job.isDemo ? (
                <span className="small-tag demo">Demo</span>
              ) : (
                <span className="small-tag">Your own agent</span>
              )}
              <span className="muted small">Started {formatDate(job.createdAt)}</span>
            </div>
          </div>
        </div>
        <ol className="job-stages" aria-label="Progress">
          <li className="done">
            <Check size={14} aria-hidden="true" />
            Requested
          </li>
          <li className={job.status === 'completed' ? 'done' : ''}>
            {job.status === 'completed' ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <CircleHelp size={14} aria-hidden="true" />
            )}
            Work done
          </li>
          <li className={job.acceptance === 'accepted' ? 'done' : ''}>
            {job.acceptance === 'accepted' ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <CircleHelp size={14} aria-hidden="true" />
            )}
            You accepted
          </li>
        </ol>
        <div className="exchange-grid">
          <section className="exchange-panel given" aria-labelledby="given-title">
            <header>
              <span className="eyebrow">Sent</span>
              <h3 id="given-title">
                {requester ? <AgentGlyph agent={requester} size="small" /> : null}
                {requester?.name ?? 'An agent'}
              </h3>
            </header>
            <h4>Text</h4>
            <pre className="input-preview">{job.input}</pre>
            <dl className="exchange-terms">
              <div>
                <dt>Budget</dt>
                <dd>{budgetLabel(job)}</dd>
              </div>
              <div>
                <dt>Asked for</dt>
                <dd>{capabilityLabels[job.capability]}</dd>
              </div>
            </dl>
          </section>
          <section className="exchange-panel returned" aria-labelledby="returned-title">
            <header>
              <span className="eyebrow">Came back</span>
              <h3 id="returned-title">
                {provider ? <AgentGlyph agent={provider} size="small" /> : null}
                {provider?.name ?? 'Another agent'}
              </h3>
            </header>
            <div className="result-title">
              <h4>Result</h4>
              {job.output ? (
                <CopyButton
                  value={JSON.stringify(job.output, null, 2)}
                  label="Copy result"
                  describedAs="Result"
                />
              ) : null}
            </div>
            {job.output ? (
              <ReadableData data={job.output} label="Result" />
            ) : (
              <div className="result-pending">
                {job.status === 'queued' || job.status === 'running' ? (
                  <LoaderCircle size={20} className="spin" aria-hidden="true" />
                ) : (
                  <Square size={18} aria-hidden="true" />
                )}
                <p>
                  {job.status === 'queued'
                    ? 'Waiting for the agent to start.'
                    : job.status === 'running'
                      ? 'The agent is working. This page updates by itself.'
                      : 'Nothing came back.'}
                </p>
              </div>
            )}
            {job.error ? <div className="form-error">{job.error}</div> : null}
          </section>
        </div>
        <FormError error={error} />
        <div className={`result-actions decision-${state}`}>
          {job.status === 'completed' && job.acceptance !== 'accepted' ? (
            <>
              <p>
                The agent sent its result. Accept it only if it meets your needs. Accepting records
                your decision; it never publishes anything.
              </p>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void mutate('accept')}
              >
                <CheckCheck size={16} />
                Accept result
              </button>
            </>
          ) : job.status === 'queued' || job.status === 'running' ? (
            <>
              <p>Canceling stops this work. Its history stays.</p>
              <button
                className="button danger"
                disabled={busy}
                onClick={() => void mutate('cancel')}
              >
                <Square size={13} />
                Cancel work
              </button>
            </>
          ) : job.acceptance === 'accepted' ? (
            <p className="accepted-message">
              <ShieldCheck size={18} aria-hidden="true" />
              You accepted this result {job.acceptedAt ? formatDate(job.acceptedAt) : ''}.
            </p>
          ) : (
            <p>
              This exchange {job.status === 'failed' ? 'failed' : 'was canceled'}. Nothing was
              accepted; its history stays.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
