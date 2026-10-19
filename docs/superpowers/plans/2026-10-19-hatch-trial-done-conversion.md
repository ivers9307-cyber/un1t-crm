# Hatch Trial Done → Membership or Class Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two hours after a Hatch Street lead finishes their trial, send Hatch's approved opener template; if they reply, Mia knows why and sells a membership or class pack through MIAHATCH.6's payment link; if they don't, send one follow-up the next day.

**Architecture:** A new runner (`runTrialDoneOutreach`) rides the existing `agent-followups` cron. It finds people in the `trial_done` column of each un1t.online studio's acquisition board (deals, not `pipeline_stage_slug`), computes when their trial ended from the un1t.online mirror, rechecks eligibility immediately before every send, and records each person once in a new service-role table `trial_done_outreach`. Mia's reply path reads that row and adds a short trial-done block to the uncached part of her system prompt. The board classifier learns the "2 attended + trial expired" rule through a un1t-only wrapper, leaving Stillorgan's Glofox board untouched.

**Tech Stack:** Next.js 16 route handlers, Supabase (service role), vitest, WhatsApp Cloud API through `src/lib/whatsapp.js`.

**Spec:** `docs/superpowers/specs/2026-10-19-hatch-trial-done-conversion-design.md`

## Global Constraints

- Hatch Street location `28c78d6b-f7b3-4edf-8c7c-840bd047b3f4`; code is studio-generic: it runs at every studio whose `membership_source = 'un1t_online'` and whose `customer_agent.trial_done.enabled` is true.
- Default **off**: `customer_agent.trial_done.enabled = false`, a studio-only key (never inherited from the org layer). `only_contact_ids` (non-empty) restricts it to test contacts.
- Templates (approved at Hatch only): opener `hatch_trial_done_checkin`, follow-up `hatch_trial_done_followup`, one variable `{{1}}` = first name. Names are settings fields with these defaults.
- Who: attended ≥ 3, or attended = 2 and the trial expired. Trial expiry = trial grant time + the trial product's `raw->>'expire_credits_in_days'` days (7 today; read, never hard-coded). 0–1 attended is never Trial done.
- Excluded at every send: active member at another studio (`loadActiveElsewhere`), staff (contact email equals a non-tombstoned `profiles.email`, case-insensitive), anyone with `membership_history` or `paid_pack` in `shapeTrialEligibility` reasons, anyone whose current classification is no longer `trial_done`, `wa_status` in `opted_out | blocked | undeliverable`, no Hatch `contact_location_preferences.whatsapp_marketing = true` row.
- Timing: opener at trigger + `delay_hours` (2); not sent if now > trigger + `stale_after_hours` (24); only inside `proactiveWindowOpen` (09:00–19:59 studio clock and outside quiet hours); the 24-hour marketing frequency cap defers (never closes).
- One follow-up only: a template 22–30 h after the opener if the customer never replied; or, if they replied and went quiet, one Mia-written in-window nudge 3–20 h after their last message. Neither if they bought, opted out or are no longer eligible.
- Once per person per studio, ever (`unique (location_id, contact_id)`).
- No em-dashes in any customer-facing text, including Mia's instruction block. Customer copy is operator-editable (settings field + default).
- No charging: the only money path is MIAHATCH.6's `send_purchase_link`. `POST /purchases/charge` stays €0-trial-only.
- Migrations: next number **756** (754 is unused but skipped to avoid a collision with any open branch). Service-role-only table per mig 752's pattern. Apply via Supabase MCP before the code deploys.

## Review Focus

1. **They buy between the opener and the follow-up.** Expect no follow-up and the row closed `purchased`. Test in Task 5 (`followup skipped and closed when the person bought`).
2. **A Stillorgan-home contact who trialled at Hatch.** Expect them found via Hatch's deal, consent read from Hatch's row, and the thread at Hatch. Test in Task 4 (`finds a sibling-studio contact through the Hatch deal`).
3. **Two cron ticks overlap.** Expect exactly one opener (claim with lease). Test in Task 4 (`a second runner losing the claim sends nothing`).
4. **The template isn't approved yet, or was rejected.** Expect nothing sent, nothing closed, a structured skip reason, and the opener still due on a later tick. Test in Task 4 (`unapproved template skips without closing or claiming`).
5. **They reply STOP after the opener.** Expect no follow-up (Hatch consent false or `wa_status` opted out) and the row closed `opted_out`. Test in Task 5 (`opt-out after the opener closes the row`).

---

### Task 1: `trial_done_outreach` table (mig 756)

**Files:**
- Create: `supabase/migrations/756_trial_done_outreach.sql`
- Test: `tests/migration-756-trial-done-outreach.test.js`

**Interfaces:**
- Produces: table `public.trial_done_outreach` with columns
  `id uuid pk default gen_random_uuid()`, `location_id uuid not null references locations(id)`, `contact_id uuid not null references contacts(id) on delete cascade`, `deal_id uuid null`, `trigger_kind text not null check (trigger_kind in ('three_attended','two_attended_expired'))`, `trigger_at timestamptz not null`, `opener_claimed_at timestamptz`, `opener_sent_at timestamptz`, `opener_wa_message_id text`, `followup_kind text check (followup_kind in ('template','nudge'))`, `followup_claimed_at timestamptz`, `followup_sent_at timestamptz`, `followup_wa_message_id text`, `closed_at timestamptz`, `closed_reason text`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`; `unique (location_id, contact_id)`; index on `contact_id`; partial index `(location_id) where closed_at is null`.

- [ ] **Step 1: Write the failing test.** Follow `tests/` migration tests that read the SQL file (for example the mig 752 test, if present, or `tests/table-default-acl-guard.test.js`'s file reading). Assert the file creates the table with every column above, the unique `(location_id, contact_id)`, `ENABLE ROW LEVEL SECURITY`, `REVOKE ALL ON public.trial_done_outreach FROM anon, authenticated`, `GRANT SELECT, INSERT, UPDATE, DELETE ON public.trial_done_outreach TO service_role`, no `CREATE POLICY`, and a `DO $$` self-check that raises if RLS is off.
- [ ] **Step 2:** Run `npx vitest run tests/migration-756-trial-done-outreach.test.js`. Expected: FAIL, file missing.
- [ ] **Step 3:** Write the migration in mig 752's shape (`BEGIN; SET LOCAL lock_timeout = '5s'; … COMMIT;`, `IF NOT EXISTS`, `COMMENT ON TABLE` naming the spec).
- [ ] **Step 4:** Run the test plus `npm run check:select-columns` and `npx vitest run tests/table-default-acl-guard.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `TRIALDONE.1 — mig 756: trial_done_outreach (service role only)`.

### Task 2: "2 attended + expired trial" on the un1t board

**Files:**
- Modify: `src/lib/membership/reads/un1t-online.js` (`PRODUCT_COLS` ~:466, `EVENT_COLS` ~:468, `pipelineInputs` :610)
- Modify: `src/lib/membership/reads/un1t-online-shape.js` (`splitUn1tCredits` :494, `shapePipelineSnapshot` :596, `shapePipelineDateEvidence` :686)
- Modify: `shared/pipelines/acquisition-un1t.js`
- Modify: `src/lib/membership/reads/un1t-pipeline-dates.js` (`trial_done` case :101)
- Test: `src/lib/membership/reads/un1t-online-shape.test.js`, `shared/pipelines/index.test.js`, `src/lib/membership/reads/un1t-pipeline-dates.test.js`, `src/lib/membership/reads/un1t-online.test.js`

**Interfaces:**
- Produces: snapshot key `trial_expires_at: string|null` (ISO; newest trial grant + that trial product's `expire_credits_in_days` days; null when no trial or no expiry known).
- Produces: evidence keys `attended_ends: string[]` (ascending end times of attended bookings, from `un1t_events.ends_at`, falling back to `starts_at`) and `trial_expires_at` (copied from the snapshot).
- Produces: `classify(snapshot, now)` exported from `shared/pipelines/acquisition-un1t.js`: returns the shared `classifyContact` result, except `second_class` becomes `trial_done` when `snapshot.trial_expires_at` is in the past.
- Produces: `export function trialDoneEvidenceAt(evidence) -> { kind: 'three_attended'|'two_attended_expired', at: string } | null` in `un1t-pipeline-dates.js` (third attended END, or the expiry when exactly two attended).

- [ ] **Step 1: Write the failing tests.**
  - Shape: `snapshot.trial_expires_at is grant + expire_credits_in_days` (product raw `{ expire_credits_in_days: 7 }`, grant transaction at `2026-10-10T09:00:00Z` → `2026-10-17T09:00:00.000Z`); `no expiry when the product carries none` → null; `ledger-only grant counts` (a `un1t_write_events` trial row, no transaction).
  - Evidence: `attended_ends uses events.ends_at, ascending`.
  - Classify: `2 attended + expired trial is trial_done`; `2 attended + unexpired trial stays second_class`; `1 attended + expired stays first_class`; `3 attended is trial_done (unchanged)`; `the Glofox acquisition classify is unchanged for the same snapshot` (import `shared/pipelines/acquisition.js` and assert `second_class`).
  - Dates: `trialDoneEvidenceAt` returns `{ kind: 'three_attended', at: <3rd end> }`, `{ kind: 'two_attended_expired', at: <expiry> }`, and null for one attended; `un1tStageEnteredAt('trial_done')` returns the expiry for the two-attended case.
- [ ] **Step 2:** Run the four test files. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `expire_credits_in_days:raw->>expire_credits_in_days` to `PRODUCT_COLS` and `ends_at` to `EVENT_COLS`; carry `ends_at` onto bookings beside `starts_at` in `pipelineInputs`. Expose the newest trial's grant time and product id from `splitUn1tCredits` (it already computes `newestTrialAt`; return the product id too), and compute `trial_expires_at` in `shapePipelineSnapshot`. Update `shapePipelineSnapshot`'s doc comment ("exactly the keys `classifyContact` reads" plus `trial_expires_at` for the un1t wrapper). Replace the re-export in `acquisition-un1t.js` with a local `classify` that wraps `classifyContact`; keep `stages`, `inputSource`, `requiredFields`.
- [ ] **Step 4:** Run the four test files, then `npx vitest run src/lib/pipeline-reclassify.test.js src/lib/pipeline-classifier.test.js` and `npm run check:select-columns`. Expected: PASS (the select-columns checker resolves `raw->>` paths; if it cannot, add an allowlist entry with reason and expiry).
- [ ] **Step 5:** Commit `TRIALDONE.2 — un1t board: 2 attended + expired trial is Trial done`.

### Task 3: `customer_agent.trial_done` settings

**Files:**
- Modify: `src/lib/agent/settings-contract.js` (`DEFAULTS` :24, `SettingsSchema` :161, `buildCustomerAgentSettings` :347, `StudioSettingsSchema` :424)
- Modify: `src/lib/agent/settings-overrides.js` (`STUDIO_ONLY_KEYS` :29)
- Modify: `src/app/settings/customer-agent/CustomerAgentClient.jsx` (new card beside the first-class check-in card ~:1186; show only at a `un1t_online` studio, like the Hatch payments group :843)
- Test: `src/lib/agent/settings-contract.test.js`, plus the existing CustomerAgentClient test file if one renders the check-in card

**Interfaces:**
- Produces: `DEFAULTS.trial_done` =
  ```js
  {
    enabled: false,
    delay_hours: 2,
    stale_after_hours: 24,
    opener_template: 'hatch_trial_done_checkin',
    followup_template: 'hatch_trial_done_followup',
    followup_after_hours: 22,
    followup_max_hours: 30,
    nudge_after_hours: 3,
    nudge_max_hours: 20,
    daily_cap: 20,
    only_contact_ids: [],
    mia_instruction: TRIAL_DONE_MIA_INSTRUCTION_DEFAULT,
  }
  ```
  and `export const TRIAL_DONE_MIA_INSTRUCTION_DEFAULT` (exact copy, no em-dash):
  `This customer finished their trial at {studio} on {date}, and we messaged them about carrying on. Help them choose between the Foundation membership and a class pack. Call list_purchase_options before naming any product or price, lead with the Foundation membership, and once they choose, send the payment link with send_purchase_link. Answer their questions honestly and never pressure them.`
- `only_contact_ids`: when non-empty, the runner acts on these contacts and no one else (the MIA TEST switch; `enabled` + a list is a test, never live for everyone). Zod: up to 20 uuids.
- Zod: hours are integers 1–72, `daily_cap` 1–200, templates match `^[a-z0-9_]{1,512}$`, `mia_instruction` 1–1000 chars.

- [ ] **Step 1: Write the failing tests:** `DEFAULTS.trial_done matches the spec`; `trial_done is studio-only` (an org blob's `trial_done` is ignored); `rejects an em-dash in mia_instruction` (the studio save must refuse `—`); round-trip through `buildCustomerAgentSettings`.
- [ ] **Step 2:** Run `npx vitest run src/lib/agent/settings-contract.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the default, schema, merge, studio-only key and the card (switch, two template-name inputs, delay, mia_instruction textarea with the default as placeholder; owner/master only via the existing `canEditMiaSettings` gate).
- [ ] **Step 4:** Run the test file and `npm run lint`. Expected: PASS.
- [ ] **Step 5:** Commit `TRIALDONE.3 — customer_agent.trial_done settings (studio-only, off)`.

### Task 4: The runner: candidates, eligibility, opener

**Files:**
- Create: `src/lib/agent/trial-done.js` (pure decisions)
- Create: `src/lib/agent/trial-done-runner.js` (I/O)
- Modify: `src/app/api/cron/agent-followups/route.js` (call after `runFirstClassCheckins` :37, under its own try/catch; add `trial_done` counts to the heartbeat payload)
- Modify: `tests/whatsapp-config-callers.test.js` (new resolver caller row: a refusal is a recorded skip, `no_number`)
- Test: `src/lib/agent/trial-done.test.js`, `src/lib/agent/trial-done-runner.test.js`, `src/app/api/cron/agent-followups/route.test.js`

**Interfaces:**
- Consumes: `trialDoneEvidenceAt(evidence)` and un1t `classify` (Task 2); `trial_done_outreach` (Task 1); `DEFAULTS.trial_done` (Task 3); `loadActiveElsewhere(db, locationId)`; `membershipReadsFor`'s `pipelineInputs(db, locationId, { now })` → `{ success, data: { contacts, snapshots: Map, evidence: Map } }`; `shapeTrialEligibility`; `resolveAgentSettingsForLocation`; `proactiveWindowOpen`; `isFrequencyCapped`, `getLocationFrequencyCap`, `stampMarketingTouch` (`src/lib/frequency-cap.js`); `sendTemplateMessage`, `headerComponentFor`, `getOrCreateConversation`; `buildFollowupComponents`, `recordProactiveMessage` (`followups.js`).
- Produces (pure, `trial-done.js`):
  - `openerDecision({ trigger, outreach, nowMs, settings }) -> { action: 'opener' } | { action: null, reason: 'no_trigger'|'too_soon'|'stale'|'already_sent'|'closed'|'claimed' }`
  - `eligibilityVerdict({ stage, eligibilityReasons, activeElsewhere, isStaff, waStatus, hasConsent }) -> { ok: true } | { ok: false, reason: 'not_trial_done'|'purchased'|'active_elsewhere'|'staff'|'opted_out'|'no_consent' }` (`purchased` = reasons include `membership_history` or `paid_pack`; `opted_out` covers the three wa statuses).
  - `TRIAL_DONE_CLAIM_LEASE_MS = 30 * 60_000`
- Produces (runner): `export async function runTrialDoneOutreach(db, { nowMs = Date.now() } = {}) -> { openers, followups, skipped, reasons: Record<string, number> }`.
- Activity on each send: `activities` row `type: 'agent_trial_done'`, `kind: 'event'`, `location_id` = the studio, subject `Mia messaged after their trial` (opener) / `Mia followed up after their trial` (follow-up).

Runner per tick, per studio with `membership_source = 'un1t_online'` and `trial_done.enabled` and (`settings.enabled || settings.test_mode`):
1. Skip the studio when `proactiveWindowOpen` is false or it has no switched-on number (`studioOwnsWhatsAppNumber`), counting the reason.
2. Read open deals in the `trial_done` stage of the studio's enabled `acquisition_un1t` pipeline (deals query shape from `pipeline-reclassify.js:338`, `.range()`-paged). These include sibling-studio contacts.
3. One `pipelineInputs` call; for each deal's contact, `trigger = trialDoneEvidenceAt(evidence)`, `stage = classify(snapshot, nowMs)`, eligibility reasons via `shapeTrialEligibility` from the same rows (the reads module may expose them on the evidence; otherwise call `un1tOnlineReads.trialEligibility` per candidate).
4. Upsert the outreach row (`on conflict (location_id, contact_id) do nothing`) with `trigger_kind`, `trigger_at`, `deal_id`.
5. `openerDecision`; `stale` closes the row (`closed_reason 'stale'`); `too_soon` waits.
6. Recheck `eligibilityVerdict` with fresh reads (active elsewhere once per tick, staff by email, `wa_status`, Hatch consent row). Not ok → close with the reason.
7. Frequency cap capped → skip `frequency_capped` (row stays open).
8. Template: `whatsapp_templates` by studio + `opener_template`, newest first; not `APPROVED` → skip `template_not_approved` (row stays open, nothing claimed).
9. Claim: `update … set opener_claimed_at = now where id = … and opener_sent_at is null and (opener_claimed_at is null or opener_claimed_at < now - lease) returning id`; zero rows → `claimed`.
10. Send to `contact.wa_phone` with `{{1}}` = first name (fallback `there`), `{ locationId: studio.id, businessAccountId: template.business_account_id }`; no `messageId` or a throw → release the claim (`opener_claimed_at = null`) and count `send_failed` / `no_number`.
11. Record: `opener_sent_at`, `opener_wa_message_id`; `getOrCreateConversation(db, contact, studio.id)`; `recordProactiveMessage(…, { templateName })`; the activity; `stampMarketingTouch`. Daily cap: count today's `agent_trial_done` activities at the studio; at the cap, stop the studio.

- [ ] **Step 1: Write the failing pure tests** (`trial-done.test.js`): opener `too_soon` at trigger + 1h59m, `opener` at + 2h, `stale` at + 24h01m, `already_sent`, `closed`, `claimed` within the lease and not after it; every `eligibilityVerdict` reason, including `trial_used` alone being ok.
- [ ] **Step 2: Write the failing runner tests** (`trial-done-runner.test.js`, a recording fake db in the style of `followups-checkin-claim.test.js`; mock `sendTemplateMessage`):
  - `sends the opener 2 hours after the third class ends, at the studio, with the first name`
  - `finds a sibling-studio contact through the Hatch deal` (contact `location_id` = Stillorgan; consent read for Hatch; send and conversation at Hatch)
  - `a second runner losing the claim sends nothing`
  - `unapproved template skips without closing or claiming`
  - `staff, an active Stillorgan member, a purchaser and an opted-out contact are closed with their reason, never sent`
  - `frequency-capped is deferred, not closed`
  - `outside 09:00-19:59 nothing is sent`
  - `a studio with trial_done off is never read`
  - `only_contact_ids limits every send to those contacts`
  - `the daily cap stops the studio`
  - `a failed send releases the claim`
- [ ] **Step 3:** Run both. Expected: FAIL.
- [ ] **Step 4: Implement** `trial-done.js`, `trial-done-runner.js`, the cron call, and the config-callers row.
- [ ] **Step 5:** Run both files, `src/app/api/cron/agent-followups/route.test.js`, `tests/whatsapp-config-callers.test.js`, `npm run check:select-columns`, `npm run check:guardrails`. Expected: PASS.
- [ ] **Step 6:** Commit `TRIALDONE.4 — trial-done opener runner on the agent-followups cron`.

### Task 5: The one follow-up

**Files:**
- Modify: `src/lib/agent/trial-done.js`, `src/lib/agent/trial-done-runner.js`
- Test: `src/lib/agent/trial-done.test.js`, `src/lib/agent/trial-done-runner.test.js`

**Interfaces:**
- Produces: `followupDecision({ outreach, lastInboundAtMs, lastOutboundAtMs, nowMs, settings }) -> { action: 'template'|'nudge' } | { action: null, reason: 'no_opener'|'already_followed_up'|'closed'|'too_soon'|'window_passed'|'awaiting_mia' }`
  - No inbound after `opener_sent_at`: `template` from opener + 22h to opener + 30h; after 30h `window_passed` (close).
  - Inbound after the opener: the customer's last message is newer than Mia's last outbound → `awaiting_mia`; otherwise `nudge` from last inbound + 3h to + 20h; after 20h `window_passed` (close).
- Uses `composeAgentText` (`followups.js:410`) for the nudge with instruction `[STUDIO SYSTEM - not the customer] They finished their trial and talked with you about continuing, then went quiet. Write one short, friendly check-in that picks up where you left off. No prices unless you already gave them. No pressure.` sent with `sendTextMessage` inside the window.

Before any follow-up the runner reruns `eligibilityVerdict` (Task 4): `purchased` closes `purchased`, `opted_out`/`no_consent` closes `opted_out`, and so on. Claim/lease/record exactly as the opener, on the `followup_*` columns, `followup_kind` set at claim.

- [ ] **Step 1: Write the failing tests:** each `followupDecision` branch at its boundaries; runner `template at opener + 22h when they never replied`, `nudge 3h after their last message when Mia answered last`, `no follow-up while the customer is waiting on Mia`, `followup skipped and closed when the person bought`, `opt-out after the opener closes the row`, `only one follow-up ever`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** Last inbound / outbound come from `whatsapp_messages` on the studio's conversation for that contact, after `opener_sent_at`, ordered by `created_at desc`, limit 1 per direction.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `TRIALDONE.5 — one trial-done follow-up: template or in-window nudge`.

### Task 6: Mia knows it is a trial-done conversation

**Files:**
- Modify: `src/lib/agent/prompt.js` (`buildCustomerSystemPromptParts` :547, next to the `trialUsedClassLine` push :641)
- Modify: `src/lib/agent/auto-reply.js` (`systemOpts` :865)
- Create: `src/lib/agent/trial-done-context.js`
- Test: `src/lib/agent/trial-done-context.test.js`, the existing prompt test file (`src/lib/agent/prompt.test.js` or the one covering `trialUsedClassLine`)

**Interfaces:**
- Produces: `export async function trialDoneLineFor(db, { locationId, contactId, nowMs, settings, studioName, zone }) -> string|null`. Reads `trial_done_outreach` for `(locationId, contactId)` with `opener_sent_at` within the last 7 days and `closed_reason` not in (`purchased`, `opted_out`). Returns `settings.trial_done.mia_instruction` with `{studio}` → studio name and `{date}` → `trigger_at` as a day in the studio zone (e.g. `Friday 17 October`). Null otherwise, or on any read error (logged with `logWarn`, never thrown).
- Produces: `opts.trialDoneLine` in `buildCustomerSystemPromptParts`, pushed into `volatileParts` (uncached) only when a non-empty string.

- [ ] **Step 1: Write the failing tests:** `trialDoneLineFor returns the instruction with studio and date filled`; `null after 7 days`; `null when closed purchased`; `null and no throw when the read fails`; prompt: `the trial-done line is in the volatile block, not the cached one`; `absent line changes nothing` (byte-identical prompt to before).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement**; call `trialDoneLineFor` in `auto-reply.js` once per turn only when the thread's studio has `trial_done.enabled` and the contact is known, and add the result to `systemOpts`.
- [ ] **Step 4:** Run the two test files plus `npx vitest run src/lib/agent`. Expected: PASS.
- [ ] **Step 5:** Commit `TRIALDONE.6 — Mia's trial-done context block`.

### Task 7: CI mirror, PR, rollout

**Files:** `docs/changelog/entries/<PR>.md`

- [ ] **Step 1:** Run the full CI mirror from `CLAUDE.md` (`npm test && npm run lint && … && npm run check:ota-paths`) and `npm run build`. Expected: all pass.
- [ ] **Step 2:** Apply mig 756 via Supabase MCP `apply_migration` on `iyvtbjjxdggiadzwwvdj`, then `get_advisors` (security). Expected: no new findings.
- [ ] **Step 3:** Open the PR, add the changelog entry, push.
- [ ] **Step 4 (after merge and deploy, with Richard):**
  1. Confirm both templates are `APPROVED` at Hatch.
  2. Seed Hatch's offer list through `PUT /api/locations/<hatch>/mia-offers` (or the settings page): The Foundation Monthly Membership (`669d7b78-…`, lead), 10 Class Pack (`c7bbedea-…`), then the 3-month, 6-month and annual Foundation memberships and the 5, 20 and 30 class packs.
  3. MIA TEST run: set `trial_done.only_contact_ids` to MIA TEST's contact id and `enabled: true`, put MIA TEST in Hatch's `trial_done` state (or insert its outreach row with a `trigger_at` 2 h ago), and check opener, reply handling, offers and the payment link (MIAHATCH.6 `un1t_chat_actions_enabled` on). Richard pays by hand.
  4. Richard clears `only_contact_ids`, which switches it on for everyone at Hatch.
