# Per-location comms — PR 3: the send-path cutover (LOCCOMMS.3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `contact_location_preferences` the authority for who receives a marketing broadcast, so Hatch Street can finally mail its own list — including the 23 people who have been silently unreachable since June.

**Architecture:** A view, not a join. `contact_location_audience` exposes `contacts.*` plus the location's channel flags under **distinct** names, so the send paths keep doing single-table filtering and every existing audience filter works untouched.

**Tech Stack:** Postgres view (`security_invoker = on`), Supabase MCP, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-per-location-communication-preferences-design.md`
**Previous:** PR 1 (`#1239`, migs 487+488) table + backfill. PR 2 (`#1240`, migs 489+490) sync triggers + per-location capture.

---

## This is the sharp edge — read before touching anything

Every other PR in this programme is additive. **This one changes who receives email.** Get it wrong and you either mail people who unsubscribed or silently drop a campaign's audience, and neither raises an error.

Two hard-won constraints, both discovered the hard way and neither negotiable:

**1. Do NOT inner-join `contact_location_preferences`.** `buildAudienceQuery` carries the CLASSIFY.1 note: the codebase already tried inner-joining `contact_preferences` and moved to a denormalised column because of *"a long line of PostgREST embedded-resource bugs in the count path"* — `head:true` counts silently returning wrong numbers. `CLAUDE.md` records the same trap independently ("Embedded-resource filters break under count-only (`head:true`) selects → return 0, no error").

**2. Do NOT resolve ids and use `.in('id', …)`.** That is the tag-filter pattern and it is deliberately bounded by `MAX_EXCLUSION_IDS`, with a comment about *"blowing the URL-length limit"*. Stillorgan's membership is ~8,500 ids.

Hence the view.

### Why the view is shaped the way it is

`contacts` has **94 columns**, and both tables have `email_marketing`. Postgres rejects duplicate column names in a view, so a naive `c.*, clp.*` fails. Enumerating 93 columns would work but rots: a column added to `contacts` later would silently vanish from the view.

Instead the location's flags get **distinct names**, so `c.*` can be used verbatim and stays future-proof:

| View column | Source | Meaning |
|---|---|---|
| *(all 94 `contacts` columns, unchanged)* | `c.*` | includes `location_id` = the contact's **home** location, and `email_administrative`, which **stays global by design** |
| `audience_location_id` | `clp.location_id` | the **list** they are on — this is what the send path filters |
| `loc_email_marketing` | `clp.email_marketing` | per-location consent |
| `loc_sms_marketing` | `clp.sms_marketing` | per-location consent |
| `loc_whatsapp_marketing` | `clp.whatsapp_marketing` | per-location consent |

An inner join, so **row absent = never send** is enforced by the view itself rather than by remembering to write a filter.

Note `email_administrative` deliberately keeps its global meaning — booking confirmations and reminders are transactional and follow the transaction, not a marketing list. Only the three marketing channels become per-location.

### What is NOT in this PR

**`contacts.email_status` is not touched.** It was going to be retired here; enumerating the readers moved it to PR 4. It is a hard suppressor in `/api/contacts/[id]/email` (which never fetches `email_marketing`), the contact-page and `ContactDrawer` badges, `booking-confirmations.js` and `event-attendee-reminders.js`. Retiring it is also only *coherent* once unsubscribe is per-location — today `'unsubscribed'` cannot answer "from which business?". Leaving it blocks manual sends to people who opted out, which is the conservative direction.

### File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/491_contact_location_audience_view.sql` | The view + a pre-cutover drift assertion |
| `src/lib/postmark.js` | `buildAudienceQuery` **and** `buildAudienceQueryAsync` |
| `src/lib/whatsapp.js` | broadcast count + list |
| `src/lib/sms.js` | `smsAudienceBase` — currently a `contact_preferences!inner` embed |
| `src/lib/*.test.js` | parity tests per path |
| `docs/CHANGELOG.md` | One entry |

---

### Task 1: The view + drift assertion

**Files:** Create `supabase/migrations/491_contact_location_audience_view.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 491 — contact_location_audience (LOCCOMMS.3). The read surface for sends.
--
-- A VIEW, not a join. buildAudienceQuery's CLASSIFY.1 note records that this
-- codebase already tried inner-joining contact_preferences and retreated to a
-- denormalised column because of "a long line of PostgREST embedded-resource
-- bugs in the count path" — head:true counts silently returning wrong numbers.
-- A wrong count in the send path is a campaign that under- or over-sends with
-- no error. Resolving ids and using .in('id', …) is closed too: that pattern is
-- bounded by MAX_EXCLUSION_IDS over URL-length limits, and Stillorgan alone has
-- ~8,500 members.
--
-- The view keeps sends on SINGLE-TABLE filtering, which is what CLASSIFY.1 was
-- protecting, while making per-location consent the authority.
--
-- COLUMN NAMING: contacts has 94 columns and both tables have email_marketing;
-- Postgres rejects duplicate names in a view. The location's flags therefore get
-- DISTINCT names so `c.*` can be used verbatim and stays future-proof — a column
-- added to contacts later appears here automatically instead of silently
-- vanishing from every audience.
--
--   location_id           = the contact's HOME location (from contacts, unchanged)
--   audience_location_id  = the LIST they are on   <- what sends filter
--   loc_*_marketing       = per-location consent   <- what sends gate on
--
-- email_administrative is deliberately NOT here as a loc_ column: transactional
-- mail follows the transaction, not a marketing list, so it keeps its global
-- meaning via c.*.
--
-- INNER join: row absent = that location may never send, enforced structurally
-- rather than by remembering to write a filter.

create view contact_location_audience
with (security_invoker = on) as
select
  c.*,
  clp.location_id        as audience_location_id,
  clp.email_marketing    as loc_email_marketing,
  clp.sms_marketing      as loc_sms_marketing,
  clp.whatsapp_marketing as loc_whatsapp_marketing
from contacts c
join contact_location_preferences clp on clp.contact_id = c.id;

comment on view contact_location_audience is
  'LOCCOMMS.3 — send-path read surface. Filter audience_location_id + loc_*_marketing. A view rather than a PostgREST embed because embedded-resource filters silently break head:true counts (CLASSIFY.1).';

-- Pre-cutover assertion. PR 2's triggers keep this table in step, so a repair
-- pass is no longer needed — but prove it rather than assume it, because from
-- the moment the code below ships this table decides who gets email.
do $$
declare missing int; drifted int; moved int;
begin
  select count(*) into missing from contacts c
   where c.location_id is not null
     and not exists (select 1 from contact_location_preferences clp
                      where clp.contact_id = c.id and clp.location_id = c.location_id);

  select count(*) into drifted from contacts c
    join contact_location_preferences clp
      on clp.contact_id = c.id and clp.location_id = c.location_id
   where c.email_marketing = false and clp.email_marketing = true;

  -- The one case the PR 2 triggers do NOT cover: a contact whose
  -- contacts.location_id changed after their row was created. They keep a row
  -- at the OLD location and have none at the new one.
  select count(*) into moved from contacts c
   where c.location_id is not null
     and exists (select 1 from contact_location_preferences clp where clp.contact_id = c.id)
     and not exists (select 1 from contact_location_preferences clp
                      where clp.contact_id = c.id and clp.location_id = c.location_id);

  if missing > 0 then
    raise exception 'LOCCOMMS.3 FAILED: % contacts have no row at their own location — cutting over now would make them unreachable', missing;
  end if;
  if drifted > 0 then
    raise exception 'LOCCOMMS.3 FAILED: % contacts opted out globally still show opted in at their own location — cutting over now would mail people who unsubscribed', drifted;
  end if;
  raise notice 'LOCCOMMS.3 pre-cutover clean — 0 missing, 0 drifted, % relocated contacts', moved;
end $$;
```

- [ ] **Step 2: Commit** (`git add` the file; message `LOCCOMMS.3 — mig 491: contact_location_audience view`)

---

### Task 2: Capture the BEFORE parity numbers

**This must happen before any JS changes and after the view exists.** It is the gate.

- [ ] **Step 1: Record the current audience for every location and channel**

```sql
select l.name,
       count(*) filter (where c.email_marketing and c.email_status not in ('bounced','complained')
                          and c.email_suppressed_at is null)                as email_now,
       count(*) filter (where c.whatsapp_marketing)                          as whatsapp_now
from contacts c join locations l on l.id = c.location_id
where c.location_id is not null
group by l.name order by l.name;
```

- [ ] **Step 2: Record what the NEW path would return**

```sql
select l.name,
       count(*) filter (where a.loc_email_marketing and a.email_status not in ('bounced','complained')
                          and a.email_suppressed_at is null)                as email_after,
       count(*) filter (where a.loc_whatsapp_marketing)                      as whatsapp_after
from contact_location_audience a join locations l on l.id = a.audience_location_id
group by l.name order by l.name;
```

- [ ] **Step 3: Diff them and STOP if anything is unexpected**

Expected: **every location identical except Hatch Street, which grows by exactly 23**
(the cross-location tag-holders). Any other movement means the model or the backfill is
wrong — do not proceed. Record both tables in the PR description.

---

### Task 3: Cut over `postmark.js`

**Files:** Modify `src/lib/postmark.js` (both builders); Test: `src/lib/postmark.test.js`

- [ ] **Step 1: Write the failing test**

```js
it('LOCCOMMS.3 — email audience reads the per-location consent column', () => {
  const q = buildAudienceQuery(mockDb(), null, 'loc-hatch')
  expect(q._from).toBe('contact_location_audience')
  expect(q._filters).toContainEqual(['eq', 'audience_location_id', 'loc-hatch'])
  expect(q._filters).toContainEqual(['eq', 'loc_email_marketing', true])
  // the contact's HOME location must NOT be the gate any more
  expect(q._filters).not.toContainEqual(['eq', 'location_id', 'loc-hatch'])
})
```

- [ ] **Step 2: Run it, confirm it fails** — `npx vitest run src/lib/postmark.test.js -t LOCCOMMS.3`

- [ ] **Step 3: Change both builders**

In `buildAudienceQuery` **and** `buildAudienceQueryAsync`:
- `.from('contacts')` → `.from('contact_location_audience')`
- `.eq('location_id', locationId)` → `.eq('audience_location_id', locationId)`
- the consent gate: map the marketing channels to their `loc_` names, leaving
  `email_administrative` pointing at the global column.

Add a `consentColumnFor(consentField)` helper so the mapping lives in one place:
`email_marketing → loc_email_marketing`, `whatsapp_marketing → loc_whatsapp_marketing`,
`sms_marketing → loc_sms_marketing`, anything else (i.e. `email_administrative`) unchanged.
Keep `assertConsentField`'s allowlist behaviour.

**Leave the reputation gates exactly as they are** — `email_status not in (bounced,
complained)` and `email_suppressed_at is null` are address-level and still come from `c.*`.

- [ ] **Step 4: Run the tests** — the new one passes and every existing postmark test still does.

- [ ] **Step 5: Commit**

---

### Task 4: Cut over `whatsapp.js`

**Files:** Modify `src/lib/whatsapp.js` (the count at ~688 and the list at ~834)

- [ ] **Step 1: Write the failing test** mirroring Task 3's, asserting
  `audience_location_id` + `loc_whatsapp_marketing`.
- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Change both sites** the same way.
- [ ] **Step 4: Run tests.**  - [ ] **Step 5: Commit.**

---

### Task 5: Cut over `sms.js`

`smsAudienceBase` is the odd one out — it still uses `contact_preferences!inner(sms_marketing)`,
the embed shape email abandoned under CLASSIFY.1. Moving it to the view removes that
embed as a side effect.

- [ ] **Step 1: Write the failing test** asserting the view, `audience_location_id`,
  `loc_sms_marketing`, and **no `contact_preferences` embed**.
- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Rewrite `smsAudienceBase`** against the view. Keep `sms_status = 'active'`
  and `phone is not null`.
- [ ] **Step 4: Run tests.**  - [ ] **Step 5: Commit.**

---

### Task 6: Post-cutover verification — the real gate

- [ ] **Step 1: Full CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails
```

- [ ] **Step 2: `npm run build`** — the view is a new table name in queries; catch resolution failures locally rather than in CI.

- [ ] **Step 3: Re-run the Task 2 parity queries and diff against the recorded BEFORE.**
Numbers must match what Task 2 predicted. If a location moved unexpectedly, revert rather
than investigate forward — this decides who receives email.

- [ ] **Step 4: Advisors** — `get_advisors` type=security. The view must be
`security_invoker = on`; a SECURITY DEFINER view is an ERROR-level finding.

- [ ] **Step 5: Prove the 23 are now reachable**

```sql
select count(*) from contact_location_audience
 where audience_location_id = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'
   and loc_email_marketing
   and email_status not in ('bounced','complained')
   and email_suppressed_at is null;
```

Expected ~81, versus the 58 a Hatch campaign could reach before this programme started.

---

## Definition of done

- [ ] `contact_location_audience` exists with `security_invoker = on`
- [ ] All three send paths read the view; none filters `contacts.location_id` for the audience
- [ ] `email_administrative` still resolves to the **global** column
- [ ] Reputation gates unchanged and still applied
- [ ] Parity: every location identical except Hatch, +23
- [ ] **`contacts.email_status` untouched** — still ~2,680 `unsubscribed`
- [ ] Eight CI checks + `npm run build` + advisors clean

## Out of scope

- Retiring `email_status='unsubscribed'` and its five readers — **PR 4**
- Per-location unsubscribe, preference centre, `List-Unsubscribe` — PR 4
- `AUDIENCE_FIELDS`, the denormalised columns, deprecating `contact_preferences` — PR 5
