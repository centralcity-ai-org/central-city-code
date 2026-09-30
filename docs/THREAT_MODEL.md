# Threat model - local development slice

Scope: browser sessions, account-owned data, native runtime credentials, demonstration jobs, local persistence and event delivery. This is a development review, not an independent security audit.

| Boundary | Risk | Required control and evidence |
|---|---|---|
| Browser -> API | Cross-site mutation or session theft | Same-origin and custom request header; HTTP-only SameSite cookies; password hashing; login throttling; logout revocation. |
| Account -> stored objects | Another account's agent, job or result is disclosed or changed | Owner scoping on every object lookup and transition; negative cross-owner integration tests. |
| Runtime -> API | Stolen, expired or replayed request gains access | Agent-scoped hashed credential, signed timestamp/nonce/body, replay rejection, current revocation and bounded rate limits. |
| Connection -> execution | A deleted permission remains usable | Recheck current directional grant before claim and result; stop unauthorized future effects. |
| Job -> worker | Duplicated or canceled work overwrites state | Idempotency body binding, atomic claim, bounded lease attempts, current-state checks, late-result rejection. |
| Provider -> buyer | Provider completion is mistaken for acceptance | Distinct acceptance field; only the owner accepts completed results. |
| Untrusted input -> renderer/runtime | Script, URL or instructions execute | React text rendering; schema limits; deterministic handlers; no arbitrary URL fetch, shell/tool execution, or uploaded programs. |
| SSE -> browser | Cross-owner events leak or unbounded clients consume memory | Authenticated workspace stream, invalidation-only payloads, bounded clients/lifetime/backpressure and shutdown cleanup. |
| Development storage -> source/public assets | Secrets or internal operating documents escape | App repository isolated from operating package; `.local`, credentials and internal documents ignored; static root limited to compiled `dist`. |

External credentials must be sent over HTTPS except for loopback development. A signature does not encrypt a bearer token and does not prove agent competence. The local server is intentionally not bound to a public interface. A malicious local OS user and full machine compromise are outside the protection this application can provide.

Native owner-initiated credential rotation is implemented with atomic invalidation, presence reset, active-job cancellation and current-credential checks at every runtime transaction. A separate local review and targeted tests cover this feature; they are not a production security assessment. See [credential operations](CREDENTIALS.md).

Known future controls: managed identity/recovery, automatic credential expiry, durable key-history records, hardened per-tenant database roles and RLS, independent production review, artifact storage/encryption, deployment rate controls, streaming load validation, and paid-model budget reservation. Do not infer these controls from the presence of a login form or a passing limited test suite.
