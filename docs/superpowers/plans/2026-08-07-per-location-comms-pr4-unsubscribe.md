# Per-location comms — PR 4: per-location unsubscribe + preference centre (LOCCOMMS.4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make unsubscribe mean "stop mailing me from *this* business" instead of "remove me from every UN1T list", and give people a preference centre that shows which lists they are actually on.

**Architecture:** The unsubscribe URL carries the sending location. No location in the URL = unsubscribe from everything, which is both the safe direction and exact back-compat for links already sitting in people's inboxes.

**Tech Stack:** Next.js App Router, Supabase, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-per-location-communication-preferences-design.md` (decision 3)
**Previous:** PR 1 `#1239` (table+backfill) · PR 2 `#1240` (sync triggers+capture) · PR 3 `#1242` (send cutover)

---

## Why this blocks the founding-member campaign

PR 3 made Hatch Street a real, separate audience — 82 reachable people. **But the unsubscribe link is still global.** Someone who opts out of a Hatch launch email comes off Stillorgan's list too, silently, and they never asked for that.

That is worse than it sounds. Stillorgan has 3,364 reachable contacts against Hatch's 82, so a single Hatch campaign can strip members off the list of the gym they actually attend. Until this ships, sending a location-specific campaign is a way to lose consent you already had.

## Scope: unsubscribe UX only

**The `email_status='unsubscribed'` retirement moves to PR 5.** It was in this PR's original scope. It is cleanup — five readers and four writers — and it is *independent* of the customer-facing change here. Keeping PR 4 tight matters because this is the compliance-critical surface: one-click behaviour is mandated by Gmail and Yahoo bulk-sender rules, and getting it wrong generates spam complaints against the sending domain **every location shares**.

Leaving `email_status` alone through PR 4 is safe: it blocks manual sends to people who opted out, which is the conservative direction.

## The URL design, and the one rule that matters

Today: `/unsubscribe/[token]` where the token is `contact_preferences.unsubscribe_token` — **per contact, not per location**.

PR 4 appends the sending location: `/unsubscribe/[token]?l=<locationId>`.

**BACK-COMPAT RULE — do not get this wrong.** Emails already delivered carry the *old* URL with no `l`. Those links must keep working, and with **no `l` they unsubscribe from EVERY location** — today's exact behaviour. A person clicking an old link expects to be removed, and removing them from everything is the direction that cannot generate a complaint. Never default a missing `l` to "do nothing" or to a guessed location.

**Tampering** is acceptable here and should not be over-engineered. The token authenticates the *person*; `l` only selects which of **their own** lists to leave. Editing it lets someone unsubscribe themselves from a different gym — their data, their choice, no escalation. A per-location token column was considered and rejected as cost without a threat.

### File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/492_unsubscribe_location_audit.sql` | `consent_log.location_id` is already there (mig 487) — this only backfills `source` conventions if needed; **skip the migration entirely if nothing is required** |
| `src/lib/postmark.js` | `buildUnsubscribeUrl` gains `locationId`; footer copy names the business |
| `src/app/api/unsubscribe/[token]/route.js` | POST honours `?l=`; writes `contact_location_preferences` |
| `src/app/api/preferences/[token]/route.js` | GET returns every list; PATCH updates one |
| `src/app/preferences/[token]/page.js` | per-list toggles + "unsubscribe from everything" |
| `src/lib/campaign-sender.js`, `src/lib/sequences/steps.js` | pass the location when building the URL |

> **Note the two 491 migrations.** `491_contact_location_audience_view` (mine) and
> `491_zoom_sync_runs` (another session) both exist and are both applied. Keep both, per
> the mig 485 precedent — the `schema_migrations` rows are already named and renaming a
> file desyncs it from the database. Next free number is **492**.

---

### Task 1: `buildUnsubscribeUrl` carries the location

**Files:** Modify `src/lib/postmark.js`; Test: `src/lib/postmark.test.js`

- [ ] **Step 1: Write the failing test**

```js
describe('LOCCOMMS.4 — unsubscribe URL carries the sending location', () => {
  it('appends ?l= when a location is supplied', () => {
    const url = buildUnsubscribeUrl({ contact_preferences: [{ unsubscribe_token: 'tok' }] },
                                    'https://crm.example', 'loc-hatch')
    expect(url).toBe('https://crm.example/unsubscribe/tok?l=loc-hatch')
  })

  it('omits ?l= when no location is supplied — that means GLOBAL unsubscribe', () => {
    const url = buildUnsubscribeUrl({ contact_preferences: [{ unsubscribe_token: 'tok' }] },
                                    'https://crm.example')
    expect(url).toBe('https://crm.example/unsubscribe/tok')
  })

  it('survives the List-Unsubscribe transform with the param intact', () => {
    const page = buildUnsubscribeUrl({ contact_preferences: [{ unsubscribe_token: 'tok' }] },
                                     'https://crm.example', 'loc-hatch')
    expect(toListUnsubscribeUrl(page)).toBe('https://crm.example/api/unsubscribe/tok?l=loc-hatch')
  })
})
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement** — add an optional third arg; append `?l=${locationId}` only when truthy. Leave the existing token fallback (`prefs?.unsubscribe_token || contact?.id`) exactly as it is.
- [ ] **Step 4: Run tests** — the existing `toListUnsubscribeUrl` tests must still pass (it does a plain `/unsubscribe/` → `/api/unsubscribe/` replace, so a query string rides along untouched; the third test above pins that).
- [ ] **Step 5: Commit.**

---

### Task 2: the one-click POST honours the location

**Files:** Modify `src/app/api/unsubscribe/[token]/route.js`; Test: new `src/app/api/unsubscribe/unsubscribe-scope.test.js`

- [ ] **Step 1: Write the failing tests**

Three cases, and the second is the one that matters:

```js
it('with ?l= — unsubscribes ONLY that location', async () => { /* other location's row untouched */ })
it('with NO ?l= — unsubscribes EVERY location (back-compat for links already in inboxes)', async () => {})
it('defaults to email_marketing only when the body is empty (Gmail one-click)', async () => {})
```

- [ ] **Step 2: Run them, confirm they fail.**

- [ ] **Step 3: Implement**

After resolving the token to a contact, read `?l=` from the request URL:
- **present** → update `contact_location_preferences` for `(contact_id, that location)` only
- **absent** → update **all** of that contact's rows

Write one `consent_log` row per (channel, location) with `source: 'one_click_unsubscribe'` and the `location_id` column added in mig 487, so the audit trail finally records *which* business was left.

**Keep the empty-body default of `['email_marketing']`.** Gmail's one-click POSTs with no body, and a person clicking "Unsubscribe" in an email must not silently lose WhatsApp and SMS too.

**Leave the `contacts.email_status` stamp alone** — that is PR 5. It is a global flag and under a per-location unsubscribe it is now imprecise, but leaving it set is the conservative direction and removing it here would widen this PR into PR 5's cleanup.

- [ ] **Step 4: Run tests.**  - [ ] **Step 5: Commit.**

---

### Task 3: the preference centre shows every list

**Files:** Modify `src/app/api/preferences/[token]/route.js` and `src/app/preferences/[token]/page.js`

- [ ] **Step 1: Write the failing API test** — GET returns one entry per `contact_location_preferences` row with the location's display name and the three channel booleans.

- [ ] **Step 2: Run it, confirm it fails.**

- [ ] **Step 3: Implement the API** — GET joins `locations` for the name; PATCH takes `{ locationId, channels: {...} }` and updates exactly one row. A PATCH with no `locationId` applies to all rows (the "unsubscribe from everything" control).

- [ ] **Step 4: Implement the page** — one card per list, three toggles each, plus a single prominent **"Unsubscribe from all UN1T emails"**. Compose from `@/components/ui` primitives; status chips use `bg-<c>-500/10 text-<c>-700` (lint-enforced).

That global control is not optional politeness: it is what stops someone who wants out entirely from reaching for the spam button, and complaints damage the sending domain every location shares.

- [ ] **Step 5: Run tests + `npm run build`.**  - [ ] **Step 6: Commit.**

---

### Task 4: footers name the business

**Files:** Modify `src/lib/postmark.js` (`appendUnsubscribeFooter`), `src/lib/campaign-sender.js`, `src/lib/sequences/steps.js`

- [ ] **Step 1: Write the failing test** — the footer contains the location's display name, e.g. *"You're receiving this because you joined the UN1T Hatch Street list."*

- [ ] **Step 2: Run it, confirm it fails.**

- [ ] **Step 3: Implement.** Thread the location name through and fall back to today's generic wording when it is unavailable — never render a half-built sentence.

**Copy must be operator-editable** (settings field + default fallback), per the repo invariant — not hard-coded.

- [ ] **Step 4: Pass the location at both send sites** so the URL actually carries it:
  - `campaign-sender.js:434` → `buildUnsubscribeUrl(contact, baseUrl, campaign.location_id)`
  - `sequences/steps.js:167` → the sequence's location

**Check `sequences/steps.js` fetches the token.** It calls `buildUnsubscribeUrl(contact, …)` but no sequences query selects `contact_preferences(unsubscribe_token)`, so it is currently falling back to `contact.id`. That is pre-existing and out of scope to fix here, but confirm the URL still resolves — if the route does not accept a bare contact id, sequence unsubscribe links are already broken and that becomes a bug worth its own fix.

- [ ] **Step 5: Run tests.**  - [ ] **Step 6: Commit.**

---

### Task 5: verify end to end

- [ ] **Step 1: Full CI mirror + `npm run build`.**

- [ ] **Step 2: Prove per-location isolation against live data** (abort-guaranteed, nothing persists):

```sql
do $$
declare cid uuid; msg text;
begin
  select id into cid from contacts where lower(email)='emily.wilson@live.ie';
  -- simulate the route's per-location write
  update contact_location_preferences set email_marketing = false
   where contact_id = cid and location_id = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4';
  select string_agg(l.name || '=' || clp.email_marketing::text, ', ' order by l.name) into msg
    from contact_location_preferences clp join locations l on l.id = clp.location_id
   where clp.contact_id = cid;
  raise exception 'PER-LOCATION UNSUB >>> %', msg;
end $$;
```

Expected: Hatch `false`, Stillorgan **unchanged**. If Stillorgan also flipped, the PR 2 sync trigger is over-propagating and this PR must not ship.

- [ ] **Step 3: Confirm an OLD-style link still unsubscribes globally** — the back-compat rule.

- [ ] **Step 4: Changelog + PR.**

---

## Definition of done

- [ ] `?l=` unsubscribes exactly one location; absent `l` unsubscribes all
- [ ] One-click with an empty body still means email only
- [ ] `consent_log` records the location
- [ ] Preference centre lists every list with per-channel toggles + a global opt-out
- [ ] Footers name the business, operator-editable with a fallback
- [ ] Both send sites pass their location
- [ ] `contacts.email_status` untouched — PR 5
- [ ] Eight CI checks + build + the live isolation probe

## Out of scope

- Retiring `email_status='unsubscribed'` and its five readers — **PR 5**
- `AUDIENCE_FIELDS`, denormalised columns, deprecating `contact_preferences` — PR 5
- Fixing the pre-existing missing `unsubscribe_token` fetch in sequences — flag it, do not fix it here
