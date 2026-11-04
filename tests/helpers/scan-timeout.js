// The per-test timeout for a test that walks a whole tree (src/, shared/,
// mobile/, desktop/, scripts/, or supabase/migrations) while it runs
// (CI-SPEED.2). The first such test on a cold CI worker pays the cost of
// reading and parsing the tree (7.2 s on a loaded GitHub Actions shard, 4 Nov
// 2026; well under a second once warm), past vitest's 5 s default, and failed
// two unrelated PRs (#2296, #2299) that way.
//
// Pass it as the third argument of `it` on the scanning tests only. Never
// raise vitest's global `testTimeout`: a slow unit test should still fail
// fast. A test that only reads data the file computed at collection (a
// module- or describe-level `const files = walk(...)`) needs no allowance:
// vitest does not time collection. A describe that already carries
// `{ timeout: 120_000 }` keeps it; this constant would lower it.
export const SCAN_TIMEOUT_MS = 30_000
