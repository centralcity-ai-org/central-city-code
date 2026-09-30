/**
 * Public destinations that exist today (DESIGN_SYSTEM §2.1–2.2: a link renders only when its
 * route exists). Some routes are still hash-based until the path router covers them, so every entry
 * is the URL that works now. `null` means "not live yet": the header or footer leaves it out.
 */
export const LINKS = {
  home: '/',
  downtown: '/downtown',
  signIn: '/#signin',
  signUp: '/#signin',
  /** "Invite your AI" (DESIGN_SYSTEM §3.2): sign in, then the room's Invite sheet. */
  invite: '/invite',
  /** The no-account path (/mcp/open and the per-app setup): today's Connect page. */
  tryWithoutAccount: '/#connect',
  mcpConnection: '/#connect',
  protocol: '/downtown#district-protocol',
  /**
   * The public source code (header: Developers › GitHub). An external GitHub page:
   * a clean snapshot of this application's tree, published as its own public repository.
   * `null` until that repository is public: the header shows no Developers section before then.
   */
  code: 'https://github.com/centralcity-ai/central-city-code' as string | null,
  docs: '/docs',
  rooms: null as string | null,
  answers: null as string | null,
  about: '/about',
  contact: '/contact',
  support: '/support',
  security: '/security',
  privacy: '/privacy',
  terms: '/terms',
  status: '/status',
  downtownJson: '/downtown.json',
  downtownMd: '/downtown.md',
} as const;

const GITHUB = 'https://github.com/centralcity-ai';

/** One entry in a header menu and the footer: a short name and where it goes. */
export type NavItem = {
  label: string;
  href: string;
  /** On GitHub: opens in a new tab (noopener) and shows ↗. */
  external?: boolean;
};
export type NavGroup = {
  id: 'product' | 'developers' | 'open-source' | 'company';
  label: string;
  items: NavItem[];
};

/** The public GitHub repositories the header and footer may link (tests check every URL). */
export const PUBLIC_REPOS = [
  'https://github.com/centralcity-ai/protocol',
  'https://github.com/centralcity-ai/sdk-ts',
  'https://github.com/centralcity-ai/central-city-code',
  'https://github.com/centralcity-ai/transparency',
];

/**
 * The public header's four menus; the footer mirrors them. Short names, nothing listed twice.
 * Every href is a live page or a public GitHub page; e2e/shell.spec.ts checks each one.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'product',
    label: 'Product',
    items: [
      { label: 'Workspace', href: LINKS.signIn },
      { label: 'Connect AI', href: '/connect' },
    ],
  },
  {
    id: 'developers',
    label: 'Developers',
    items: [
      { label: 'API', href: '/docs/api' },
      { label: 'Docs', href: '/docs' },
      { label: 'Protocol', href: `${GITHUB}/protocol`, external: true },
      { label: 'SDK', href: `${GITHUB}/sdk-ts`, external: true },
      {
        label: 'Changelog',
        href: `${GITHUB}/central-city-code/blob/main/CHANGELOG.md`,
        external: true,
      },
      { label: 'Status', href: LINKS.status },
    ],
  },
  {
    id: 'open-source',
    label: 'Open Source',
    items: [
      { label: 'Source code', href: `${GITHUB}/central-city-code`, external: true },
      { label: 'Repositories', href: LINKS.downtown },
      { label: 'Verify', href: '/downtown/verify' },
      { label: 'Transparency log', href: `${GITHUB}/transparency`, external: true },
    ],
  },
  {
    id: 'company',
    label: 'Company',
    items: [
      { label: 'About', href: LINKS.about },
      { label: 'Contact', href: LINKS.contact },
      { label: 'Security', href: LINKS.security },
      { label: 'Privacy', href: LINKS.privacy },
    ],
  },
];

export type FooterLink = { label: string; href: string | null; external?: boolean };
export type FooterColumn = { title: string; links: FooterLink[] };

/**
 * The site footer: the header's four groups, then Help & legal (support and the policies).
 * Every same-site entry is a live page; e2e/footer.spec.ts opens each one and fails on a 404.
 */
export const FOOTER_COLUMNS: FooterColumn[] = [
  ...NAV_GROUPS.map((group) => ({ title: group.label, links: group.items })),
  {
    title: 'Help & legal',
    links: [
      { label: 'Support', href: LINKS.support },
      { label: 'Terms of service', href: LINKS.terms },
      { label: 'Privacy choices', href: '/privacy-choices' },
      { label: 'Acceptable use', href: '/acceptable-use' },
      { label: 'Data processing addendum', href: '/dpa' },
      { label: 'Imprint', href: '/imprint' },
    ],
  },
];

/** The footer's bottom line: no registration numbers here, only the name and city. */
export const FOOTER_COPYRIGHT = '© 2026 Central City S.R.L. · Torino, Italy';

/** Columns with at least one live link, each holding only its live links. */
export function liveFooterColumns(columns = FOOTER_COLUMNS) {
  return columns
    .map((column) => ({
      title: column.title,
      links: column.links.filter(
        (link): link is { label: string; href: string; external?: boolean } => Boolean(link.href),
      ),
    }))
    .filter((column) => column.links.length > 0);
}
