# Engagement notification loop — design spec

**Date:** 2026-06-20
**Status:** approved (brainstorm), ready for implementation plan
**Repos touched:** `un1t-crm` (backend, cron, data), `champ-app` (dashboard streak chip, native deep-links)
**Related:** `~/code/hr-platform-product-audit-2026-06-20.md` (Tier 1, "turn on the loop"), [[champ-bridge-hr-live]], [[champ-app-design-bar]]

## 1. Goal

Close the engagement loop on the HR platform: the achievements engine, streak maths, and goals are all *computed* but never reach the member (achievements unlock with `notified_at = NULL` and nothing consumes it; streaks only appear in one highlight line; goals have no completion event). "Turn on the loop" = notify members of these moments via push + surface streaks in-app, so the dopamine/retention mechanics the platform already built actually fire.

Per the audit, this is the highest retention-per-effort move because the engines exist — this is surfacing + plumbing, not new maths.

## 2. Context — what already exists

- `endSession()` (`un1t-crm/src/lib/live-class.js:257`) finalises a session and already fires, best-effort, gated on `session.contact_id`: post-class email, a "session ready" `sendCustomerPush`, `runDetectionForSession` (**fire-and-forget — its `unlocked` result is discarded**), and export enqueue.
- `runDetectionForSession(db, sessionId)` (`src/lib/achievements.js:341`) inserts unlocked rows into `contact_achievements` (25 active rules) and returns `{ ok, unlocked: [{ slug, ruleId }] }`. Rows carry `notified_at` (timestamptz, currently always NULL).
- `sendCustomerPush(db, contactIds, { title, body, data })` (`src/lib/customer-push.js`) fans out to `champ_push_tokens` via Expo. A registered token = opted in.
- `computeStreak(thisSession, history)` (`src/lib/hr-analytics.js:232`, non-exported) — consecutive-day streak, used only by `pickHighlight`. `hr-analytics.js` is **byte-identical across three locations**: `un1t-crm/src/lib`, `champ-app/shared`, `champ-app/src/lib`.
- `GOAL_DEFS` + `computeProgress(goal, sessions, now)` (`champ-app/shared/goals.js`) — 4 kinds (`weekly_points`, `weekly_classes`, `monthly_points`, `monthly_classes`). **un1t-crm has no goals lib and nothing references `contact_goals`** (goals are champ-app-only today). `contact_goals` is empty in prod (0 rows) → goal-completion is dormant until members set goals.
- Native push deep-link routing: `champ-app/mobile/app/_layout.jsx` has `switch (data.type)` with a `session_report` case — the extension point for new types.

## 3. Scope

**In:** achievement-unlock push, in-app streak counter, streak-at-risk daily nudge, goal-completion celebration. Channels: **push + the existing post-class email only** (email already includes achievements). **Out:** in-app notification feed/center (Tier 2), per-category notification preferences (a registered token = receives engagement pushes; OS toggle + the existing native push switch are the off-switch), WhatsApp channel (operator rule: never transactional WA), any new email.

## 4. Architecture (approach A)

Hook each notification at its natural trigger; a shared helper builds + sends + records:

- **Achievement + goal-completion** fire **inline at session-end** (immediate dopamine, reusing the detection that already runs there).
- **Streak-at-risk** fires from a **daily cron** (inherently time-based).
- New `un1t-crm/src/lib/customer-notifications.js` — pure payload builders + thin IO wrappers over `sendCustomerPush` and the idempotency table. Keeps `endSession` clean and the builders unit-testable.

Rejected: a generic `notification_log` + unified dispatcher (that's the Tier-2 in-app feed; YAGNI now); an all-cron design (kills post-class immediacy).

## 5. Component A — achievement push + streak counter

### A1. Achievement push (un1t-crm)
- Extend the rule `select` in `runDetectionForSession` (`achievements.js:373`) to include `name, icon`; return them in `unlocked` (`[{ slug, ruleId, name, icon }]`).
- In `endSession`, replace the current two separate side-effects (session-ready push + fire-and-forget detection) with: `await runDetectionForSession(...)` (still best-effort: wrap so it can never block/fail finalisation), then send **exactly one consolidated push** via `customer-notifications.js`:
  - ≥1 unlocked → lead with the achievement. 1: `New achievement — {name}` / body `{points} UN1T Points · {class}. Tap to see your stats.` ≥2: `You unlocked {n} achievements` / same body. `data: { type: 'achievement', session_id, count }`.
  - 0 unlocked → existing session-ready copy. `data: { type: 'session_report', session_id }`.
- After the push attempt, stamp `notified_at = now()` on the `contact_achievements` rows unlocked in this session (idempotency: never re-push an achievement). Stamp regardless of token presence (the member also got the email; avoids a backlog burst when they later install the app).
- **One push per class**, never spam. (Exception: a goal completed in the same session sends its own push — see C; max 2, rare.)

### A2. Streak counter (champ-app)
- Add exported `currentStreak(sessions, nowMs)` to `hr-analytics.js` (all three byte-identical copies): live consecutive-day streak as of today, "live" if the most recent session day is today or yesterday (gap tolerance 1 day), counting consecutive days back from there. Returns `{ current, best, lastDayMs }` (best = longest run in the set).
- Surface a streak chip on the champ-app dashboard — web `src/app/page.jsx` + native `mobile/app/(tabs)/index.jsx` — and on the session report. Visual per §8.
- Mobile: add `data.type` case `achievement` → `/account/achievements` in `_layout.jsx`.

## 6. Component B — streak-at-risk cron (un1t-crm)

- New route `/api/cron/notify-streak-at-risk`, **daily at 11:00 UTC** (~midday Dublin, leaves the day to act). Auth via `CRON_SECRET`; `maxDuration = 300`.
- Logic: candidate set = contacts with a session **yesterday** (only they can have a streak "ending yesterday"). For each: confirm **no session today**, compute the consecutive-day run ending yesterday, require **run ≥ 3**, require a `champ_push_tokens` row. Paginate the session read (`.range`, may exceed 1k rows) per the repo's pagination rule.
- Push via `customer-notifications.js`: `Keep the {n}-day streak alive` / `Train today so you don't lose it.` `data: { type: 'streak_at_risk' }`.
- Idempotency: insert `customer_engagement_nudges (contact_id, 'streak_at_risk', '<YYYY-MM-DD UTC>')` — `UNIQUE` prevents a second nudge same day.
- Conventions: add a `cron_heartbeats` row (name + `expected_interval_seconds` = 86400 + grace) in the migration; call `stampHeartbeat('notify-streak-at-risk')` on the success path; add the `vercel.json` crons entry.
- Mobile: `data.type` case `streak_at_risk` → dashboard.

## 7. Component C — goal-completion (un1t-crm)

- Port `goals.js` into `un1t-crm/src/lib/goals.js` **byte-identical** to `champ-app/shared/goals.js` (+ a shared fixture guard, per the repo's duplicated-lib convention). Keep the two in sync.
- In `endSession`, after finalisation: load the member's active goals (`contact_goals` where `is_active` and `archived_at IS NULL`) + their sessions for the relevant period; `computeProgress(goal, sessions, now)` **including** this session. For each goal where `current ≥ target`:
  - `period_key` = `YYYY-Www` (ISO week) for weekly kinds, `YYYY-MM` for monthly.
  - Insert `customer_engagement_nudges (contact_id, 'goal_complete', '<goal_id>:<period_key>')`. The `UNIQUE` constraint = once-per-period idempotency (no before/after diff needed — first session to cross the line wins).
  - On a fresh insert, push: `Goal smashed — {target} {unit} {period-phrase}` / `Weekly target complete. Nice work.` `data: { type: 'goal', goal_id }`.
- Mobile: `data.type` case `goal` → `/account/goals`.
- Dormant until members set goals (0 today) — acceptable, same pattern as roster/categories.

## 8. Visual direction (champ-app streak chip)

Approved mock: dark UN1T identity — near-black surface, **monochrome with a single ember accent** (`#ff5a1f`), Poppins, bold athletic type, uppercase tracked micro-labels. The streak is the hero: large numeral, `DAY STREAK` label, a 7-cell day-strip (consecutive days lit ember, today as a dashed "train today" outline, future faded), a "train today to make it N" hook, plus points-this-week and best-streak stats. Inherits the existing champ-app dark tokens so it matches the shipped design system. **No generic icon-tile/card-stack patterns.**

## 9. Canonical notification copy

| Trigger | Title | Body |
|---|---|---|
| 1 achievement | `New achievement — {name}` | `{points} UN1T Points · {class}. Tap to see your stats.` |
| ≥2 achievements | `You unlocked {n} achievements` | `{points} UN1T Points · {class}. Tap to see your stats.` |
| No achievement (baseline) | `Your session is ready` | `{points} UN1T Points · {class}` |
| Streak at risk | `Keep the {n}-day streak alive` | `Train today so you don't lose it.` |
| Goal complete | `Goal smashed — {target} {unit} this {week\|month}` | `{Weekly\|Monthly} target complete. Nice work.` |

All copy lives in `customer-notifications.js` builders (operator-editability is a later concern; not in v1 scope).

## 10. Data model — one migration (≈ mig 296, implementer confirms next number)

```
customer_engagement_nudges (
  id uuid pk default gen_random_uuid(),
  contact_id uuid not null references contacts(id) on delete cascade,
  type text not null check (type in ('streak_at_risk','goal_complete')),
  dedup_key text not null,
  created_at timestamptz not null default now(),
  unique (contact_id, type, dedup_key)
)
```
- RLS: enable. Service-role write (all routes use the service client). Customer self-read own via `contact_id = private.auth_contact_id()` (cheap seed for a future feed). Index `(contact_id, type)`. Run `get_advisors` after.
- `cron_heartbeats` row for `notify-streak-at-risk`.
- Achievements reuse existing `contact_achievements.notified_at` — no new column/table.

## 11. Testing (pure, per repo style)

- Push-copy builders (all 5 rows in §9) — exact strings.
- `currentStreak(sessions, nowMs)` — live/broken/gap-tolerance/empty; run under multiple `TZ` per the date-test rule.
- Goal `period_key` derivation (week + month boundaries, UTC).
- Goal-completion decision (crosses target / already at target / under target).
- Streak-at-risk predicate (ran-yesterday + no-today + run≥3 + has-token; each negative case).
- `goals.js` byte-identical guard fixture (un1t-crm ↔ champ-app).

## 12. Defaults / parameters

- One push per class (lead with achievement, else session-ready).
- Streak-at-risk threshold **≥ 3** consecutive days; nudge **11:00 UTC**.
- Copy per §9.

## 13. Out of scope (v1)

In-app notification feed/center; per-category notification preferences; WhatsApp; any email change; operator-editable copy.

## 14. Risks / notes

- `endSession` becomes slightly heavier (awaits detection + goal calc). Keep every notification side-effect best-effort (try/catch-swallowed) so the session always finalises — this is the existing contract.
- `hr-analytics.js` must stay byte-identical across its three copies; `goals.js` must stay in sync between un1t-crm and champ-app. The plan must update all copies together.
- Streak-at-risk cron reads across all active members daily — paginate; the candidate-narrowing (trained-yesterday) keeps it small.
- Mobile changes ship via OTA (JS-only); no native rebuild needed (deep-link cases are JS).

## 15. Suggested phasing (for the plan)

1. **Component A** (achievement push + streak counter + mobile deep-link) — the core, highest value, no new table strictly needed except the shared lib changes.
2. **Component C** (goal-completion) — needs the `customer_engagement_nudges` table + `goals.js` port.
3. **Component B** (streak-at-risk cron) — needs the table (shared with C), heartbeat, vercel.json.

Each is independently shippable; the migration (table + heartbeat) lands with whichever of B/C goes first.
