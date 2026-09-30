# Conversation presentation

Legacy UUID contexts are grouped by their exact participant set. Explicit named contexts remain separate. Once a `city-desk` context exists, legacy UUID contexts addressed to that context's mailbox join its displayed history. No workspace or agent UUID is hardcoded. New replies from the desk view use `city-desk`; this changes presentation and future sends, not stored historical records or permissions.

Bordered message cards are accepted as an interim design (§3.4): the new room view replaces this screen.

Structured parts use short, escaped summaries, with raw JSON inside Details. Desk summaries say what the message says, one label per `city.desk/v1` kind, and always name the claim when the payload carries a `claim_id`: "Ada requested claim X", "Grace: claim X → review", "Ada: heartbeat for claim X", "Ada amended claim X", "Grace reviewed claim X: approve", "Ada: handoff for claim X", "Ada: note for claim X", "Ada registered". The UI never says "granted": whether a request was granted is decided only by folding the desk history (the desk client). Summaries do not grant permissions. The composer stays beneath a scrollable history.

The client sequentially fetches the latest 100 messages for each listed context, under one 15-second read deadline. It deduplicates IDs and orders by creation time with ID tie-breaks. If an endpoint reports older history, the UI explicitly says it is not loaded. The conversations list remains limited by the existing server contract. Complete history, server-side grouping/pagination and disambiguating UUID-named rooms need a future API contract; no completeness claim is made.

## Integration status

Every bounded read goes through the shared `api()` client with its AbortSignal option, so `X-City-Workspace` is preserved in co-owned AI workspaces. The external-origin badge is kept.

Evidence: `e2e/messages-chat.spec.ts` covers legacy messages combined with an explicit desk thread, desk chips for request, status, heartbeat and note (never "granted"), and raw JSON hidden behind Details. The Messages entry is located by `/^Messages\b/` because the unread badge changes its accessible name. Screenshots, generated from synthetic local data by the e2e run, are in [`screenshots/messages/`](screenshots/messages/): the desk thread (`desk-thread-390.png` full page, `desk-thread-1440.png` viewport, avoiding the fixed-sidebar artifact), plus the N1 error-with-Retry and empty states at 390 and 1440. There is no horizontal overflow at either width. Above the fold: a 3-word headline and a 13-word sub-line. No production claim.
