# Unified inbox — WhatsApp + Instagram (UIX, June 2026)

Operator-approved concept (2026-06-11, interactive mockup reviewed in
session): replace the separate Inbox / Instagram tabs at
`/communications` with **one queue, one thread, one contact command
centre** — manage the conversation, the contact, their consent, and
their bookings (consultation + Glofox class) without leaving the page.

## Resume notes

- **UIX-0 (this PR):** probe checks shipped on `/api/glofox/probe`
  (`?check=events_discovery`, `?check=booking_dryrun`) — run both as a
  logged-in master and record results below before building P3.
  - events_discovery result: _pending_
  - booking_dryrun result: _pending_
- P1 → P2 → P3 ship as independent PRs; each is usable on its own.

## Approved shape (three panes)

### 1. Unified queue (left)
- WhatsApp + Instagram conversations merged, channel filter chips
  (All / WhatsApp / IG), per-row channel badge + unread + resolved tick.
- **"Needs reply" vs "Everything"** split. `Resolve` on a thread drops
  it from Needs reply → the badge count means "awaiting a human"
  (inbox-zero workflow), not merely "unread".
- Search by name/handle later (not in P1 scope).

### 2. Thread (middle)
- Channel-aware header: WA 24h-window countdown / IG human-agent
  window (~7 days — verify against the live IG send constraint),
  handle, View contact.
- Composer states:
  - window open → free text + quick-reply chips (first chip may be a
    context-aware suggestion — stretch goal, not core).
  - window closed (WA) → **template-locked composer** with template
    picker (reuses the existing picker + quality chips).
  - contact unsubscribed → "service replies only" banner in-thread.
- Internal note + template buttons beside send.

### 3. Contact command centre (right) — 3 tabs
- **Profile:** pipeline stage chip, tags, Glofox membership/credits,
  **marketing consent toggle with audit line** (writes consent_log,
  same semantics as the STOP/START keyword system, source `staff`),
  quick actions (enrol in sequence, create task from chat, open full
  contact record).
- **Book:** two inline flows —
  a. **Consultation** — day chips → time grid from the existing
     event_types availability engine → book → confirmation message
     **dropped into the thread**.
  b. **Glofox class** — upcoming classes (name, time, coach, spots),
     Book / Waitlist → `createBooking` (`/2.0/bookings`, already in
     `src/lib/glofox.js` with `cancelBooking`) → confirmation into the
     thread. Requires UIX-0 probe results for the event-listing
     endpoint (none is verified yet).
- **Activity:** compact timeline (attendance, consent events, lead
  source) from activities + consent_log + Glofox interactions.

## Phases

| Phase | Scope | Notes |
|-------|-------|-------|
| UIX-0 | Glofox probe checks (this PR) + design doc | Operator clicks 2 probe URLs; results recorded above |
| P1 | Unified queue + Resolve + channel-aware thread/composer states | Needs mig: `whatsapp_conversations.status` gains `resolved` (or a `resolved_at` column — prefer the column, avoids enum churn); same for instagram_conversations. No Glofox dependency |
| P2 | Command centre: Profile tab (consent toggle + audit + quick actions) + Activity tab | Backend exists (consent_log, whatsapp-consent.js patterns, activities) |
| P3 | Book tab: consultation slots, then Glofox classes | Consultation = event_types availability (exists). Glofox = fetchUpcomingEvents (write against the probe-verified endpoint) + createBooking; **live end-to-end test books a real class for the operator's own member record, then cancelBooking** |

## Hard-won constraints to respect

- IG/WA conversation tables each have ≥2 FKs to contacts → every
  embed must be disambiguated (`contacts!contact_id(...)`).
- The WA webhook must keep its always-200 contract; resolved-state
  writes must never throw.
- `buildWhatsAppAudience` / send paths already honour
  `whatsapp_marketing` + `wa_status` — the consent toggle reuses those
  exact flags (no new consent model).
- Glofox booking errors come back as `message_code`
  (e.g. YOU_HAVE_BOOKED_FOR_THIS_EVENT) — surface them verbatim in the
  booking panel.
- Vercel 4.5 MB body cap: irrelevant here (no uploads), but media
  display in threads must keep using public/signed URLs as today.
