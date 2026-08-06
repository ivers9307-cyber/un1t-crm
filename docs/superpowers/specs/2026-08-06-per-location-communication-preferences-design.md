# Per-location communication preferences (LOCCOMMS.1)

**Date:** 2026-08-06
**Status:** Design approved, not yet built
**Origin:** Fallout from LEADCAP.1 (PR #1229) — see "Why this exists"

---

## Why this exists

Hatch Street is a **standalone business** that happens to share an organisation with
Stillorgan. Today the CRM cannot express that. Marketing consent lives in
`contact_preferences`, keyed on `contact_id` **alone** — one set of preferences per
person for the entire estate. A person is either subscribed to "UN1T" or not.

Two concrete failures made this urgent.

**1. Consent cannot be scoped, so restoring it over-grants.** Recovering leads lost to
LEADCAP.1 meant restoring the email consent two people gave on the Hatch Street waitlist
form. Because preferences are global, flipping `email_marketing` re-subscribed them to
**Stillorgan** as well — which they had opted out of in May. The consent they actually
gave was *"hear from UN1T about the Hatch Street launch"*: specific to one business. The
schema had no way to record that, and `applyFormMarketingConsent` would have done the
identical thing had the form worked. There was no correct state available: global-on
over-grants Stillorgan, global-off drops them from the launch they asked for.
(Both were reverted to their pre-change state on 2026-08-06 pending this work; their
Hatch Street `hatch-founding-member` tags were retained as the evidence of intent.)

**2. Location lists silently under-deliver.** `buildAudienceQueryAsync` (`postmark.js`)
and its WhatsApp equivalent hard-filter `.eq('location_id', locationId)` on **contacts**.
So a Hatch Street campaign reaches only people whose *contact row* sits at Hatch. Measured
2026-08-06:

| Metric | Count |
|---|---|
| Contacts tagged `hatch-founding-member` (all Hatch-scoped) | **81** |
| …whose contact row is at Hatch Street | 58 |
| …whose contact row is elsewhere (Stillorgan) → **silently unreachable** | **23** |

19 of those 23 were tagged **8–21 June**, before PR #709 removed the cross-location
fallback — i.e. this gap predates the LEADCAP.1 incident and has been quietly shrinking
the launch list ever since. **28% of the founding-member audience would receive nothing,
with no error and no warning.**

Both failures are the same root error as LEADCAP.1 itself: **location is the wrong axis.**
A contact belongs to an organisation; a *communication relationship* belongs to a location.

### Prior art in this repo

Hosts already solve exactly this problem: `host_contacts` (membership of that sender's
list) plus `host_email_suppressions` (unsubscribe from that sender only), both independent
of global `contact_preferences`. This design generalises that proven idea to locations,
rather than inventing a new mechanism.

---

## Decisions taken

Recorded so implementers do not relitigate them.

| # | Decision | Rationale |
|---|---|---|
| 1 | **Per-location is authoritative; global keeps reputation only.** | A bounce is a fact about an email *address* and is true everywhere. Consent is a fact about a *relationship with one business*. Splitting them lets Hatch mail its own list even when that person left Stillorgan. |
| 2 | **Explicit opt-in per location. No auto-seeding from the org.** | A location's list contains only people who actively joined it. Launch marketing to the existing base is **a Stillorgan campaign about Hatch** — those people did consent to hear from Stillorgan. No new concept needed and no reliance on soft opt-in for cold leads. |
| 3 | **One-click unsubscribe removes the sending location only, then shows all lists.** | Satisfies the Gmail/Yahoo bulk-sender one-click mandate, makes the per-location model self-service, and gives an easy global exit so nobody reaches for the spam button — complaints damage the sending domain every location shares. |
| 4 | **Single `contact_location_preferences` table** (over mirroring the two host tables, or a general `subscriber_lists` abstraction). | Same *shape* as today's `contact_preferences`, so the consent helper, sync triggers, `consent_log`, audience filter and both send paths translate by adding a location key rather than being rewritten. Covers all three channels uniformly. A general list abstraction is the eventual direction if Repset needs it — migrating working host code now is risk for no gain (YAGNI). |

---

## The model

```sql
create table contact_location_preferences (
  contact_id         uuid not null references contacts(id)  on delete cascade,
  location_id        uuid not null references locations(id) on delete cascade,
  email_marketing    boolean not null default true,
  sms_marketing      boolean not null default true,
  whatsapp_marketing boolean not null default true,
  subscribed_at      timestamptz not null default now(),
  source             text not null,   -- waitlist_form | class_booking | event_signup | operator | migration
  unsubscribed_at    timestamptz,
  updated_at         timestamptz not null default now(),
  primary key (contact_id, location_id)
);
```

**Semantics — the single most important paragraph in this document:**

- **Row absent = not on that location's list.** That location may never send to them.
  This is what makes Decision 2 real.
- Row present, channel `true` = mailable on that channel by that location.
- Channels default `true` *within a row* because **creating the row is the opt-in act**.
  A row with every channel false is meaningful history: "joined, then unsubscribed",
  distinguishable from "never joined".
- `unsubscribed_at` is set when the last channel goes false; cleared on re-subscribe.

The `contacts` row itself stays **shared and unmodified**. Nobody's `location_id` moves.
This matters: two of the five recovered people are current *Stillorgan* members, and
relocating them would misfile them out of the studio they actually train at.

### What stays global on `contacts`

| Field | Fate | Why |
|---|---|---|
| `email_status` | Narrows to `active \| bounced \| complained`. The value `unsubscribed` **retires**. | Bounce/complaint are address-level reputation. "Unsubscribed" is consent and moves per-location. |
| `email_suppressed_at` | Stays global | Inactivity suppression (mig 395) is an address-level hygiene fact. |
| `email_administrative` | **Stays global and person-level** | Booking confirmations and reminders. You cannot unsubscribe from a receipt, and it follows the transaction's location naturally. Explicitly called out so nobody assumes it moved. |

`consent_log` gains a nullable `location_id` (null = historical/global-era row).

---

## Read path (sends)

`buildAudienceQueryAsync` in `src/lib/postmark.js` and the equivalent in
`src/lib/whatsapp.js` currently open with:

```js
db.from('contacts').select(...).eq('location_id', locationId).eq(consentField, true)
```

They instead **join the preference row for the sending location** and require the channel
true, while keeping the reputation gates global:

- join `contact_location_preferences` on `contact_id`, `location_id = <sending location>`
- require the relevant channel `true`
- keep `email_status not in ('bounced','complained')` and `email_suppressed_at is null`

This single change makes lists genuinely per-location **and** fixes the 23 unreachable
people as a consequence — rather than by widening every campaign's audience to the org,
which was considered and rejected as it would silently broaden unrelated sends.

Tag filtering in `audience-filter.js` (`contactIdsForTag`) already scopes
`contact_tags.location_id` correctly and needs no change.

---

## Write path (capture)

`applyFormMarketingConsent` (`src/lib/marketing-consent.js`) gains a required
`locationId` and upserts the per-location row instead of the global one. Every caller
already knows its location:

- `/api/public/leads` — the studio resolved from `public_path`
- `/api/public/class-booking` — the class's location
- `/api/public/events/[slug]/register` — the event's location
- `/api/public/host-list/[slug]/subscribe` — leave on the host mechanism; unchanged

Upsert is idempotent: resubmitting a form re-subscribes **that location only** and clears
`unsubscribed_at`. It must never touch another location's row.

The ClassPass short-circuit (permanently opted out, mig 151) is preserved as-is.

---

## Unsubscribe and the preference centre

- The unsubscribe token carries `(contact_id, location_id)`.
- `List-Unsubscribe-Post` one-click sets **that location's** channels false and stamps
  `unsubscribed_at`. It must not touch other locations.
- The response redirects to `/preferences/[token]`, which lists **every location list the
  person is on**, each with per-channel toggles, plus one "unsubscribe from everything"
  control that writes false across all their rows.
- Email footers must name the business:
  *"You're receiving this because you joined the UN1T Hatch Street list."*
  Generic "you subscribed to UN1T" wording is what generates complaints under a
  per-location model.

---

## Migration and backfill

Forward-only, applied via Supabase MCP against `iyvtbjjxdggiadzwwvdj`, `get_advisors`
after DDL. **Day one must be a zero-behaviour-change event for Stillorgan.**

1. Create `contact_location_preferences`; add `consent_log.location_id`. Nothing reads it.
2. **Backfill**: one row for **every contact**, at that contact's current
   `contacts.location_id`, `source='migration'`.
   - Contact **has** a `contact_preferences` row → copy its three marketing booleans and
     use its timestamp for `subscribed_at`.
   - Contact has **no** preferences row → default all three to `true`, `subscribed_at` =
     `contacts.created_at`. This is not a widening: `applyFormMarketingConsent` already
     treats a missing row as opted-in (`const current = pref ? !!pref[ch] : true`), so
     copying that default preserves today's behaviour exactly. Backfilling only the
     contacts that happen to have a row would silently make everyone else unreachable —
     the same class of failure this whole programme exists to fix.
3. **Retire the `unsubscribed` status**: where `contacts.email_status='unsubscribed'`, set
   that row's `email_marketing=false`, then set the column to `active`.
   Leave `bounced`/`complained` untouched.
4. **Seed Hatch Street** from evidence already in the database: for every holder of an
   active `hatch-founding-member` tag scoped to Hatch, insert a Hatch row with
   `source='waitlist_form'` and `subscribed_at = contact_tags.added_at`. This covers all
   81, including the 23 whose contact row is elsewhere.
5. `contact_preferences` stays on disk, stops being read, is `COMMENT`-marked
   `DEPRECATED (mig N)`, and drops in a later migration — per the repo's deprecation
   convention, so code can roll back without DB action.

**Emily Wilson Green and David Twomey resolve correctly and automatically**: step 2 gives
each a Stillorgan row with `email_marketing=false` (their real May opt-out), step 4 gives
each a Hatch row opted in (their real July waitlist consent). Opted into Hatch, not
Stillorgan — derived from recorded evidence rather than anyone's judgement. No manual
fix-ups needed, and none should be applied ahead of the migration.

---

## Sequencing

Five PRs. Each ships independently and leaves the system working.

| PR | Scope | Risk |
|---|---|---|
| 1 | Schema, backfill, `consent_log.location_id`. No reads. | Low — additive |
| 2 | Capture path writes per-location (dual-write; global still authoritative) | Low |
| 3 | **Send paths cut over to per-location** | **High — see below** |
| 4 | Unsubscribe token, one-click, preference centre, `List-Unsubscribe` headers | Medium |
| 5 | Audience builder + `AUDIENCE_FIELDS`; deprecate `contact_preferences` and the denormalised columns | Medium |

### PR 3 is the sharp edge

A backfill that misses anyone means campaigns **silently under-send** — precisely the
failure mode of the incident that prompted this work. Gate the cutover on:

- row-count parity: **every** contact has ≥1 location row (not merely those that had a
  `contact_preferences` row) — assert `count(distinct contact_id) == count(contacts)`
- **audience-count parity**: for every existing campaign/segment, compute the audience
  under the old and new query and require an **exact match**, except the Hatch Street
  list, which must grow by exactly the 23 known cases
- a per-location isolation check: opt out of A, assert still reachable from B

Do not merge PR 3 on green unit tests alone; these are live-data assertions.

---

## Known wrinkles

- **`contacts.email_marketing` / `whatsapp_marketing` / `email_administrative`** are
  denormalised columns maintained by triggers on `contact_preferences`
  (`sync_contacts_email_marketing_trigger` et al). They are read by audience filters and
  the 1,000-row pagination patterns. Per-location they become meaningless. Keep them
  during transition with the meaning "opted into **any** location", then drop in PR 5
  along with their triggers.
- **`AUDIENCE_FIELDS`** exposes `email_marketing` as a filterable field. Under the new
  model the field must resolve against the audience's own location, not the contact.
- **Sequences and automations** that check consent must resolve it for the sequence's
  location.
- **Host lists are out of scope.** They keep their own mechanism.

---

## Testing

- Backfill parity: row counts plus spot-diffs on a sample including opted-out contacts
- Audience-count parity old-vs-new per existing campaign (the PR 3 gate)
- Isolation: opt out of location A → still reachable from B; and the converse
- One-click unsubscribe touches exactly one location's row
- Reputation is still global: a `bounced` address is excluded from **every** location
- `email_administrative` unaffected by any per-location opt-out
- Form resubmission is idempotent and never touches a sibling location

---

## Out of scope

- Generalising hosts and locations into one `subscriber_lists` abstraction (Approach 3).
  Revisit if Repset multi-tenancy needs it.
- An org-level "UN1T Group" list. Decision 2 makes it unnecessary: brand announcements go
  to the relevant location's list.
- Changing `contacts_email_unique`. One email still means one contact row estate-wide;
  this design deliberately works **with** that constraint rather than against it.
