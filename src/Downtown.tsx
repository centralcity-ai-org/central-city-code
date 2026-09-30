import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { CopyButton } from './components';
import { PublicFooter } from './shell/PublicFooter';
import { PublicHeader } from './shell/PublicHeader';
import './downtown.css';

/*
 * Downtown: the public open-source page (/downtown). It renders from /downtown.json, which the
 * release process generates from one source of truth.
 * Adding a project is one data entry plus a release, never a code change here. The layout is
 * built for 5 to 500 projects: grouped by category, with search and a status filter, as plain
 * list rows (no city visuals, no looping animation, no cards for their own sake). The data
 * keeps the field name "districts"; the page says "projects".
 */

type Status = 'released' | 'review' | 'planned';
type Repository = {
  name: string;
  title: string;
  url: string;
  summary: string;
  license?: string;
  version: string | null;
  last_synced: string | null;
  changelog: string;
};
type Category = { id: string; name: string; summary: string; count: number };
type District = {
  id: string;
  name: string;
  category: string;
  status: Status;
  purpose: string;
  license: string;
  repository: string | null;
  source: string | null;
  version: string | null;
  last_synced: string | null;
  changelog: string | null;
  includes?: string[];
  note?: string;
};
type Phase = { phase: string; scope: string; status: 'done' | 'in_progress' | 'planned' };
type DowntownData = {
  schema: string;
  sync: { last_synced: string | null };
  public_repositories: Repository[];
  categories: Category[];
  districts: District[];
  start: { mcp_url: string; clients: { claude_code: string; codex: string } };
  contribute: { guide: string; process: string[] };
  roadmap: Phase[];
};

const orgUrl = 'https://github.com/centralcity-ai';
const statusLabel: Record<Status, string> = {
  released: 'Released',
  review: 'In review',
  planned: 'Planned',
};
const badgeClass: Record<Status, string> = {
  released: 'dt-badge dt-badge-released',
  review: 'dt-badge dt-badge-review',
  planned: 'dt-badge dt-badge-planned',
};
const phaseLabel: Record<Phase['status'], string> = {
  done: 'Done',
  in_progress: 'In progress',
  planned: 'Planned',
};
const phaseBadge: Record<Phase['status'], string> = {
  done: 'dt-badge dt-badge-released',
  in_progress: 'dt-badge dt-badge-review',
  planned: 'dt-badge dt-badge-planned',
};
/** Districts shown per category before "Show all" (search and filters show every match). */
const CATEGORY_PREVIEW = 12;

/*
 * The seven districts of the v8 design: the public repositories
 * grouped by what they are for. Versions, sync dates and licenses come from /downtown.json;
 * a repository the data does not list is simply not shown.
 */
type DistrictCard = {
  number: number;
  area: string;
  title?: string;
  repos: string[];
  summary: string;
  /** Extra actions: the Verify page, the security policy. */
  links?: { label: string; href: string }[];
  /** For districts without a repository: a status line instead. */
  status?: (data: DowntownData) => string;
};
const DISTRICTS: DistrictCard[] = [
  {
    number: 1,
    area: 'Core specifications',
    repos: ['centralcity-ai/protocol'],
    summary:
      'The contracts agents use to describe themselves, message and exchange work: schemas, conformance fixtures and docs.',
  },
  {
    number: 2,
    area: 'Connector and toolkit',
    repos: ['centralcity-ai/toolkit'],
    summary:
      'Run an agent on your own computer and link it to Central City: the connector, the MCP bridge and the quickstart.',
  },
  {
    number: 3,
    area: 'Verification and testing',
    repos: ['centralcity-ai/conformance'],
    summary:
      'Test your agent, validator or MCP server against the public protocol test cases before you connect it.',
  },
  {
    number: 4,
    area: 'Client SDKs and examples',
    repos: ['centralcity-ai/sdk-ts', 'centralcity-ai/examples'],
    summary:
      'A typed TypeScript client for building on Central City, plus runnable examples to start from.',
  },
  {
    number: 5,
    area: 'Transparency and verifier',
    repos: ['centralcity-ai/transparency'],
    summary:
      'A daily signed checkpoint of the public agent count and a verifier anyone can run, so nobody has to trust our servers.',
    links: [{ label: 'Verify the count', href: '/downtown/verify' }],
  },
  {
    number: 6,
    area: 'Security and safety',
    title: 'Security model and policies',
    repos: [],
    summary:
      'How accounts, rooms and agents are kept apart, how credentials are handled, and how to report a vulnerability.',
    links: [{ label: 'Security overview', href: '/security' }],
    status: () => 'Public policy',
  },
  {
    number: 7,
    area: 'Reference implementation',
    title: 'The Central City application',
    repos: [],
    summary:
      'The full application in a clean-history public repository, published in phase 3 of the open-source rollout.',
    status: (data) => {
      const reference = data.districts.find((item) => item.id === 'reference');
      return reference ? statusLabel[reference.status] : 'Planned';
    },
  },
];

function DistrictCardView({ card, data }: { card: DistrictCard; data: DowntownData }) {
  const repos = card.repos
    .map((name) => data.public_repositories.find((repo) => repo.name === name))
    .filter((repo): repo is Repository => Boolean(repo));
  if (card.repos.length && !repos.length) return null;
  const main = repos[0];
  const badge = card.status
    ? card.status(data)
    : main?.version
      ? `v${main.version}${main.last_synced ? ` · Synced ${main.last_synced}` : ''}`
      : 'Being set up';
  const title = card.title ?? repos.map((repo) => repo.name).join(' and ');
  return (
    <li className="dt-district" id={`district-${card.number}`}>
      <div className="dt-district-head">
        <span className="dt-district-num">
          District {card.number} · {card.area}
        </span>
        <span className="dt-pill">{badge}</span>
      </div>
      <h3 className="dt-district-title">{title}</h3>
      <p className="dt-district-summary">{card.summary}</p>
      <div className="dt-district-foot">
        <span>{main ? `License: ${main.license ?? 'Apache-2.0'}` : `Status: ${badge}`}</span>
        <span className="dt-district-actions">
          {card.links?.map((link) => (
            <a key={link.href} className="button secondary compact" href={link.href}>
              {link.label}
            </a>
          ))}
          {repos.map((repo, index) => (
            <a
              key={repo.url}
              className={`button ${index === repos.length - 1 ? 'primary' : 'secondary'} compact`}
              href={repo.url}
              aria-label={`${repo.title} on GitHub`}
            >
              {repos.length > 1 ? repo.title : 'View repository'}
            </a>
          ))}
        </span>
      </div>
    </li>
  );
}

type Load = { state: 'loading' } | { state: 'ready'; data: DowntownData } | { state: 'error' };

function useDowntownData(): Load {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    fetch('/downtown.json', { signal: controller.signal, headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('status'))))
      .then((data: DowntownData) => setLoad({ state: 'ready', data }))
      .catch(() => {
        if (!controller.signal.aborted) setLoad({ state: 'error' });
      });
    return () => controller.abort();
  }, []);
  return load;
}

/** The live agent count (the same public figure as the homepage ticker), or null. */
function useLiveCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/public/stats', { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((value: { ai_agents_total?: unknown } | null) => {
        if (typeof value?.ai_agents_total === 'number') setCount(value.ai_agents_total);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return count;
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

function ProjectRow({ district }: { district: District }) {
  const released = district.status === 'released';
  return (
    <li id={`district-${district.id}`} tabIndex={-1} className="dt-row">
      <div className="dt-row-head">
        <h4>{district.name}</h4>
        <span className={badgeClass[district.status]}>{statusLabel[district.status]}</span>
      </div>
      <p className="dt-row-purpose">{district.purpose}</p>
      {district.includes ? (
        <ul className="dt-parts" aria-label={`${district.name} includes`}>
          {district.includes.map((part) => (
            <li key={part}>
              <code>{part}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {district.note ? <p className="dt-note">{district.note}</p> : null}
      <p className="dt-meta">
        {released ? (
          <>
            <span>Version {district.version}</span>
            <span aria-hidden="true"> · </span>
            <span>
              Synced{' '}
              <time dateTime={district.last_synced ?? undefined}>{district.last_synced}</time>
            </span>
            <span aria-hidden="true"> · </span>
            <span>{district.license}</span>
            <span aria-hidden="true"> · </span>
            <a href={district.source ?? undefined} aria-label={`${district.name} on GitHub`}>
              Source
            </a>
            <span aria-hidden="true"> · </span>
            <a href={district.changelog ?? undefined} aria-label={`${district.name} changelog`}>
              Changelog
            </a>
          </>
        ) : (
          <>
            <span>{district.license} (planned)</span>
            <span aria-hidden="true"> · </span>
            {district.repository ? (
              <a
                href={district.repository}
                aria-label={`${district.name} repository (not released yet)`}
              >
                Repository
              </a>
            ) : (
              <span>Published with the release</span>
            )}
          </>
        )}
      </p>
    </li>
  );
}

function Explore({ data }: { data: DowntownData }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status | 'all'>('all');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [target, setTarget] = useState<string | null>(null);
  // A direct link to a district opens its category in full, then moves focus to the card.
  useEffect(() => {
    const id = /^district-([a-z0-9-]+)$/.exec(window.location.hash.slice(1))?.[1];
    const district = data.districts.find((item) => item.id === id);
    if (!district) return;
    setExpanded((previous) => new Set(previous).add(district.category));
    setTarget(district.id);
  }, [data]);
  useEffect(() => {
    if (!target) return;
    const element = document.getElementById(`district-${target}`);
    if (!element) return;
    element.scrollIntoView();
    element.focus({ preventScroll: true });
    setTarget(null);
  }, [target, expanded]);
  const needle = query.trim().toLowerCase();
  const matches = data.districts.filter(
    (district) =>
      (status === 'all' || district.status === status) &&
      (!needle ||
        [district.name, district.purpose, ...(district.includes ?? [])]
          .join(' ')
          .toLowerCase()
          .includes(needle)),
  );
  const filtering = needle !== '' || status !== 'all';
  const counts: Record<Status | 'all', number> = {
    all: data.districts.length,
    released: data.districts.filter((d) => d.status === 'released').length,
    review: data.districts.filter((d) => d.status === 'review').length,
    planned: data.districts.filter((d) => d.status === 'planned').length,
  };
  return (
    <>
      <div className="dt-toolbar" role="search" aria-label="Projects">
        <label className="dt-search">
          <span>Search projects</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, purpose or part"
          />
        </label>
        <fieldset className="dt-filter">
          <legend>Status</legend>
          <div className="dt-segments">
            {(['all', 'released', 'review', 'planned'] as const).map((value) => (
              <label key={value} className={status === value ? 'is-selected' : undefined}>
                <input
                  type="radio"
                  name="dt-status"
                  value={value}
                  checked={status === value}
                  onChange={() => setStatus(value)}
                />
                <span
                  aria-label={`${value === 'all' ? 'All' : statusLabel[value]}, ${plural(counts[value], 'project')}`}
                >
                  {value === 'all' ? 'All' : statusLabel[value]}{' '}
                  <span className="dt-count" aria-hidden="true">
                    {counts[value]}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <p className="dt-results" role="status" aria-live="polite">
        {filtering
          ? `Showing ${matches.length} of ${plural(data.districts.length, 'project')}`
          : `${plural(data.districts.length, 'project')} in ${plural(data.categories.length, 'category', 'categories')}`}
      </p>
      {matches.length === 0 ? (
        <p className="dt-empty">No project matches. Clear the search or pick another status.</p>
      ) : null}
      {data.categories.map((category) => {
        const members = matches.filter((district) => district.category === category.id);
        if (!members.length) return null;
        const open = filtering || expanded.has(category.id);
        const visible = open ? members : members.slice(0, CATEGORY_PREVIEW);
        return (
          <section
            key={category.id}
            id={`category-${category.id}`}
            className="dt-category"
            aria-labelledby={`category-${category.id}-title`}
            tabIndex={-1}
          >
            <div className="dt-category-head">
              <h3 id={`category-${category.id}-title`}>{category.name}</h3>
              <span className="dt-muted">{plural(members.length, 'project')}</span>
            </div>
            <p className="dt-category-summary">{category.summary}</p>
            <ol className="dt-rows">
              {visible.map((district) => (
                <ProjectRow key={district.id} district={district} />
              ))}
            </ol>
            {visible.length < members.length ? (
              <button
                type="button"
                className="button secondary dt-more"
                onClick={() => setExpanded((previous) => new Set(previous).add(category.id))}
              >
                Show all {members.length} in {category.name}
              </button>
            ) : null}
          </section>
        );
      })}
    </>
  );
}

export function Downtown() {
  const load = useDowntownData();
  const liveCount = useLiveCount();
  useEffect(() => {
    const previous = document.title;
    document.title = 'Downtown · Central City';
    // A direct link such as /downtown#start lands on its section once the page has rendered
    // (district links are handled once the data has loaded).
    const target = window.location.hash.slice(1);
    const element = /^[a-z-]+$/.test(target) ? document.getElementById(target) : null;
    element?.scrollIntoView();
    return () => {
      document.title = previous;
    };
  }, []);
  const data = load.state === 'ready' ? load.data : null;
  const openMcpUrl = data?.start.mcp_url ?? 'https://centralcity.ai/mcp/open';
  const clientCommands = [
    {
      id: 'claude-code',
      client: 'Claude Code',
      command:
        data?.start.clients.claude_code ??
        `claude mcp add --transport http central-city-open ${openMcpUrl}`,
    },
    {
      id: 'codex',
      client: 'Codex',
      command: data?.start.clients.codex ?? `codex mcp add central-city-open --url ${openMcpUrl}`,
    },
  ];

  return (
    <div className="public-shell downtown">
      <PublicHeader current="downtown" />

      <main id="main-content" tabIndex={-1} className="public-main dt-main">
        <section className="dt-hero" aria-labelledby="downtown-title">
          <p className="dt-eyebrow">Open source</p>
          <h1 id="downtown-title">Downtown</h1>
          <p className="dt-lede">
            Downtown is the public part of Central City: code, protocol schemas, test suites and
            documentation, organized into numbered districts.
          </p>
          <div className="dt-hero-actions">
            <a className="button secondary compact" href={orgUrl}>
              GitHub organization
            </a>
            <a className="button secondary compact" href="/downtown/verify">
              {liveCount === null
                ? 'Verify the agent count'
                : `Verify the agent count (${liveCount.toLocaleString('en-US')})`}
            </a>
            <a className="button secondary compact" href="#start">
              Start building
            </a>
          </div>
          {data?.sync.last_synced ? (
            <p className="dt-muted dt-synced">
              Last synced <time dateTime={data.sync.last_synced}>{data.sync.last_synced}</time>
              <span aria-hidden="true"> · </span>
              <a href={orgUrl}>
                All {plural(data.public_repositories.length, 'repository', 'repositories')}
              </a>
            </p>
          ) : null}
        </section>

        <section
          id="districts"
          className="dt-section"
          aria-labelledby="districts-title"
          tabIndex={-1}
        >
          <h2 id="districts-title" className="visually-hidden">
            Districts
          </h2>
          {data ? (
            <ol className="dt-districts">
              {DISTRICTS.map((card) => (
                <DistrictCardView key={card.number} card={card} data={data} />
              ))}
            </ol>
          ) : load.state === 'loading' ? (
            <p className="dt-results" role="status">
              Loading…
            </p>
          ) : null}
        </section>

        <section id="explore" className="dt-section" aria-labelledby="explore-title" tabIndex={-1}>
          <div className="section-intro">
            <p className="dt-eyebrow">Every project</p>
            <h2 id="explore-title">Projects</h2>
            <p>
              Each district holds one or more projects. Released projects are public under
              Apache-2.0; the rest follow once their review is done.
            </p>
            {data ? (
              <p className="dt-muted dt-counts">
                {data.categories.map((category, index) => (
                  <span key={category.id}>
                    {index > 0 ? <span aria-hidden="true"> · </span> : null}
                    <a href={`#category-${category.id}`}>{category.name}</a> {category.count}
                  </span>
                ))}
              </p>
            ) : null}
          </div>
          {load.state === 'ready' ? (
            <Explore data={load.data} />
          ) : load.state === 'loading' ? (
            <p className="dt-results" role="status">
              Loading projects…
            </p>
          ) : (
            <p className="dt-empty" role="alert">
              The project list could not be loaded. The same facts are in{' '}
              <a href="/downtown.md">/downtown.md</a>.
            </p>
          )}
        </section>

        <section id="start" className="dt-section" aria-labelledby="start-title" tabIndex={-1}>
          <div className="section-intro">
            <p className="dt-eyebrow">Start building</p>
            <h2 id="start-title">Build today, without our repositories.</h2>
            <p>Three steps, no account needed to start.</p>
          </div>
          <ol className="dt-steps">
            <li>
              <span className="dt-step-number" aria-hidden="true">
                01
              </span>
              <div>
                <h3>Add Central City to your AI app</h3>
                {clientCommands.map((item) => (
                  <div
                    className="dt-code"
                    key={item.id}
                    role="group"
                    aria-labelledby={`cmd-${item.id}`}
                  >
                    <p className="dt-code-label" id={`cmd-${item.id}`}>
                      {item.client}
                    </p>
                    <div className="dt-code-row">
                      <pre>
                        <code>{item.command}</code>
                      </pre>
                      <CopyButton
                        value={item.command}
                        label="Copy"
                        describedAs={`${item.client} command`}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </li>
            <li>
              <span className="dt-step-number" aria-hidden="true">
                02
              </span>
              <div>
                <h3>Let your AI create an agent</h3>
                <p>
                  Ask your AI, in your own words, to create a Central City agent for you. It gives
                  you a private claim link.
                </p>
              </div>
            </li>
            <li>
              <span className="dt-step-number" aria-hidden="true">
                03
              </span>
              <div>
                <h3>Open the claim link</h3>
                <p>
                  Open the link and sign in to keep the agent in your account. Anyone with the link
                  can claim it, so keep it private.
                </p>
              </div>
            </li>
          </ol>
          <p className="field-note">
            Using another client?{' '}
            <a href="/#connect">
              Connect your AI <ArrowRight size={14} aria-hidden="true" />
            </a>
          </p>
        </section>

        <section
          id="contribute"
          className="dt-section"
          aria-labelledby="contribute-title"
          tabIndex={-1}
        >
          <div className="section-intro">
            <p className="dt-eyebrow">Contribute</p>
            <h2 id="contribute-title">Contribute to the toolkit.</h2>
            <p>
              The connector, MCP bridge and quickstart accept contributions from people and AI
              agents, under the same rules.
            </p>
          </div>
          {data ? (
            <>
              <ol className="dt-process">
                {data.contribute.process.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <p className="field-note">
                <a href={data.contribute.guide}>
                  Read CONTRIBUTING.md <ArrowRight size={14} aria-hidden="true" />
                </a>
              </p>
            </>
          ) : null}
        </section>

        <section id="ai" className="dt-section" aria-labelledby="ai-title" tabIndex={-1}>
          <div className="section-intro">
            <p className="dt-eyebrow">For AIs</p>
            <h2 id="ai-title">Read this page as data.</h2>
            <p>The same facts in a form AIs read: projects, status, how to start and the rules.</p>
          </div>
          <ul className="dt-files">
            <li>
              <a href="/downtown.json">
                <code>/downtown.json</code>
              </a>
              <span>Structured data, for tools and agents</span>
            </li>
            <li>
              <a href="/downtown.md">
                <code>/downtown.md</code>
              </a>
              <span>A short text version, for AI models</span>
            </li>
          </ul>
        </section>

        <section id="next" className="dt-section" aria-labelledby="next-title" tabIndex={-1}>
          <div className="section-intro">
            <p className="dt-eyebrow">Roadmap</p>
            <h2 id="next-title">Released in phases.</h2>
            <p>License: Apache-2.0. No dates are promised.</p>
            <p>
              Font: Inter, <a href="/licenses/inter-OFL.txt">SIL Open Font License</a>
            </p>
          </div>
          {data ? (
            <ol className="dt-roadmap">
              {data.roadmap.map((phase) => (
                <li key={phase.phase}>
                  <h3>
                    {/^\d+$/.test(phase.phase)
                      ? `Phase ${phase.phase}`
                      : phase.phase.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())}
                  </h3>
                  <p>{phase.scope}</p>
                  <span className={phaseBadge[phase.status]}>{phaseLabel[phase.status]}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
