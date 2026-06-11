# Unified inbox — WhatsApp + Instagram (UIX, June 2026)

Operator-approved concept (2026-06-11, interactive mockup reviewed in
session): replace the separate Inbox / Instagram tabs at
`/communications` with **one queue, one thread, one contact command
centre** — manage the conversation, the contact, their consent, and
their bookings (consultation + Glofox class) without leaving the page.

## Resume notes

**Shipped (2026-06-11):**
- UIX-0 probe checks — #457
- P1a resolve queue (mig 255 `resolved_at`, PATCH resolve, webhook
  auto-unresolve, Needs-reply/Everything chips in both inboxes) — #458
- P1b unified queue (`UnifiedInbox.jsx`; WAInbox/IGInbox `embedded`
  mode; `/communications/instagram` → redirect; one Inbox tab) — #459
- P2 command centre (`CommandCentre.jsx`: Profile w/ consent card +
  SequencePicker, Activity timeline; `GET
  /api/contacts/[id]/command-centre` bundle) — #460
- P3a consultation booking (Book tab: day chips → slot grid →
  `POST /api/bookings/create` → optional confirmation into the
  thread) — #461
- Polish: unified WA+IG unread count, opted-out "service replies
  only" thread banner, this notes update — (same PR as this edit)

**Probe results (operator-run 2026-06-11):**
- `events_discovery`: **`GET /2.0/events?start=<unix-secs>&end=<unix-secs>&limit=N` VERIFIED** —
  200 with `{ object:'list', page, limit, has_more, total_count, data }`;
  the time window is honoured (windowed vs unwindowed return different
  first items). Event fields seen live: `_id, name, description,
  time_start, duration, size, booked, waiting, trainers, active,
  private, booking_status, program_obj…`. `/2.0/branches/{id}/events`
  returns the same data; `/2.0/calendar` does NOT exist (WRONG_URL);
  `GET /2.0/bookings` lists (200, empty).
- `booking_dryrun` (round 1): POST /2.0/bookings **resolves** (no
  WRONG_URL — bookings exist on this tier) but `{user_id, event_id}`
  fails validation with *"The model field is required., The model id
  field is required."* — and `user_id` was NOT flagged. Real shape:
  **`{ user_id, model, model_id }`** (polymorphic). The exact `model`
  token is pinned by probe v2 (shipped in the P3b PR — re-click
  `?check=booking_dryrun`; it now tries 'Event'/'event'/'events' in
  one pass). `GLOFOX_BOOKING_MODEL` in src/lib/glofox.js currently
  'Event' — adjust if v2 shows a different spelling wins.

**Remaining:**
- Operator: re-click `?check=booking_dryrun` (v2) → confirm/correct
  `GLOFOX_BOOKING_MODEL` → **live E2E**: in the inbox Book tab, book
  the operator's own member record into a real class, verify it in
  Glofox, then click Undo (cancelBooking).
- Auth-gated visual click-test of the whole unified inbox (P1–P3
  code-reviewed + build-verified only).

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
