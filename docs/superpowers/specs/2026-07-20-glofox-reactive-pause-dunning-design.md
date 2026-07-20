# Reactive Glofox — pause capture, real-time dunning, profile display

**Date:** 2026-07-20
**Status:** Approved (design), implementing
**Trigger:** Glofox published OpenAPI v2.3.0. It exposes a `service` webhook whose payload carries the membership **pause window** (`start_date` / `duration` / `resume_date`) — data we capture nowhere today — plus a documented `invoice` webhook status lifecycle we can act on.

## Goal

React to Glofox `service` / `invoice` / `membership` webhooks in real time:
1. Capture the membership **pause window** (esp. `resume_date`) and surface "Paused · resumes 15 Aug" on the member profile.
2. Turn arrears **dunning** from manual-only into event-driven — auto-enroll on `PAST_DUE`, and (the gap nothing covers today) auto-**stop** when the invoice is paid/forgiven or the member pauses.

## Current state (verified in code)

- **One webhook receiver** `src/app/api/webhooks/glofox/route.js` — HMAC-SHA256 per-location over the raw body, dedup on `glofox_webhook_events.event_id`, dead-letter safety net, always 200s.
- `INVOICE_UPDATED` → `applyInvoiceWebhook` → `glofox_invoices` + LTV (returns `invoice_status`). **Already built.**
- `MEMBERSHIP_*` → member re-sync → writes `contacts.glofox_membership_state` (active/paused/cancelled/expired) and fires the `membership_state_change` sequence trigger. **Pause *status* already captured.**
- `SERVICE_*` → tagged only, **no handler**; the parser can't even resolve the contact from a service payload.
- **Pause window / `resume_date` captured nowhere** — the member GET has only a bare `subscription.paused` boolean.
- **Dunning is 100% manual** — only the Churn Radar "Send payment reminder" button enrolls into `locations.dunning_sequence_id`. No auto-enroll; **nothing stops a running dunning sequence when the invoice is paid**. The `INVOICE_UPDATED` tag is status-blind (fires on successful payments too) so it can't be a dunning trigger.
- Enroll primitive: `enrolContacts({sequenceId, contactIds, sourceType, sourceRef})` (idempotent). Exit primitive: `setEnrollmentStatus({enrollmentId, status, reason})`.
- Overdue list is **live** off `glofox_invoices` (≤60s cache) — not gated on the Monday snapshot.

## Data model — migration `428_glofox_reactive_pause_dunning.sql`

**New `glofox_services` table** (mirrors `glofox_invoices` idempotency — Glofox id PK, upsert-safe):
`id` (PK), `contact_id`, `location_id`, `membership_id`, `glofox_user_id`, `status`, `paused` bool, `pause_start_at`, `pause_resume_at`, `pause_duration_unit`, `pause_duration_amount`, `next_payment_at`, `raw_payload`, `created_at`/`updated_at`/`synced_at`. Indexes on contact/location/paused.

**Denormalized pause fields on `contacts`** (profile + churn read one row, no join — same pattern as `glofox_membership_state`):
`glofox_membership_paused_at TIMESTAMPTZ`, `glofox_membership_resume_at TIMESTAMPTZ`.

**Per-location dunning toggle on `locations`**: `dunning_auto_enroll BOOLEAN DEFAULT false`.

All `add column/table if not exists` + `comment on`, forward-only, applied via Supabase MCP against `iyvtbjjxdggiadzwwvdj`; `get_advisors` after.

## Pillar A — Service webhook → pause capture

- **Parser** (`src/lib/glofox.js`): add array-index support to `pluck()` and service paths so `parseGlofoxEvent` resolves the contact from `Payload.member_ids[0]` (populates `userId` → existing `glofox_member_id` lookup works, no new lookup logic).
- **`src/lib/glofox-services.js`** → `parseServicePayload` + `upsertGlofoxService` + `applyServiceWebhook(db, locationId, contactId, rawEvent)`:
  1. Parse the `pause` object + service fields.
  2. Upsert `glofox_services` (onConflict `id`).
  3. Denormalize onto `contacts`: set `glofox_membership_paused_at`/`resume_at` + `glofox_membership_state='paused'` when paused; clear the pause columns when not.
  4. Return `{ paused, resume_at, stateChanged }`.
- **Handler in `route.js`** action block (alongside the invoice block), best-effort try/catch. On a pause state flip, fire `triggerSequencesForMembershipStateChange`.
- **Resume reconcile:** the nightly `glofox-attendance-refresh` sync already flips paused→active; add a cheap step to clear the pause columns once `resume_at < now`. UI treats a past `resume_at` as no-longer-paused (compute-on-read).

## Pillar B — Reactive dunning + suppression (`route.js`, after `applyInvoiceWebhook`)

- `PAST_DUE` → **auto-enroll** into `locations.dunning_sequence_id`, gated on `dunning_auto_enroll`. Reuse the server-side trouble re-derivation + active/manual guard from `churn-radar/action`. `enrolContacts({sourceType:'invoice_past_due', sourceRef: invoiceId})` (idempotent → retry storms with new invoice ids collapse to one enrollment). Skip if contact state is `paused`.
- `PAID` / `FORGIVEN` → **suppress** via new `exitDunningForContact(db, locationId, contactId, reason)` → exits `status='active'` dunning enrollments (`reason:'invoice_paid'`). No-op when nothing active.
- Member **paused** → suppress in-flight dunning (`reason:'membership_paused'`).
- Optional: `invalidateRadar` on these events so the Overdue list is instant.

## Pillar C — Profile display ("visible neutral banner + card date")

- **Header** (`ContactHeaderBand.jsx`): neutral amber chip next to the name — "Paused · resumes 15 Aug" — from `glofox_membership_state==='paused'` + `glofox_membership_resume_at`. **Not** in the "Needs attention" band (a pause isn't a chase item). `bg-amber-500/10 text-amber-700`.
- **Card** (`GlofoxProfileCard.jsx`): append resume date to the paused chip + a "Paused since {date} · resumes {date}" line.
- Profile page + command-centre API already `select('*')` → new columns flow automatically. New `formatResumeDate` in `src/components/contact/format.js`.
- **Mobile**: mirror in `mobile/components/ContactGlofoxCard.jsx` + `mobile/app/contacts/[id].jsx`; port the formatter into `mobile/lib/contact-command-centre.js` (can't import `src/lib`).

## Idempotency & failure handling

- Delivery dedup via `glofox_webhook_events.event_id`; `enrolContacts` + suppression independently idempotent (guard `status='active'`). Every new block in its own try/catch, log-only — route always 200s. Never gate on invoice-id uniqueness (new id per attempt).

## Safety defaults

1. **Reactive dunning is opt-in per location, default OFF** (`dunning_auto_enroll=false`) — nothing changes until flipped in Churn Radar settings.
2. **Paused members are never dunned** and are auto-exited from an in-flight dunning sequence.

## Testing

`glofox.test.js` (service parser + array paths), `glofox-services.test.js` (pause state machine), reactive-dunning enroll/suppress unit tests, `format`/header tests. Then CI mirror (6 checks) + `npm run build`.

## Phasing (each independently shippable)

- **Phase 1** — data model + service webhook pause capture + profile display (web + mobile). *Directly answers the ask.*
- **Phase 2** — reactive dunning enroll on `PAST_DUE` (opt-in toggle).
- **Phase 3** — suppression (paid/forgiven/paused → exit) + churn "resumes in N days" + cache invalidation.

## Verify-on-implementation

- Confirm `StringToSign` for the webhook signature = raw body (matches existing `verifyGlofoxSignature`). ✅ (existing impl already does this.)
- Confirm the live `SERVICE_UPDATED` payload nests `member_ids`/`pause` under `Payload` as the spec shows (parser is defensive either way).
