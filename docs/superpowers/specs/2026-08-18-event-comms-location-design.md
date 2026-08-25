# Per-event comms location — design

**Date:** 2026-08-18
**Status:** Approved (design); pending implementation plan
**Related:** EVENTS-SMS-SENDER (#1447), EVENTS-SMS-SENDER-2 (#1448), HOST-MASTER.1 (mig 464)

## Problem

An event's outbound comms (confirmation SMS, payment-link SMS, confirmation email, reminder email) resolve their sender **identity from the event's `location_id`**. For a **hosted event** that `location_id` is the hidden per-host **anchor location** (`"<host> (host events)"`, `is_host_anchor=true`), which has:

- no `twilio_alpha_sender_id` → SMS fell through to the global `TWILIO_FROM` default (the **CCF Autos** sender). Patched defensively in #1447/#1448 (org-sender fallback) and by pinning the Pride anchor's sender.
- no `tenant_email_domains` row → `resolveEmailSender` falls back to the **global default** email sender (a UN1T address, so milder — but still not the location's identity).

The defensive fixes work but are heuristics ("the org's oldest sender-bearing location"). The structural gap: **a hosted event is not associated with the real UN1T location it is run from.** The venue is free text (`venue_name`); the only structured location is the sender-less anchor.

## Goal

Give each event an explicit, structured **comms location** — the real UN1T location whose Twilio + email identity its outbound comms use — defaulting to the org's master location, editable per event. Fixes SMS **and** email from one place, and is robust to a future host run from a non-default site (e.g. Hatch → "UN1THATCH").

## Non-goals

- No change for normal (non-host) events — their `location_id` already is a real location and stays the comms location.
- No host-facing control. Which UN1T identity to send from is a UN1T decision; the picker is staff-only. Host-portal-created events inherit the default.
- No new email/SMS sending mechanics — only which **location** feeds the existing `sendLocationSms` / `resolveEmailSender`.
- No backfill. Existing host events (NULL field) resolve to the org master via the resolver on the next send.

## Design decisions

- **Per-event**, not per-host — matches "associate the event to a location at creation" and lets one host run events from different sites.
- **Default = org master location** (`organizations.master_location_id`, Stillorgan for UN1T Group) via the existing `resolveMasterLocationId()`. Not a new "oldest location" heuristic.
- **Staff-only picker.**
- The anchor's own sender and the #1448 `resolveSenderLocation` org-fallback **stay as safety nets** beneath the explicit field.

## Data model

Migration (`race_events`):

```sql
ALTER TABLE public.race_events
  ADD COLUMN sending_location_id uuid NULL REFERENCES public.locations(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.race_events.sending_location_id IS
  'Real UN1T location whose Twilio + email identity this event''s outbound comms use. NULL → resolved at send time (host event → org master_location_id → anchor; normal event → location_id).';
```

Nullable, `ON DELETE SET NULL` (falls back to the resolver), no backfill.

## Resolver (single source of truth)

New module `src/lib/event-comms-location.js`:

```
resolveEventCommsLocation(db, event) → location row | null
```

where `event` carries at least `{ location_id, host_id, sending_location_id }`. Logic:

1. **explicit override** — `event.sending_location_id` set → target = it.
2. **host event** (`event.host_id` present) and no override → target = org master via `resolveMasterLocationId(db, { organization_id, anchor_location_id: event.location_id })` (org derived from the anchor location); falls back to `event.location_id` (anchor) when no master is configured — never to a wrong location.
3. **normal event** → target = `event.location_id`.

Then load the target location row (`id, name, twilio_alpha_sender_id, organization_id`), apply `overlayConnections(db, row, ['twilio_sender'])` (registry dual-read, matching the current send paths), and return it. On any lookup failure, fall back to the event's own embedded location so a send is never blocked.

Split for testability: a **pure** `pickCommsLocationTarget(event, masterLocationId)` holds the tier logic (override → host-master → own location), unit-tested exhaustively; the async `resolveEventCommsLocation(db, event)` wrapper derives the master id, calls the picker, loads + overlays the row.

Callers use `row` for SMS (`sendLocationSms({ location: row })`) and `row.id` for email (`sendTransactionalEmail({ locationId: row.id })`).

## SMS integration

- `src/lib/race-confirmations.js` — `sendRaceConfirmations` select adds `sending_location_id`; `sendSms` uses `resolveEventCommsLocation(db, race)` as the send location. The existing `resolveSenderLocation` stays as the inner safety net.
- `src/app/api/registrations/[id]/payment-sms/route.js` — select adds `sending_location_id`; resolves the comms location before `sendLocationSms`.

## Email integration

- `src/lib/race-confirmations.js` — `sendEmail` passes the comms location `id` as `locationId` to `sendTransactionalEmail` (instead of `payment.race.location_id`).
- `src/lib/event-attendee-reminders.js` — `runEventReminders` select adds `sending_location_id`; `sendReminderEmail` passes the comms location `id` as `locationId`.

**Live effect on email:** host confirmation/reminder emails are NOT gated by the SMS toggle, so they currently send from the global default. On deploy they move to the master location's email identity — an improvement, and no worse than today if the master has no `tenant_email_domains` row (still the global default). Call this out at rollout.

## UI + API

- `src/components/RaceEventForm.jsx` — a **"Send comms from"** dropdown listing real UN1T locations (`is_host_anchor=false`, active), shown for host events, its default selection pre-set to the org master. State + save-payload field.
- `src/app/api/events/route.js` (create) + `[id]/route.js` (update) — `sending_location_id: uuidLike.nullable().optional()` on both schemas; create persists what's sent (the form supplies the master default — no route-side defaulting), update patches it through the generic scalar patch; `loadRace` selects it back. Validate the id is a real, in-org, non-anchor location (IDOR guard, mirroring the email-template guard).
- **No** change to the host self-serve create path (`/api/host/events`): it leaves `sending_location_id` NULL and the resolver yields the org master — hosts don't choose UN1T's identity. No `host-events.js` create change; the resolver is the single defaulting mechanism.

## Testing (TDD)

- `resolveEventCommsLocation` — override / host→master / host→anchor-fallback / normal-event / null-event / lookup-error-fallback, with a stub db.
- `/api/events` create + update schemas — accept a uuid, reject non-uuid, default/omit clean; in-org non-anchor validation.
- Comms paths — each resolves via the helper and sends from the resolved location (assert the location handed to `sendLocationSms` / the `locationId` handed to `sendTransactionalEmail`).
- `RaceEventForm` — default value = master; payload carries the field.

## Rollout & safety

- Migration first (additive, nullable, no backfill), then code — standard order.
- SMS is latent-correct (event SMS is off via #1445); **email identity changes on deploy** — verify the master location (Stillorgan) has a `tenant_email_domains` row, else it stays on the global default (unchanged from today).
- Normal events: zero behaviour change (resolve to their own `location_id`).
- Safety nets retained: explicit field → org master → anchor sender (data-fixed) → `resolveSenderLocation` org-fallback → global default.
