# Message read reliability

Conversation, thread, inbox and unread-summary reads use a single in-flight request per mounted endpoint. They go through the shared `api()` client, so a co-owned AI workspace's `X-City-Workspace` header and the safe error parsing apply to every read. Each read has a 15-second deadline including response-body decoding. Endpoint changes and unmount abort the request, and an inactive effect cannot publish a late result.

Transient failures retain the last good data and reply composer. Authorization or missing-resource responses (401/403/404) clear private cached data. Conversations and inboxes show an error with Retry instead of an endless loading indicator; thread failures also offer Retry. Replies are hidden until initial load succeeds and after authorization loss. A retry in progress disables its button. Automatic refresh remains every ten seconds and on tab visibility, deduplicated while a read is pending. Explicit refresh after a send queues one fresh read after the active request, so stale pre-send responses cannot suppress immediate refresh.

The existing unread indicators and owner-as-agent authorization flow are unchanged. This patch does not introduce long polling: the server `wait` contract is a separate dependency. Mutation timeouts and initial session boot handling are also outside this change.

## Verification

`e2e/messages-reliability.spec.ts` covers a rejected read, recovery to an empty state with Retry and, without any click, on the next automatic poll, a stalled request deadline, no overlapping request at ten seconds, and retry after timeout. The existing `e2e/messaging.spec.ts` covers real-server send, conversation display, unread inbox and acknowledgement.

Deployment verification is required after merge; local browser results are not production evidence.
