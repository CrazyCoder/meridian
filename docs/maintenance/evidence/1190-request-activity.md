# Request-activity incorporation (#1190)

Source: `be7ad199b7614378b3499d20b16dab1021e5caed` by Nowaker,
AuthorDate 2026-09-28T10:59:22Z. Authored cherry `f89bfe0c` preserves identity
and date on base `e3fa58208`. Public contract tracked in #1216. User explicitly
prioritized this contribution. No release or external comments authorized.

Product fit: a count-only, loopback-only endpoint exposes admitted HTTP work
and queue activity to local supervisors without disclosing account/session data.
The authored safe-restart claim was too strong: background Responses jobs,
pending client-tool processes and post-probe arrivals can outlive that count.
The correction exposes `scope: client-http` and documents those exclusions and
the required graceful-shutdown lifecycle. It does not invent an atomic barrier.

Meaningful negative control: an actual combined HTTP application creates a
background Responses job against the existing deterministic CLI fixture. After
its POST is consumed, `/inflight` reports HTTP zero while retrieval still reports
queued/in-progress work. The test cancels that job and verifies cancelled status.
This is protocol-fixture evidence, not a live Antigravity model claim. Twelve focused
request/response/peer/queue tests pass, including response-body consumption and cancellation.

Further adversarial finding: Claude ended its registry entry when SDK work settled,
before a buffered or streamed response body was consumed. Both direct HTTP
integration controls fail before the fix (expected one, got zero). HTTP tracking
now has its own terminal callback, while existing SDK/session cleanup still runs
at SDK settlement. Both controls pass after consuming the body; they explicitly
verify SDK work is already finished. Aborts/errors/cancellation retire the HTTP
entry. The wrapper preserves the SDK publication-promise mapping required by
internal OpenAI/priority relays; 25 focused HTTP/Responses tests pass.
Application body consumption is not a remote receipt acknowledgement.

Actual headless gate: maintained `scripts/e2e-inflight-client.mjs`, two independent
OpenCode 1.18.32 clients, real Opus 5.5, SDK 0.2.141, Claude Code 2.1.284,
Bun 1.3.11, Linux arm64. Independently installed OpenCode scrub 0.2.3. Both
clients and the same-session follow-up exit 0 and return the actual model marker.
Across 1,219 HTTP observations: maximum total 4; active streams and queued work
both observed; every snapshot's buckets sum exactly to total; final total zero.
Forwarded peer request receives 403. All five real SDK queries use the isolated
read-only OAuth-token profile; at least one query resumes. No mocked SDK/model
response is used in this gate. Raw private client output is not published.

First container attempt failed before serving requests because the reused image
had the stock Docker entrypoint and no machine ID. The corrected invocation uses
the repository's `e2e-container-entry.cjs` with `E2E_CONTAINER=1` to generate a
machine ID inside the disposable container. It keeps production boot-identity
fencing; `MERIDIAN_ALLOW_MISSING_BOOT_IDENTITY` was never used. This explains the
rerun. The access-only private snapshot was removed when the container exited;
no refresh token was copied and host credentials were not changed.

Commands: build Meridian; provide a mode-0600 access-only `E2E_AUTH_FILE` and
independently installed `E2E_PLUGIN_PATH`; run `bun scripts/e2e-inflight-client.mjs`.
For the Linux disposable image, use `node scripts/e2e-container-entry.cjs` as the
entrypoint and set `E2E_CONTAINER=1`; source/scripts and auth mounts are read-only.
Do not put tokens in arguments, environment logs, media or this evidence record.

Final local suite, standalone typecheck/build and exact-head CI are recorded in
the integration PR before merge. No account tracking or Antigravity restart safety
is inferred from the HTTP count. The standalone Antigravity backend does not serve
this endpoint; combined mode counts its POST responses only. Windows receives the
required smoke CI; no separate live Windows model test is claimed.

After the body-lifecycle correction, the actual Linux gate passed again: 1,442
observations, maximum total four, streams/queue observed, final zero, both
clients and continuation exit zero, five real SDK queries and resume. Final
regression checks after publication-promise preservation pass: `npm test`
5,029 pass / zero failures / four platform skips; standalone typecheck/build
pass. The final actual Linux gate records 1,095 observations, maximum total
four, streams and queue observed, exact bucket sums, final zero, forwarding
403, both clients and continuation exit zero, five real SDK calls and resume.
Actual upstream assistant messages confirm `claude-opus-5-5`.

The first final-model run failed because the previously saved access token
was invalid: both client errors reported expired/invalid Claude authentication.
A diagnostic run retained private artifacts and confirmed that cause. The
replacement access-only snapshot came from the isolated browser-created
account already proven by #792's actual client gate, with no host credential
writes or refresh-token export. The same final code/assertions then passed.
The access snapshot is removed after this gate. Required CI must pass on the
updated integration head; earlier green CI does not certify this correction.


Final-head CI exposed a test synchronization defect: after one request reached
its SDK, another could temporarily leave its turn queue before entering the SDK
queue. The immediate snapshot saw two active requests instead of one active and
one queued. The test now waits for the same expected queue state and retains all
count assertions; twelve focused Linux tests pass. No production behavior or
assertion was weakened. Final integration must be checked again on the updated
main containing #1171's independently validated build changes.


After #1171 landed as `bd00c164d198a368956c79658897a6360a0cd5ea`, the
integration rebased onto that base. Source `be7ad199` now maps to authored
cherry `6605d8ad`, retaining the same Author/AuthorDate. Both E2E sections were
kept when resolving their documentation append conflict. Combined final-tree
local, actual client and exact-head CI gates are repeated before merge and
recorded in the integration PR; earlier results remain historical evidence.
