# Private A2A transport profile

Implemented 25 September 2026. This is a loopback-only, authenticated HTTP profile for three operations using the A2A v1.0 JSON-RPC representation. It is a bounded local interoperability milestone, not general A2A conformance, third-party SDK compatibility, public discovery, remote execution, or a production service. The earlier `A2A_SPIKE.md` records the historical mapping stage; this document describes the subsequent transport.

## Exact pin and sources

Specification release **1.0.0**, wire version **1.0**, JSONRPC representation; upstream commit `173695755607e884aa9acf8ce4feed90e32727a1`; normative protobuf SHA-256 `4b74c0baa923ae0acb55474e548f1d6e5d3f83b80d757b65f8bf3e99a3c2257f`. The pin is unchanged from the mapping spike. On 25 September 2026 I retrieved the [official versioned specification](https://a2a-protocol.org/v1.0.0/specification/) and [commit-pinned normative protobuf](https://raw.githubusercontent.com/a2aproject/A2A/173695755607e884aa9acf8ce4feed90e32727a1/specification/a2a.proto). I checked version/service parameters (3.2.6, 3.6), task cancellation (3.1.5), scoped authorization (7, 13), and JSON-RPC methods/errors (9). The earlier spike records the measured source hash; this slice did not regenerate schemas or repeat that hash measurement.

## Endpoint and authority

`POST /api/runtime/a2a/:providerId` accepts `application/json`. The owner supplies the provider UUID and an external-requester runtime credential through the existing private native provisioning flow. Agents created from a manifest publish an Agent Card at `/a2a/<agent-id>/.well-known/agent-card.json`, signed when a signing key is configured; only public agents' cards are public. No agent directory is disclosed. No caller-supplied endpoint is fetched.

Required headers:

```text
A2A-Version: 1.0
A2A-Extensions: urn:central-city:a2a:native-auth:1
Authorization: Bearer <native runtime credential>
X-CC-Timestamp: <13-digit Unix milliseconds>
X-CC-Nonce: <fresh 16-128 character native nonce>
X-CC-Signature: <hex HMAC-SHA256>
Content-Type: application/json
```

The extension URI is a private profile identifier, not a registered interoperable authentication standard. The native credential is both bearer credential and HMAC key. The exact signed UTF-8 string is `POST\n<pathname>\n<timestamp>\n<nonce>\n<SHA256(raw request body)>`; query strings are forbidden. Timestamp tolerance is 60 seconds, replay nonces are durably enforced, and the existing per-agent/IP limits apply. Fresh signatures are required even for message retries. Version and extension headers are fixed selections rather than negotiable permissions; this native signing format does not cover them. Never send this credential to an outside A2A server.

The caller's credential determines its owner and requester. The provider must be a hosted deterministic demo in the same workspace, and a current directional requester-to-provider connection is required for all operations. Existing authentication and `mutateRuntime` check the exact current credential again inside the workspace transaction, so rotation/revocation between authentication and mutation cannot preserve authority. All task mutations and grant changes share the native transaction lock. A rotated credential retains its stable requester identity and can retrieve historical tasks only while its grant remains current. The native presence/capacity/pause/history limits still govern new admissions.

## Requests and state

```json
{
  "jsonrpc": "2.0",
  "id": "request-1",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "message-1",
      "role": "ROLE_USER",
      "parts": [{ "text": "Invoice amount: 42" }]
    },
    "configuration": { "returnImmediately": true }
  }
}
```

Send returns `result.task`. `GetTask` and `CancelTask` take `params: {"id":"<returned task id>"}` and return the task in `result`. Get optionally accepts `historyLength: 0`. Send optionally accepts zero history, JSON output mode and text/plain media type as defined in `protocol/a2a.ts`. All other fields/operations are rejected. Requests must carry a JSON-RPC ID; batches and notifications are rejected. There is no blocking send, continuation, streaming, push, task listing, file/URL content, arbitrary data input, or error-state ingestion.

For an independent Node client, save this example as a local `.mjs` file. Set `CC_RUNTIME_TOKEN` and `CC_PROVIDER_ID` to the provisioned requester credential and granted hosted provider. The requester must already have sent a native heartbeat; this snippet does not provision authority. Run `node client.mjs SendMessage message-1`, then `node client.mjs GetTask <returned-task-id>` or `node client.mjs CancelTask <returned-task-id>`. Reusing `message-1` with the same input retries the same task; each invocation creates a new signature nonce. Only task/error output is printed, never credentials.

```js
import { createHash, createHmac, randomUUID } from 'node:crypto';
const token = process.env.CC_RUNTIME_TOKEN;
const provider = process.env.CC_PROVIDER_ID;
if (!token || !provider) throw new Error('Set the private runtime credential and provider ID.');
const [method = 'SendMessage', identifier = randomUUID()] = process.argv.slice(2);
if (!['SendMessage', 'GetTask', 'CancelTask'].includes(method)) throw new Error('Unsupported method');
const params = method === 'SendMessage'
  ? { message: { messageId: identifier, role: 'ROLE_USER', parts: [{ text: 'Invoice amount: 42' }] },
      configuration: { returnImmediately: true } }
  : { id: identifier };
const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params });
const path = `/api/runtime/a2a/${encodeURIComponent(provider)}`;
const stamp = String(Date.now()), nonce = randomUUID();
const hash = createHash('sha256').update(body).digest('hex');
const signature = createHmac('sha256', token)
  .update(`POST\n${path}\n${stamp}\n${nonce}\n${hash}`).digest('hex');
const response = await fetch(`http://127.0.0.1:4310${path}`, {
  method: 'POST', body,
  headers: {
    'content-type': 'application/json', authorization: `Bearer ${token}`,
    'a2a-version': '1.0', 'a2a-extensions': 'urn:central-city:a2a:native-auth:1',
    'x-cc-timestamp': stamp, 'x-cc-nonce': nonce, 'x-cc-signature': signature,
  },
});
console.log(response.status, await response.json());
```

Message deduplication is durable in the existing native job record. The reserved `a2a:` idempotency key hashes requester, provider and message ID. Its stored request hash covers the entire canonical JSON parameters plus profile identifier; property order and RPC correlation ID are irrelevant, but changed text or configuration is a conflict. Native admission rejects the reserved prefix. Retries with a fresh nonce return the same job state, including after process restart. There are no separate mapping tables to migrate or orphan. The 1,000-job cap preserves all retained retry evidence and refuses new admission when full.

Opaque task/context IDs are distinct SHA-256 projections of requester/provider/native random job ID plus a purpose marker. They are deterministically recoverable from persisted state. Every lookup also checks the actual owner, requester, provider, transport namespace and current grant; IDs are not authorization. Native job IDs and credentials are excluded from responses. Completion projects only the structured output artifact and execution state; native owner acceptance remains separate.

Cancel succeeds only while queued/running and atomically records cancellation before responding. Already-terminal tasks return `-32002`, including repeat cancellation. A worker/cancel race resolves through the same lock: either cancellation wins and no artifact appears, or completion wins and cancellation fails truthfully. Existing native cancellation does not reverse effects; this route admits only pure deterministic hosted work with zero external API cost. Historical canceled/failed records without `completedAt` project their last native update timestamp; new terminal transitions record completion time.

## Bounds and errors

Requests: 64 KiB UTF-8; input: 12,000 characters; projected output: 32 KiB. Body parsing/size errors are handled before runtime authentication where Fastify normally does so. Errors never contain task data or credentials.

Success and protocol-validation errors use HTTP 200 with JSON-RPC envelopes. Mapping errors include unsupported version `-32009`, extension required `-32008`, unsupported operation `-32004`, missing/inaccessible task `-32001`, terminal cancel `-32002`, invalid request `-32600`, and unsupported parameters `-32602`. Native security/admission and HTTP parser failures retain meaningful HTTP 4xx (401 credential/signature, 403 grant/provider, 409 nonce or message conflict, 413 size, 429 throttling) in a JSON-RPC envelope; native failures use local generic code `-32000` unless mapped to a standard parser/request/not-found code. Internal failures use HTTP 500 with a generic message. This error profile and strict unknown-field rejection are deliberate limitations, not complete standard conformance.

## Evidence and next gate

Run `pnpm exec tsx --test tests/a2a-transport.test.ts tests/a2a-mapping.test.ts` and `pnpm typecheck`. The transport tests use independent Node `fetch` calls over actual loopback TCP and independently calculate HMAC, without importing the connector, protocol mapper or server transport helpers. They exercise completion, concurrent duplicate sends, changed payload/configuration, restart, owner/requester/provider isolation, current grants, rotation and revocation, malformed/version/extension/body bounds, nonce replay, auth-to-mutation races, and cancellation/completion serialization. These are implementation tests, not an external SDK or formal conformance suite.

Next interoperability gate: an independently maintained pinned A2A SDK with explicit custom-auth support, supported Agent Card negotiation, broader schema/error compatibility and TLS/production authority review. No public release is implied. Rollback can remove the route/import/helper/tests without a database migration; historical `a2a:` jobs remain native records and should be preserved.
