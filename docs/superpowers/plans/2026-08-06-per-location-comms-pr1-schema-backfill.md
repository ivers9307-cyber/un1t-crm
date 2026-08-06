# Per-location comms — PR 1: schema + backfill (LOCCOMMS.1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `contact_location_preferences`, add `consent_log.location_id`, and backfill both from existing data — with in-migration assertions that abort on any parity failure. **No application code reads the new table in this PR.**

**Architecture:** Two forward-only migrations. `486` is pure DDL (table, index, RLS, trigger, `consent_log` column, deprecation comments). `487` is the data backfill plus `DO` blocks that `raise exception` if counts don't match, so a bad backfill rolls the whole migration back instead of silently under-populating. Nothing reads the table until PR 3, so this PR is behaviour-neutral by construction.

**Tech Stack:** Postgres 17 / Supabase. Migrations applied via the Supabase MCP `apply_migration` against project `iyvtbjjxdggiadzwwvdj` (un1t-crm — **not** the sentinel project `tpttqakxmyxrwnqjepfm`). No JS changes, so vitest is unaffected; verification is live SQL.

**Spec:** `docs/superpowers/specs/2026-08-06-per-location-communication-preferences-design.md`

---

## Context the implementer needs

Read these before starting:

- The spec above, especially "Trap: `contact_preferences.location_id` already exists and is a decoy". That column is populated but **decorative** — `contact_preferences` has `UNIQUE (contact_id)` so it can never hold per-location state. Do not repurpose it.
- `CLAUDE.md` → Invariants → "Data access & security". Migrations are forward-only; run `get_advisors` (type=security) after DDL; apply the migration **before** any code depending on it deploys.
- **The restrictive-`FOR ALL` trap** (mig 485): a `RESTRICTIVE FOR ALL ... USING (false)` policy denies SELECT too and fails *silently* — reads return an empty set, not an error. This plan uses a single **PERMISSIVE** `FOR ALL` policy, matching the sibling tables. `npm run check:rls-restrictive` gates the class.

### File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/486_contact_location_preferences.sql` | DDL only — table, index, RLS policy, updated_at trigger, `consent_log.location_id`, deprecation comments |
| `supabase/migrations/487_contact_location_preferences_backfill.sql` | Data only — backfill, `unsubscribed` retirement, Hatch seed, assertions |
| `docs/CHANGELOG.md` | One entry, per repo convention |

Split follows the existing precedent of `482_email_tickets.sql` / `484_email_tickets_backfill.sql`.

### Live baseline (measured 2026-08-06 — re-measure in Task 1, do not trust these blindly)

| Fact | Count |
|---|---|
| `contacts` | 8,558 |
| `contacts` with non-null `location_id` | 8,555 |
| `contacts` with NULL `location_id` | 3 |
| `contact_preferences` rows | 8,557 |
| Contacts with no preferences row | 1 |
| Active `hatch-founding-member` tags (all Hatch-scoped) | 81 |

---

### Task 1: Re-measure the baseline

The numbers above are from 2026-08-06 and the database is live. The assertions in Task 3 must match reality at apply time, not at plan time.

**Files:** none (read-only)

- [ ] **Step 1: Run the baseline query**

Use the Supabase MCP `execute_sql` against `iyvtbjjxdggiadzwwvdj`:

```sql
select
  (select count(*) from contacts)                                   as contacts_total,
  (select count(*) from contacts where location_id is not null)     as contacts_with_location,
  (select count(*) from contacts where location_id is null)         as contacts_null_location,
  (select count(*) from contact_preferences)                        as pref_rows,
  (select count(*) from contact_tags
    where tag='hatch-founding-member' and removed_at is null)       as hatch_tags;
```

- [ ] **Step 2: Record the results**

Write the five numbers down. `contacts_with_location` and `hatch_tags` are used verbatim in Task 3's assertions. If `contacts_null_location` is no longer 3, that is fine — the assertion only warns on it — but note the new value.

- [ ] **Step 3: Confirm the next migration number**

Run: `ls supabase/migrations | tail -5`
Expected: highest prefix is `485` (it appears twice — `485_email_mailboxes.sql` and `485_rls_restrictive_forall_kills_select.sql`, duplicated on purpose). So the next numbers are **486** and **487**. If something ≥486 now exists, shift both files up and keep them adjacent.

---

### Task 2: Write migration 486 (DDL)

**Files:**
- Create: `supabase/migrations/486_contact_location_preferences.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- 486 — contact_location_preferences (LOCCOMMS.1, spec 2026-08-06).
--
-- Hatch Street is a standalone business sharing an org with Stillorgan, and
-- `contact_preferences` cannot express that: it carries UNIQUE (contact_id), so
-- there is exactly one set of marketing preferences per person for the whole
-- estate. Restoring the consent someone gave on the Hatch waitlist form also
-- re-subscribed them to Stillorgan, which they had opted out of.
--
-- This table makes the *communication relationship* per-location while the
-- contact stays shared. Nobody's contacts.location_id moves.
--
-- SEMANTICS — read this before writing any query against it:
--   Row ABSENT      = that location may NEVER send to this contact.
--   Row present     = they opted into that location; the booleans are the
--                     per-channel state within it.
--   All three false = joined, then unsubscribed (distinct from never joined).
-- Channels default true INSIDE a row because creating the row IS the opt-in act.
--
-- Nothing reads this table yet — the send paths cut over in LOCCOMMS PR 3.

create table contact_location_preferences (
  contact_id         uuid not null references contacts(id)  on delete cascade,
  location_id        uuid not null references locations(id) on delete cascade,
  email_marketing    boolean not null default true,
  sms_marketing      boolean not null default true,
  whatsapp_marketing boolean not null default true,
  subscribed_at      timestamptz not null default now(),
  source             text not null,
  unsubscribed_at    timestamptz,
  updated_at         timestamptz not null default now(),
  primary key (contact_id, location_id)
);

-- The send path filters by (location_id, channel); contact_id is already the
-- PK prefix so contact-keyed lookups are served by the primary key.
create index idx_clp_location on contact_location_preferences (location_id);

alter table contact_location_preferences enable row level security;

-- ONE permissive FOR ALL policy, mirroring contact_preferences_location_scoped.
-- Staff see only rows for locations they belong to. Service-role routes bypass
-- RLS entirely and enforce access in app code (see CLAUDE.md invariants).
-- Deliberately NOT a restrictive FOR ALL — that pattern denies SELECT too and
-- fails silently (mig 485).
create policy contact_location_preferences_location_scoped
  on contact_location_preferences
  as permissive for all to authenticated
  using (private.auth_is_in_location(location_id))
  with check (private.auth_is_in_location(location_id));

create trigger contact_location_preferences_updated_at
  before update on contact_location_preferences
  for each row execute function update_updated_at();

-- consent_log becomes location-aware. Nullable: existing rows predate the
-- per-location model and stay null.
alter table consent_log add column location_id uuid references locations(id);
create index idx_consent_log_location on consent_log (location_id);

comment on table contact_location_preferences is
  'LOCCOMMS.1 — per-location marketing consent. Row absent = that location may never send. Supersedes the marketing columns on contact_preferences.';

comment on column contact_preferences.location_id is
  'DECORATIVE. contact_preferences has UNIQUE(contact_id), so this column can never express per-location state — it is a denormalised copy of contacts.location_id and nothing reads it. Superseded by contact_location_preferences (mig 486). DO NOT DRIVE.';
```

- [ ] **Step 2: Verify the two functions referenced actually exist**

`private.auth_is_in_location` and `update_updated_at` are both used by existing
tables, but confirm before applying — a missing function fails the migration.

```sql
select p.proname, n.nspname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.proname in ('auth_is_in_location','update_updated_at');
```

Expected: `auth_is_in_location` in schema `private`, `update_updated_at` in `public`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/486_contact_location_preferences.sql
git commit -m "LOCCOMMS.1 — mig 486: contact_location_preferences + consent_log.location_id"
```

---

### Task 3: Write migration 487 (backfill + assertions)

**Files:**
- Create: `supabase/migrations/487_contact_location_preferences_backfill.sql`

Every expected value in the assertions is computed from the database at apply time, so there is nothing to hand-substitute. Task 1's numbers are for your own sanity-check against the `raise notice` output, not for pasting in.

- [ ] **Step 1: Write the backfill migration**

```sql
-- 487 — backfill contact_location_preferences (LOCCOMMS.1).
--
-- Day one must be a ZERO-BEHAVIOUR-CHANGE event. Nothing reads this table yet,
-- but PR 3 cuts the send paths over to it, and a backfill that misses anyone
-- means campaigns silently under-send — the exact failure mode that motivated
-- this work. Hence the assertions: they raise, which rolls the whole migration
-- back rather than leaving a half-populated table.

-- 1. Every contact WITH a location gets a row at that location.
--    A contact with no contact_preferences row defaults to TRUE, because
--    applyFormMarketingConsent already treats a missing row as opted in
--    (`const current = pref ? !!pref[ch] : true`). Copying that default
--    preserves today's behaviour exactly.
--    email_status='unsubscribed' is a CONSENT state, so it folds into
--    email_marketing here and the column is retired in step 2.
insert into contact_location_preferences
  (contact_id, location_id, email_marketing, sms_marketing, whatsapp_marketing,
   subscribed_at, unsubscribed_at, source)
select
  c.id,
  c.location_id,
  coalesce(p.email_marketing, true) and c.email_status is distinct from 'unsubscribed',
  coalesce(p.sms_marketing, true),
  coalesce(p.whatsapp_marketing, true),
  coalesce(p.created_at, c.created_at, now()),
  case
    when (coalesce(p.email_marketing, true) and c.email_status is distinct from 'unsubscribed') = false
     and coalesce(p.sms_marketing, true)      = false
     and coalesce(p.whatsapp_marketing, true) = false
    then coalesce(p.updated_at, now())
    else null
  end,
  'migration'
from contacts c
left join contact_preferences p on p.contact_id = c.id
where c.location_id is not null
on conflict (contact_id, location_id) do nothing;

-- 2. Retire the 'unsubscribed' value. email_status now carries reputation only
--    (active | bounced | complained). bounced/complained are untouched — they
--    are address-level facts and must stay global.
update contacts set email_status = 'active' where email_status = 'unsubscribed';

-- 3. Seed Hatch Street (and any future location list) from the tag evidence.
--    contact_tags.location_id already carries the correct location scope.
--    ON CONFLICT DO NOTHING is correct: a tag-holder whose contact row is
--    already AT that location got their row in step 1, and for them the global
--    preference WAS their location preference — every send they ever received
--    from that location was governed by it. Only tag-holders whose contact row
--    lives elsewhere need a fresh opted-in row, which is exactly the set that
--    is currently unreachable.
insert into contact_location_preferences
  (contact_id, location_id, email_marketing, sms_marketing, whatsapp_marketing,
   subscribed_at, source)
select ct.contact_id, ct.location_id, true, true, true, ct.added_at, 'waitlist_form'
from contact_tags ct
where ct.tag = 'hatch-founding-member'
  and ct.removed_at is null
  and ct.location_id is not null
on conflict (contact_id, location_id) do nothing;

-- 4. Assertions. A raise here aborts the transaction and rolls back 1-3.
do $$
declare
  expected_contacts int;
  actual_contacts   int;
  null_loc          int;
  hatch_people      int;
  hatch_expected    int;
begin
  select count(*) into expected_contacts from contacts where location_id is not null;
  select count(distinct contact_id) into actual_contacts from contact_location_preferences;
  select count(*) into null_loc from contacts where location_id is null;

  -- Expected = every active, location-scoped tag. Actual = those that ended up
  -- with a matching preference row. Counting them from different tables is what
  -- makes this a real check rather than a tautology.
  select count(*) into hatch_expected
    from contact_tags
   where tag = 'hatch-founding-member' and removed_at is null and location_id is not null;

  select count(distinct clp.contact_id) into hatch_people
    from contact_location_preferences clp
    join contact_tags ct
      on ct.contact_id = clp.contact_id
     and ct.location_id = clp.location_id
     and ct.tag = 'hatch-founding-member'
     and ct.removed_at is null;

  if actual_contacts <> expected_contacts then
    raise exception
      'LOCCOMMS.1 backfill parity FAILED: % contacts have a location but only % are in contact_location_preferences',
      expected_contacts, actual_contacts;
  end if;

  if hatch_people <> hatch_expected then
    raise exception
      'LOCCOMMS.1 Hatch seed FAILED: % active Hatch tags but only % have a preference row',
      hatch_expected, hatch_people;
  end if;

  if exists (select 1 from contacts where email_status = 'unsubscribed') then
    raise exception 'LOCCOMMS.1 FAILED: contacts.email_status still contains ''unsubscribed''';
  end if;

  raise notice 'LOCCOMMS.1 backfill OK — % contacts, % Hatch list members, % null-location contacts skipped (already unreachable by every campaign)',
    actual_contacts, hatch_people, null_loc;
end $$;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/487_contact_location_preferences_backfill.sql
git commit -m "LOCCOMMS.1 — mig 487: backfill contact_location_preferences with abort-on-mismatch assertions"
```

---

### Task 4: Apply and verify against the live database

- [ ] **Step 1: Confirm the target project**

Use the Supabase MCP `list_projects`. Confirm `iyvtbjjxdggiadzwwvdj` is `un1t-crm`.
Applying to `tpttqakxmyxrwnqjepfm` (sentinel) would be wrong.

- [ ] **Step 2: Apply 486**

Use `apply_migration` with name `486_contact_location_preferences` and the file's contents.
Expected: success, no error.

- [ ] **Step 3: Apply 487**

Use `apply_migration` with name `487_contact_location_preferences_backfill`.
Expected: success. **If an assertion raised, nothing was written** — read the message, fix the cause, and re-apply. Do not weaken an assertion to make it pass.

- [ ] **Step 4: Verify the shape landed**

```sql
select
  (select count(*) from contact_location_preferences)                       as rows_total,
  (select count(distinct contact_id) from contact_location_preferences)     as distinct_contacts,
  (select count(*) from contacts where location_id is not null)             as expected_contacts,
  (select count(*) from contacts where email_status = 'unsubscribed')       as should_be_zero,
  (select count(*) from contact_location_preferences where source='waitlist_form') as hatch_seeded;
```

Expected: `distinct_contacts == expected_contacts`; `should_be_zero == 0`;
`rows_total > distinct_contacts` (the extra rows are the cross-location Hatch seeds).

- [ ] **Step 5: Verify the two known cases resolved correctly**

This is the acceptance test for the whole design — these two people are why it exists.

```sql
select c.name, l.name as location, clp.email_marketing, clp.source
from contact_location_preferences clp
join contacts c   on c.id = clp.contact_id
join locations l  on l.id = clp.location_id
where lower(c.email) in ('emily.wilson@live.ie','davidtwomey22@hotmail.com')
order by c.name, l.name;
```

Expected: **two rows each.** Hatch Street with `email_marketing = true`, source
`waitlist_form`; Stillorgan with `email_marketing = false`, source `migration`.
Opted into Hatch, not Stillorgan — derived from evidence, with no manual edit.
If this does not hold, stop and diagnose; do not hand-patch the rows.

- [ ] **Step 6: Run the security advisors**

Use `get_advisors` with `type=security`. Required after any DDL.
Expected: no new ERROR-level findings naming `contact_location_preferences`.
The two pre-existing intentional SECURITY DEFINER warnings are known — do not "fix" them.

- [ ] **Step 7: Run the CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails
```

Expected: all pass. `check:rls-restrictive` replays every migration and must not flag
the new table (it is permissive, not restrictive). `check:location-scoping` derives
tenant tables from migrations — `contact_location_preferences` becomes one, which is
fine because no route queries it yet.

---

### Task 5: Changelog and PR

**Files:**
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Add the changelog entry**

Append a numbered entry in the file's existing style, covering: the new table and its
row-absent semantics; `consent_log.location_id`; the retirement of
`email_status='unsubscribed'`; that `contact_preferences` is now superseded for
marketing but still read by application code until PR 3; and that
`contact_preferences.location_id` is decorative and must not be driven.

- [ ] **Step 2: Commit and open the PR**

```bash
git add docs/CHANGELOG.md
git commit -m "LOCCOMMS.1 — changelog for migs 486/487"
git push -u origin HEAD
gh pr create --base main --fill
```

Report the PR URL. Pushing is not shipping.

---

## Definition of done

- [ ] `contact_location_preferences` exists with the PK, index, RLS policy and trigger
- [ ] `consent_log.location_id` exists and is nullable
- [ ] Every contact with a non-null `location_id` has exactly one `source='migration'` row
- [ ] All active `hatch-founding-member` tag-holders have a Hatch row
- [ ] No `contacts.email_status = 'unsubscribed'` remains
- [ ] Emily and David each have two rows: Hatch true, Stillorgan false
- [ ] Advisors clean; all eight CI-mirror checks pass
- [ ] **No application behaviour changed** — nothing reads the new table yet

## Explicitly out of scope for this PR

Do not start these; they are PRs 2–5 and each needs its own plan written against what
this one actually shipped:

- Changing `applyFormMarketingConsent` to write per-location
- Changing `buildAudienceQueryAsync` or the WhatsApp send path
- Unsubscribe tokens, the preference centre, `List-Unsubscribe` headers
- Touching `AUDIENCE_FIELDS`, the denormalised `contacts.email_marketing` column, or its
  sync triggers
- Dropping `contact_preferences`, or adding the `DEPRECATED (mig N)` comment to it — that
  belongs in PR 5, once reads have actually stopped. Marking it deprecated now would be
  false: application code still reads it until PR 3 cuts the send paths over.
