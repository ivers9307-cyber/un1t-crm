## W1.S4 — `shared/` seam (and its `src/lib` twins) take the brand

Plan: `docs/superpowers/plans/2026-10-10-saas-wave1-identity.md` → Track S, Task W1.S4, Appendix C (+ the Appendix A rows for the `src/lib` twins). Depends on W1.B1 (merged, #1989): every product name is now built by `productName(shortName, 'points')` from `shared/brand-name.js`; **no `UN1T` literal remains in any swept file**, and UN1T keeps reading "UN1T Points" because `org_settings.short_name = 'UN1T'`.

**Merging this PR publishes an OTA on the staff/member lane** (`shared/**` is a bundle path in `eas-update.yml`). Lane checked 10 Oct 19:30: `eas update:list --branch main` (runtime 2.4.0) shows the three newest groups at `Rollout Percentage N/A` (100%) — **no 1–99% partial rollout blocks the publish** (P6).

### Guard first (red → green)
`tests/un1t-literal-sweep.test.js` is NEW (W1.S1a has not landed, so this PR creates the ledger the plan describes; S1a–S3/S5 append to `SWEPT`/`KEEP`). It greps every swept file for `UN1T` outside comments (via `tests/helpers/js-code.js` `stripComments`), per-file `KEEP` allowlist for appendix `keep` rows (none here). Red on the 9 swept files (14 literal rows) before the sweep, green after.

### Rows swept — 14 of 14 (Appendix C: 9; Appendix A twins: 5)

| File:line (before) | Literal | Rule | After |
|---|---|---|---|
| shared/challenge-wrapped.js:20 | `METRIC_LABEL.points: 'UN1T Points'` | productName('Points') | `metricLabels(shortName)` (exported fn; the `METRIC_LABEL` const export is gone — no importer); `challengeWrappedModel({ …, shortName })` |
| shared/customer-notifications.js:20 | `` `${n} UN1T Points` `` | productName('Points') | `pointsPhrase(n, shortName)`; `buildSessionPush({ …, shortName })` |
| src/lib/customer-notifications.js:20 | same (identical twin) | productName('Points') | same; twin + twin tests stay byte-identical (pair-sync `identical` + `twinTests`) |
| shared/goals.js:23 | `'UN1T points this week'` | productName('Points') | `goalDefs(shortName).weekly_points.label` = `"{Brand} Points this week"` |
| shared/goals.js:37 | `'UN1T points this month'` | productName('Points') | `goalDefs(shortName).monthly_points.label` |
| src/lib/goals.js:42 | `'UN1T points this week'` | productName('Points') | same `goalDefs` (pair is `diverged`; `goalDefs`/`GOAL_DEFS`/`GOAL_KINDS` stay byte-equal, drifted list unchanged) |
| src/lib/goals.js:56 | `'UN1T points this month'` | productName('Points') | same |
| shared/hr-analytics.js:198 | "Personal best … — N UN1T Points." | productName('Points') | `pickHighlight({ …, shortName })`; rule `msg` reads `shortName` |
| shared/hr-analytics.js:214 | "In the top N% … — N UN1T Points." | productName('Points') | same |
| src/lib/hr-analytics.js:198 | same (identical twin) | productName('Points') | same; `buildSessionAnalytics({ …, shortName })` |
| src/lib/hr-analytics.js:214 | same | productName('Points') | same |
| shared/permissions.js:734 | hint "Notify when UN1T issues you a contract…" | brand → "your studio" (static hint) | "Notify when your studio issues you a contract that needs signing" |
| shared/session-history.js:164 | "You've trained N times at UN1T" | brand(loc) | `lifetimeMilestones(sessions, nowMs, { brand, shortName })` → "…times at {brand}", no "at …" clause when no brand |
| shared/session-history.js:175 | "N UN1T Points earned" | productName('Points') | "N {Brand} Points earned" |

### Web callers pass the branding they resolve
- `src/lib/live-class.js` `finalizeSessionRewards`: `getLocationBranding(db, session.location_id).shortName` → `buildSessionPush` (inside the existing best-effort try; the resolver never throws).
- `src/lib/hr-post-class-email.js` `loadContextForSession` resolves `shortName` (last, after every read the tests count) → `composeEmail` → `buildSessionReport({ …, shortName })` → `buildSessionAnalytics` → `pickHighlight`. `shared/hr-session-report.js` + `src/lib/hr-session-report.js` (identical pair, no literal) thread `ctx.shortName` through. The email's OWN "UN1T Points" literals (:261-448) are W1.S1a's rows and are untouched here.

### Phone callers (W1.S5 — not this PR)
Every shared signature stays backward-compatible: `GOAL_DEFS`, `lifetimeMilestones(sessions, nowMs)`, `challengeWrappedModel({…})` keep working with no brand in hand and read **bare "Points"** (`productName('', 'points')`), never a literal. `mobile/app/(member)/**` is untouched (`check:mobile-imports` green). ⚠️ Interim visible change on the phone once this OTA lands and until W1.S5 wires `useBrand()` (W1.B2 #1995 is open, not merged): the member Home/Goals labels read "Points this week" instead of "UN1T points this week", Progress milestones read "You've trained N times" / "N Points earned", and the Challenge Wrapped hero reads "Points". Web pushes and the post-class email keep "UN1T Points" (they resolve the brand). If that interim is not acceptable, merge this together with W1.S5.

### Tests and gates
- `npx vitest run tests/un1t-literal-sweep.test.js tests/shared-pair-sync.test.js shared/customer-notifications.test.js src/lib/customer-notifications.test.js shared/hr-analytics.test.js src/lib/hr-analytics.test.js shared/goals.test.js src/lib/goals.test.js shared/challenge-wrapped.test.js shared/session-history.test.js shared/hr-session-report.test.js src/lib/hr-session-report.test.js src/lib/live-class.test.js src/lib/hr-post-class-email.test.js shared/permissions.test.js tests/changelog-entries.test.js` → **16 files, 468 tests, all green**.
- `check:ota-paths`, `check:mobile-imports`, `check:mobile-parity`, `check:guardrails`, `check:select-columns` → all PASS. eslint on every touched file → 0 errors (2 pre-existing warnings on main: `MS_DAY` in `src/lib/goals.js`, `table` in `hr-post-class-email.test.js`).
- Tests updated: the twin test copies (`customer-notifications`, `hr-analytics`) pass `shortName: 'UN1T'` where they pinned "UN1T Points" and add brand-less / other-brand assertions; `goals` (both), `challenge-wrapped`, `session-history` gain label tests; `live-class.test.js` asserts the push body `42 UN1T Points · DR1VE` via a mocked resolver; `hr-post-class-email.test.js` only gains the resolver mock.

### Deviations from the plan text
- `GOAL_DEFS(shortName)` → `goalDefs(shortName)` + `GOAL_DEFS = goalDefs('')`: the object is read as `GOAL_DEFS[kind]` at 10 mobile/web sites for unit/period/field, so turning the constant itself into a function would have broken the phone's goal screens in the same OTA. `METRIC_LABEL(shortName)` → `metricLabels(shortName)` (camelCase for a function). `milestones(shortName, brand)` → an options object on the existing `lifetimeMilestones` signature.
- No migration. No `mobile/` or champ-app change (S5/S6).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
