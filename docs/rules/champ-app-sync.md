# champ-app shared sync rule

The full rules behind the one-line summaries in `CLAUDE.md`. Moved here word for word from `CLAUDE.md` on 19 Nov 2026 (CLAUDEMD.1); keep the two in step when a rule changes.

## champ-app shared sync rule (Repset merge P1, 2026-08-17)

Phase 1 of the Repset one-app merge landed champ-app's `shared/` modules here as
**copies, not moves** — champ-app's live backend still consumes its own `shared/`
and stays authoritative for its copies until backend consolidation.

**Modules that exist in BOTH repos and are consumed by the champ-app server**
(empirically derived from `champ-app/src` imports of `../shared` / `@/shared`):
`achievement-progress`, `brand`, `challenges`, `cohort-board`,
`customer-notifications`, `customer-push-channels`, `dublin-time`, `format`,
`goals`, `heart-rate`, `hr-analytics`, `hr-session-report`,
`progress-analytics`, `sessions-list`, `share-card`, `social`, `tier-window`,
`tiers`, `wearable-trends-view`, `workout-detail`.

- **Mirror rule:** any edit to one of these modules in either repo MUST be
  mirrored in the other repo **in the same working session**. No drift.
- **Divergence window:** until the P2 app-tree port merges, ANY change to
  champ-app `shared/` (not just the list above) must be mirrored into
  `un1t-crm/shared/`.
- **Pre-existing cross-repo pairs** (now three-way, since the shared copies
  live here too): `src/lib/tiers.js` ↔ `shared/tiers.js`,
  `src/lib/tv-zone-colors.js` ↔ `shared/zone-colors.js`,
  `src/lib/hr-analytics.js` ↔ `shared/hr-analytics.js`.
- 🔴 **The IN-REPO half of this rule is now a test, not a comment**
  (`tests/shared-pair-sync.test.js`, PAIRSYNC.1). Every module present in
  BOTH `shared/` and `src/lib/` must be classified in its manifest —
  `reexport` (proven by runtime identity, the pattern to prefer),
  `identical`, `web-superset`, `diverged` or `unrelated` — each with a
  reason. A new duplicated module fails the suite until someone classifies
  it. **Byte-identity was the wrong assertion and would have failed on main:
  three pairs had ALREADY drifted when their "byte-identical" comments were
  written** — `tiers` (web grew the windowed-decay helpers, which
  `src/lib/live-class.js` depends on, so they must NOT be deleted to force
  identity), `heart-rate` (zone LABELS differ, `'Z1'` vs `'Zone 1'`), and
  `goals` (UTC vs Europe/Dublin week boundaries, fixed by TZ.17: both now
  bucket on the member's zone; **a different `periodEnd` arity is still
  OPEN**). Those three are pinned in mode
  `diverged`, which fires in BOTH directions: a newly-drifted export fails,
  and so does a silent re-sync. **The champ-app leg is unguardable from this
  repo** — nothing here can read that repo, so the ~20-module rule above
  still rests on discipline.
- `shared/customer-push-channels.js` was the ONE filename collision at landing
  time (verbatim copies, comment-only diff) — un1t-crm's copy stands.
