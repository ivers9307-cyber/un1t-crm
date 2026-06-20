# Social v1 — friends, activity feed, kudos — design spec

**Date:** 2026-06-20
**Status:** approved (brainstorm), ready for implementation plan
**Slice:** The next slice after the challenges + tiers initiative (engagement loop ✅, tiers ✅, challenges ✅). This is the "between-class social layer" the audit named as the #1 retention lever.
**Repos:** `champ-app` (all member surfaces + the social APIs — this is a customer-facing feature) + `un1t-crm` (canonical home of the pure `social.js` helpers + their tests, byte-synced to champ-app; plus the per-location kill-switch). **Cross-repo:** pure helpers byte-synced like `challenges.js` (`un1t-crm/src/lib/social.js` ↔ `champ-app/shared/social.js` + one-line re-export). The DB reads/aggregates are champ-app-side IO (service client), mirroring `load-challenges.js`.
**Related:** [[hr-platform-product-audit]] (Tier-2, social v1). Reuses the just-merged challenges/leaderboard engine (`challenges.js` `rankStandings` + the `computeStandings` aggregation), the engagement-loop push infra (`sendCustomerPush`, `customer_engagement_nudges`, the deep-link switch), the achievements engine, and the HR-class-allocation stamping on `heart_rate_sessions` (for shared-class suggestions).

## 1. Goal

A mutual-friends graph plus the social surfaces built on it — an **activity feed** of friends' workouts/achievements, **tap reactions** (kudos), and a **friends-only leaderboard** — in the member app. The proven category retention engine (Myzone: 10+ friends → ~47% more effort, 20–25% longer stay). Surfaces in champ-app (web + native).

## 2. Locked decisions (from the brainstorm)

1. **Scope:** friends + friend-filtered leaderboards + activity feed + tap reactions (the full loop).
2. **Graph model:** mutual friends — A requests, B accepts (symmetric edge). Discovery via **name search + shared-class suggestions** (members you've actually trained with).
3. **Visibility:** **summary only** — per session: class name, UN1T Points, headline effort (Z4+ minutes / top zone), duration; plus achievements, tier, and leaderboard rank. **Never** raw HR traces or avg/max HR.
4. **Interactions:** **tap-only preset reactions** (set of emoji, e.g. 💪🔥👏😮) — no free text. Reaction → push to the author. Reactions target **sessions and achievement unlocks** (durable rows); tier-ups are info-only feed items in v1.
5. **Feed architecture:** **compute-on-read** (no stored feed table) — matches leaderboards/tiers.
6. **Friends are same-studio in v1** (coherent leaderboards; revisit when a 2nd location goes HR-live).

## 3. Scope

**In:** mutual friend graph (request/accept/decline/unfriend/block); name search + shared-class suggestions; compute-on-read activity feed (friends' session summaries + achievement unlocks reactable; tier-ups info-only); tap reactions (one per member per item, changeable) with push-to-author (coalesced); friends-only leaderboard (monthly board + a "Friends" filter on each active challenge); member Private-mode toggle; per-location kill-switch; champ-app web + native surfaces + dashboard teaser + deep-links.

**Out (v1 → social v2):** free-text comments (moderation surface); 1:1 head-to-head friend challenges; club/group feeds; cross-location friends; reactions on tier-ups/challenge-wins; web push; a staff moderation/abuse console (tap-only reactions ⇒ near-zero abuse surface — `block` + `unfriend` are member-side, sufficient for v1).

## 4. Architecture

- **Friend graph** = one `member_friendships` table, edges between **app-linked contacts** (both have `contacts.user_id`). Logically symmetric once `accepted`; queried in both directions.
- **Feed = computed on read** (service client, cross-member, projected to first-name + last-initial): the union of accepted friends' last-N-days **session summaries** + **achievement unlocks** + **tier-ups**, sorted desc, time-paginated. No stored feed table, no fan-out writer. Reactions attach to the **durable source rows** (session id / achievement id), so they survive without a feed table.
- **Friends leaderboard** = the existing standings aggregation restricted to the contact set {self ∪ accepted friends} via a `contactIds` allowlist (a small extension to the merged engine), reused for the monthly board and the per-challenge "Friends" filter.
- **Reactions** = one `feed_reactions` table, polymorphic `(entity_type, entity_id)`, one row per (reactor, entity), changeable.
- **Notifications** ride the engagement loop: friend-request and request-accepted are immediate single pushes; reaction pushes are **coalesced** (at most one per author+entity per window, summarised "X + N others reacted").
- **Privacy** is enforced in the server-side projection (summary-only; raw HR never leaves the service layer). A `member_social_settings` row carries Private mode.
- **Kill-switch** via the per-location feature-gate pattern; champ-app's social endpoints check it server-side and return disabled (app hides the Social tab) when off.

## 5. Data model — one migration (champ-app reads it via service client; table lives in the shared Supabase project, so the migration is in un1t-crm/supabase/migrations)

```
member_friendships (
  id uuid pk default gen_random_uuid(),
  requester_contact_id uuid not null references contacts(id) on delete cascade,
  addressee_contact_id uuid not null references contacts(id) on delete cascade,
  status text not null check (status in ('pending','accepted','blocked')),
  location_id uuid not null references locations(id) on delete cascade,  -- same-studio constraint + scoping
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_contact_id <> addressee_contact_id)
)
-- unique on the UNORDERED pair: unique index on (least(requester,addressee), greatest(requester,addressee))
-- indexes: (addressee_contact_id, status), (requester_contact_id, status), (location_id)

feed_reactions (
  id uuid pk default gen_random_uuid(),
  reactor_contact_id uuid not null references contacts(id) on delete cascade,
  entity_type text not null check (entity_type in ('session','achievement')),
  entity_id uuid not null,                 -- heart_rate_sessions.id | <achievements row>.id
  reaction text not null check (reaction in ('strong','fire','clap','wow')),
  location_id uuid not null references locations(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (reactor_contact_id, entity_type, entity_id)   -- one reaction per item per person, changeable via upsert
)
-- index: (entity_type, entity_id)

member_social_settings (
  contact_id uuid pk references contacts(id) on delete cascade,
  private_mode boolean not null default false,   -- hide from search/suggestions + hide my activity from friends' feeds
  updated_at timestamptz not null default now()
)
```

**RLS:** `member_friendships` — a member reads/writes rows where they are requester or addressee (`private.auth_contact_id()`); service role does the cross-member reads. `feed_reactions` — member reads reactions on entities they can see, writes/deletes only their own. `member_social_settings` — member reads/writes only their own row. All cross-member feed/leaderboard reads are **service-role + projection**, never customer RLS (the leaderboards/tiers precedent). No standings/feed table.

## 6. Engine

**Pure helpers — byte-synced `un1t-crm/src/lib/social.js` ↔ `champ-app/shared/social.js`** (canonical + tests in un1t-crm), unit-tested:
- `friendshipPairKey(a, b)` → canonical unordered key (sorted pair) for dedup/unique logic.
- `friendStatusFor(row, myContactId)` → `'incoming' | 'outgoing' | 'friends' | 'blocked'` from a friendship row + my id.
- `mergeFeed(items)` → merge session/achievement/tier-up items into one list sorted by timestamp desc (stable).
- `reactionSummary(rows, myContactId)` → `{ counts: {strong,fire,clap,wow}, total, mine }` for one entity.
- `suggestionScore(sharedClassCount)` / `rankSuggestions(rows)` → rank candidates by shared-class count desc, tie-break by name.
- `REACTIONS` constant (the 4 reaction keys + their emoji) so client + push copy stay in sync.

**IO (champ-app-side, service client; mirrors `load-challenges.js`):**
- `loadFeed(db, { myContactId, locationId, friendContactIds, sinceIso, limit, beforeIso })` — paginated read of friends' `heart_rate_sessions` (ended, contact in friend set, class summary fields), `achievements` unlocks, and tier-up events (derived from `member_monthly_targets` crossing a tier boundary), projected + merged + reaction summaries attached. Excludes friends in Private mode.
- `loadFriendsBoard(db, { myContactId, friendContactIds, window })` — the standings aggregation over {self ∪ friends}, monthly (points) + reusable for the per-challenge filter.
- `loadSuggestions(db, { myContactId, locationId })` — non-friend app-linked members at the location ranked by shared `glofox_event_id` count on `heart_rate_sessions` (the HR-class-allocation stamp), excluding Private-mode members and existing friends/requests.
- All paginate per the >1k-row rule (copy `pipeline-reclassify.js`), project to first-name + last-initial, and never return raw HR.

## 7. Member surfaces (champ-app — web + native)

One **Social** tab with three in-screen segments (matches the approved mockup):
- **Feed** — activity cards (session summary / achievement / tier-up) each with a reaction row; tap a reaction to set/change yours → push to author. Time-paginated infinite scroll.
- **Friends** — incoming/outgoing requests (accept/decline), accepted friends list (unfriend/block), name search to add, and "trained together" suggestions (Add). 
- **Boards** — the friends-only monthly leaderboard (your row highlighted), and a "Friends" toggle on each active challenge's board.
- **Dashboard teaser** — pending-request count + latest friend activity, linking into the Social tab.
- **Deep-links** — `friend_request` (→ Friends segment) and `feed`/`reaction` (→ Feed) added to `mobile/app/_layout.jsx`.

**APIs (champ-app):** `GET /api/social/feed` (paginated), `GET/PUT /api/social/settings` (Private mode), `GET /api/social/friends`, `GET /api/social/requests`, `POST /api/social/friends/request|accept|decline`, `DELETE /api/social/friends/[contactId]` (unfriend) + block, `GET /api/social/suggestions`, `GET /api/social/search?q=`, `POST/DELETE /api/social/reactions`, `GET /api/social/leaderboard`. All: getUser → contact → service client (the `/api/tier-status` skeleton); each checks the per-location kill-switch first.

## 8. Notifications (reuse the engagement loop)

New builders in the byte-synced `customer-notifications.js`: `buildFriendRequestPush`, `buildFriendAcceptedPush`, `buildReactionPush`. Wiring:
- **Friend request received / accepted** — immediate single push at the request/accept route.
- **Reaction received** — push to the author, **coalesced**: at most one push per (author, entity) per window, summarised ("Sarah + 2 others reacted to your session"). Idempotency/coalescing via a `customer_engagement_nudges`-style row keyed on (author_contact_id, entity_type, entity_id, window) — no new cron; inline at reaction time.
- Push `data.type` deep-links per §7.

## 9. Privacy / GDPR

- **Summary-only** enforced in the server projection — raw HR / avg / max HR never leave the service layer.
- **Private mode** (`member_social_settings.private_mode`): removes you from search + suggestions and hides your activity from friends' feeds (reversible; default off — discoverable, friends see summary).
- All cross-member reads are service-role + projection (never customer RLS), consistent with leaderboards/tiers.
- `block` + `unfriend` member-side. `ON DELETE CASCADE` from `contacts` cleans up friendships/reactions/settings when a contact is removed/unlinked.

## 10. Operator (un1t-crm)

- A per-location **kill-switch** via the location feature-gate pattern (`locations.features.social`-style). champ-app's social endpoints check it server-side (service client) and return disabled when off, so the app hides the Social tab. Default state TBD in the plan (likely off-until-enabled, Stillorgan-first, mirroring class-climate/challenges rollout posture).
- Otherwise member-app-only. No new operator UI beyond the existing Features toggle surface; the exact gate key + parity-linter handling resolved in the plan.

## 11. Testing (pure, per-repo style)

- `friendshipPairKey` (order-independence), `friendStatusFor` (all four states), `mergeFeed` (sort desc, stable, mixed types, empty), `reactionSummary` (counts, `mine`, empty, all four types), `rankSuggestions` (desc, tie-break, empty), `REACTIONS` shape.
- IO loaders covered by champ-app-side tests where they're pure-ish; the service-client reads validated by shape (projection has no raw HR, no contactId leak) — same bar as challenges-io.

## 12. Out of scope (v1)

Free-text comments; 1:1 friend challenges; club/group feeds; cross-location friends; reactions on tier-ups/challenge-wins; web push; staff moderation console. All → social v2.

## 13. Suggested phasing (for the plan)

1. **Graph + migration + pure helpers + tests** — `member_friendships` / `feed_reactions` / `member_social_settings` migration; byte-synced `social.js` + tests; the `contactIds` extension to the standings aggregation.
2. **Friends screen + APIs** — request/accept/decline/unfriend/block, search, suggestions; the Social tab shell + Friends segment (web + native).
3. **Feed + reactions** — `loadFeed` + the Feed segment + the reaction set/change flow + reaction push (coalesced).
4. **Friends leaderboard** — `loadFriendsBoard` + the Boards segment + the per-challenge "Friends" filter.
5. **Notifications + operator kill-switch + deep-links + dashboard teaser** — request/accept pushes, the kill-switch gate, deep-link cases, the home teaser.

Each phase is independently shippable.

## 14. To verify during plan-gathering (don't assume)

- **Achievements table shape** — confirm per-unlock rows exist with stable `id`s (the engagement loop consumed `notified_at` on them, so they should) and the exact table/column names, for the feed + reaction target.
- **Tier-up derivation** — confirm the `member_monthly_targets` shape and how to detect the month a cumulative count crossed a tier boundary (for the info-only tier-up feed item).
- **Session class stamp** — confirm `heart_rate_sessions` carries `glofox_event_id` / `class_name` (HR-CLASS-ALLOC.1) for both the feed summary and the shared-class suggestion join.
- **Feature-gate key** — confirm whether `social` should be a `locations.features` key, a `WEB_PERMISSIONS` entry routed through `WEB_ONLY_OK`, or a dedicated column, and how champ-app reads it.
- **Person-link edge case** — a person with two app-linked contacts ([[contact-identity-linking]]) is rare; confirm friending by `contact_id` (where `user_id` is set) is acceptable for v1.
