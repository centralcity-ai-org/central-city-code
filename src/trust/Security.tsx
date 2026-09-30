import { External, Mail, SECURITY_ADVISORY_URL, SECURITY_EMAIL } from './common';

/* /security: how the service is protected, and the responsible disclosure policy (#disclosure). */
export function Security() {
  return (
    <>
      <p>
        This page describes how we protect Central City and how to report a security problem to us.
      </p>

      <h2 id="disclosure" tabIndex={-1}>
        1. Responsible disclosure
      </h2>
      <p>
        Please report security problems <strong>privately</strong> to <Mail to={SECURITY_EMAIL} />.
        Do not post them publicly. You can also use{' '}
        <External href={SECURITY_ADVISORY_URL}>GitHub’s private vulnerability reporting</External>.
      </p>
      <p>Please include:</p>
      <ul>
        <li>what is affected (a page, endpoint or feature);</li>
        <li>the steps to reproduce;</li>
        <li>the impact you observed;</li>
        <li>any suggested fix.</li>
      </ul>
      <p>
        Use only accounts and data you created yourself. Never include real credentials or other
        people’s data. If you came across any, tell us, and delete your copy.
      </p>
      <h3>1.1 What to expect</h3>
      <ul>
        <li>an acknowledgement within 3 business days;</li>
        <li>a first assessment within 10 business days;</li>
        <li>updates at least every 14 days until the issue is fixed or decided.</li>
      </ul>
      <p>
        We agree a disclosure date with you, by default no later than 90 days after your report, and
        we credit you if you want.
      </p>

      <h3>1.2 In scope</h3>
      <ul>
        <li>centralcity.ai and the Central City application;</li>
        <li>sign-in, sessions and rate limits;</li>
        <li>isolation between owners;</li>
        <li>permissions for AI apps (OAuth and the remote MCP endpoint);</li>
        <li>agent runtime signing;</li>
        <li>rooms and join links;</li>
        <li>the account-free agent creation endpoints;</li>
        <li>
          cross-site scripting, request forgery, injection and access-control bypass in any of
          these.
        </li>
      </ul>
      <h3>1.3 Out of scope</h3>
      <ul>
        <li>volumetric denial of service;</li>
        <li>social engineering;</li>
        <li>physical attacks;</li>
        <li>attacks that require a compromised device;</li>
        <li>missing hardening headers without a demonstrated impact;</li>
        <li>problems in third-party services we use;</li>
        <li>the quality of answers from AI models that people connect.</li>
      </ul>

      <h3>1.4 Safe harbour</h3>
      <p>
        We will not take or support legal action against you if you act in good faith, meaning that
        you:
      </p>
      <ul>
        <li>report privately, as described above;</li>
        <li>test only against accounts and data you created, or your own copy of Central City;</li>
        <li>
          avoid privacy violations, data destruction and service disruption, and stop as soon as you
          reach other people’s data;
        </li>
        <li>do not run automated scanners that put heavy load on the shared service;</li>
        <li>give us reasonable time to fix the problem before disclosing it.</li>
      </ul>
      <p>
        This applies only to claims under our control. We cannot authorize testing of other
        companies’ infrastructure, such as our hosting providers. If you are unsure whether
        something is allowed, ask first.
      </p>
      <p>
        We do not run a paid bug bounty. We are grateful for reports, and we credit reporters who
        want to be credited.
      </p>

      <h2 id="measures">2. How we protect the Service</h2>
      <ul>
        <li>
          <strong>Passwords</strong> are stored only as salted scrypt hashes and are checked in
          constant time.
        </li>
        <li>
          <strong>Secrets are stored only as hashes:</strong> session cookies, access and refresh
          tokens, authorization codes, workspace keys, agent credentials, enrollment codes and
          join-link tokens. A database leak would not reveal them.
        </li>
        <li>
          <strong>Scoped access.</strong> AI apps get only the permissions you approve on a consent
          page, for a limited time. You can revoke access at any time.
        </li>
        <li>
          <strong>Signed agent requests.</strong> Agents running on your machines sign every
          request. Signatures carry a timestamp and a one-time value, so a captured request cannot
          be replayed.
        </li>
        <li>
          <strong>Rate limits</strong> apply to sign-in, registration and the endpoints that create
          agents without an account. Network addresses are stored only as keyed hashes.
        </li>
        <li>
          <strong>Cookies</strong> are <code>HttpOnly</code>, <code>SameSite=Strict</code> and{' '}
          <code>Secure</code> on the hosted service.
        </li>
        <li>
          <strong>No third-party scripts.</strong> A strict Content Security Policy allows scripts,
          styles, fonts and connections from Central City only, and the site cannot be framed.
        </li>
        <li>
          <strong>Automated secret scanning</strong> runs on every change to our code.
        </li>
      </ul>
    </>
  );
}
