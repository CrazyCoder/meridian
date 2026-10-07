# SQLite migration retirement race (#1243)

Disposition: defer the current source 6558c209f8bddf8e59b554d16c9834381c7817c2
pending correction and its #1220/#1245 parent gate. This is a bounded fault
review, not a completed SQLite migration/rollback/client acceptance review.

The maintained scripts/e2e-session-store-retirement-review.mjs exercises the
source's actual fileDigest/retireImportedFile against an owned real filesystem.
A controlled rename boundary publishes an older JSON writer's replacement
atomically after the imported-content digest check and before retirement's
real rename. Current source then moves the unimported replacement away from
sessions.json. Its bytes survive in sessions.json.migrated-*, but the active
path is absent and the database has not imported those replacement mappings.
A normal restart cannot recover mappings from a retired file it does not read.

macOS arm64 / Bun 1.3.14: the default safety assertion exits 1, reproducing the
required active-path violation. Explicit E2E_EXPECT_RETIREMENT_RACE=1 exits 0
with REPRODUCED_UNSAFE_RETIREMENT, not a fix-acceptance PASS. Both observe
interleaved=true, activeContainsReplacement=false and
retiredContainsUnimported=true. The earlier focused test independently failed
0 pass / 1 fail. No credentials, SDK persistence or model calls are involved.
The spy is only the scheduler boundary: all file writes and renames are real,
and the owned directory/mock are cleaned in finally. This is a reproducible
interleaving, not a claimed full native cross-process migration test.

Run with Bun and E2E_STORE_DATABASE_MODULE pointing at the source worktree's
src/proxy/session/storeDatabase.ts, E2E_SOURCE_SHA set to the exact reviewed
head. Default mode must preserve the active newer file after a correction;
expected-race mode is only the negative control. The explicit module path
keeps the rejected source implementation out of main. Node syntax checking
and both fault modes were verified for the maintained harness.

Revisit when retirement participates in the legacy sessions.json writer lock
across snapshot/import/commit/retirement, or an equivalent crash-safe protocol
prevents this interleaving. Another digest read alone does not close the race.
Compose the parent's caller snapshots/revocation/epoch fixes and prove the
#1245 canonical-prefix gate before accepting the stack. Preserve contributor
Author/AuthorDate if incorporation becomes viable; no source PR is closed by
this bounded hold.
