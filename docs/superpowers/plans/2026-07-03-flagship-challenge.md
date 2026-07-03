# Flagship transformation challenge — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Two independent chains (separate repos/worktrees) run in parallel; tasks WITHIN a chain are sequential. Spec: `/private/tmp/claude-501/-Users-richardivers-code/d813fcf9-84f8-4dbb-80e4-eb5a4ef39ecf/scratchpad/crm-flagship-wt/docs/superpowers/specs/2026-07-03-flagship-challenge-design.md` — the contract.

**Goal:** an `is_flagship` flag that turns a challenge into a transformation event: InBody bookend + challenge Wrapped + consistency/cohort scoring. Reuse-first.

## Chain A — un1t-crm (worktree: /private/tmp/claude-501/-Users-richardivers-code/d813fcf9-84f8-4dbb-80e4-eb5a4ef39ecf/scratchpad/crm-flagship-wt, branch feat/pulse-flagship-challenge)

### Invariants
- Work ONLY in that worktree; `git -C <wt>`; NEVER checkout/switch/pull/push. Service-role routes enforce access in code; `{success,data?,error?}`; awaited writes; validateBody + zod from @/lib/schemas; register routes in openapi if the shape changes. Migrations forward-only — write the .sql, DO NOT apply (controller applies via MCP). Light-theme chips `bg-*-500/10 text-*-700`. Run the relevant tests + eslint before committing.

### A1 — flag + API + form + migration
**Files:** `supabase/migrations/358_challenge_is_flagship.sql`; `src/app/api/challenges/route.js`; `src/app/api/challenges/[id]/route.js` (if it has an edit PATCH); `src/components/ChallengeForm.jsx`; any challenges API test.
- Migration: `alter table public.challenges add column if not exists is_flagship boolean not null default false;` + a COMMENT. Next free number is 358 — verify vs `list_migrations` at apply time. DO NOT APPLY.
- `CreateSchema` (POST): add `is_flagship: z.boolean().optional().default(false)` + a `.refine` that `is_flagship` implies `mode==='individual'`. Add `is_flagship` to the `insert({...})`. Mirror in the edit route if one exists.
- `ChallengeForm.jsx`: a "Flagship transformation challenge" checkbox, disabled unless mode==='individual' (clear it when switching to collective), helper text "Switches on the InBody transformation bookend + a Challenge Wrapped finisher in the member app." Post it in the create payload.
- Tests: schema accepts is_flagship + rejects flagship+collective; insert carries it. Run `npm test` (challenges-related) + `npx eslint` on touched files + `npm run build`. Commit `FLAGSHIP.A1`. Then run the CI mirror (`npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`) + `next build`; fix; add a CHANGELOG row; commit `FLAGSHIP.A2`. Do NOT push.

## Chain B — champ-app (worktree: /private/tmp/claude-501/-Users-richardivers-code/d813fcf9-84f8-4dbb-80e4-eb5a4ef39ecf/scratchpad/flagship-wt, branch feat/flagship-challenge)

### Invariants
- Work ONLY in that worktree; `git -C <wt>`; NEVER checkout/switch/pull/push. Do NOT touch package.json/lockfile (nitro-modules). shared/ pure JS, co-located vitest from the worktree root. `is_flagship` on a challenge row may be undefined until the un1t-crm migration lands — treat falsy/undefined as "not flagship" (features simply don't activate). InBody read via the member's RLS-scoped self client (never service). Customer copy: NO booking/reserve/pause/cancel. Own-stats-only; names via shortName where standings are shown. react-native-svg is available.

### B1 — extract shared InBody helper (TDD)
**Files:** create `shared/inbody.js` + `shared/inbody.test.js`; edit `mobile/app/coaching/inbody.jsx` to import `METRICS` from it (behaviour-preserving).
- Move `METRICS` (weight_kg/smm_kg/pbf_percent with label/unit/dp/betterWhenLower) into `shared/inbody.js`. Add `inbodyBookend(scans, { fromMs, toMs })` per the spec (baseline = latest scan on/before fromMs else earliest within window; latest = latest on/before toMs; per-metric from/to/delta/improved via betterWhenLower + score; `null` when <2 usable scans span). Pure, ms compares.
- Tests: baseline picks the pre-window scan; falls back to first-in-window; delta + improved direction (weight↓ improved, muscle↑ improved); `<2 scans`→null; absent metric fields tolerated. `coaching/inbody.jsx` still renders (import swap only). `npm test` green. Commit `FLAGSHIP.B1`.

### B2 — InBody bookend card + flagship badge
**Files:** create `mobile/components/ChallengeTransformationCard.jsx`; edit `mobile/app/challenges.jsx` (ChallengesScreen) + `src/lib/load-challenges.js` (surface `is_flagship` per challenge if not already via select('*')/RPC path — verify what the app receives).
- `ChallengeTransformationCard`: props = the flagship challenge (id, starts_on, ends_on). Reads `inbody_scans` (self client, same select as coaching/inbody), computes `inbodyBookend(scans, {fromMs: starts_on, toMs: min(now, ends_on)})`, renders the metric deltas (ember on improved) + score; null bookend → "Get scanned on the InBody to track your transformation" (no booking). "Full trends ›" → `router.push('/coaching/inbody')`.
- In `ChallengesScreen`: for challenges with `is_flagship`, show a "Flagship" badge and render `<ChallengeTransformationCard>` under that challenge. Confirm `is_flagship` reaches the client (extend the challenges select/loader if the RPC path drops it). Commit `FLAGSHIP.B2`.

### B3 — challenge Wrapped finisher
**Files:** create `mobile/app/wrapped/challenge/[id].jsx` (+ extract shared story primitives into `mobile/components/wrapped/` from `wrapped/month.jsx` if cleanly shareable, else mirror the pattern); a small loader for the challenge's own stats.
- Story (own stats): classes attended in window, points, rank (from the standings the Compete screen loads), InBody delta (reuse `inbodyBookend`), finisher badge (hit target/completed). Count-up hero + stat tiles + confetti + reduce-motion, mirroring `wrapped/month.jsx`.
- Trigger: in `ChallengesScreen`, when a `is_flagship` challenge ended within the last N days (default 14) AND the member participated (has a standings row), show a "See your Challenge Wrapped ›" entry → `router.push('/wrapped/challenge/<id>')`. Commit `FLAGSHIP.B3`.

### B4 — validation
`npm test` + `npm run lint`; `git diff origin/main...HEAD --stat` shows NO package.json/lockfile; grep lockfile still has `react-native-nitro-modules`; no booking copy. Commit `FLAGSHIP.B4` if fixes. Do NOT push.

## Verification gate (controller, after both chains)
Adversarial review (privacy: InBody self-client only + own-stats-only + no booking copy; the is_flagship+individual refine; bookend baseline correctness; Wrapped trigger only for participants of ended flagships; falsy is_flagship inert). Re-run both CI mirrors + builds. Apply mig 358 via Supabase MCP (verify next-free number) + get_advisors. Rebase both branches onto current origin/main if needed (champ-app in the worktree so Richard's checkout is untouched); push; open two PRs; hold for Richard. NO merge.
