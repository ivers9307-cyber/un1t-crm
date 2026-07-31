# Host Leads on the Master Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host signups/attendees land on the org's master (Stillorgan) contact — broadcast-reachable, tagged to host + events, mapped on the CRM profile — but never AUTO-enrolled in automations (manual enrolment still includes them); existing anchor-location leads migrate once.

**Architecture:** One migration (org `master_location_id` + `contacts.automations_exempt`); a placement helper; an exemption gate at the single enrolment choke point (`enrolContacts`, keyed on `sourceType === 'manual'`); tag writes in the existing attendee-sync hook; a live-read Events card + exempt badge on the contact profile; an idempotent admin migration route reusing `src/lib/contact-merge.js`.

**Tech Stack:** Next.js 16 App Router, Supabase service client, Zod, Vitest. Spec: `docs/superpowers/specs/2026-07-31-host-leads-master-profile-design.md`. Worktree `~/code/un1t-crm-hostgrowth`, branch `host-leads-stillorgan`.

**Repo rules binding every task:** thenable builders (`try/catch`, never `.catch`); `await` every write; 1k-row cap → `.range()`-paginate fan-outs; select options only on FIRST `.select()`; migrations via Supabase MCP against `iyvtbjjxdggiadzwwvdj` then `get_advisors`; `type="button"` on non-submit buttons; CI mirror (6 checks) + `npm run build` before push. **Next free migration number: 464** (dir has 460 + 463; re-check at apply time).

**Verified planning facts:** every AUTOMATIC enrolment passes a named sourceType (`contact_created`, `tag_added`, `race_registered`, `race_finished`, `booking_created`, `first_booking`, `pipeline_stage_change`, `membership_state_change`, `segment_added/removed`, `invoice_past_due` (dunning), `event_reminder`, `anniversary`, `inactivity`, `achievement_unlocked`); `enrolContacts` defaults `sourceType='manual'` and manual UI enrolment uses the default → the gate rule is exactly `sourceType !== 'manual'` → filter. Merge machinery exists: `src/lib/contact-merge.js` (`getContactImpact`, `pickMergedFields`, `mergeTagArrays`, …) + `POST /api/contacts/merge`. `findOrCreateRaceContact({ db, locationId, email, name, phone, restrictToLocation })` matches at `locationId` then creates there.

---

### Task 1: Migration 464 + apply

**Files:** Create `supabase/migrations/464_master_location_and_automations_exempt.sql`

- [ ] **Step 1: Write the migration**

```sql
-- HOST-MASTER.1 — host leads live on the org's MASTER location (Stillorgan
-- for UN1T Group) instead of the host anchor location, and are exempt from
-- AUTOMATIC sequence/automation enrolment (manual enrolment ignores the flag).
alter table organizations
  add column if not exists master_location_id uuid references locations(id);
comment on column organizations.master_location_id is
  'HOST-MASTER.1 — where host-sourced contacts are placed/matched. NULL = fall back to the host anchor location (pre-master behaviour).';

update organizations o
   set master_location_id = 'a0000000-0000-0000-0000-000000000001'
 where o.id = (select organization_id from locations where id = 'a0000000-0000-0000-0000-000000000001')
   and o.master_location_id is null;

alter table contacts
  add column if not exists automations_exempt boolean not null default false;
comment on column contacts.automations_exempt is
  'HOST-MASTER.1 — blocks AUTOMATIC sequence/automation enrolment only (enrolContacts sourceType != manual). Manual staff enrolment includes them. Set on host-sourced contact CREATION; never set on matched existing contacts.';

create index if not exists idx_contacts_automations_exempt
  on contacts (id) where automations_exempt;
```

- [ ] **Step 2: Apply via Supabase MCP** (`apply_migration`, project `iyvtbjjxdggiadzwwvdj`, name `464_master_location_and_automations_exempt`), then `get_advisors` type=security — expect no NEW findings.
- [ ] **Step 3: Commit** — `git add supabase/migrations/464_master_location_and_automations_exempt.sql && git commit -m "HOST-MASTER.1 — mig 464: organizations.master_location_id + contacts.automations_exempt"`

### Task 2: `resolveMasterLocationId` + `eventTagFor` (TDD)

**Files:** Modify `src/lib/host-events.js` (helpers live beside `ensureAnchorLocation`); Modify `src/lib/host-contact-list.js` (eventTagFor beside hostTagFor); Tests: extend `src/lib/host-events.test.js` and `src/lib/host-contact-list.test.js`.

- [ ] **Step 1: Failing tests**

`host-events.test.js` (mirror the file's mock style):

```js
describe('resolveMasterLocationId', () => {
  it('returns the org master location when set', async () => {
    const db = orgDb({ master_location_id: 'master-1' })
    expect(await resolveMasterLocationId(db, { organization_id: 'org-1', anchor_location_id: 'anchor-1' })).toBe('master-1')
  })
  it('falls back to the host anchor location when unset', async () => {
    const db = orgDb({ master_location_id: null })
    expect(await resolveMasterLocationId(db, { organization_id: 'org-1', anchor_location_id: 'anchor-1' })).toBe('anchor-1')
  })
})
```

(`orgDb` = minimal mock returning the row from `.from('organizations').select(...).eq('id', …).maybeSingle()`.)

`host-contact-list.test.js`:

```js
describe('eventTagFor', () => {
  it('builds event:<slug>', () => expect(eventTagFor({ slug: 'pride-sep20' })).toBe('event:pride-sep20'))
  it('falls back to normalised name then event', () => {
    expect(eventTagFor({ slug: null, name: 'Pride Run 5K' })).toBe('event:pride-run-5k')
    expect(eventTagFor({})).toBe('event:event')
  })
})
```

- [ ] **Step 2: Run to fail** — `npx vitest run src/lib/host-events.test.js src/lib/host-contact-list.test.js`
- [ ] **Step 3: Implement**

`host-events.js`:

```js
// HOST-MASTER.1 — where host-sourced CONTACTS live. The org's master
// location when configured (Stillorgan for UN1T Group, mig 464);
// otherwise the host's anchor location — fail-open to the pre-master
// behaviour, never to a wrong location. Errors also fall back.
export async function resolveMasterLocationId(db, host) {
  try {
    if (!host?.organization_id) return host?.anchor_location_id || null
    const { data } = await db
      .from('organizations')
      .select('master_location_id')
      .eq('id', host.organization_id)
      .maybeSingle()
    return data?.master_location_id || host.anchor_location_id || null
  } catch {
    return host?.anchor_location_id || null
  }
}
```

`host-contact-list.js` (reuse hostTagFor's normalisation — extract the shared base):

```js
function tagBase(input, fallback) {
  const base = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || fallback
}
export function hostTagFor(host) {
  return `host:${tagBase(host?.slug || host?.name, 'host')}`
}
// HOST-MASTER.3 — one tag per race event a contact attends.
export function eventTagFor(raceEvent) {
  return `event:${tagBase(raceEvent?.slug || raceEvent?.name, 'event')}`
}
```

- [ ] **Step 4: Run tests green** (both files, all pre-existing tests still pass — hostTagFor behaviour identical).
- [ ] **Step 5: Commit** — `HOST-MASTER.2 — resolveMasterLocationId + eventTagFor helpers`

### Task 3: enrolContacts auto-enrolment gate (TDD) — the new regression contract

**Files:** Modify `src/lib/sequences/enrol.js:31` region; Test: the sequences test file that covers enrolContacts (find `enrol.test.js` or the sequences suite — extend where enrolContacts is already tested; create `src/lib/sequences/enrol.exempt.test.js` if none).

- [ ] **Step 1: Failing tests** (adapt mocks to the file's existing style; the essential cases)

```js
it('drops automations_exempt contacts for non-manual sourceTypes', async () => {
  // contacts c1 (exempt) + c2 (not) both candidates; sourceType 'tag_added'
  // → only c2 inserted; skipped count includes c1
})
it('manual sourceType enrols exempt contacts', async () => {
  // same fixture, sourceType 'manual' (and the default/omitted case) → c1 AND c2 inserted
})
```

- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** — in `enrolContacts`, after the candidate list is computed and BEFORE insert:

```js
  // HOST-MASTER.1 — automations_exempt blocks AUTOMATIC enrolment only.
  // Every trigger/cron/segment/dunning caller passes a named sourceType;
  // 'manual' is exclusively the operator-initiated path (and the default),
  // which deliberately bypasses this gate (Richard: manual triggers must
  // include host leads).
  let candidates = candidatesAfterCooldown // ← whatever the existing final list var is
  let exemptSkipped = 0
  if (sourceType !== 'manual' && candidates.length > 0) {
    const { data: flags } = await db
      .from('contacts')
      .select('id')
      .in('id', candidates)
      .eq('automations_exempt', true)
    const exempt = new Set((flags || []).map(r => r.id))
    exemptSkipped = exempt.size
    candidates = candidates.filter(id => !exempt.has(id))
  }
```

and add `exemptSkipped` into the returned `skipped` count. (Read the function first; splice into its actual variable names, keep everything else identical. Candidate batches are ≤ page-size at call sites, but if any caller can exceed 1k ids, chunk the `.in()` by 500.)

- [ ] **Step 4: Full sequences suite green** — `npx vitest run src/lib/sequences`
- [ ] **Step 5: Commit** — `HOST-MASTER.3 — enrolContacts drops automations_exempt contacts for non-manual sources`

### Task 4: Placement + exempt flag on the two host write paths (TDD)

**Files:** Modify `src/lib/race-contact-linking.js` (`findOrCreateRaceContact` gains `insertFields`); Modify `src/app/api/public/host-list/[slug]/subscribe/route.js`; Modify `src/app/api/public/events/[slug]/register/route.js` AND `src/app/api/public/races/[slug]/register/route.js` (diff them first — they are near-twins; apply the same change to both); Tests: `src/lib/race-contact-linking.test.js` (extend).

- [ ] **Step 1: Failing test** — `insertFields` are stamped on CREATE but never on MATCH:

```js
it('applies insertFields on create only', async () => {
  // no existing match → insert payload includes automations_exempt: true
  // existing match → returns match id, NO update issued
})
```

- [ ] **Step 2: Implement `insertFields`** — signature `({ db, locationId, email, name = null, phone = null, restrictToLocation = false, insertFields = {} })`; spread `...insertFields` into the contact INSERT object only. No other behaviour change.
- [ ] **Step 3: Subscribe route** — replace the anchor-location resolution:

```js
    const locationId = await resolveMasterLocationId(db, host) || host.anchor_location_id || await ensureAnchorLocation(db, host)
    const contactId = await findOrCreateRaceContact({
      db, locationId, email,
      name: body.name,
      restrictToLocation: true,          // match at the MASTER location = link to the real member
      insertFields: { automations_exempt: true },  // new contacts only — matches keep their settings
    })
```

(import `resolveMasterLocationId` from `@/lib/host-events`; update the route's header comment — contacts now land at the org master location, anchor is the fallback.)

- [ ] **Step 4: Register routes** — in both register routes, where the event has been loaded: if the event's `host_id` is set (third-party host event), resolve the host row (`event_hosts` by `host_id`: `id, organization_id, anchor_location_id`) once and compute `contactLocationId = await resolveMasterLocationId(db, hostRow) || event.location_id`; pass that + `insertFields: { automations_exempt: true }` to EVERY `findOrCreateRaceContact` call in the file (captain + members + solo path — `src/lib/race-register-solo.js` too if it creates contacts; read it). Internal events (`host_id` null) keep `event.location_id` and no insertFields — zero behaviour change.
- [ ] **Step 5: Verify** — `npx vitest run src/lib/race-contact-linking.test.js && npm run lint && npm run build`; also run any existing register-route tests (`npx vitest run 'src/app/api/public'`).
- [ ] **Step 6: Commit** — `HOST-MASTER.4 — host signups/attendee contacts land at the org master location, exempt on create`

### Task 5: Event + host tags on confirmed attendance (TDD)

**Files:** Modify `src/lib/host-contact-list.js` (`addEventAttendeesToHostList`); Test: extend `src/lib/host-contact-list.test.js`.

- [ ] **Step 1: Failing test** — after the host_contacts upsert, each attendee contact receives `writeContactTag` calls for `eventTagFor(race)` and `hostTagFor(host)` (mock `@/lib/contact-tags`; race select now includes `slug, name` + host row provides slug/name — extend the function's race query and add a host lookup).
- [ ] **Step 2: Implement** — in `addEventAttendeesToHostList`, widen the race select to `id, host_id, slug, name`, load the host row (`event_hosts`: `id, slug, name`) once, and after the upsert loop:

```js
  // HOST-MASTER.3 — tag each attendee to the host + this event (both tag
  // systems; writeContactTag is idempotent and fires tag_added sequences,
  // which cannot auto-enrol exempt contacts thanks to the enrolContacts gate).
  const tags = [hostTagFor(host), eventTagFor(race)]
  for (const contactId of contactIds) {
    for (const tag of tags) {
      try { await writeContactTag(db, contactId, tag) } catch (e) { logWarn('host-contact-list', 'tag write failed', { err: e, contactId, tag }) }
    }
  }
```

(Check `writeContactTag`'s real signature in `src/lib/contact-tags.js` first and match it — including whether it also appends to `contacts.tags` or that needs the separate import-style append the subscribe route uses; replicate the subscribe route's dual-write exactly.) Callers are fire-and-forget with their own try/catch — per-tag failures must not throw past the loop.

- [ ] **Step 3: Tests green** — full `npx vitest run src/lib/host-contact-list.test.js`.
- [ ] **Step 4: Commit** — `HOST-MASTER.5 — confirmed host-event attendees get host + event tags`

### Task 6: Contact profile — Events card + No-auto-enrol badge/toggle

**Files:** Create `src/components/ContactEventsCard.jsx` (server-rendered props, plain list); Modify `src/app/contacts/[id]/page.js` (data fetch + render + badge); Modify the contact PATCH route + schema (find it: the route the profile's edit uses — likely `src/app/api/contacts/[id]/route.js` with a Zod schema in `src/lib/schemas.js`; add `automations_exempt: z.boolean().optional()`, Manager+ only — reject the field for lower roles); Create `src/components/AutomationsExemptToggle.jsx` (small client toggle calling the PATCH).

- [ ] **Step 1: Data fetch** — in the profile page's parallel `Promise.all`, add:

```js
    db.from('team_members')
      .select('id, teams:team_id ( name, race_registrations ( id, status, race_events ( id, name, slug, race_date, host_id, event_hosts:host_id ( name ) ) ) )')
      .eq('contact_id', id),
```

(Verify the embed path against the real FK graph first — `race_registrations` FK to teams; if the nested embed 300s (PGRST201 multi-FK), fall back to two queries: team_members → team ids → race_registrations by team_id with `race_events` embed.) Flatten to `[{ id, name, slug, race_date, status, hostName }]`, newest first.

- [ ] **Step 2: Card** — `ContactEventsCard` renders a `Card` (from `@/components/ui`) titled "Events", one row per registration: name (link to `/events/${id}` admin page), `race_date`, status chip (`bg-emerald-500/10 text-emerald-700` for confirmed — LIGHT-theme chip rule), "Hosted by X" line when hostName. Returns null when empty. Place it right after `<PastEventsCard …/>`.
- [ ] **Step 3: Badge + toggle** — next to the contact name header: when `contact.automations_exempt`, an amber chip `No auto-enrol` (`bg-amber-500/10 text-amber-700`). `AutomationsExemptToggle` (Manager+ only, `type="button"`) flips it via the PATCH route and refreshes. Schema/route change per Files note.
- [ ] **Step 4: Verify** — `npm run lint && npm run build`; profile renders for a contact with no registrations (card absent).
- [ ] **Step 5: Commit** — `HOST-MASTER.6 — Events card + No auto-enrol badge/toggle on the contact profile`

### Task 7: One-off migration route (dry-run first) (TDD)

**Files:** Create `src/lib/host-lead-migration.js` + `src/lib/host-lead-migration.test.js`; Create `src/app/api/admin/migrate-host-leads/route.js` (master/owner-gated, `?dry=1` default-on — mirror an existing admin backfill route, e.g. `src/app/api/admin/backfill-host-contacts/route.js`, for the gate + shape).

- [ ] **Step 1: Failing tests** for the pure planner `planHostLeadMigration(anchorContacts, masterContactsByEmail)`:

```js
it('plans a merge for an email match (case-insensitive)', …)   // → { action: 'merge', from, into }
it('plans a move for no match', …)                              // → { action: 'move', id }
it('skips contacts with no email as move (never merge)', …)
```

- [ ] **Step 2: Implement lib** — `planHostLeadMigration` (pure) + `runHostLeadMigration(db, { dryRun })`:
  1. Load `is_host_anchor` locations + their org's master_location_id (skip orgs without one).
  2. Page through contacts at each anchor location; load master-location contacts' `{ id, email }` map (paginated).
  3. Plan via the pure fn. Execute when `!dryRun`:
     - **move**: `update contacts set location_id = master, automations_exempt = true where id = …`.
     - **merge**: re-point child rows to the master contact — `host_contacts` (upsert-then-delete to respect UNIQUE(host_id, contact_id)), `team_members.contact_id`, `contact_tags` (insert-missing then delete), `contact_preferences` (keep the MASTER's rows; drop the anchor duplicate's), plus copy `contacts.tags` array entries onto the master via `mergeTagArrays` from `@/lib/contact-merge`; then delete the anchor contact row. Consult `getContactImpact` in `src/lib/contact-merge.js` + the merge route for the estate's full child-table list and mirror it for any table with rows (WhatsApp conversations etc. are unlikely for anchor contacts but handle via the same list, not assumptions).
  4. Return `{ planned, merged, moved, skipped, errors }`; log each merge pair via `logWarn('host-lead-migration', …)`.
- [ ] **Step 3: Route** — POST, `getCurrentUser()` → master/owner only (403), `?dry=1` unless `?dry=0`, returns the summary. Register in `openapi.js` (Admin tag).
- [ ] **Step 4: Verify** — lib tests green; `npm run check:route-guards && npm run lint && npm run build`.
- [ ] **Step 5: Commit** — `HOST-MASTER.7 — host-lead migration lib + admin route (dry-run default)`

### Task 8: Ship + run the migration

- [ ] **Step 1: Full CI mirror + build** (all six + `npm run build`).
- [ ] **Step 2: Docs** — `docs/CHANGELOG.md` entry; update the audience-scope test file's header comment (the separation contract changed: host leads now DELIBERATELY live at the master location; the pin still guarantees location isolation generally; auto-enrol protection = the enrolContacts gate).
- [ ] **Step 3: Push + PR** to main (`gh pr create`) with the standard body + verification summary; report URL. After merge + deploy: call `POST /api/admin/migrate-host-leads?dry=1`, review the plan, then `?dry=0`, then spot-check (host portal counts unchanged; a merged member shows tags + Events card; signup lands at Stillorgan exempt).

---

## Self-review notes (applied)

- Spec coverage: placement (T4), fallback helper (T2), exemption gate incl. manual bypass (T3), tags (T2/T5), profile card+badge (T6), migration (T7), invariant/doc updates (T8), consent note (spec-only, no build) ✓. Out-of-scope items untouched.
- Type consistency: `resolveMasterLocationId(db, host)` used identically in T4 (subscribe + register); `insertFields` param name consistent; `eventTagFor(raceEvent)` / `hostTagFor(host)` per T2 definitions.
- Known judgement points delegated with resolution paths named (embed FK fallback in T6; contact-merge child-table list in T7; register-route twin diff in T4) — each names the authoritative source to consult, not a TBD.
