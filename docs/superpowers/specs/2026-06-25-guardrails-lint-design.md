# Guardrails lint (P1-1 part 1) — design

**Date:** 2026-06-25
**Roadmap:** P1-1 from the 2026-06-25 whole-estate audit (`~/code/estate-audit-2026-06-25/REPORT.md`).

## Context

The audit found three recurring whole-estate defect classes: the silent 1,000-row PostgREST cap, Dublin/BST wall-clock-vs-UTC date mishandling, and supabase-js thenable misuse. The P0 fixes shipped the *helpers* (`selectAll`/`selectAllByKeys`, the Dublin-date helpers, the `try { await } catch` pattern). **P1-1 adds the *guardrails*** so new code can't silently reintroduce the bugs — caught at PR time instead of in production.

## Decisions (from brainstorming)

- **Pagination: NO blanket rule.** A "every `.select()` must `.range()`" rule flags ~530 sites (1,499 total selects, ~967 already bounded), the overwhelming majority legitimate small reads — net-negative noise. Instead: one narrow high-signal rule (below) + the shipped `selectAll()` helper + the CLAUDE.md invariant + code review.
- **Date rule deferred to part 2.** Making it a blocking error needs a ~60-site sweep that also fixes the latent "UTC `today` for a Dublin concept" bugs the audit flagged (streaks, Today-feed, mobile "today"). That's a focused follow-up of its own, not infra.

## Scope (part 1): lint infrastructure + 2 ERROR-level rules

### Architecture
A new isolated flat config `eslint.guardrails.config.mjs` (mirrors the existing `eslint.mobile-imports.config.mjs` precedent — a scoped config run as its own CI step), defining 2 local custom rules via an inline plugin, run over `src/**/*.{js,jsx}` through a new `check:guardrails` npm script + Web-CI step. Rules are **ERROR-level** (the whole point is to block the bug at PR time). The main `npm run lint` is untouched.

### Rule 1 — `no-catch-on-supabase-builder` (0 current violations)
Flags `.catch(` / `.finally(` whose callee object is a supabase builder chain rooted at `.from(` / `.rpc(` / `.storage(`, with **no intervening `.then(`**. The builder is a thenable — `.then()` fires the request and returns a real Promise (allowed) — but it has no `.catch`/`.finally`, so chaining them throws a synchronous TypeError and the query never runs (the `enrol.js` bug). Message: *"supabase query builders are thenables, not Promises — they have no `.catch`/`.finally`. Use `try { await … } catch {}`."*

### Rule 2 — `no-uncapped-supabase-limit` (12 current hits → swept in this PR)
Flags `.limit(N)` where N is a numeric literal ≥ 1000 and the chain has no `.range(`. PostgREST caps every response at `db-max-rows` (1000); `.limit(20000)` silently returns ≤1000 — the misconception behind several latent bugs. The 12 current hits are classified in this PR: paginate the real bugs (`selectAll()`/`.range()`); annotate the deliberate caps (e.g. `contact-events.js` "rules don't need unbounded history") with a one-line `eslint-disable` + reason. Message: *"PostgREST caps results at 1000 rows regardless of `.limit(N)`. Paginate with `selectAll()`/`.range()`, or annotate an intentional cap with an eslint-disable + reason."*

### Testing
ESLint `RuleTester` unit tests per rule (valid + invalid fixtures), run under vitest — the rules themselves are tested.

### Wiring
- `package.json`: `"check:guardrails": "eslint --config eslint.guardrails.config.mjs 'src/**/*.{js,jsx}'"`.
- `.github/workflows/web-ci.yml`: add the `check:guardrails` step (alongside the other checks).
- `CLAUDE.md`: add `check:guardrails` to the CI-mirror command.

## Out of scope (part 2 and beyond)
- The BST/Dublin date rule + its ~60-site sweep (incl. fixing the latent "today" bugs).
- The atomic `inc()` RPC helper (audit P1-4 — concurrent-counter undercount; separate).
