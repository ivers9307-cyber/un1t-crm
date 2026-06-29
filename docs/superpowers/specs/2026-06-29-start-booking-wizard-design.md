# Spec — `/start` booking wizard (consultation or class) for Meta ad leads

**Date:** 2026-06-29 · **Status:** Approved (design) · **Repo:** un1t-crm · **Location:** Stillorgan only

## Goal

A second public landing page for Meta ads where the lead **books at the point of capture** — either a **free consultation** or a **free class** — instead of just leaving details. Confirmation is delivered by **WhatsApp**. Existing Glofox accounts are reconciled (credits reused, repeat free-class abuse gated to staff review).

This complements the first page (`/free-class`, which captures a lead then WhatsApps them to choose). `/start` is the "book now" variant.

## The page — 3-step wizard

**URL:** `un1tdublin.com/start` (public; allowlisted in `brands.js` un1t-marketing + `proxy.js` + `AppShell` PUBLIC_PATHS, same as `/free-class`). `noindex`.

1. **Choose:** "Book a free consultation" or "Book a free class"
2. **Your details:** first name, last name, email, phone (normalised to E.164 for WhatsApp) → **Next**
3. **Book it:**
   - *Consultation* → calendar + slot picker (existing flow)
   - *Class* → pick a day → pick a time (live Glofox classes)
4. **Confirmation screen** + a **WhatsApp** confirming it

Built on the existing `BookingWidget.jsx` multi-step pattern; reuses the Irish phone formatting, validation and consent checkbox.

## Path A — Consultation (reuse, synchronous)

Wires the **existing public consultation flow** into the wizard, unchanged in substance:
- `GET /api/public/bookings/free-un1t-consultation` (+ `/slots?date=`) for availability (`computeAvailableSlots`).
- `POST /api/public/book` to create the `bookings` row (trigger `handle_new_booking` creates the contact + new_lead deal; Glofox push if configured).
- Books instantly → on-page confirmation **and** a WhatsApp confirmation (new template, see below).

Consultations are **always allowed** regardless of account/history (no review gate).

## Path B — Class (new, asynchronous)

The slow part is Glofox (account create + booking + live credit checks). So the page **does not wait**:

1. **On submit:** create/find the CRM contact (`findOrCreateRaceContact`), normalise phone → `wa_phone`, attribute the lead (campaign), enqueue a **class-booking request** (`status='queued'`), and return immediately → page shows *"You're being booked — watch for a WhatsApp."*
2. **A drain cron** (`/api/cron/process-class-bookings`, every minute, `CRON_SECRET` + `cron_heartbeats` + `stampHeartbeat`) picks up `queued` rows and runs the **decision tree** below.
3. **Success → WhatsApp confirmation** (class-booked template). **Review/failure → staff `/approvals` queue**; on approval the booking is made + the same confirmation fires.

### Decision tree (per queued class request)

Look up the Glofox account by email (`findOrCreateGlofoxMember` search-only) + check "has attended a class before" (see Detection) + live credit balance.

| Situation | Action |
|---|---|
| **Attended ≥1 class before** | → **Review queue** (no auto-book). Staff confirm → book + WhatsApp. |
| **No Glofox account (brand new)** | Create trial account (`createIfMissing`, `attachTrial` → grants the free-class credit) → book the class → ✅ WhatsApp. |
| **Account exists, has unused credits, never trained** | Book against existing credits (do **not** create/grant). **Reclassify as fresh lead.** → ✅ WhatsApp. |
| **Account exists, no credits, never trained** | Grant the trial (treat as new) → book → ✅ WhatsApp. |
| **Any Glofox failure (account create or booking)** | → **Review queue** so staff can book manually. |

**Detection — "attended a class before":** check `class_bookings` (mig 288) for the contact's `glofox_member_id` with `attended = true`. *(Risk: `class_bookings` may not hold full history; implementation verifies completeness and falls back to a live Glofox attendance check if needed.)*

**"Reclassify as fresh lead":** set `contacts.pipeline_stage_slug` to the new-lead stage (re-open / ensure an open `new_lead` deal) + apply the campaign tag + set `lead_source`. Surfaces re-engaged dormant contacts to the team as fresh opportunities.

**Credits:** read live from Glofox (`/2.0/members/{id}` → credits); not cached. Acceptable because the whole class path is async.

## Review / approval queue (reuse)

Reuse **`agent_membership_requests`** (`kind='class_booking'`, `status='pending'`) + the existing `/approvals` + `/settings/customer-agent/requests` UI. Review items carry the class + contact in `details`. The approve action triggers the actual Glofox booking + the WhatsApp confirmation. (Implementation note: confirm/extend the existing approve handler so approving a `class_booking` from this flow performs the booking.)

## WhatsApp confirmations (new templates — operator creates, content below)

No 24h session window after a web booking, so confirmations are **templates** sent via the existing template-send infra (reuse `maybeSendCampaignWhatsappWelcome`'s send pattern from PR #707: send to the lead's E.164 phone, log to the conversation). Category **UTILITY** (transactional → faster approval, fewer restrictions).

**Template `booking_class_confirmed`** (UTILITY, en):
> Hi {{1}}, you're booked in! 🎉 Your class **{{2}}** at UN1T Stillorgan is confirmed for {{3}}. Bring trainers, water and yourself — beginners welcome. Need to change it? Just reply.
> `{{1}}`=first name, `{{2}}`=class name, `{{3}}`=day & time.

**Template `booking_consult_confirmed`** (UTILITY, en):
> Hi {{1}}, your free consultation at UN1T Stillorgan is booked for {{2}}. We'll talk through your goals and get you started. See you then — need to rearrange? Just reply.
> `{{1}}`=first name, `{{2}}`=day & time.

*(Optional, not in v1: a "request received, we'll confirm shortly" holding template for review-queue cases. For now the confirmation fires once staff approve.)*

## Attribution

New campaign key in `LEAD_CAMPAIGNS` (`src/lib/leads.js`), e.g. `stillorgan-start` → tag `stillorgan-start`, `lead_source = meta_book`. The `/start` page tags every lead via the same secure server-side mechanism as `/free-class` (PR #706). This page books directly, so it does **not** fire the `/free-class` WhatsApp welcome — the booking confirmation replaces it.

## Reuse vs new

**Reuse:** `BookingWidget.jsx` pattern · `booking-slots.js` / `computeAvailableSlots` · `POST /api/public/book` (consultation) · `findOrCreateRaceContact` · `findOrCreateGlofoxMember` (account dedup + trial) · `createBooking` (Glofox class booking) · `agent_membership_requests` + `/approvals` UI · the template-send pattern from PR #707 · `LEAD_CAMPAIGNS` attribution.

**New:** the `/start` wizard shell + choose-step · public **list-classes** endpoint (`GET /api/public/classes` — shaped via `shapeClassListForAgent`) · the **class-booking request queue** (new table) + **drain cron** · the decision-tree logic · the two WhatsApp confirmation templates · the "attended before" detection + "reclassify" helper.

## Data model (new)

`class_booking_requests` (queue):
- `id`, `location_id`, `contact_id`, `glofox_event_id`, `class_name`, `starts_at`
- `status` — `queued` → `processing` → `booked` | `needs_review` | `failed`
- `attempts`, `last_error`, `created_at`, `updated_at`
- On `needs_review`/`failed` → also insert an `agent_membership_requests` row so it appears in `/approvals`.

Forward-only migration via Supabase MCP; `get_advisors` after DDL; advisor RLS pattern per CLAUDE.md.

## Phasing

- **Phase 1** — wizard shell + choose-step + **consultation path** (mostly reuse) + consult WhatsApp confirmation + attribution. Shippable fast; you can run ads to the consult option immediately.
- **Phase 2** — **class path**: list-classes endpoint, queue table + drain cron, decision tree, class WhatsApp confirmation, review-queue integration.

## Dependencies / preconditions

- Mia enabled for Stillorgan ✅ (done). Glofox connected for Stillorgan ✅. Stillorgan trial membership configured (`locations.settings.glofox.trial_membership_id`) — **verify it grants the intended free-class credit(s)**.
- Operator creates the two UTILITY confirmation templates (content above) → Meta approval.
- ⚠️ WhatsApp number is **quality_rating RED** — booking confirmations are UTILITY/expected (low block risk), but watch quality.
- Reuses campaign infra from PR #706 and the send pattern from PR #707 — implementation branch stacks on / rebases after those merge.

## Risks / open items (resolve in planning)

- `class_bookings` historical completeness for the "attended before" gate (fallback: live Glofox attendance check).
- The existing `agent_membership_requests` approve handler may need extending to actually perform the booking for this flow.
- Glofox booking idempotency under cron retries (don't double-book; key on the request id / Glofox booking id).
- Live credit-check + booking latency and Glofox error taxonomy (which errors → retry vs → review).

## Out of scope (YAGNI)

Payments/memberships (free offers only), multi-location (Stillorgan only), rescheduling/cancellation UI (lead replies → Mia/team), the optional holding template.
