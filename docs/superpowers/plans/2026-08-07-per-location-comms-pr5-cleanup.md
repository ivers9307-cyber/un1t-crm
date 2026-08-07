# Per-location comms — PR 5: sequences + retire `email_status` (LOCCOMMS.5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last send path still reading global consent, and retire `email_status='unsubscribed'` now that unsubscribe is per-location.

**Spec:** `docs/superpowers/specs/2026-08-06-per-location-communication-preferences-design.md`
**Previous:** PR 1 `#1239` · PR 2 `#1240` · PR 3 `#1242` · PR 4 `#1245`

---

## The finding that reshaped this PR

**Sequences never got cut over in PR 3, and they are still gating on the global column.**

`sendEmailStep` checks `contact.email_marketing !== true` and `sendWhatsappStep` checks
`contact.whatsapp_marketing !== true` — the denormalised globals, not the row for the
sequence's own location. Sequences do not go through `buildAudienceQuery`, so PR 3's
cutover missed them entirely.

That is wrong in **both** directions:

- Someone opted out globally but opted **in** at the sequence's location — the exact shape
  of the LEADCAP.1 recovered leads — is **wrongly skipped**.
- Someone opted in globally but opted **out** at that location is **wrongly sent to**,
  which is the harm the whole programme exists to prevent.

**It is latent, not live:** `email_sends` contains only `campaign` (15,339) and
`transactional` (106) rows — **zero sequence emails have ever been sent**. So nothing has
gone wrong yet, and this must land before any sequence is switched on.

`sequence.location_id` already exists (the scheduler uses it for the frequency cap), so
the fix has everything it needs.

## Retiring `email_status='unsubscribed'` is now low-risk

Deferred from PR 3 and PR 4, and the ground has since become safe:

| Fact | Value |
|---|---|
| Rows to retire | **2,680** |
| Reputation rows to preserve (`bounced`/`complained`) | **23** |
| Saved **campaigns** filtering on `email_status` | **0** |
| Saved **sequences** filtering on `email_status` | **0** |

Nothing operator-built depends on the value, so retiring it cannot silently change a saved
audience. `email_marketing` is **not** in `AUDIENCE_FIELDS` at all (only `email_status`
is), so the audience-builder work the spec anticipated is largely moot.

### File structure

| File | Responsibility |
|---|---|
| `src/lib/sequences/steps.js` | per-location consent gate for email / WhatsApp / SMS steps |
| `src/lib/sequences/scheduler.js` | pass the location row (or fetch it) to the step |
| `supabase/migrations/492_retire_email_status_unsubscribed.sql` | flip 2,680 rows; leave `bounced`/`complained` |
| `src/app/api/contacts/[id]/email/route.js` | `BLOCKED_EMAIL_STATUSES` drops `unsubscribed`; gate per-location instead |
| `src/app/contacts/[id]/page.js`, `src/components/contact/ContactDrawer.jsx` | badge stops reading `unsubscribed` |
| `src/lib/booking-confirmations.js`, `src/lib/event-attendee-reminders.js` | drop `unsubscribed` — these are TRANSACTIONAL |
| `src/app/api/admin/marketing-preferences-import/route.js`, `preferences/[token]`, `contacts/[id]/marketing-preferences` | stop *writing* the value |

---

### Task 1: sequences gate on per-location consent

**Files:** Modify `src/lib/sequences/steps.js`, `src/lib/sequences/scheduler.js`; Test: `src/lib/sequences/steps.test.js`

- [ ] **Step 1: Write the failing tests** — three cases, and the middle one is the point:

```js
it('sends when the contact is opted out GLOBALLY but opted in at the sequence location', ...)
it('SKIPS when the contact is opted in globally but opted out at the sequence location', ...)
it('skips when there is no row for that location at all (row absent = never send)', ...)
```

- [ ] **Step 2: Run them, confirm they fail.**

- [ ] **Step 3: Implement.** In the scheduler's contact fetch, also select the row for
  `sequence.location_id`; in `steps.js`, gate on that row's channel rather than
  `contact.email_marketing` / `contact.whatsapp_marketing` / `sms_status`.

  **Row absent must mean skip**, matching the view's inner join — a contact with no row
  for that location is not on its list.

  Keep `recordStepSkip` reasons intact so the operator-facing skip log still explains
  itself; extend the reason text to name the location.

- [ ] **Step 4: Run tests.**  - [ ] **Step 5: Commit.**

---

### Task 2: migration 492 — retire the value

**Files:** Create `supabase/migrations/492_retire_email_status_unsubscribed.sql`

> Note: two `491` migrations already exist (`491_contact_location_audience_view` and
> `491_zoom_sync_runs`, from a parallel session). Both are applied; per the mig 485
> precedent they stay as-is because the `schema_migrations` rows are already named.
> **492 is the next free number** — re-check before applying, the repo moves fast.

- [ ] **Step 1: Write the migration**

```sql
-- 492 — retire contacts.email_status = 'unsubscribed' (LOCCOMMS.5).
--
-- email_status now carries REPUTATION ONLY: active | bounced | complained.
-- "Unsubscribed" is a consent state and consent became per-location in PR 1-4,
-- so a single global flag can no longer answer "unsubscribed from WHICH
-- business?" — it blocks manual sends from every location on the strength of
-- someone leaving one list.
--
-- Deferred from PR 3 and PR 4 on purpose: this value is a hard suppressor in
-- five readers, and flipping it before those readers changed would have
-- silently un-blocked manual staff sends to everyone who unsubscribed. It
-- ships in the SAME deploy as the code that stops consuming it.
--
-- bounced / complained are untouched — address-level reputation, true
-- everywhere, and clearing them would damage the shared sending domain.
--
-- The consent itself is NOT lost: it lives in contact_location_preferences,
-- backfilled by mig 488 which folded this exact signal in.

update contacts set email_status = 'active' where email_status = 'unsubscribed';

do $$
declare remaining int; reputation int;
begin
  select count(*) into remaining  from contacts where email_status = 'unsubscribed';
  select count(*) into reputation from contacts where email_status in ('bounced','complained');
  if remaining > 0 then
    raise exception 'LOCCOMMS.5 FAILED: % rows still carry email_status=unsubscribed', remaining;
  end if;
  raise notice 'LOCCOMMS.5 — email_status retired to reputation-only; % bounced/complained preserved', reputation;
end $$;
```

- [ ] **Step 2: Commit. DO NOT APPLY YET** — it must go out with Task 3.

---

### Task 3: the five readers stop consuming it

**Files:** as listed in the file table above.

- [ ] **Step 1: `/api/contacts/[id]/email`** — drop `'unsubscribed'` from
  `BLOCKED_EMAIL_STATUSES`, and instead check the acting staff user's active location row
  in `contact_location_preferences`. **This route is the reason the retirement was deferred
  twice:** it never fetches `email_marketing`, so `email_status` is currently its only
  consent gate. Replacing rather than removing that gate is the whole task — do not simply
  delete the check.

- [ ] **Step 2: The two badges** (`contacts/[id]/page.js:387`,
  `ContactDrawer.jsx:223`) — `emailBlocked` keeps `bounced`/`complained` and drops
  `unsubscribed`. Consider surfacing "not on this location's list" separately; a badge that
  silently stops appearing is worse than one that says less.

- [ ] **Step 3: `booking-confirmations.js:154` and `event-attendee-reminders.js:151`** —
  drop `'unsubscribed'`. **This is a deliberate behaviour change worth stating in the PR:**
  these are TRANSACTIONAL sends and a marketing opt-out should never have blocked a booking
  confirmation. People who unsubscribed from marketing will start receiving confirmations
  for classes they booked. That is correct, and it is also *new*.

- [ ] **Step 4: The three writers** (`preferences/[token]`,
  `contacts/[id]/marketing-preferences`, `marketing-preferences-import`) stop writing
  `'unsubscribed'`. Leave the `bounced`/`complained` handling alone.

- [ ] **Step 5: Run the CI mirror + `npm run build`.**  - [ ] **Step 6: Commit.**

---

### Task 4: apply, verify, deprecate

- [ ] **Step 1: Apply mig 492** — only once Task 3 is merged or in the same deploy.

- [ ] **Step 2: Verify**

```sql
select
  (select count(*) from contacts where email_status='unsubscribed')            as must_be_zero,
  (select count(*) from contacts where email_status in ('bounced','complained')) as must_be_23,
  (select count(*) from contact_location_preferences where email_marketing=false) as optouts_intact;
```

The third number is the one that matters: **the consent must still exist per-location.**
Retiring the flag must not have lost anyone's opt-out.

- [ ] **Step 3: `COMMENT ON TABLE contact_preferences`** marking it superseded for
  marketing, per the repo's deprecation convention (add + backfill → comment → code stops
  reading → a *later* migration drops). **Do not drop it in this PR** — code can then roll
  back without DB action.

- [ ] **Step 4: Changelog + PR.**

---

## Definition of done

- [ ] Sequences gate on the row for `sequence.location_id`; row absent = skip
- [ ] Zero `contacts.email_status = 'unsubscribed'`; 23 `bounced`/`complained` intact
- [ ] No reader consults `'unsubscribed'`; `/api/contacts/[id]/email` gates per-location instead
- [ ] Per-location opt-out counts unchanged before vs after
- [ ] `contact_preferences` commented as superseded, **not dropped**
- [ ] Eight CI checks + build + advisors

## Out of scope

- Dropping `contact_preferences` or the denormalised `contacts.email_marketing` column and
  its mig 155 trigger. Both still have readers, and the convention is a later migration.
- `AUDIENCE_FIELDS` changes — `email_marketing` is not a filterable field, and no saved
  campaign or sequence filters on `email_status` (verified: 0 and 0).
