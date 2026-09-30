# Local language-model connector

This optional native connector runs real language-model inference on supplied text through a separately running local CPU server. It supports research/source briefs and source-against-draft checks. It does not browse, fetch URLs, use tools, make trades or contact a paid model API. External native job cost remains unknown in the application; output labels compute as `local-compute-unmetered`, not free or zero-cost operation.

## Verified compact runtime

The local Windows reference uses the official **llama.cpp b11146 CPU x64** package, reported as `0.5.0-dev`, commit `7fe450e19`, and the official publisher's **Qwen2.5-1.5B-Instruct Q4_K_M GGUF**. The compact 1.5B model is a bounded local trial for a 16 GB laptop, not a frontier-model quality claim. No system installer, Windows service, GPU runtime or API account is required.

| Artifact | Pinned source                                                                                                                                                                                                |       Download size | SHA-256                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------: | ------------------------------------------------------------------ |
| Runtime  | [llama.cpp b11146 CPU x64](https://github.com/ggml-org/llama.cpp/releases/download/b11146/llama-b11146-bin-win-cpu-x64.zip)                                                                                  |    18,560,055 bytes | `14cf1303ca9ac3abd94816850532f9f9a69ac66fbaca3776fc6f9061c2fac1d1` |
| Model    | [Qwen official revision 91cad51170dc346986eccefdc2dd33a9da36ead9](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf) | 1,117,320,736 bytes | `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e` |

Both downloaded artifact hashes were verified against official release metadata on 25 September 2026. Total binary/model download is 1,135,880,791 bytes, excluding small documentation files. llama.cpp uses the [MIT license](https://github.com/ggml-org/llama.cpp/blob/b11146/LICENSE); the model repository includes [Apache 2.0](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/blob/91cad51170dc346986eccefdc2dd33a9da36ead9/LICENSE). Keep their license files with downloaded artifacts. [Official model card](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF) · [Pinned server API documentation](https://github.com/ggml-org/llama.cpp/blob/b11146/tools/server/README.md).

Download only the exact CPU package/model, verify size and SHA-256 before extraction/use, and keep the binaries/model outside source control. A checksum checks integrity against the reviewed artifact; it does not certify model quality or an uncompromised publisher.

## Start the model separately

Example arguments for the verified `llama-server.exe`:

```text
-m "C:\private-models\qwen2.5-1.5b-instruct-q4_k_m.gguf"
--host 127.0.0.1 --port 4322 --alias central-city-qwen-1.5b
--ctx-size 4096 --parallel 1 --threads 6 --threads-batch 6 --n-gpu-layers 0
--no-ui --no-agent --no-ui-mcp-proxy
--cors-origins http://127.0.0.1:4310 --no-cors-credentials
```

On Windows launch background runtime processes with `Start-Process -WindowStyle Hidden`, redirect stdout/stderr to private local files, and retain the returned PID for shutdown. Do not bind to `0.0.0.0`, enable built-in tools/MCP, or use the server's default broad CORS policy. The model endpoint is unauthenticated local HTTP in this reference; trusted local processes can access it. CORS is a browser-origin restriction, not authentication or protection against other programs on the machine. Keep the server on a trusted personal machine and stop it when unused.

Wait for `GET http://127.0.0.1:4322/health` to return `{"status":"ok"}` before starting connectors. Start only one inference at a time on this CPU profile. A 28-second deadline includes queue time; competing tasks can exceed it even if isolated calls pass. Initial model loading is separate from job execution. Closing Codex does not necessarily stop this ordinary local process; use its verified PID when shutting down.

## Connect a native agent

Register an external research or verify agent in Central City, save its scoped token privately, and use a distinct sequence file for every connector. Example private configuration:

```json
{
  "baseUrl": "http://127.0.0.1:4310",
  "token": "<native-agent-token>",
  "sequenceFile": "./research.sequence",
  "modelEndpoint": "http://127.0.0.1:4322",
  "model": "central-city-qwen-1.5b"
}
```

```text
node --import tsx connector/local-model-cli.ts connect .local/research-model.json
```

The separate CLI reuses the existing signed native `runConnector` heartbeat, lease, result and cancellation behavior. Neither the existing demo executor nor the existing connector CLI changes. Configuration is capped at 8 KiB. Tokens remain in private configuration files, never command-line arguments or logs. The sequence path resolves relative to the configuration file.

By default, both native server and model endpoint must use exact numeric loopback origins with an explicit port: `http://127.0.0.1:PORT` or `http://[::1]:PORT`. DNS names, `localhost`, alternate numeric encodings, credentials, query strings, fragments, paths and redirects are refused. The model request always targets `/v1/chat/completions`; no URL can be supplied by a job. This implementation uses llama.cpp's documented JSON-schema extension to `response_format: json_object`; compatibility with a different server must be tested separately.

## Explicit protected hosted app mode

The same local process can opt in to a protected HTTPS Central City app while retaining local inference. The operator must first verify the intended deployment's exact origin and its access protection through the trusted project configuration. Use synthetic staging inputs; this preparation does not establish a working hosted runtime or model quality.

Keep this configuration in a private file outside source control, restricted to your operating-system account (`chmod 600` on Unix or equivalent Windows permissions):

```json
{
  "appMode": "hosted",
  "baseUrl": "https://your-verified-deployment.example",
  "protectionBypassToken": "<private-vercel-automation-bypass-secret>",
  "token": "<native-agent-token-for-this-app>",
  "sequenceFile": "./research.sequence",
  "modelEndpoint": "http://127.0.0.1:4322",
  "model": "central-city-qwen-1.5b"
}
```

Run the same `connector/local-model-cli.ts connect` command with this private file. Omitting `appMode` or setting it to `local` preserves local-only app access. Hosted mode requires a bypass token and a canonical HTTPS origin, with no trailing slash, embedded credentials, path, query, fragment, whitespace, or normalized spelling such as an explicit default `:443` port. The model endpoint still requires numeric loopback with an explicit port. The CLI accepts no arbitrary headers or extra configuration keys; the bypass token is bounded to 16–512 visible ASCII characters within the existing 8 KiB file limit.

The connector sends the private bypass token only in the documented `x-vercel-protection-bypass` header to that exact app origin. It refuses redirects, including login and alternate-domain redirects, and never puts the bypass token in a URL, cookie, model request, result body, or event log. Transport and malformed-response errors discard arbitrary error details. The native agent token and signed request remain required: deployment access does not grant application authority, directional connections, owner review, or acceptance. Source input is retrieved from the hosted app and results are uploaded to it; only inference stays local.

Keep deployment protection enabled. Obtain an existing authorized machine-access secret privately from the project administrator; this code does not create credentials or change Vercel settings. Vercel automation secrets can cover all deployments in a project, so treat one as a broader platform credential than the native agent token. See [Vercel's Protection Bypass for Automation documentation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation) (checked 26 September 2026). A rejected secret, login redirect, or unknown deployment origin is a configuration/access issue, not a reason to remove protection. If exposed, revoke or rotate the Vercel secret separately from the native agent token.

Run `node --import tsx --test tests/hosted-connector.test.ts` for synthetic configuration, transport, credential isolation, and CLI error checks. These fixtures do not contact Vercel, create credentials, download weights, or perform actual inference. The model process/location, authorized protected access, and a complete hosted workflow with review and persistence still require separate verification. The existing pause/result-delivery limitation in [connector recovery](CONNECTOR.md#troubleshooting-and-recovery) also remains unresolved.

## Input and result contracts

- A research job's input is the raw source text. Source is nonempty, at most **4,000 JavaScript characters and 6,000 UTF-8 bytes**.
- A verify job's input is exactly JSON `{ "source": "...", "draft": { ... } }`. Draft can be any JSON object from another native provider, bounded to **6,000 UTF-8 bytes**. It need not use this model's research schema. The entire job input is at most **12,000 UTF-8 bytes**, stricter than a character-only transport limit for some languages. Input is never silently truncated.
- `extract` is unsupported by this executor. Use the deterministic extractor for that capability.

The research result contains `title`, `summary`, `keyPoints`, `sourceQuotes` and `limitations`. Every returned source quote must be an exact substring of the supplied source. The checker returns `verdict: supported|needs-review`, bounded `checks` with claim/assessment/reason/supportingQuote, and limitations. Supported claims need a nonempty exact source quotation; `supported` cannot accompany a non-supported check. Quotes may still be contextually irrelevant, and the model chooses which claims it checks. This is source-support assistance, not independent factual verification or exhaustive review.

Each successful output includes `execution: local-language-model`, the server-reported model identity matched to configuration, measured `elapsedMs`, server-reported token usage when present, `billing: local-compute-unmetered`, and the source-only limitation. Missing token usage remains `null`. Electricity, machine depreciation and local compute cost are not measured. Results still require the platform's owner review and acceptance; model completion or a supported verdict grants no downstream authority.

The system prompt marks source and draft as untrusted data, keeps them in a separate JSON user message, and provides no tools. Strict runtime output validation is separate from prompting. Semantic prompt injection, hallucinations, omissions and weak reasoning remain possible; this small model is an experimental local assistant.

Rejected model work is explicitly reported under the current native job lease using a safe failure category: `invalid-input`, `invalid-output`, `execution-timeout` or `runtime-unavailable`. Result validation is not relaxed to make a model run succeed. The native connector may retry delivery of this failure, but does not silently repeat the model inference for that claimed job. The operator receives a terminal failure for review; starting a new attempt requires an explicit new job/workflow decision.

## Execution bounds and verification

Default generation is 320 tokens, temperature zero, nonstreaming. Configuration API permits 64–384 generation tokens and a maximum 28,000 ms timeout, below the native connector's 35-second executor deadline. A truncated completion, tool call, wrong model identity, invalid JSON/schema, fabricated quote, contradictory verdict or inconsistent token count is rejected. HTTP bodies are limited to 64 KiB while reading, even without Content-Length. HTTP errors, abort reasons, prompts, output bodies and configuration are not included in error messages.

Run `node --import tsx --test tests/local-model.test.ts` for actual loopback mock tests. They cover literal-address validation, source-as-data requests, generic checker drafts, malformed/oversized input, invalid model results, quote checks, chunked output limits, redirect refusal, cancellation/deadline behavior and honest missing-usage metadata. No real model is downloaded or contacted by these regression tests.

The initial isolated synthetic local trial produced a validated brief in **6.47 seconds** (166 input/112 output tokens) and a model check in **21.77 seconds** (346 input/290 output tokens). These are two measured calls, not a performance guarantee or quality benchmark. The check returned `needs-review`; its exact quotes passed validation while its verbose reasons illustrate the model's limitations. Signed two-agent workflow, review gates and persistence require separate end-to-end evidence.

A subsequent native two-agent trial completed its brief but failed to produce an accepted checker result despite model generation finishing. That trial involved an older loaded adapter and overlapping model work, so the exact cause is not established. It exposed the need for explicit executor-failure delivery instead of silent lease retries; the failure path above was added during integration. The subsequent isolated native trial passed two actual model calls, both owner review gates and an exact persistence check after database restart in **31.851 seconds total**. Preserve both failed and successful trial evidence in the release verification record; this remains a bounded synthetic demonstration, not a reliability or customer-quality benchmark.
