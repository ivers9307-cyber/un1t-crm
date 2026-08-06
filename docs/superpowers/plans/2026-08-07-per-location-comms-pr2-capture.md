# Per-location comms — PR 2: close the drift window + per-location capture (LOCCOMMS.2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `contact_location_preferences` drifting away from reality between now and the PR 3 cutover, and start capturing genuine per-location opt-ins from the public forms.

**Architecture:** Two DB triggers plus a change to the shared consent helper. The triggers close the window for *every* writer — including the one that lives in the database — without touching seven call sites. The helper change is the actual new capability: recording an opt-in at the location a form belongs to, which may not be the location the contact is filed under.

**Tech Stack:** Postgres triggers (mirroring `sync_contacts_email_marketing`, mig 155), Supabase MCP `apply_migration`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-per-location-communication-preferences-design.md`
**Previous:** PR 1 (`#1239`, migs 487+488) shipped the table and backfill. Nothing reads it yet.

---

## Why triggers rather than app-level dual-write

The spec originally said "capture path dual-writes". Investigation changed the approach, and the spec's own note already flagged this as strictly better.

`contact_preferences` has **eight** write paths:

| Writer | |
|---|---|
| `src/app/api/preferences/[token]/route.js` | preference centre |
| `src/app/api/unsubscribe/[token]/route.js` | unsubscribe link |
| `src/app/api/contacts/[id]/marketing-preferences/route.js` | staff edit |
| `src/app/api/admin/marketing-preferences-import/route.js` | bulk import |
| `src/lib/marketing-consent.js` | the shared helper (two functions) |
| `src/lib/whatsapp-consent.js` | WA keyword opt-out |
| `src/lib/agent/followups.js` | Mia |
| `auto_unsubscribe_classpass()` | **a DB trigger — app-level dual-write cannot reach it at all** |

Updating seven files and hoping no future writer is missed is precisely the silent-drift failure this programme exists to prevent. One trigger catches all eight, today and forever.

## The one-directional rule

**A channel going FALSE propagates to ALL of that contact's location rows. A channel going TRUE propagates only to the row at their own `contacts.location_id`.**

Asymmetric on purpose. Until PR 4 makes unsubscribe per-location, the unsubscribe link is global and a person clicking it means "stop emailing me" — that must reach every location. But a global opt-in says nothing about whether they want mail from a gym they have never dealt with, so it must not manufacture consent for a sibling location. Off is safe to broadcast; on is not.

### File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/489_contact_location_preferences_sync.sql` | Both triggers + a catch-up backfill for anything created since mig 488 |
| `src/lib/marketing-consent.js` | `applyFormMarketingConsent` gains `locationId` and writes the location row |
| `src/lib/marketing-consent.test.js` | Tests for the helper change |
| `src/app/api/public/{leads,class-booking,events/[slug]/register}/route.js` | Pass `locationId` |
| `docs/CHANGELOG.md` | One entry |

---

### Task 1: Baseline the drift before changing anything

**Files:** none (read-only)

- [ ] **Step 1: Measure current drift**

```sql
select
  (select count(*) from contacts c
    where c.location_id is not null
      and not exists (select 1 from contact_location_preferences clp
                       where clp.contact_id = c.id and clp.location_id = c.location_id)
  ) as contacts_missing_a_location_row,
  (select count(*) from contacts c
     join contact_location_preferences clp
       on clp.contact_id = c.id and clp.location_id = c.location_id and clp.source='migration'
    where c.email_marketing = false and clp.email_marketing = true
  ) as drifted_optouts;
```

Both were **0** immediately after mig 488 on 2026-08-06. Any non-zero value here is the window already costing us — record it, because Task 2's catch-up must clear it and Task 3 verifies it stays at zero.

---

### Task 2: Migration 489 — the triggers

**Files:**
- Create: `supabase/migrations/489_contact_location_preferences_sync.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 489 — keep contact_location_preferences in step with contact_preferences
-- (LOCCOMMS.2). Closes the PR1 -> PR3 drift window.
--
-- Without this, every opt-out between mig 488 and the PR 3 cutover lands ONLY
-- in contact_preferences, and the cutover would silently re-subscribe those
-- people. Contacts created in the window would get no location row at all and
-- become permanently unreachable (row absent = never send).
--
-- Triggers, not app-level dual-write: contact_preferences has eight writers and
-- one of them (auto_unsubscribe_classpass) is itself a database trigger that no
-- amount of JavaScript can intercept.
--
-- THE ONE-DIRECTIONAL RULE, and it is deliberate:
--   channel -> FALSE  propagates to ALL of that contact's location rows
--   channel -> TRUE   propagates ONLY to the row at contacts.location_id
-- Until PR 4 makes unsubscribe per-location, the unsubscribe link is global and
-- means "stop emailing me" — that must reach every location. A global opt-in
-- says nothing about a gym the person has never dealt with, so it must not
-- manufacture consent there. Off is safe to broadcast; on is not.

-- 1. New contacts get a location row, mirroring create_contact_preferences.
--    Without this a contact created after mig 488 has no row, and row-absent
--    means no location may ever send to them.
create or replace function create_contact_location_preferences()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.location_id is not null then
    insert into contact_location_preferences
      (contact_id, location_id, source)
    values (new.id, new.location_id, 'contact_created')
    on conflict (contact_id, location_id) do nothing;
  end if;
  return new;
end;
$$;

-- Named to sort BEFORE contact_preferences_trigger, so the location row exists
-- by the time the preferences row is created and the sync trigger below fires.
-- Postgres runs same-event triggers in name order.
create trigger contact_location_preferences_create_trigger
  after insert on contacts
  for each row execute function create_contact_location_preferences();

-- 2. Propagate preference changes.
create or replace function sync_contact_location_preferences()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  own_location uuid;
begin
  select location_id into own_location from contacts where id = new.contact_id;

  -- OFF propagates everywhere.
  if coalesce(new.email_marketing, true) = false then
    update contact_location_preferences
       set email_marketing = false, updated_at = now()
     where contact_id = new.contact_id and email_marketing is distinct from false;
  end if;

  if coalesce(new.sms_marketing, true) = false then
    update contact_location_preferences
       set sms_marketing = false, updated_at = now()
     where contact_id = new.contact_id and sms_marketing is distinct from false;
  end if;

  if coalesce(new.whatsapp_marketing, true) = false then
    update contact_location_preferences
       set whatsapp_marketing = false, updated_at = now()
     where contact_id = new.contact_id and whatsapp_marketing is distinct from false;
  end if;

  -- ON propagates only to their own location, and only if that row exists.
  -- Deliberately does NOT create a row: an opt-in recorded globally is not
  -- evidence that they joined that location's list.
  if own_location is not null then
    update contact_location_preferences
       set email_marketing    = coalesce(new.email_marketing, true),
           sms_marketing      = coalesce(new.sms_marketing, true),
           whatsapp_marketing = coalesce(new.whatsapp_marketing, true),
           updated_at         = now()
     where contact_id = new.contact_id
       and location_id = own_location
       and (email_marketing    is distinct from coalesce(new.email_marketing, true)
         or sms_marketing      is distinct from coalesce(new.sms_marketing, true)
         or whatsapp_marketing is distinct from coalesce(new.whatsapp_marketing, true));
  end if;

  return new;
end;
$$;

create trigger sync_contact_location_preferences_trigger
  after insert or update on contact_preferences
  for each row execute function sync_contact_location_preferences();

-- 3. Catch-up for anything that happened between mig 488 and this migration.
--    Same shape as 488 step 1, so it is safe to run repeatedly.
insert into contact_location_preferences
  (contact_id, location_id, email_marketing, sms_marketing, whatsapp_marketing,
   subscribed_at, source)
select
  c.id, c.location_id,
  coalesce(p.email_marketing, true) and c.email_status is distinct from 'unsubscribed',
  coalesce(p.sms_marketing, true),
  coalesce(p.whatsapp_marketing, true),
  coalesce(p.created_at, c.created_at, now()),
  'migration'
from contacts c
left join contact_preferences p on p.contact_id = c.id
where c.location_id is not null
on conflict (contact_id, location_id) do nothing;

-- 4. And correct any row that drifted OFF while we had no trigger. One
--    directional: this may only turn channels off, never on.
update contact_location_preferences clp
   set email_marketing = false, updated_at = now()
  from contacts c
 where c.id = clp.contact_id
   and c.email_marketing = false
   and clp.email_marketing = true
   and clp.source = 'migration';

do $$
declare missing int; drifted int;
begin
  select count(*) into missing from contacts c
   where c.location_id is not null
     and not exists (select 1 from contact_location_preferences clp
                      where clp.contact_id = c.id and clp.location_id = c.location_id);

  select count(*) into drifted from contacts c
    join contact_location_preferences clp
      on clp.contact_id = c.id and clp.location_id = c.location_id and clp.source='migration'
   where c.email_marketing = false and clp.email_marketing = true;

  if missing > 0 then
    raise exception 'LOCCOMMS.2 FAILED: % contacts still have no row at their own location', missing;
  end if;
  if drifted > 0 then
    raise exception 'LOCCOMMS.2 FAILED: % contacts opted out globally still show opted in at their own location', drifted;
  end if;
  raise notice 'LOCCOMMS.2 sync triggers installed; drift cleared';
end $$;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/489_contact_location_preferences_sync.sql
git commit -m "LOCCOMMS.2 — mig 489: sync triggers + catch-up backfill"
```

---

### Task 3: Verify the triggers actually fire

Do this against the live database **after** applying 489, before touching any JS.
A trigger that silently does nothing is the failure mode here.

- [ ] **Step 1: Apply 489** via Supabase MCP `apply_migration` against `iyvtbjjxdggiadzwwvdj`.

- [ ] **Step 2: Prove OFF propagates to all locations**

Use a contact that has rows at two locations — Emily Wilson Green
(`emily.wilson@live.ie`) has Hatch and Stillorgan. **Roll this back afterwards.**

```sql
begin;
update contact_preferences set sms_marketing = false
 where contact_id = (select id from contacts where lower(email)='emily.wilson@live.ie');
select l.name, clp.sms_marketing
  from contact_location_preferences clp join locations l on l.id = clp.location_id
 where clp.contact_id = (select id from contacts where lower(email)='emily.wilson@live.ie');
rollback;
```

Expected: **both** rows show `sms_marketing = false`.

- [ ] **Step 3: Prove ON does NOT propagate to a sibling location**

```sql
begin;
update contact_preferences set email_marketing = true
 where contact_id = (select id from contacts where lower(email)='davidtwomey22@hotmail.com');
select l.name, clp.email_marketing
  from contact_location_preferences clp join locations l on l.id = clp.location_id
 where clp.contact_id = (select id from contacts where lower(email)='davidtwomey22@hotmail.com');
rollback;
```

Expected: Stillorgan (his own location) flips to `true`; **Hatch stays as it was**.
If Hatch also flipped, the one-directional rule is broken — stop and fix.

- [ ] **Step 4: Prove a new contact gets a row**

```sql
begin;
insert into contacts (name, email, location_id)
values ('LOCCOMMS trigger probe', 'loccomms-probe@example.invalid',
        'a0000000-0000-0000-0000-000000000001')
returning id;
select count(*) from contact_location_preferences
 where contact_id = (select id from contacts where email='loccomms-probe@example.invalid');
rollback;
```

Expected: `1`. The `rollback` is essential — this must not persist.

---

### Task 4: `applyFormMarketingConsent` writes the location row

This is the new capability, and it is NOT what the triggers do. A Stillorgan
member joining the Hatch waitlist needs a row at **Hatch** — a location they are
not filed under, which the triggers deliberately never create.

**Files:**
- Modify: `src/lib/marketing-consent.js`
- Test: `src/lib/marketing-consent.test.js`

- [ ] **Step 1: Write the failing test**

```js
it('LOCCOMMS.2 — records consent at the FORM location, not the contact location', async () => {
  // Contact is filed at Stillorgan; the form belongs to Hatch Street.
  const db = makeDb({ contact: { id: 'c1', location_id: 'loc-stillorgan' } })
  await applyFormMarketingConsent(db, {
    contactId: 'c1', consent: true, source: 'waitlist_form', locationId: 'loc-hatch',
  })
  expect(db.upserts('contact_location_preferences')).toContainEqual(
    expect.objectContaining({ contact_id: 'c1', location_id: 'loc-hatch', email_marketing: true }),
  )
  // and must NOT have touched the contact's own location
  expect(db.upserts('contact_location_preferences')).not.toContainEqual(
    expect.objectContaining({ location_id: 'loc-stillorgan' }),
  )
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/marketing-consent.test.js -t LOCCOMMS.2`
Expected: FAIL — `locationId` is not a parameter yet.

- [ ] **Step 3: Implement**

Add `locationId` to the destructured args. After the existing
`contact_preferences` upsert (keep it — global stays authoritative until PR 3),
upsert the location row:

```js
if (locationId) {
  const row = { contact_id: contactId, location_id: locationId, source, updated_at: new Date().toISOString() }
  for (const ch of MARKETING_CHANNELS) row[ch] = consent
  if (consent) row.unsubscribed_at = null
  await db.from('contact_location_preferences').upsert(row, { onConflict: 'contact_id,location_id' })
}
```

Log a warning when `locationId` is absent so callers that forget it are visible
rather than silently global-only.

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/marketing-consent.test.js`
Expected: PASS, and every pre-existing test in the file still passes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing-consent.js src/lib/marketing-consent.test.js
git commit -m "LOCCOMMS.2 — applyFormMarketingConsent records consent at the form's location"
```

---

### Task 5: Pass `locationId` from the public forms

**Files:**
- Modify: `src/app/api/public/leads/route.js`
- Modify: `src/app/api/public/class-booking/route.js`
- Modify: `src/app/api/public/events/[slug]/register/route.js`

- [ ] **Step 1: Add the argument at each call site**

There are **seven** call sites, not the three this plan first listed — `/api/public/book`
and `src/lib/whatsapp-flow/completion.js` were missed, and `events/[slug]/register` has
**two**. Six get the argument; the seventh is deliberately skipped.

| Call site | Variable to pass |
|---|---|
| `api/public/leads/route.js:99` | `locationId` |
| `api/public/class-booking/route.js:130` | `locationId` |
| `api/public/book/route.js:148` | **`event.location_id`** — there is no `locationId` in scope |
| `api/public/events/[slug]/register/route.js:175` | **`contactLocationId`** — no `locationId` in scope |
| `api/public/events/[slug]/register/route.js:355` | **`contactLocationId`** (HOST-MASTER.4: host-event contacts live at the org master, matching the `writeContactTags` call above) |
| `lib/whatsapp-flow/completion.js:19` | `locationId` (already a function parameter) |
| `api/public/host-list/[slug]/subscribe/route.js:104` | **SKIP** — hosts have their own mechanism (`host_contacts` + `host_email_suppressions`) |

**Do not assume the variable is called `locationId`.** Three of the six are not, and
passing a bare `locationId` there is a `ReferenceError` *inside a try/catch* — so consent
capture would silently stop for those forms with only a log line to show for it. `eslint`
`no-undef` catches it; run lint before trusting any edit here.

- [ ] **Step 2: Run the CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails
```

- [ ] **Step 3: Commit, changelog, PR**

```bash
git add -A && git commit -m "LOCCOMMS.2 — public forms pass their location to the consent helper"
git push -u origin HEAD && gh pr create --base main --fill
```

---

## Definition of done

- [ ] Both triggers exist and are **proven to fire** by Task 3's rollback probes
- [ ] OFF propagates to every location row; ON reaches only the contact's own
- [ ] A newly created contact automatically gets a location row
- [ ] Zero contacts missing a row at their own location; zero drifted opt-outs
- [ ] `applyFormMarketingConsent` records consent at the **form's** location
- [ ] All eight CI-mirror checks pass
- [ ] **Still nothing reads the table** — PR 3 remains the cutover

## Out of scope

- Reading the table in any send path (PR 3)
- Per-location unsubscribe, the preference centre, `List-Unsubscribe` (PR 4)
- `AUDIENCE_FIELDS`, the denormalised columns, deprecating `contact_preferences` (PR 5)
- Retiring `email_status='unsubscribed'` — **PR 3 only**, with the readers that consume it
