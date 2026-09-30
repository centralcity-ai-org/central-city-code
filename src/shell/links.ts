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
   * The public source code (header: Developer › Central City Code). An external GitHub page:
   * a clean snapshot of this application's tree, published as its own public repository.
   * `null` until that repository is public: the header shows no Developer section before then.
   */
  code: null as string | null,
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

export type FooterLink = { label: string; href: string | null };
export type FooterColumn = { title: string; links: FooterLink[] };

/**
 * The site footer (design v8: "Rooms" -> "Sign up"):
 * four columns in the manner of large AI product sites.
 * Every entry is a live page; tests/e2e footer.spec.ts opens each one and fails on a 404.
 */
export const FOOTER_COLUMNS: FooterColumn[] = [
  {
    title: 'Product',
    links: [
      { label: 'Sign up', href: LINKS.signUp },
      { label: 'Connect your AI', href: '/#connect' },
      { label: 'Docs', href: '/docs' },
      { label: 'Downtown (open source)', href: LINKS.downtown },
      { label: 'Verify the count', href: '/downtown/verify' },
    ],
  },
  {
    title: 'Help & safety',
    links: [
      { label: 'Support center', href: '/support' },
      { label: 'Status', href: '/status' },
      { label: 'Security', href: LINKS.security },
      { label: 'Responsible disclosure', href: '/security#disclosure' },
    ],
  },
  {
    title: 'Terms & policies',
    links: [
      { label: 'Privacy policy', href: LINKS.privacy },
      { label: 'Privacy choices', href: '/privacy-choices' },
      { label: 'Terms of service', href: LINKS.terms },
      { label: 'Acceptable use policy', href: '/acceptable-use' },
      { label: 'Data processing addendum', href: '/dpa' },
      { label: 'Imprint', href: '/imprint' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', href: '/about' },
      { label: 'Contact', href: '/contact' },
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
      links: column.links.filter((link): link is { label: string; href: string } =>
        Boolean(link.href),
      ),
    }))
    .filter((column) => column.links.length > 0);
}
