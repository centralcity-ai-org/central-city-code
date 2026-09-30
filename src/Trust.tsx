import { useEffect, type ReactNode } from 'react';
import { PublicFooter } from './shell/PublicFooter';
import { PublicHeader } from './shell/PublicHeader';
import { About } from './trust/About';
import { AcceptableUse } from './trust/AcceptableUse';
import { Contact } from './trust/Contact';
import { Dpa } from './trust/Dpa';
import { Imprint } from './trust/Imprint';
import { Privacy } from './trust/Privacy';
import { PrivacyChoices } from './trust/PrivacyChoices';
import { Security } from './trust/Security';
import { Status } from './trust/Status';
import { Support } from './trust/Support';
import { Terms } from './trust/Terms';
import { Updated } from './trust/common';
import './trust.css';

/*
 * The public trust and company pages linked from the footer (src/shell/links.ts): policies, help
 * and company information. One reading column in the public shell; no session needed. The texts
 * follow what the Service does today: check the code before changing a statement.
 */

export {
  CONTACT_EMAIL,
  HELLO_EMAIL,
  PRIVACY_EMAIL,
  SECURITY_EMAIL,
  SUPPORT_EMAIL,
  TRUST_EFFECTIVE_DATE,
} from './trust/common';

export type TrustPageId =
  | 'privacy'
  | 'privacy-choices'
  | 'terms'
  | 'acceptable-use'
  | 'dpa'
  | 'imprint'
  | 'security'
  | 'support'
  | 'status'
  | 'about'
  | 'contact';

type PageInfo = {
  title: string;
  /** The small label above the title (design v8). */
  eyebrow: string;
  group: 'help' | 'policies' | 'company';
  /** Policy pages show their effective and last-updated dates under the title. */
  dated?: boolean;
  body: () => ReactNode;
};

const PAGES: Record<TrustPageId, PageInfo> = {
  support: { title: 'Support Center', eyebrow: 'Help & guidance', group: 'help', body: Support },
  status: { title: 'Status', eyebrow: 'System health', group: 'help', body: Status },
  security: {
    title: 'Security',
    eyebrow: 'Trust & assurance',
    group: 'help',
    dated: true,
    body: Security,
  },
  privacy: {
    title: 'Privacy Policy',
    eyebrow: 'Data protection',
    group: 'policies',
    dated: true,
    body: Privacy,
  },
  'privacy-choices': {
    title: 'Privacy Choices and Cookies',
    eyebrow: 'Choices & storage',
    group: 'policies',
    dated: true,
    body: PrivacyChoices,
  },
  terms: {
    title: 'Terms of Service',
    eyebrow: 'Legal agreement',
    group: 'policies',
    dated: true,
    body: Terms,
  },
  'acceptable-use': {
    title: 'Acceptable Use Policy',
    eyebrow: 'Community & usage',
    group: 'policies',
    dated: true,
    body: AcceptableUse,
  },
  dpa: {
    title: 'Data Processing Addendum',
    eyebrow: 'GDPR Article 28',
    group: 'policies',
    dated: true,
    body: Dpa,
  },
  imprint: {
    title: 'Imprint',
    eyebrow: 'Statutory notice',
    group: 'policies',
    dated: true,
    body: Imprint,
  },
  about: { title: 'About Central City', eyebrow: 'Company', group: 'company', body: About },
  contact: { title: 'Contact', eyebrow: 'Communication', group: 'company', body: Contact },
};

const RELATED_LABEL: Record<PageInfo['group'], string> = {
  help: 'Help and safety',
  policies: 'Terms and policies',
  company: 'Company',
};

export const TRUST_PAGE_IDS = Object.keys(PAGES) as TrustPageId[];
export const trustTitle = (page: TrustPageId) => PAGES[page].title;

export function TrustPage({ page }: { page: TrustPageId }) {
  const { title, eyebrow, group, dated, body: Body } = PAGES[page];
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · Central City`;
    // A deep link such as /security#disclosure: the section exists only after this chunk loads.
    const target = window.location.hash.slice(1);
    if (/^[a-z-]+$/.test(target)) document.getElementById(target)?.scrollIntoView();
    return () => {
      document.title = previous;
    };
  }, [title]);
  const related = TRUST_PAGE_IDS.filter((id) => id !== page && PAGES[id].group === group);
  return (
    <div className="public-shell">
      <PublicHeader current="home" />
      <main id="main-content" tabIndex={-1} className="public-main trust-page">
        <article className={`trust trust-page-${page}`} aria-labelledby="trust-title">
          <header className="trust-head">
            <p className="trust-eyebrow">{eyebrow}</p>
            <h1 id="trust-title">{title}</h1>
            {dated ? <Updated /> : null}
          </header>
          <div className="trust-body">
            <Body />
          </div>
          <nav className="trust-related" aria-label={RELATED_LABEL[group]}>
            {related.map((id) => (
              <a key={id} href={`/${id}`}>
                {PAGES[id].title}
              </a>
            ))}
          </nav>
        </article>
      </main>
      <PublicFooter />
    </div>
  );
}
