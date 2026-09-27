## PR COACHNOTES.1: a coach's shift row carries their own note and the briefing, never the block's manager notes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `GET /api/schedule/shifts`, a row read by someone who is not a manager at that row's studio carries `notes` = the assignment's **own** note (or null), plus the block's `briefing`. It never carries the block's manager `notes`. Manager views, and callers that pass no viewer, are unchanged.

**Why:** Row B3 of `00-INDEX.md`, **APPROVED by Richard on 27 Sep**. COACHSCOPE.1 treats `shift_blocks.notes` as a manager's working note: `/api/schedule/blocks` strips it from coaches (`slimBlockForCoach`, `src/app/api/schedule/blocks/route.js:129-174`, pinned by `route.test.js:105-114`). BLOCKEDIT.1 (mig 629) then added `briefing` as the field written for coaches (`shared/shift-briefing.js:7-8` says block notes "stay out of coach surfaces"). One path still leaks it. `toApiShiftRow` collapses `notes: a.notes ?? b.notes ?? null` (`src/lib/roster-read.js:128`), and `slimShiftRowForCoach` keeps `notes` on the caller's **own** row (`:172`). So a coach whose assignment has no note of its own gets the block's manager note on their own row, and the phone's Schedule tab prints it under the shift (`mobile/app/(staff)/(tabs)/schedule.jsx:319-321`, `{shift.notes && …}`).

**Architecture:** One change in one module. `toApiShiftRow(a, { forCoach })` drops the block fallback for a coach-audience row. `fetchApiShiftRows` decides the audience once per row, from `viewer.isManagerAt(row's studio)`, **before** it builds the row. The block notes are then never on the coach row, so `slimShiftRowForCoach` cannot pass them on. No route, phone, `shared/` or schema change. The OpenAPI text for the route says what the row now carries.

**Tech Stack:** Next.js 16 App Router, Supabase PostgREST via the service-role client, Vitest (node).

**Size / ships:** S. **Web only. No migration. No OTA**: nothing under `mobile/` or `shared/` changes. The phone's own rows come from the server, so merging the web PR changes what phones receive on their next fetch. The row keeps the same keys (`notes` is still present; null where there is nothing to show), so old phone builds are unaffected. No new route, no permission key.

**Depends on:** nothing unmerged. Written against `origin/main` at `28d02e59` (#1779 DUBLINDAY.1). Every path and line below was checked against that tree. If main moves, find each anchor by the quoted text, not the number.

---

### What was found (verified against `origin/main` `28d02e59`, and prod read-only on 27 Sep 2026)

**Every surface that could carry block `notes` to a coach.** Only the first row of this table leaks.

| Surface | What a coach gets today | Evidence |
|---|---|---|
| `GET /api/schedule/shifts`: **own row** (phone Me view + Today list; `ShiftRow` renders `shift.notes`) | **LEAKS**: `a.notes ?? b.notes`, so the block note appears when the assignment has none | `src/lib/roster-read.js:98` (comment), `:103` (select includes `notes`), `:128`, `:172` (own row keeps `notes`); `mobile/app/(staff)/(tabs)/schedule.jsx:319-321` |
| `GET /api/schedule/shifts`: **colleague's row** (phone Team view, web Today "On with you today") | null (COACHSCOPE.1) | `roster-read.js:172`; pinned `roster-read.test.js:251-293` |
| `GET /api/schedule/blocks`, non-manager (web `ScheduleCalendar` for staff, phone Manage for non-managers) | no `notes` key on the block or on any assignment | `blocks/route.js:119-122`, `:129-174`; pinned `blocks/route.test.js:105-114` |
| `blocksToShiftRows` (`src/lib/roster-summary.js:158`, `notes: a.notes \|\| block.notes`) used by `ScheduleCalendar` | null for a coach: it reads the slim `/blocks` feed, which has no notes. Nothing in `ScheduleCalendar` renders `.notes` | `src/components/ScheduleCalendar.jsx:59` import; `git grep "\.notes" src/components/ScheduleCalendar.jsx` = no render |
| `shared/dashboard-data.js` `fetchDashboardShifts` (phone + web PersonalDashboard, Today) | no notes at all: the select names `briefing` but not `notes` | `shared/dashboard-data.js:99-104`, row shape `:111-133` |
| ICS calendar feed (ICSFEED.1) | no notes and no briefing: "not even selected" | `src/lib/staff-calendar-feed.js:8-10`; `FEED_SHIFT_SELECT` `src/lib/staff-calendar-feed-server.js:23-30` |
| Swap cards (`GET /api/schedule/swaps`) | assignment note only (`swapShiftShape` has no block notes), and a colleague's is nulled | `roster-read.js:58-78` (`notes: a.notes ?? null`, `:66`); embed `swaps/route.js:28-35`; `slimSwapForCoach` `:135-136` |
| Shift offers (REPLACE.1b), swap-cover notices, replace notices, roster notify | no `notes` read | `git grep -n "\bnotes\b"` over `src/lib/swap-cover*.js`, `shift-replace*.js`, `roster-notify.js`, offers readers: none that reach a message |
| Shift reminder pushes (`src/lib/shift-reminders.js:482`) | reads `fetchApiShiftRows` with **no viewer**, never quotes `notes` in a push | no `notes` in `shift-reminders.js` |
| Staff assistant `get_shifts_for_week` (`src/app/api/assistant/chat/route.js:201-235`) | no viewer; emits date/staff/shift/time/status/published only (and the assistant is off everywhere) | same lines |
| Phone Home cache (`mobile/lib/physical-snapshot.js:236-270`) | drops `notes` explicitly | `slimShiftsForCache` |
| Every write/detail route that returns `notes` (`/assignments/[id]` PUT, `/blocks/[id]`, `/blocks/[id]/assignments`, `/blocks/bulk-assign`, POST `/blocks`) | manager-only (`MANAGER_ROLES` at the studio) | `assignments/[id]/route.js:46,81,270`; `blocks/[id]/route.js:66,89,204,244`; `blocks/[id]/assignments/route.js:62,89` |

**The trigger the comment names.** `roster-read.js:98` says the fallback "matches the trigger's coalesce". That trigger was the Roster v2 legacy mirror: `shift_assignments → public.shifts` wrote `notes = coalesce(new.notes, v_block.notes)` (`supabase/migrations/068_shift_assignments_legacy_mirror.sql:64,84`, re-made in `069_…:54,70` and `100_…:78,93`). Its **reverse** mirror (`069_shifts_legacy_reverse_mirror.sql:143,153,170`) copied `shifts.notes` back into `shift_assignments.notes`. So while the legacy mirror lived, a write through the old shifts endpoints could copy a block's note into an assignment's own note. Both triggers and `public.shifts` were dropped in `238_drop_shifts_legacy_mirror.sql`.

Checked live on `iyvtbjjxdggiadzwwvdj` (read-only, counts only, 27 Sep 2026):

- `public.shifts` no longer exists. The only non-internal triggers on `shift_assignments`/`shift_blocks` are `set_shift_assignments_updated_at`, `shift_assignments_overlap_guard` and `set_shift_blocks_updated_at`. No function body mentions both `shift_assignments` and `notes`.
- **`shift_blocks.notes`: 0 of 934 blocks are non-null. `shift_assignments.notes`: 0 of 872 assignments are non-null.** So nobody holds a copied block note, and no coach sees a block note today. There is nothing to clean up and no migration.
- `shift_blocks.briefing`: 0 of 934 set (BLOCKEDIT.1 is new).
- No UI writes either `notes` column. Only the API accepts it (`POST /api/schedule/blocks`, `PUT /api/schedule/assignments/[id]`, `POST /api/schedule/blocks/[id]/assignments`, `POST /api/schedule/blocks/bulk-assign`). `git grep notes` over `src/components/ScheduleCalendar.jsx`, `src/components/schedule/` and `mobile/lib/schedule-api.js` finds no writer.

**So the leak is latent.** Coaches are not reading block notes today, which answers the worry that made B3 a DECISION row. This PR closes the path before a manager or an integration writes a block note that isn't meant for coaches.

**Who counts as a manager here.** `MANAGER_ROLES = ['master', 'owner', 'manager', 'head_coach']` (`src/lib/schemas.js:193`). The `/shifts` route builds `viewer.isManagerAt(loc) = hasRoleAtLocation(user, loc, MANAGER_ROLES)` (`src/app/api/schedule/shifts/route.js:64-67`). The same test decides who gets the full `/blocks` feed (`blocks/route.js:120`) and who may write assignment notes and block fields. `shifts/route.test.js:30-38` already pins "head coach at loc-2 is a manager there, and plain staff at loc-1".

---

### Decisions (each pinned by a test)

**D1. A coach-audience row's `notes` is the assignment's own note, never the block's.** Where the caller is not a manager at the row's studio, `notes = a.notes ?? null`. Their own row still shows their own assignment note (Richard's approved wording: "the assignment's own note and the block's briefing"). A colleague's row stays null (COACHSCOPE.1, unchanged). *Pinned:* "a coach's own row with no note of its own carries null, not the block's notes"; "a coach's own row keeps the assignment's own note"; "no block note reaches any coach row, own or colleague".

**D2. The briefing stays on every row.** It is the coach-facing block text (BLOCKEDIT.1). *Pinned:* the same own-row test asserts `briefing`, plus the existing `roster-read.test.js:338-344`.

**D3. Head coaches follow the scheduler's manager rule.** A head coach AT the row's studio is a manager there (`MANAGER_ROLES`), so they keep the block-notes fallback. That is consistent with `/blocks`, where they already get the full block with its `notes`, and with the assignment and block write routes, where they can write them. A head coach who is plain staff at another studio is a coach there and loses them on that studio's rows. No new role list, no new rule. *Pinned:* "judged per studio" (roster-read), plus the existing route test `shifts/route.test.js:30-38`.

**D4. A manager reading their OWN shift sees what they see today.** Manager views are unchanged by Richard's decision: a manager's own row keeps `a.notes ?? b.notes`. They manage that block and read its `notes` in the calendar dialog anyway, so the phone Me view is just another manager view of it. *Pinned:* "a manager at the studio still gets the block notes as the fallback, own row included".

**D5. Callers with no viewer are unchanged.** The shift-reminder cron (`src/lib/shift-reminders.js:482`) and the assistant (`src/app/api/assistant/chat/route.js:201`) pass no viewer and never emit `notes`. Their rows keep the manager shape, so neither module changes. *Pinned:* "with no viewer the row is unchanged", plus the existing "maps assignments…" test (`roster-read.test.js:160-161`, `rows[1].notes` = `'blk'`).

**D6. The audience is decided before the row is built.** `slimShiftRowForCoach` receives a row that already lacks the block notes. Stripping afterwards is not possible: once `toApiShiftRow` has collapsed `a.notes ?? b.notes`, you can no longer tell whose note it is. `slimShiftRowForCoach`'s own-row rule (keep `notes`) is therefore only correct for a row built with `forCoach: true`, and its docstring says so. *Pinned:* the stringify test (no block-note text anywhere in a coach's payload).

**D7. No data change, no phone change.** 0 block notes and 0 assignment notes exist (above), and the legacy mirror is gone, so there are no copies to clear. The phone keeps rendering `shift.notes`, which now holds only the coach's own note. No OTA.

---

### Files

| File | Responsibility |
|---|---|
| `src/lib/roster-read.js` (modify: comment `:86-98`, `toApiShiftRow` `:110-145`, `slimShiftRowForCoach` docstring `:147-166`, `fetchApiShiftRows` pipeline `:215-224`) | `toApiShiftRow(a, { forCoach })`; audience per row before the build |
| `src/lib/roster-read.test.js` (modify: append after `:345`) | the new `describe('block notes stay manager-only (COACHNOTES.1)')` |
| `src/lib/openapi.js` (modify: `/api/schedule/shifts` description, `:4330`) | say what `notes` is on the caller's own row |
| `docs/CHANGELOG.md` (modify) | one row, after `gh pr create` |

**Setup:** a fresh worktree off `origin/main`, never a shared one (standing rule):

```bash
cd ~/code/un1t-crm && git fetch origin main && git worktree add ../un1t-crm-coachnotes1 -b coachnotes-1 origin/main && cd ../un1t-crm-coachnotes1 && npm ci
```

---

### Task 1: failing tests for the coach audience

**Files:**
- Test: `src/lib/roster-read.test.js` (append at the end of the file, after the `briefing (BLOCKEDIT.1)` describe that ends at line 345)

- [ ] **Step 1: Append the tests**

```js
// COACHNOTES.1 — a coach's view of a shift carries the assignment's OWN note
// and the block's briefing, never the block's manager `notes`. Manager views,
// and callers with no viewer (the reminder cron, the assistant), are unchanged.
// Fictional people only: the repo is public.
describe('block notes stay manager-only (COACHNOTES.1)', () => {
  const BLOCK_NOTE = 'MGR-BLOCK-NOTE: short-staffed, keep an eye on Sam'
  const mk = (id, loc, profileId, assignmentNote) => ({
    id, profile_id: profileId, status: 'scheduled', notes: assignmentNote, partial_reason: null,
    start_time_override: null, end_time_override: null, assigned_by: 'mgr', updated_at: 't',
    shift_blocks: {
      location_id: loc, template_id: 't1', block_date: '2026-06-10', start_time: '09:00:00', end_time: '10:00:00',
      notes: BLOCK_NOTE, briefing: 'Fire drill at 10', roster_id: 'r1', rosters: { status: 'published' },
      shift_templates: { id: 't1', name: 'AM', start_time: '09:00:00', end_time: '10:00:00', role_label: 'Coach' },
    },
    profiles: { id: profileId, full_name: `Name ${profileId}`, email: `${profileId}@x.ie`, avatar_url: null, role: 'staff' },
  })
  const read = (data, opts = {}) =>
    fetchApiShiftRows(makeDb({ data, error: null }), { locationIds: ['loc-coach', 'loc-mgr'], ...opts })
  const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]))
  const coachEverywhere = { id: 'me', isManagerAt: () => false }

  it("a coach's own row with no note of its own carries null, not the block's notes", async () => {
    const { rows } = await read([mk('own', 'loc-coach', 'me', null)], { viewer: coachEverywhere })
    expect(rows).toHaveLength(1)
    expect(rows[0].notes).toBeNull()
    // The coach-facing text still arrives.
    expect(rows[0].briefing).toBe('Fire drill at 10')
  })

  it("a coach's own row keeps the assignment's own note", async () => {
    const { rows } = await read([mk('own', 'loc-coach', 'me', 'Bring the rower keys')], { viewer: coachEverywhere })
    expect(rows[0].notes).toBe('Bring the rower keys')
  })

  it('no block note reaches any coach row, own or colleague', async () => {
    const { rows } = await read([
      mk('own-empty', 'loc-coach', 'me', null),
      mk('own-noted', 'loc-coach', 'me', 'Bring the rower keys'),
      mk('mate', 'loc-coach', 'sam', null),
    ], { viewer: coachEverywhere })
    expect(rows).toHaveLength(3)
    expect(JSON.stringify(rows)).not.toContain('MGR-BLOCK-NOTE')
  })

  it('a manager at the studio still gets the block notes as the fallback, own row included', async () => {
    const managerEverywhere = { id: 'me', isManagerAt: () => true }
    const { rows } = await read([
      mk('mgr-own', 'loc-mgr', 'me', null),
      mk('mgr-mate', 'loc-mgr', 'sam', null),
      mk('mgr-noted', 'loc-mgr', 'sam', 'Own note wins'),
    ], { viewer: managerEverywhere })
    const r = byId(rows)
    expect(r['mgr-own'].notes).toBe(BLOCK_NOTE)
    expect(r['mgr-mate'].notes).toBe(BLOCK_NOTE)
    expect(r['mgr-noted'].notes).toBe('Own note wins')
  })

  it('judged per studio: the same caller loses block notes where they coach and keeps them where they manage', async () => {
    // e.g. a head coach at loc-mgr who is plain staff at loc-coach (the route's
    // isManagerAt is hasRoleAtLocation(user, loc, MANAGER_ROLES)).
    const viewer = { id: 'me', isManagerAt: (loc) => loc === 'loc-mgr' }
    const { rows } = await read([
      mk('at-coach-studio', 'loc-coach', 'me', null),
      mk('at-mgr-studio', 'loc-mgr', 'me', null),
    ], { viewer })
    const r = byId(rows)
    expect(r['at-coach-studio'].notes).toBeNull()
    expect(r['at-mgr-studio'].notes).toBe(BLOCK_NOTE)
    // Briefing on both.
    expect(r['at-coach-studio'].briefing).toBe('Fire drill at 10')
    expect(r['at-mgr-studio'].briefing).toBe('Fire drill at 10')
  })

  it('with no viewer (the reminder cron, the assistant) the row is unchanged', async () => {
    const { rows } = await read([mk('cron', 'loc-coach', 'me', null)])
    expect(rows[0].notes).toBe(BLOCK_NOTE)
  })

  it('the coach rules around notes are otherwise untouched: drafts dropped, email slimmed, publishedOnly honoured', async () => {
    const draft = mk('draft', 'loc-coach', 'me', null)
    draft.shift_blocks = { ...draft.shift_blocks, rosters: { status: 'draft' } }
    const { rows } = await read([mk('own', 'loc-coach', 'me', null), draft], { viewer: coachEverywhere })
    expect(rows.map((x) => x.id)).toEqual(['own'])
    expect(rows[0].profiles).toEqual({ id: 'me', full_name: 'Name me', avatar_url: null, role: 'staff' })
    const pubOnly = await read([mk('mgr-own', 'loc-mgr', 'me', null), draft], {
      viewer: { id: 'me', isManagerAt: () => true }, publishedOnly: true,
    })
    expect(pubOnly.rows.map((x) => x.id)).toEqual(['mgr-own'])
  })
})
```

- [ ] **Step 2: Run them and check the right ones fail**

Run: `npx vitest run src/lib/roster-read.test.js`

Expected: **3 FAIL**, all in the new describe:
- "a coach's own row with no note of its own…": `expected 'MGR-BLOCK-NOTE: short-staffed, keep an eye on Sam' to be null`
- "no block note reaches any coach row…": `expected '[…]' not to contain 'MGR-BLOCK-NOTE'`
- "judged per studio…": `at-coach-studio` notes is the block note, not null

The other four new tests PASS on main. They pin D4/D5 and the untouched coach rules, so the change cannot move them. Every pre-existing test PASSES.

### Task 2: build the coach row without the block's notes

**Files:**
- Modify: `src/lib/roster-read.js:86-98` (comment), `:110-145` (`toApiShiftRow`), `:147-166` (`slimShiftRowForCoach` docstring), `:215-224` (`fetchApiShiftRows` pipeline)

- [ ] **Step 1: Replace the stale header comment line**

In the block comment above `API_SHIFT_SELECT`, replace line 98:

```js
//   - notes = assignment.notes ?? block.notes (matches the trigger's coalesce)
```

with:

```js
//   - notes = assignment.notes ?? block.notes for a MANAGER-audience row (the
//     legacy mig 068/100 mirror's coalesce; that trigger went in mig 238).
//     COACHNOTES.1: a coach-audience row carries the assignment's own note
//     only. Block notes are a manager's working note; the coach-facing block
//     text is `briefing` (BLOCKEDIT.1, mig 629).
```

- [ ] **Step 2: Give `toApiShiftRow` an audience**

Replace the function signature and the `notes` line. The signature (line 110):

```js
function toApiShiftRow(a) {
```

becomes:

```js
/**
 * @param {object} a  embedded shift_assignments row (API_SHIFT_SELECT)
 * @param {{ forCoach?: boolean }} [opts]
 *   forCoach — COACHNOTES.1: the row is for someone who is NOT a manager at
 *   its studio. `notes` is then the assignment's own note only, never the
 *   block's manager note. Decide this BEFORE building the row: once the two
 *   are collapsed nobody can tell them apart (slimShiftRowForCoach can't).
 */
function toApiShiftRow(a, { forCoach = false } = {}) {
```

and line 128:

```js
    notes: a.notes ?? b.notes ?? null,
```

becomes:

```js
    // COACHNOTES.1 — block notes are a manager's working note: manager rows
    // fall back to them, coach rows never do (a coach reads the briefing).
    notes: forCoach ? (a.notes ?? null) : (a.notes ?? b.notes ?? null),
```

- [ ] **Step 3: Decide the audience per row before building it**

In `fetchApiShiftRows`, replace lines 215-224:

```js
  const rows = (data || [])
    .filter((a) => a.shift_blocks && isLiveAssignment(a))
    .map(toApiShiftRow)
    // D1 — coaches see published shifts only; managers pass publishedOnly:false.
    .filter((r) => !publishedOnly || r.published)
    // COACHSCOPE.1 — per-location: a non-manager at this row's studio gets
    // published rows only, slimmed.
    .filter((r) => !viewer || r.published || viewer.isManagerAt(r.location_id))
    .map((r) => (!viewer || viewer.isManagerAt(r.location_id) ? r : slimShiftRowForCoach(r, viewer.id)))
    .sort((x, y) => (x.shift_date < y.shift_date ? -1 : x.shift_date > y.shift_date ? 1 : 0))
```

with:

```js
  const rows = (data || [])
    .filter((a) => a.shift_blocks && isLiveAssignment(a))
    .flatMap((a) => {
      // COACHSCOPE.1 — the audience is judged per row, against the caller's
      // role AT THIS ROW'S STUDIO. No viewer (cron, assistant) = manager shape.
      // COACHNOTES.1 — and it is judged BEFORE the row is built, so a coach
      // row never holds the block's manager notes (toApiShiftRow forCoach).
      const manager = !viewer || viewer.isManagerAt(a.shift_blocks.location_id)
      const r = toApiShiftRow(a, { forCoach: !manager })
      // D1 — coaches see published shifts only; managers pass publishedOnly:false.
      if (publishedOnly && !r.published) return []
      // COACHSCOPE.1 — a non-manager at this row's studio gets published rows only, slimmed.
      if (!manager && !r.published) return []
      return [manager ? r : slimShiftRowForCoach(r, viewer.id)]
    })
    .sort((x, y) => (x.shift_date < y.shift_date ? -1 : x.shift_date > y.shift_date ? 1 : 0))
```

`a.shift_blocks.location_id` is the same value `toApiShiftRow` puts on `r.location_id` (`:115`). The `capped` check below (`:230`) still reads the raw `data.length`, which is unchanged.

- [ ] **Step 4: Say it in `slimShiftRowForCoach`'s docstring**

In the docstring (lines 152-158), replace:

```js
 * are on: id, name, avatar, role label. Their own row keeps its notes and
 * partial_reason (the Me view renders both); a colleague's row loses them,
```

with:

```js
 * are on: id, name, avatar, role label. Their own row keeps its notes and
 * partial_reason (the Me view renders both). Those notes are the ASSIGNMENT's
 * own note only, because the row must be built with toApiShiftRow(a, { forCoach:
 * true }) (COACHNOTES.1): this function cannot tell a block note from an
 * assignment note once they are collapsed. A colleague's row loses them,
```

- [ ] **Step 5: Run the suite**

Run: `npx vitest run src/lib/roster-read.test.js src/app/api/schedule/shifts/route.test.js src/lib/shift-reminders.test.js src/lib/cron-arm-health.test.js`

Expected: all PASS. That includes the 3 tests that failed in Task 1, the pre-existing "maps assignments… block notes fall back" (no viewer, D5) and the COACHSCOPE.1 viewer test (`:251-293`, whose blocks have `notes: null`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/roster-read.js src/lib/roster-read.test.js
git commit -m "$(cat <<'EOF'
COACHNOTES.1 — a coach's shift row never carries the block's manager notes

toApiShiftRow collapsed notes = assignment.notes ?? block.notes for every row,
and slimShiftRowForCoach keeps notes on the caller's own row, so a coach whose
assignment had no note of its own got the block's manager note on the phone's
Me view. The audience is now decided per row (role at that row's studio)
before the row is built: coach rows carry the assignment's own note only,
plus the briefing. Manager rows and no-viewer callers are unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Task 3: the API description

**Files:**
- Modify: `src/lib/openapi.js:4330` (the `/api/schedule/shifts` GET `description` string)

- [ ] **Step 1: Edit the sentence about slimmed rows**

In that description string, replace:

```
and notes / partial_reason are null on colleagues' rows.
```

with:

```
and notes / partial_reason are null on colleagues' rows. On the caller's own row there, notes is that assignment's own note only, never the shift block's manager notes (COACHNOTES.1); the coach-facing block text is briefing, on every row. A manager at the row's studio gets notes = the assignment's note, else the block's.
```

- [ ] **Step 2: Run the OpenAPI tests**

Run: `npx vitest run src/lib/openapi.test.js`

Expected: PASS (the path is still registered, `:66` and `:362`).

- [ ] **Step 3: Commit**

```bash
git add src/lib/openapi.js
git commit -m "$(cat <<'EOF'
COACHNOTES.1 — document what notes carries on a coach's own shift row

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### PR gate

Close the dev server and any other worktree's watchers first (8GB machine). Rebase and re-run the focused suites under both host timezones. Nothing here is date code, but it is the standing rule:

```bash
git fetch origin main && git rebase origin/main
npx vitest run src/lib/roster-read.test.js src/app/api/schedule/shifts/route.test.js src/app/api/schedule/blocks/route.test.js src/lib/shift-reminders.test.js src/lib/openapi.test.js
TZ=America/Los_Angeles npx vitest run src/lib/roster-read.test.js
```

Expected: all green.

- [ ] **The 12-command CI mirror (CLAUDE.md "Build, test & ship"):**

```bash
set -o pipefail
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: every command exits 0 and vitest reports `0 failed`.
- `check:select-columns`: `API_SHIFT_SELECT` is unchanged (it still selects `shift_blocks.notes`, which manager rows need).
- `check:ota-paths`: nothing under `mobile/` or `shared/`, so no publish.
- `check:route-guards` / `check:location-scoping`: no route touched.

- [ ] **The build:**

```bash
npm run build
```

Expected: `✓ Compiled successfully`.

- [ ] **Independent review** (standing rule). Point the reviewer at: D1 (own row keeps the assignment's note; only the block fallback goes), D3 (head coach = manager at their own studio, per `MANAGER_ROLES`, the same as `/blocks`), D4 (a manager's own row unchanged), D5 (no-viewer callers unchanged), D6 (why the audience is decided before the build and not in `slimShiftRowForCoach`), and the `flatMap` rewrite: it must keep the exact filter order and semantics (publishedOnly, then the non-manager published rule, then slim), and the `capped` check still reads the raw page.

- [ ] **Preview check** (GET-only, prod data; local dev has no database). There are **0** block and assignment notes in prod, so no response changes today. The check is that nothing else moved. On the Vercel preview, "Master: View as" a Stillorgan coach, then open DevTools and fetch `/api/schedule/shifts?location_id=<Stillorgan>&start_date=<this Monday>&end_date=<this Sunday>`. Confirm the same rows as production, `notes: null` on every row, `briefing` present, no `email` on any profile. Repeat as Richard (master): same row count as production.

---

### PR

**Title:** `COACHNOTES.1 — a coach's shift row carries their own note and the briefing, never the block's manager notes`

**Body must say, in this order:**
1. **Web only. No migration. No OTA** (nothing under `mobile/` or `shared/`; phones get the change from the server on their next fetch, with the same row keys).
2. **What coaches stop seeing:** on the phone's Schedule tab (Me view and today's list), the text under one of your own shifts no longer falls back to the **shift block's manager note** when your assignment has no note of its own. Coaches still see their own assignment note, if a manager wrote one, and the shift's **briefing**. Colleagues' rows were already blank (COACHSCOPE.1).
3. **Who keeps seeing block notes:** anyone who is master, owner, manager or head coach **at that shift's studio**, on every row there, their own included. That is the same rule as the calendar feed and the edit routes. A head coach who is plain staff at the other studio is a coach there.
4. **Nobody loses anything today:** prod has 0 of 934 blocks with notes and 0 of 872 assignments with notes (counted 27 Sep), and no screen writes either field. This closes the path before one is written. The legacy mirror that once copied block notes into assignment notes (migs 068/069/100) was dropped in mig 238, so no copies need clearing.
5. Every other coach surface was checked and already carries no block notes: the calendar feed (`/api/schedule/blocks`), Today/PersonalDashboard (`shared/dashboard-data.js`), the ICS feed, swap and offer cards, reminder pushes, the assistant, the phone Home cache.
6. Unchanged: manager views, the reminder cron and the assistant (no viewer = manager shape).
7. Preview-check result.
8. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### CHANGELOG

After `gh pr create`, add ONE row directly under the table header in `docs/CHANGELOG.md`, then commit and push. Never edit another row (`merge=union`).

```
| #<PR> | COACHNOTES.1 — a coach's shift row carries their own note and the briefing, never the block's manager notes | 2026-09-2x. Follow-ups B3 (approved by Richard 27 Sep). **Web only; no mig, no OTA.** `toApiShiftRow` collapsed `notes = assignment.notes ?? block.notes` for every row and `slimShiftRowForCoach` keeps `notes` on the caller's own row, so the phone Me view would print a block's manager note under a coach's own shift. `fetchApiShiftRows` now judges the audience per row (`viewer.isManagerAt(studio)`, MANAGER_ROLES incl. head_coach at that studio) BEFORE building it; `toApiShiftRow(a, { forCoach })` gives a coach row the assignment's own note only, plus `briefing`. Manager rows (own included) and no-viewer callers (reminder cron, assistant) unchanged. Latent: prod had 0/934 block notes and 0/872 assignment notes, and the mig 068/069 mirror that could copy block notes into assignment notes went in mig 238. Other coach surfaces audited clean (/blocks, dashboard-data, ICS, swaps, offers, pushes). OpenAPI text updated. |
```

---

### Open questions for the owner (Richard)

1. **Should a coach see their own assignment note at all?** You approved "their own note plus the briefing", and this PR keeps that. But the web calendar feed (`/api/schedule/blocks`) already hides assignment notes from coaches, own included, and the code calls them "a manager's working notes about that person". So a coach sees their own assignment note on the phone and not on the web. Nothing writes these notes from any screen (0 rows), so today it makes no difference. The clean rule would be: the briefing is the only shift text coaches ever see. Drop assignment notes from coaches too? That is a one-line follow-up (`notes: null` for coach rows), with the phone's `shift.notes` line then dead code for coaches.
2. **Do block and assignment notes need a screen, or should they go?** Both columns are empty and API-only. If they are never going to be used, a later clean-up could stop selecting them, and the whole class of leak goes with them.

### Follow-ups found while planning (not in this PR)

- `blocksToShiftRows` (`src/lib/roster-summary.js:158`) also collapses `a.notes || block.notes`. It is safe for coaches only because `/api/schedule/blocks` strips both notes before the calendar calls it, and no component renders the result's `notes`. If a coach path ever feeds it an unslimmed block, the same leak returns. A later hygiene PR could drop `notes` from that row: no payroll or summary code reads it (check with `git grep` first).
- CHANGELOG row 225 still describes `notes = assignment.notes ?? block.notes` as the `/shifts` rule. It is a historical row, so leave it; this PR's row records the change.

---

### Self-review (done while writing)

- **Spec coverage.** The leak at `toApiShiftRow`: Task 2. Own rows vs the Team feed: tests "own row…", "no block note reaches any coach row, own or colleague". `/blocks` for non-managers: audited, already stripped and pinned (`blocks/route.test.js:105-114`), no change. Dashboard fetchers: audited. `fetchDashboardShifts` selects `briefing`, not `notes`, so the premise that it "selects notes on assignments" does not hold on main. ICS: audited, not selected. Reminders, pushes, emails: audited, never quote notes. Swap and offer cards: audited. Phone Schedule/Today/PersonalDashboard: only `ShiftRow` renders `shift.notes`, and it is fixed server-side. Web ScheduleCalendar for staff: slim feed, no render. The trigger: found (mig 068/069/100, dropped in 238), and live counts show 0 copies. Head coach: D3. Manager's own shift: D4.
- **Placeholders:** none. `<PR>` and the `x` in the CHANGELOG date are filled in at PR time.
- **Names:** `toApiShiftRow(a, { forCoach })` is used identically in Task 2 Steps 2-4. `fetchApiShiftRows`'s signature is unchanged. The test helpers (`makeDb`, `fetchApiShiftRows`) already exist in `roster-read.test.js` (`:1-37`), so the new describe adds no import.
