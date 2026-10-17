# MIAORG.1 — Mia at organisation level (Phase 3): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mia's settings are set once per organisation with per-studio overrides, and Mia works properly at a studio without Glofox (Hatch Street, on un1t.online): she answers from that studio's knowledge, reads its timetable, sends its booking link, and hands account questions to that studio's staff. Follow-ups and check-ins go out through the thread's own number.

**Architecture:** One resolver `resolveAgentSettings(db, locationId)` merges `DEFAULTS ← org_settings.customer_agent ← locations.settings.customer_agent`, never inheriting the studio-only keys. Every runtime reader switches to it. The studio editor saves only the fields it overrides; a new org-defaults editor (masters, org admins) writes `org_settings.customer_agent`. Mia's tool list and prompt become capability-aware, driven by the studio's membership source (`resolveMembershipSource` / provider `capabilities`).

**Tech Stack:** Next.js 16, Supabase (service role), vitest, PGlite; Anthropic Messages API via `anthropicMessages` (unchanged).

**Spec:** none written (Richard opted out of questions, 17 Oct 2026: "just start from the outline"). The outline agreed on 15 Oct is binding: org defaults + per-studio overrides via one resolver; the on/off switch stays per studio, default off, never inherited; booking/membership tools off where the source isn't Glofox; un1t.online link for booking; account questions to the studio's staff; follow-ups/check-ins through the thread. Decisions below marked **(controller's call)** are mine.

**Worktree:** `/Users/richardivers/code/un1t-crm-mia-org`, branch `feat/mia-org-settings` (off origin/main 1ad11246). `npm ci` done.

## Facts from the code + live data (17 Oct)
- Hatch: `membership_source = 'un1t_online'`, 59 upcoming `un1t_events`, 135 contacts linked by `un1t_user_id`, 0 `agent_knowledge` rows, no `customer_agent` blob, no WhatsApp number (threads reply via Stillorgan's, Phase 1). The un1t.online provider declares every capability false; Hatch classes are NOT in `class_occurrences`.
- Stillorgan: full `customer_agent` blob, Mia LIVE (enabled, follow-ups + check-ins on). `org_settings` has no customer_agent column. `profile_organizations` has 0 org admins (masters only today).
- Tools are one fixed list for every studio (`ALL_AGENT_TOOLS`, auto-reply.js:110, cached). The prompt says "You CAN book classes" unconditionally (prompt.js:112-127). No `booking_url` key exists in the contract.
- `handoff_sla_minutes` is read (handoff-sla.js:65) but missing from the contract, so every editor save erases it (existing bug).
- `resolveConsultationEventType` (booking-tools.js:392-397) doesn't check that a pinned `consultation_event_type_id` belongs to the studio.
- Follow-up / check-in sends use `{ locationId }` (followups.js:433, 473-475, 956, 1015-1017) and template lookups by studio (454-458, 989-993): they fail at Hatch. First-class check-ins can't fire at Hatch (they need Glofox `last_attended_at`).

## Global Constraints
- **Studio-only keys, never inherited from the org (controller's call on the list):** `enabled`, `test_mode`, `test_phones`, `consultation_event_type_id`, `booking_mode`, `cancellation_form`, `booking_url`, `booking_cta_label`, `membership_signup_url`, `membership_cta_label`, `monthly_points_target` (added by the final review: champ-app reads it off the raw studio blob, and it starts tier pushes). Everything else in `DEFAULTS` is inheritable.
- Object keys (`limits`, `followups`, `first_class_checkin`, `inline_suggestion`, `quiet_hours`) merge per field (org fields under studio fields).
- **No behaviour change on deploy:** with `org_settings.customer_agent` NULL everywhere, every studio resolves exactly as today (Stillorgan's blob is complete; Hatch has none ⇒ off).
- A failed STUDIO read keeps today's behaviour for that caller (most skip / 500). A failed ORG read: log `logError('agent-settings', …)` and resolve without the org layer (a reply in the studio's own settings beats no reply; CLAUDE.md "never a louder failure").
- **Never surface class capacity to customers:** timetable answers carry class name + start time only, never `capacity`, `bookings_count` or "spaces left".
- Customer copy operator-editable with defaults; no em-dashes in defaults.
- Org editor: master or org admin via `resolveAdminOrgId` (`org-admin.js`). Studio editor: unchanged rule (`canEditMiaSettings`).
- `tests/whatsapp-config-callers.test.js` is EXACT; migrations forward-only; mig 729 applied BEFORE merge.
- Fictional ids in tests; supabase builders are thenables (destructure + check `error`).

## Review Focus
1. **Saving the studio editor after the org layer exists** must not freeze inherited values into the studio blob (else org changes stop reaching that studio). Test in Task 3.
2. **A Hatch customer asks "can I book the 7am class?"** → no booking tool is offered; Mia shares the booking link (or hands off if none is set), never claims to have booked. Test in Task 5.
3. **Org read failure mid-turn** → Mia still answers in the studio's own settings, logged. Test in Task 1.
4. **A Hatch thread bound to a Stillorgan-homed contact** asks about their membership → no Glofox membership tool at Hatch, so Mia never reports the Stillorgan membership as Hatch's; she hands off. Test in Task 5.
5. **Timetable answer at Hatch** never includes capacity or bookings counts. Test in Task 5.

---

### Task 1: Migration 729 + resolver + contract

**Files:** create `supabase/migrations/729_org_settings_customer_agent.sql`, `tests/migration-729-org-customer-agent.test.js`, `src/lib/agent/settings-resolve.js` (+ test); modify `src/lib/agent/settings-contract.js` (+ its test).

**Interfaces — produces:**
- `org_settings.customer_agent jsonb NULL` (no default). Comment: readable by org members through the existing `org_settings_select` policy; it holds copy and tuning, no secrets (decision, stated in the migration).
- `STUDIO_ONLY_KEYS` (Set, exported from settings-contract.js) = the Global Constraints list; `INHERITABLE_OBJECT_KEYS` = `['limits','followups','first_class_checkin','inline_suggestion','quiet_hours']`.
- Contract gains `booking_url` (http(s) URL ≤ 500, nullable), `booking_cta_label` (≤ 40, nullable), `handoff_sla_minutes` (int 5..1440, nullable) — in `DEFAULTS` (null), `SettingsSchema`, `buildCustomerAgentSettings`.
- `buildCustomerAgentSettings(input, { only } = {})`: when `only` (a Set of keys) is given, the built blob contains just those keys (for override-only saves); without it, unchanged behaviour.
- `mergeAgentSettings({ org, studio }) → { settings, sources }` (pure): `settings = DEFAULTS ← org (minus STUDIO_ONLY_KEYS) ← studio`, object keys merged per field; `sources[key]` ∈ `'studio'|'org'|'default'`.
- `resolveAgentSettings(db, locationId) → Promise<{ ok: true, settings, sources, studio, org, location } | { ok: false, reason: 'read_failed'|'not_found' }>` where `location = { id, name, timezone, organization_id, settings }` (the full row's settings for callers needing siblings like `wa_card_sets`). Studio read failure → `{ ok:false }`; org read failure → logged, `org = null`.

- [ ] Tests first: merge precedence; studio-only keys ignored from org (incl. `enabled: true` at org never turns a studio on); object per-field merge; sources; org read failure → ok with org null + logError; studio missing → not_found; mig 729 PGlite (column added, nullable, idempotent); contract: new keys validated/round-tripped, `handoff_sla_minutes` survives a build, `only` builds a partial blob.
- [ ] Implement; run `npx vitest run src/lib/agent/settings-* tests/migration-729*`, `check:select-columns`, `check:guardrails`.
- [ ] Commit `MIAORG.1 — mig 729 org_settings.customer_agent; resolveAgentSettings; contract gains booking link + handoff_sla_minutes`.

### Task 2: Every runtime reader uses the resolver

**Files (modify):** `src/lib/agent/auto-reply.js` (~l.468-485), `welcome-greeting.js` (~42), `followups.js` (~521-528, 818-825), `handoff-sla.js` (~208, 337-358), `approval-suggest.js` (~190-196), `notify.js` (~141), `book-chat-copy.js` (~54), `src/lib/live-class.js` (~648), `hr-post-class-email.js` (~123), `integrations-hub.js` (~1216), `src/app/api/agent/membership-requests/[id]/suggest/route.js` (~40), `…/membership-requests/[id]/route.js` (~132, 753), `src/app/api/contacts/[id]/cancellation-form/route.js` (~74), `src/app/api/public/cancellation-form/[token]/route.js` (~62-68), and their tests.

**Interfaces — consumes:** `resolveAgentSettings` (Task 1).

- [ ] Replace each `loc.settings?.customer_agent` read with the resolver's `settings` (keep each caller's existing failure handling: a studio read failure behaves as today's read failure). Where a caller loops every location (followups, handoff-sla), resolve per location inside the loop (one org read per organisation per run is fine; cache by `organization_id` within the run). `handoff-sla.shouldSweepLocation` keeps "the STUDIO has a config" (`studio` non-null), not "resolved settings exist" (else every studio with only org defaults would sweep).
- [ ] Add a guard test `tests/agent-settings-single-reader.test.js`: scan `src/` (non-test) for `customer_agent` property reads off a `settings` object outside `settings-resolve.js`, the settings routes and settings-contract.js → fail (so a new reader can't bypass the resolver).
- [ ] Tests: each touched module's existing tests pass with the resolver mocked/faked; one test per module that an org-only value (e.g. `tone`) now reaches it.
- [ ] Run `npx vitest run src/lib/agent src/app/api tests`, `check:guardrails`, `check:select-columns`.
- [ ] Commit `MIAORG.1 — every Mia reader resolves org defaults under the studio's settings`.

### Task 3: Studio editor saves overrides only

**Files (modify):** `src/app/api/settings/customer-agent/route.js` (+ test), `src/app/settings/customer-agent/CustomerAgentClient.jsx` (+ test).

- [ ] GET returns `{ settings (resolved), studio (raw blob or null), org (org layer or null), sources, … existing fields }`.
- [ ] PUT accepts the same body plus `overridden: string[]` (keys the studio sets). It saves ONLY those keys (`buildCustomerAgentSettings(body, { only })`), always including the studio-only keys present in the body. Back-compat: a body without `overridden` saves as today (whole blob) — so an old client tab can't wipe, it just freezes values (same as today).
- [ ] Client: each inheritable field shows a small "Organisation default" tag when `sources[key] === 'org'` (or 'default'), editing it marks it overridden, and a "Use organisation default" link removes the override. Studio-only fields show no tag. Sends `overridden`. (Review Focus 1.)
- [ ] Tests: saving without touching inherited fields leaves them out of the blob; editing one adds just it; "use default" removes it; enabled/test_mode always saved; legacy body without `overridden` behaves as today.
- [ ] Commit `MIAORG.1 — studio Mia settings save overrides only; inherited fields show their source`.

### Task 4: Organisation defaults editor

**Files:** create `src/app/api/settings/customer-agent/org/route.js` (+ test); create `src/app/settings/customer-agent/OrgDefaultsClient.jsx` (+ test) mounted from `src/app/settings/customer-agent/page.js` for users who pass `resolveAdminOrgId` (master or org admin); modify `src/lib/openapi.js`.

- [ ] GET `?organization_id=` → `{ success, data: { settings (org layer merged over DEFAULTS, studio-only keys omitted), raw } }`; PUT `{ organization_id, settings, overridden? }` → validates with `SettingsSchema` minus studio-only keys (rejects them with 400), upserts `org_settings.customer_agent` (row may not exist: upsert on `organization_id`). Auth: `resolveAdminOrgId`; non-admins 404.
- [ ] "Start from a studio's settings" action: PUT `{ organization_id, copy_from_location_id }` copies that studio's inheritable keys into the org layer (studio must be in the org; caller must be master/org admin). Does not touch the studio blob.
- [ ] UI: a section "Organisation defaults (all studios)" above the studio editor for admins: the same fields minus studio-only ones, the copy action with a studio select, Save. Copy: "Studios use these unless they set their own."
- [ ] Tests: auth (master ok, org admin ok, owner without org admin 404, other org 404), studio-only keys refused, upsert when no row, copy action.
- [ ] Commit `MIAORG.1 — organisation defaults for Mia (masters, org admins)`.

### Task 5: Mia that works without Glofox

**Files (modify):** `src/lib/agent/auto-reply.js` (tool list per turn), `prompt.js`, `booking-tools.js` (`list_upcoming_classes`, `resolveConsultationEventType`), `account-tools.js` (if a tool needs a gate), tests.

- [ ] **Tool set by capability (controller's call):** compute `provider.capabilities` for the studio (`resolveMembershipSource` → provider). When `bookings` is false: drop `book_class`, `cancel_class_booking`, `list_my_upcoming_bookings`, `get_my_next_class`, `get_my_recent_attendance`, `get_my_membership`, `get_my_payment_reminder` (and any other Glofox-read tool you find). Keep `list_upcoming_classes`, identity, request_* , consultation, event, card and lead tools. Build two cached tool arrays at module load (full / no-booking) so prompt caching stays stable per variant.
- [ ] **Timetable without Glofox:** `list_upcoming_classes` at an `un1t_online` studio reads `un1t_events` for that studio (`starts_at` in the next 14 days, ordered, limit 40) and returns `{ classes: [{ name: title, starts_at }] }` ONLY — never `capacity`, `bookings_count`, `access_mode` (Review Focus 5; memory: never surface capacity). Times rendered in the studio zone (`zoneOfLocation`). A read failure answers the existing `no_booking_system` shape.
- [ ] **Prompt:** replace the unconditional "You CAN book classes" with capability text: Glofox studios keep today's wording verbatim; others get "You can't book or cancel classes here. To book, send the studio's booking link: <booking_url>" when `booking_url` is set, else "To book, hand the customer to the team." Plus "For membership, payments or account questions, hand off to the team." When `booking_url` is set it is sent as a link button with `booking_cta_label` (default "Book a class"). Glofox studio prompt text must be byte-identical to today (test).
- [ ] **Consultation type guard:** `resolveConsultationEventType` ignores a pinned `consultation_event_type_id` whose `location_id` isn't the studio's (falls back to today's discovery).
- [ ] Tests: no-booking tool set at un1t_online; full set at glofox (unchanged); timetable payload has no capacity fields; prompt variants; Glofox prompt unchanged; Hatch thread bound to a Stillorgan contact can't reach `get_my_membership` (Review Focus 4); booking request at Hatch → link or handoff, never "booked" (Review Focus 2, at the prompt/tool level).
- [ ] Commit `MIAORG.1 — Mia without Glofox: timetable from un1t.online, booking link, account questions to the team`.

### Task 6: Follow-ups and check-ins through the thread

**Files (modify):** `src/lib/agent/followups.js` (sends at ~433, 473-475, 956, 1015-1017; template lookups ~454-458, 989-993), tests, `tests/whatsapp-config-callers.test.js` (row text/counts).

- [ ] Each send passes `{ locationId, replyInConversation: <the conversation id> }`. For check-ins, use the contact's WhatsApp conversation at that studio (look it up; none → skip as today with reason `no_conversation`). Template rows read from `templateLocationIdFor(locationId, conversationId)`.
- [ ] Tests: a Hatch-filed conversation's follow-up sends through the thread with Stillorgan's template; a Stillorgan one unchanged.
- [ ] Commit `MIAORG.1 — follow-ups and check-ins go through the thread's number`.

### Task 7: CI mirror, build, final review, PR (controller)
- [ ] Each CI-mirror command + `npm run build`; final whole-branch review (Opus); one fix wave; push; PR; changelog entry.

### Task 8: Rollout (Richard's go-ahead)
- [ ] Apply mig 729 (before merge), `get_advisors`. Merge (Richard). Verify Stillorgan resolves identically (diff resolved vs raw blob = no change).
- [ ] Richard: Organisation defaults → "Start from Stillorgan"; Hatch studio settings: booking link, holding message, welcome; Hatch knowledge (Settings → Customer agent → Knowledge at Hatch); then switch Hatch on (test mode first with his phone, `enabled=false` + `test_mode=true`).
