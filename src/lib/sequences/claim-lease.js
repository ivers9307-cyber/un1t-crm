// How far forward a claimed enrolment's next_step_at is leased while the
// runner processes it. The runner has no SELECT … FOR UPDATE SKIP LOCKED,
// so each row is claimed with a CAS bump (see runSequences in scheduler.js);
// the lease is long enough to cover a tick's processing and short enough that
// a crashed tick's enrolment is retried promptly.
//
// A leaf module (PIPEBUILD.1g) so template-wait.js can read it without
// importing scheduler.js, which imports template-wait.js: the approval wake-up
// must never match a row a tick has just claimed (next_step_at inside the
// lease), or it would pull that row's next_step_at back and let a second tick
// claim it while the first is still sending.
export const CLAIM_LEASE_MS = 10 * 60_000
