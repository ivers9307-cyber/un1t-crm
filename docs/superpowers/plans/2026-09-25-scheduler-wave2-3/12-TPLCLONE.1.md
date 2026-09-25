## PR TPLCLONE.1 — copy shift templates from another studio in the same organisation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manager (or owner, head coach, org admin, master) who manages two studios of the SAME organisation can copy shift templates from one into the other from the template manager: pick the studio, see what will be created and what will be skipped, untick what they don't want, confirm, and get a notice with the counts. Copying between organisations is impossible, even for a master.

**Why:** Hatch Street has 0 shift templates, so it has nothing to roster from. Stillorgan has 19 active (plus 3 inactive; 11 of the active ones run on set weekdays). Measured live on 25 Sep. The index says 18: it is 19. The only way to give Hatch the same templates today is to type all 19 in again by hand, one form at a time.

**Architecture:** One new route, `POST /api/schedule/templates/clone`, runs the mutation skeleton from `CLAUDE.md` (user → role → `validateBody` → `assertLocationAccess` at BOTH studios → role AT both studios → organisation check → work). The decisions are pure and live in a new client-safe module, `src/lib/shift-template-clone.js`: what to copy (`planTemplateClone`), whether two studios share an organisation (`organizationCheck`), which studios the template manager may offer as a source (`cloneSourceStudios`), and the notice text (`cloneResultNotice`). **Every database read and write stays in the route file**: `check:location-scoping` only reads route and page files, so a query moved into a `src/lib` helper would be invisible to it (the "Known gap" in `scripts/check-location-scoping.mjs:51-61`). The copy is a single multi-row `upsert … ON CONFLICT (location_id, name) DO NOTHING`, so the insert is all or nothing and a template the target gains while the copy runs is skipped rather than failing the batch. A `dry_run` flag answers the same lists without writing; the UI's preview IS a dry run, so the preview and the copy can never disagree about what "already here" means.

**Tech Stack:** Next.js 16 App Router route, Supabase service-role client, Zod, React client component (`@/components/ui/Modal`), Vitest (node for the lib and route, jsdom for components).

**Ships:** web deploy only. **No migration**: the `UNIQUE (location_id, name)` constraint the upsert relies on already exists (mig 010:27, verified live as `shift_templates_location_id_name_key` on 25 Sep). Nothing under `mobile/` or `shared/` changes, so **no OTA**.

**Worktree:** branch `tplclone-1` in its own fresh worktree off `origin/main`. Tests: `npx vitest run <file>`. Do NOT run the whole suite or `npm run build` until the PR gate (8GB machine).

**Rules that bite in this PR (read `CLAUDE.md` Invariants first):**
- Service-role routes get no RLS. The route itself is the only thing between a caller and another tenant's templates. Both template reads carry `.eq('location_id', …)` IN THE CHAIN, and the insert payload carries `location_id` inline, so `check:location-scoping` sees chain-level evidence for every `shift_templates` chain (Task 6 pins that, not just the file-level pass).
- **Membership is not the organisation boundary.** A master's `user.locations` is every active location on the estate (`src/lib/auth.js:378-379`, `:416-418`), an org admin's is every location of every org they administer (`expandOrgAdminAccess`, `src/lib/auth.js:72-89`), and nothing keeps a person inside one organisation (ORGSCOPE.1, `src/lib/sibling-locations.js:4-9`). So passing `assertLocationAccess` at both studios proves nothing about the organisation. The route reads `locations.organization_id` for both and refuses unless both are present AND equal (the `undefined === undefined` rule from `src/app/api/shelly/discover/route.js:166-170`).
- **Role AT each studio, never `user.role`.** `user.role` is the role at the ACTIVE studio. Use `hasRoleAtLocation(user, id, MANAGER_ROLES)` for both ids (SCHEDROLES.1, `src/lib/role-at-location.js`). `MANAGER_ROLES` = master, owner, manager, head_coach (`src/lib/schemas.js:183`), the same set `POST /api/schedule/templates` uses (`src/app/api/schedule/templates/route.js:58-72`). There is no `WEB_PERMISSIONS` key for templates; they are role-gated, so there is no new permission key and `check:mobile-parity` is untouched.
- **Status codes follow the body-param convention.** `assertLocationAccess` answers 403 for a studio in the body (`src/lib/auth.js:743-758`); 404-not-403 is for DETAIL routes whose location comes from a fetched row. The cross-organisation refusal is 403 too: it is only reachable by a caller who is already a member of both studios, so it discloses nothing they cannot already see. A location row that vanished answers 404.
- A column named in a `.select()` is checked by `npm run check:select-columns`. Verified against the replayed schema on 25 Sep: `shift_templates(id, location_id, name, start_time, end_time, color, role_label, active, display_order, created_at, updated_at, days_of_week, max_coaches, min_coaches)` (migs 010, 067, 177); `locations(id, organization_id)` (mig 079). The source read is `select('*')` on purpose (Task 1 explains: it is what lets SHIFTTYPE.1 extend the copy in one line); every other select names its columns.
- A supabase builder resolves instead of throwing. Every read and the write destructure `error` and act on it (`check:guardrails` `no-unchecked-supabase-write`).
- **Removing a silent failure must never create a louder one.** Filling the calendar for a copied template (`generateBlocksForTemplate`) is a follow-on, not the copy: if it fails, the templates stay copied, the response is still 201 with a `warning`, and the nightly `extend-roster-horizon` cron (`src/lib/roster-horizon.js`) fills the blocks that night. Same posture as `POST /api/schedule/templates` (`route.js:94-107`).
- PostgREST caps a select at 1,000 rows. Neither template read pages: a studio has tens of templates (22 is the most on the estate), and the nightly horizon cron already reads every template in the estate unpaged (`src/lib/roster-horizon.js:34-37`). Said in a comment in the route.
- The repo is PUBLIC. Fixtures use `Studio A`, `Studio B`, `Early`, `Late`. Never a real name, email or phone.
- The Hatch Street id in the commissioning brief was wrong in its last two segments. The real ids (live, 25 Sep): Stillorgan `a0000000-0000-0000-0000-000000000001`, Hatch Street `28c78d6b-f7b3-4edf-8c7c-840bd047b3f4`, both in organisation `f117b7b8-5f56-4f80-8299-2c698242e4d2` (with "Test Studio" and "Pride Training Club (host events)"). No test or code uses a real id.

**Decisions this plan makes (flagged in Review notes):**
- Copied columns: `name, start_time, end_time, color, role_label, days_of_week, min_coaches, max_coaches`, verbatim. Set by the copy: `active = true`, `display_order` = after the target's highest existing order, keeping the source's order. Never copied: `id`, `location_id`, `created_at`, `updated_at`.
- Only active templates are copied. With no `template_ids` an inactive template is left out silently; named explicitly in `template_ids`, it comes back skipped with reason `inactive`.
- A name is "already here" ignoring case and outer spaces, and counting the target's INACTIVE templates too (the DB unique key does not care whether the row is active, and a second "Morning" beside a deactivated one would be confusing either way).
- A copied template with weekdays gets its next 8 weeks of blocks at once, as creating one by hand does. The preview says so, and says the studio's roster alerts will count them: `fetchRosterRunways` skips a studio with no active weekday template (`src/lib/roster-runway-data.js:23-27`, "Hatch Street today"), so the first weekday template copied into Hatch Street switches its runway chip and daily push on.

---

### File map

| File | Change |
|---|---|
| `src/lib/shift-template-clone.js` | Create: `TEMPLATE_CLONE_COLUMNS`, `TEMPLATE_CLONE_MANAGED_COLUMNS`, `CLONE_SKIP_REASONS`, `CLONE_SKIP_LABELS`, `templateNameKey`, `planTemplateClone`, `organizationCheck` (Task 1); `cloneSourceStudios`, `cloneResultNotice` (Task 3) |
| `src/lib/shift-template-clone.test.js` | Create (Tasks 1, 3) |
| `tests/shift-template-clone.guards.test.js` | Create: every `shift_templates` column classified (Task 2); the route's chains pass `check:location-scoping` (Task 6) |
| `src/app/api/schedule/templates/clone/route.js` | Create: gates (Task 4), the copy (Task 5) |
| `src/app/api/schedule/templates/clone/route.test.js` | Create (Task 4), extend (Task 5) |
| `src/lib/openapi.js` | Modify: new registration after the copy-month block (ends line 4439), before the `// ROSTER-FIX.6c — the FTE weekly-hours panel's arithmetic` comment (line 4441) |
| `src/lib/openapi.test.js` | Modify: one new `it` before `it('declares webhook + bridge auth schemes'` (line 313) |
| `src/components/schedule/CopyTemplatesModal.jsx` | Create (Task 8) |
| `src/components/schedule/CopyTemplatesModal.test.jsx` | Create (Task 8) |
| `src/components/ShiftTemplateManager.jsx` | Modify: imports lines 3-4 and 13; state after line 87; new `handleCopied` after `handleDelete` (ends line 216); header button lines 269-275; empty state lines 314-321; modal render after line 455 |
| `src/components/ShiftTemplateManager.clone.test.jsx` | Create (Task 9) |
| `docs/CHANGELOG.md` | Modify: one new row after `gh pr create` |

---

### Task 1: the pure copy planner and the organisation check

**Files:** Create `src/lib/shift-template-clone.js`, `src/lib/shift-template-clone.test.js`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/shift-template-clone.test.js`:

```js
// TPLCLONE.1 — the pure half of copying shift templates between two studios of
// one organisation. The route (src/app/api/schedule/templates/clone/route.js)
// does the reads and the write; these decide what gets copied.

import { describe, it, expect } from 'vitest'
import {
  TEMPLATE_CLONE_COLUMNS,
  CLONE_SKIP_REASONS,
  templateNameKey,
  planTemplateClone,
  organizationCheck,
} from './shift-template-clone'

const src = (over = {}) => ({
  id: 'src-1', location_id: 'studio-a', name: 'Early',
  start_time: '06:00:00', end_time: '09:00:00', color: '#10B981', role_label: 'Floor',
  active: true, display_order: 0, days_of_week: ['mon', 'wed'], min_coaches: 2, max_coaches: 4,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  ...over,
})

describe('templateNameKey', () => {
  it('ignores case and outer spaces, and never throws on a missing name', () => {
    expect(templateNameKey('  Early ')).toBe('early')
    expect(templateNameKey(null)).toBe('')
    expect(templateNameKey(undefined)).toBe('')
  })
})

describe('planTemplateClone', () => {
  it('copies the allow-listed columns verbatim, and no id, studio or timestamp', () => {
    const { toCreate, skipped } = planTemplateClone({ sourceTemplates: [src()], targetTemplates: [] })
    expect(skipped).toEqual([])
    expect(toCreate).toEqual([{
      source_id: 'src-1',
      row: {
        name: 'Early', start_time: '06:00:00', end_time: '09:00:00', color: '#10B981',
        role_label: 'Floor', days_of_week: ['mon', 'wed'], min_coaches: 2, max_coaches: 4,
        active: true, display_order: 0,
      },
    }])
  })

  it('copies a null role label as null (an explicit "no default role")', () => {
    const { toCreate } = planTemplateClone({ sourceTemplates: [src({ role_label: null })], targetTemplates: [] })
    expect(toCreate[0].row.role_label).toBeNull()
  })

  it('every copied column is on the allow-list, plus exactly active and display_order', () => {
    const { toCreate } = planTemplateClone({ sourceTemplates: [src()], targetTemplates: [] })
    expect(Object.keys(toCreate[0].row).sort()).toEqual([...TEMPLATE_CLONE_COLUMNS, 'active', 'display_order'].sort())
  })

  it('places the copies after the target\'s existing templates, keeping the source order', () => {
    const { toCreate } = planTemplateClone({
      sourceTemplates: [src({ id: 's1', name: 'Early' }), src({ id: 's2', name: 'Late' })],
      targetTemplates: [{ name: 'Open gym', display_order: 0 }, { name: 'Closing', display_order: 3 }],
    })
    expect(toCreate.map((p) => [p.row.name, p.row.display_order])).toEqual([['Early', 4], ['Late', 5]])
  })

  it('an empty target, or one with no readable order, starts at 0', () => {
    expect(planTemplateClone({ sourceTemplates: [src()], targetTemplates: [] }).toCreate[0].row.display_order).toBe(0)
    expect(planTemplateClone({ sourceTemplates: [src()], targetTemplates: [{ name: 'X', display_order: null }] }).toCreate[0].row.display_order).toBe(0)
    expect(planTemplateClone({ sourceTemplates: [src()], targetTemplates: null }).toCreate[0].row.display_order).toBe(0)
  })

  it('skips a name the target already has, ignoring case and outer spaces', () => {
    const { toCreate, skipped } = planTemplateClone({
      sourceTemplates: [src({ id: 's1', name: 'Early' }), src({ id: 's2', name: 'Late' })],
      targetTemplates: [{ name: ' early', display_order: 0 }],
    })
    expect(toCreate.map((p) => p.row.name)).toEqual(['Late'])
    expect(skipped).toEqual([{ source_id: 's1', name: 'Early', reason: CLONE_SKIP_REASONS.nameExists }])
  })

  it('counts the target\'s INACTIVE templates as taken names too', () => {
    const { toCreate, skipped } = planTemplateClone({
      sourceTemplates: [src()],
      targetTemplates: [{ name: 'Early', display_order: 0, active: false }],
    })
    expect(toCreate).toEqual([])
    expect(skipped[0].reason).toBe('name_exists')
  })

  it('a second source template with the same name (another case) is skipped, the first is copied', () => {
    const { toCreate, skipped } = planTemplateClone({
      sourceTemplates: [src({ id: 's1', name: 'Early' }), src({ id: 's2', name: 'EARLY' })],
      targetTemplates: [],
    })
    expect(toCreate.map((p) => p.source_id)).toEqual(['s1'])
    expect(skipped).toEqual([{ source_id: 's2', name: 'EARLY', reason: CLONE_SKIP_REASONS.duplicateInSource }])
  })

  it('default: inactive source templates are left out, and not reported', () => {
    const { toCreate, skipped } = planTemplateClone({
      sourceTemplates: [src({ id: 's1', name: 'Early' }), src({ id: 's2', name: 'Old', active: false }), src({ id: 's3', name: 'Null', active: null })],
      targetTemplates: [],
    })
    expect(toCreate.map((p) => p.source_id)).toEqual(['s1'])
    expect(skipped).toEqual([])
  })

  it('explicit ids: copies only those, and reports an inactive one and an id the source does not have', () => {
    const { toCreate, skipped } = planTemplateClone({
      sourceTemplates: [src({ id: 's1', name: 'Early' }), src({ id: 's2', name: 'Late' }), src({ id: 's3', name: 'Old', active: false })],
      targetTemplates: [],
      templateIds: ['s2', 's3', 'elsewhere'],
    })
    expect(toCreate.map((p) => p.source_id)).toEqual(['s2'])
    expect(skipped).toEqual([
      { source_id: 's3', name: 'Old', reason: 'inactive' },
      // No name: an id that is not a template of the source studio must not be
      // answered with the name of whatever row it really is.
      { source_id: 'elsewhere', name: null, reason: 'not_found' },
    ])
  })

  it('never changes its inputs', () => {
    const source = [Object.freeze(src())]
    const target = [Object.freeze({ name: 'Late', display_order: 2 })]
    Object.freeze(source); Object.freeze(target)
    expect(() => planTemplateClone({ sourceTemplates: source, targetTemplates: target })).not.toThrow()
  })
})

describe('organizationCheck', () => {
  const A = { id: 'studio-a', organization_id: 'org-1' }
  const B = { id: 'studio-b', organization_id: 'org-1' }
  const X = { id: 'studio-x', organization_id: 'org-2' }

  it('same organisation', () => {
    expect(organizationCheck([A, B], 'studio-a', 'studio-b')).toBe('same_org')
  })

  it('different organisations', () => {
    expect(organizationCheck([X, B], 'studio-x', 'studio-b')).toBe('cross_org')
  })

  it('an organisation that cannot be read is never "the same" (undefined === undefined)', () => {
    expect(organizationCheck([{ id: 'studio-a' }, { id: 'studio-b' }], 'studio-a', 'studio-b')).toBe('cross_org')
    expect(organizationCheck([A, { id: 'studio-b', organization_id: null }], 'studio-a', 'studio-b')).toBe('cross_org')
  })

  it('a studio missing from the rows is not_found', () => {
    expect(organizationCheck([A], 'studio-a', 'studio-b')).toBe('not_found')
    expect(organizationCheck(null, 'studio-a', 'studio-b')).toBe('not_found')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/shift-template-clone.test.js`
Expected: FAIL, `Failed to resolve import "./shift-template-clone"`.

- [ ] **Step 3: Minimal implementation**

Create `src/lib/shift-template-clone.js`:

```js
// TPLCLONE.1 — copy shift templates from one studio to another in the SAME
// organisation.
//
// Pure: no network, no database, no next/* import. The route
// (src/app/api/schedule/templates/clone/route.js) does every read and the
// write; the template manager (a client component) imports the UI helpers
// below. Keep the database OUT of this file: check:location-scoping reads route
// and page files only, so a query moved in here would be invisible to it.

/**
 * The columns a copy carries across, verbatim.
 *
 * Everything else on shift_templates is identity (id, location_id, created_at,
 * updated_at) or set by the copy itself (active, display_order): that is
 * TEMPLATE_CLONE_MANAGED_COLUMNS. The route reads the source with select('*')
 * and copies through this list, so this list is the ONE place that decides
 * what a copy carries.
 *
 * SHIFTTYPE.1 (Wave 2 PR 13) adds `kind`: add it here, one line, and the copy
 * carries it. tests/shift-template-clone.guards.test.js fails until every
 * column of shift_templates in supabase/migrations is in exactly one of these
 * two lists, so a new column can never be dropped by a copy in silence.
 */
export const TEMPLATE_CLONE_COLUMNS = Object.freeze([
  'name',
  'start_time',
  'end_time',
  'color',
  'role_label',
  'days_of_week',
  'min_coaches',
  'max_coaches',
])

/** Never copied: identity, or set by the copy (active = true, display_order = after the target's). */
export const TEMPLATE_CLONE_MANAGED_COLUMNS = Object.freeze([
  'id',
  'location_id',
  'created_at',
  'updated_at',
  'active',
  'display_order',
])

export const CLONE_SKIP_REASONS = Object.freeze({
  nameExists: 'name_exists',
  duplicateInSource: 'duplicate_in_source',
  inactive: 'inactive',
  notFound: 'not_found',
})

/** Plain words for each reason, for the preview and the notice. */
export const CLONE_SKIP_LABELS = Object.freeze({
  name_exists: 'a template with this name is already here',
  duplicate_in_source: 'another template being copied has the same name',
  inactive: 'deactivated at the other studio',
  not_found: 'no longer at the other studio',
})

/** The comparison key for "is this name already taken": case and outer spaces ignored. */
export function templateNameKey(name) {
  return String(name ?? '').trim().toLowerCase()
}

/**
 * Decide what a copy creates and what it skips.
 *
 * @param {object} args
 * @param {object[]} args.sourceTemplates  shift_templates rows at the source studio, in display order
 * @param {object[]} args.targetTemplates  { name, display_order } of EVERY template at the target, active or not
 * @param {string[]|null} [args.templateIds]  copy only these source ids; null = every active template
 * @returns {{ toCreate: Array<{ source_id: string, row: object }>, skipped: Array<{ source_id: string, name: string|null, reason: string }> }}
 *   `row` carries no location_id: the route adds the target's, in the insert
 *   payload itself, where check:location-scoping can see it.
 */
export function planTemplateClone({ sourceTemplates, targetTemplates, templateIds = null }) {
  const target = targetTemplates || []
  const taken = new Set(target.map((t) => templateNameKey(t?.name)))
  const orders = target.map((t) => t?.display_order).filter(Number.isInteger)
  let nextOrder = orders.length ? Math.max(...orders) + 1 : 0

  const wanted = Array.isArray(templateIds) ? new Set(templateIds) : null
  const found = new Set()
  const planned = new Set()
  const toCreate = []
  const skipped = []

  for (const t of sourceTemplates || []) {
    if (!t?.id) continue
    if (wanted && !wanted.has(t.id)) continue
    found.add(t.id)

    // The template manager lists `t.active` truthy as active, so null is
    // inactive here too. Asked for by id, say why it was not copied; not asked
    // for, it was never part of "all active templates".
    if (!t.active) {
      if (wanted) skipped.push({ source_id: t.id, name: t.name, reason: CLONE_SKIP_REASONS.inactive })
      continue
    }

    const key = templateNameKey(t.name)
    if (taken.has(key)) {
      skipped.push({ source_id: t.id, name: t.name, reason: CLONE_SKIP_REASONS.nameExists })
      continue
    }
    if (planned.has(key)) {
      skipped.push({ source_id: t.id, name: t.name, reason: CLONE_SKIP_REASONS.duplicateInSource })
      continue
    }
    planned.add(key)

    const row = {}
    for (const col of TEMPLATE_CLONE_COLUMNS) {
      if (t[col] !== undefined) row[col] = t[col]
    }
    row.active = true
    row.display_order = nextOrder++
    toCreate.push({ source_id: t.id, row })
  }

  if (wanted) {
    for (const id of wanted) {
      if (!found.has(id)) skipped.push({ source_id: id, name: null, reason: CLONE_SKIP_REASONS.notFound })
    }
  }
  return { toCreate, skipped }
}

/**
 * Do these two studios belong to one organisation?
 *
 * Both organisation ids must be present AND equal: `undefined === undefined`
 * is not "the same organisation" (same rule as src/app/api/shelly/discover).
 *
 * @param {Array<{ id: string, organization_id?: string|null }>|null} locationRows
 * @returns {'same_org' | 'cross_org' | 'not_found'}
 */
export function organizationCheck(locationRows, fromLocationId, toLocationId) {
  const byId = new Map((locationRows || []).filter((l) => l?.id).map((l) => [l.id, l]))
  const from = byId.get(fromLocationId)
  const to = byId.get(toLocationId)
  if (!from || !to) return 'not_found'
  if (!from.organization_id || !to.organization_id) return 'cross_org'
  return from.organization_id === to.organization_id ? 'same_org' : 'cross_org'
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/shift-template-clone.test.js`
Expected: all tests in the file pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shift-template-clone.js src/lib/shift-template-clone.test.js
git commit -m "TPLCLONE.1 — pure plan for copying shift templates between studios

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: every `shift_templates` column is classified for the copy

**Files:** Create `tests/shift-template-clone.guards.test.js`.

This is the guard that makes SHIFTTYPE.1's "one line" true: when PR 13 adds `kind` to `shift_templates`, this test fails until `kind` is put on `TEMPLATE_CLONE_COLUMNS` (copied) or `TEMPLATE_CLONE_MANAGED_COLUMNS` (set by the copy). It reads the same schema replay `check:select-columns` gates on (`collectSchema`, `scripts/check-select-columns.mjs:410-419`), so it cannot drift from the migrations.

- [ ] **Step 1: Write the test**

Create `tests/shift-template-clone.guards.test.js`:

```js
// TPLCLONE.1 — structural guards for the shift-template copy.
//
// 1. Every column of shift_templates (replayed from supabase/migrations, the
//    same replay check:select-columns gates on) is either COPIED or MANAGED by
//    the copy. A new column fails here until someone decides which: that is
//    how SHIFTTYPE.1's `kind` becomes a one-line change and never a column a
//    copy drops in silence.

import { describe, it, expect } from 'vitest'
import { collectSchema } from '../scripts/check-select-columns.mjs'
import { TEMPLATE_CLONE_COLUMNS, TEMPLATE_CLONE_MANAGED_COLUMNS } from '../src/lib/shift-template-clone.js'

describe('TPLCLONE.1 — every shift_templates column is classified for the copy', () => {
  const { schema } = collectSchema('supabase/migrations')
  const columns = [...(schema.get('shift_templates') || [])].sort()

  it('the replay found the table', () => {
    expect(columns).toContain('name')
    expect(columns).toContain('location_id')
  })

  it('each column is copied or managed, never both, never neither', () => {
    const copied = new Set(TEMPLATE_CLONE_COLUMNS)
    const managed = new Set(TEMPLATE_CLONE_MANAGED_COLUMNS)
    expect(columns.filter((c) => copied.has(c) && managed.has(c))).toEqual([])
    // A new column lands here until it goes on TEMPLATE_CLONE_COLUMNS (the copy
    // carries it) or TEMPLATE_CLONE_MANAGED_COLUMNS (the copy sets it itself).
    expect(columns.filter((c) => !copied.has(c) && !managed.has(c))).toEqual([])
  })

  it('names no column the table does not have', () => {
    const real = new Set(columns)
    expect([...TEMPLATE_CLONE_COLUMNS, ...TEMPLATE_CLONE_MANAGED_COLUMNS].filter((c) => !real.has(c))).toEqual([])
  })
})
```

- [ ] **Step 2: Run it, expect PASS (and prove it can fail)**

Run: `npx vitest run tests/shift-template-clone.guards.test.js`
Expected: 3 pass.

Then prove the guard bites: temporarily delete `'min_coaches',` from `TEMPLATE_CLONE_COLUMNS`, re-run, and expect `each column is copied or managed` to fail with `expected [ 'min_coaches' ] to deeply equal []`. Put the line back and re-run: green.

- [ ] **Step 3: Commit**

```bash
git add tests/shift-template-clone.guards.test.js
git commit -m "TPLCLONE.1 — every shift_templates column must be classified for the copy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: which studios to offer, and the notice

**Files:** Modify `src/lib/shift-template-clone.js`, `src/lib/shift-template-clone.test.js`.

The template manager receives the server `user` object (`src/app/settings/shifts/page.js:16`). Its `locations` rows carry `organization_id` on every path: `profile_locations.select('*, locations(*)')` for staff (`src/lib/auth.js:371-374`), `locations.select('*')` for masters (`:378-379`) and org admins (`:438-443`). So the client can compute the offer with the same `hasRoleAtLocation` the route uses. The server still decides.

- [ ] **Step 1: Write the failing tests**

In `src/lib/shift-template-clone.test.js`, replace the import block with:

```js
import {
  TEMPLATE_CLONE_COLUMNS,
  CLONE_SKIP_REASONS,
  templateNameKey,
  planTemplateClone,
  organizationCheck,
  cloneSourceStudios,
  cloneResultNotice,
} from './shift-template-clone'
```

Append at the end of the file:

```js
describe('cloneSourceStudios', () => {
  const A = { id: 'studio-a', name: 'Studio A', organization_id: 'org-1' }
  const B = { id: 'studio-b', name: 'Studio B', organization_id: 'org-1' }
  const C = { id: 'studio-c', name: 'Studio C', organization_id: 'org-1' }
  const X = { id: 'studio-x', name: 'Studio X', organization_id: 'org-2' }
  const member = (locations, rolesByLocation) => ({ id: 'u1', profileRole: 'staff', locations, rolesByLocation })

  it('offers a sibling studio the caller manages', () => {
    expect(cloneSourceStudios(member([A, B], { 'studio-a': 'manager', 'studio-b': 'head_coach' }), 'studio-b'))
      .toEqual([{ id: 'studio-a', name: 'Studio A' }])
  })

  it('never offers a studio in another organisation, even to a master', () => {
    const master = { id: 'm', profileRole: 'master', locations: [C, X, A, B], rolesByLocation: {} }
    expect(cloneSourceStudios(master, 'studio-b')).toEqual([
      { id: 'studio-a', name: 'Studio A' },
      { id: 'studio-c', name: 'Studio C' },
    ])
  })

  it('never offers a sibling where the caller is only staff', () => {
    expect(cloneSourceStudios(member([A, B], { 'studio-a': 'staff', 'studio-b': 'manager' }), 'studio-b')).toEqual([])
  })

  it('offers nothing when the caller does not manage the studio on screen', () => {
    expect(cloneSourceStudios(member([A, B], { 'studio-a': 'manager', 'studio-b': 'staff' }), 'studio-b')).toEqual([])
  })

  it('offers nothing when an organisation cannot be read, on either side', () => {
    const noOrgTarget = { ...B, organization_id: null }
    expect(cloneSourceStudios(member([A, noOrgTarget], { 'studio-a': 'manager', 'studio-b': 'manager' }), 'studio-b')).toEqual([])
    const noOrgSource = { ...A, organization_id: undefined }
    expect(cloneSourceStudios(member([noOrgSource, B], { 'studio-a': 'manager', 'studio-b': 'manager' }), 'studio-b')).toEqual([])
  })

  it('a user with no locations (the old test fixtures) is offered nothing', () => {
    expect(cloneSourceStudios({ id: 'u1', role: 'manager', activeLocation: { id: 'loc1' } }, 'loc1')).toEqual([])
    expect(cloneSourceStudios(null, 'loc1')).toEqual([])
  })
})

describe('cloneResultNotice', () => {
  const made = (name) => ({ id: `new-${name}`, source_id: `src-${name}`, name })

  it('counts what was copied and the shifts it put on the calendar', () => {
    expect(cloneResultNotice({ created: [made('Early'), made('Late')], skipped: [], generated_blocks: 16 }, 'Studio A'))
      .toBe('Copied 2 templates from Studio A. 16 empty shifts added over the next 8 weeks.')
  })

  it('names each skip reason once', () => {
    expect(cloneResultNotice({
      created: [made('Early')],
      skipped: [
        { source_id: 's2', name: 'Late', reason: 'name_exists' },
        { source_id: 's3', name: 'Mid', reason: 'name_exists' },
        { source_id: 's4', name: 'Old', reason: 'inactive' },
      ],
      generated_blocks: 0,
    }, 'Studio A')).toBe('Copied 1 template from Studio A. 3 skipped: a template with this name is already here; deactivated at the other studio.')
  })

  it('says so when nothing was copied', () => {
    expect(cloneResultNotice({ created: [], skipped: [], generated_blocks: 0 }, 'Studio A')).toBe('Nothing was copied from Studio A.')
    expect(cloneResultNotice(undefined)).toBe('Nothing was copied from the other studio.')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/shift-template-clone.test.js`
Expected: the two new describes fail with `cloneSourceStudios is not a function` / `cloneResultNotice is not a function`; Task 1's tests still pass.

- [ ] **Step 3: Minimal implementation**

In `src/lib/shift-template-clone.js`, add directly under the header comment (before `TEMPLATE_CLONE_COLUMNS`):

```js
import { hasRoleAtLocation } from './role-at-location'
import { MANAGER_ROLES } from './schemas'
```

Both are client-safe: `role-at-location` exists precisely so a client component can ask the route's question (ROSTERROLE.1), and `ScheduleCalendar.jsx` already imports `@/lib/schemas` in the browser.

Append at the end of the file:

```js
/**
 * The studios the template manager may offer as a source for a copy INTO
 * `targetLocationId`: same organisation (both ids present and equal), and the
 * caller holds a manager role AT BOTH (hasRoleAtLocation: master passes, the
 * active studio's `user.role` is never read). This only decides what the
 * screen offers; the route re-checks every part of it.
 *
 * @returns {Array<{ id: string, name: string }>} sorted by name
 */
export function cloneSourceStudios(user, targetLocationId) {
  const locations = user?.locations || []
  const target = locations.find((l) => l?.id === targetLocationId)
  if (!target?.organization_id) return []
  if (!hasRoleAtLocation(user, targetLocationId, MANAGER_ROLES)) return []
  return locations
    .filter((l) => l?.id
      && l.id !== targetLocationId
      && l.organization_id
      && l.organization_id === target.organization_id
      && hasRoleAtLocation(user, l.id, MANAGER_ROLES))
    .map((l) => ({ id: l.id, name: l.name || 'Another studio' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The one-line outcome the template manager shows after a copy. */
export function cloneResultNotice(result, fromName = 'the other studio') {
  const created = result?.created || []
  const skipped = result?.skipped || []
  const blocks = result?.generated_blocks || 0
  const n = created.length
  const parts = [n === 0
    ? `Nothing was copied from ${fromName}.`
    : `Copied ${n} template${n === 1 ? '' : 's'} from ${fromName}.`]
  if (skipped.length > 0) {
    const reasons = [...new Set(skipped.map((s) => CLONE_SKIP_LABELS[s.reason] || s.reason))]
    parts.push(`${skipped.length} skipped: ${reasons.join('; ')}.`)
  }
  if (blocks > 0) parts.push(`${blocks} empty shift${blocks === 1 ? '' : 's'} added over the next 8 weeks.`)
  return parts.join(' ')
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/shift-template-clone.test.js tests/shift-template-clone.guards.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shift-template-clone.js src/lib/shift-template-clone.test.js
git commit -m "TPLCLONE.1 — which studios to offer as a copy source, and the outcome notice

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: the route's gates

**Files:** Create `src/app/api/schedule/templates/clone/route.js`, `src/app/api/schedule/templates/clone/route.test.js`.

A static `clone` segment wins over the sibling `[id]` segment in the App Router, and `templates/[id]/route.js` exports only `PUT` and `DELETE`, so nothing there answers a POST to `/templates/clone`.

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/schedule/templates/clone/route.test.js`:

```js
// TPLCLONE.1 — POST /api/schedule/templates/clone.
//
// The fake database HONOURS the location and id filters, so a dropped
// .eq('location_id', …) is a wrong answer here, not a silently green test
// (same posture as ORGSCOPE.1's fakes). The auth helpers are the REAL ones:
// membership, role-at-studio and the master bypass are all under test.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: real.assertLocationAccess,
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/roster', async (importOriginal) => ({
  ...(await importOriginal()),
  generateBlocksForTemplate: vi.fn(),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { generateBlocksForTemplate } = await import('@/lib/roster')
const { POST } = await import('./route.js')

const ORG_1 = 'e0000000-0000-4000-8000-000000000001'
const ORG_2 = 'e0000000-0000-4000-8000-000000000002'
const STUDIO_A = 'a0000000-0000-4000-8000-000000000001' // source, org 1
const STUDIO_B = 'b0000000-0000-4000-8000-000000000002' // target, org 1
const STUDIO_X = 'f0000000-0000-4000-8000-000000000003' // another organisation
const T1 = 'c0000000-0000-4000-8000-000000000001'
const T2 = 'c0000000-0000-4000-8000-000000000002'
const T3 = 'c0000000-0000-4000-8000-000000000003'
const T9 = 'c0000000-0000-4000-8000-000000000009'
const T_FOREIGN = 'c0000000-0000-4000-8000-00000000000f'
const T_UNKNOWN = 'c0000000-0000-4000-8000-0000000000ff'

const LOCATIONS = [
  { id: STUDIO_A, organization_id: ORG_1, name: 'Studio A' },
  { id: STUDIO_B, organization_id: ORG_1, name: 'Studio B' },
  { id: STUDIO_X, organization_id: ORG_2, name: 'Studio X' },
]

const tpl = (over = {}) => ({
  id: T1, location_id: STUDIO_A, name: 'Early', start_time: '06:00:00', end_time: '09:00:00',
  color: '#10B981', role_label: 'Floor', active: true, display_order: 0,
  days_of_week: ['mon', 'wed'], min_coaches: 2, max_coaches: 4,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  ...over,
})
const EARLY = tpl()
const LATE = tpl({ id: T2, name: 'Late', start_time: '18:00:00', end_time: '21:00:00', days_of_week: [], min_coaches: 1, max_coaches: 3 })
const OLD = tpl({ id: T3, name: 'Old', active: false })
const FOREIGN = tpl({ id: T_FOREIGN, location_id: STUDIO_X, name: 'Their shift' })

function fakeDb({ locations = LOCATIONS, templates = [EARLY, LATE], fail = {}, takenMeanwhile = [] } = {}) {
  const calls = { reads: [], upserts: [] }
  function from(table) {
    if (table !== 'locations' && table !== 'shift_templates') throw new Error(`unexpected table ${table}`)
    const filters = []
    const b = {
      select() { return b },
      eq(col, v) { filters.push((r) => r[col] === v); return b },
      in(col, vs) { filters.push((r) => vs.includes(r[col])); return b },
      order() { return b },
      upsert(rows, opts) {
        calls.upserts.push({ rows, opts })
        return {
          select: async () => {
            if (fail.upsert) return { data: null, error: { message: 'insert failed' } }
            // ON CONFLICT (location_id, name) DO NOTHING: exact-name clashes are
            // not returned, including one another request added meanwhile.
            const clash = (r) => takenMeanwhile.includes(r.name)
              || templates.some((t) => t.location_id === r.location_id && t.name === r.name)
            return { data: rows.filter((r) => !clash(r)).map((r, i) => ({ id: `new-${i + 1}`, ...r })), error: null }
          },
        }
      },
      then(resolve, reject) {
        calls.reads.push(table)
        const rows = (table === 'locations' ? locations : templates).filter((r) => filters.every((f) => f(r)))
        const result = fail[table]
          ? { data: null, error: { message: `${table} read failed` } }
          : { data: rows.map((r) => ({ ...r })), error: null }
        return Promise.resolve(result).then(resolve, reject)
      },
    }
    return b
  }
  return { db: { from }, calls }
}

const studio = (id) => ({ ...LOCATIONS.find((l) => l.id === id) })
const member = (rolesByLocation) => ({
  id: 'u-1', role: 'manager', profileRole: 'staff',
  locations: Object.keys(rolesByLocation).map(studio),
  rolesByLocation,
})
const BOTH = member({ [STUDIO_A]: 'manager', [STUDIO_B]: 'manager' })
const MASTER = { id: 'u-master', role: 'master', profileRole: 'master', locations: LOCATIONS.map((l) => studio(l.id)), rolesByLocation: {} }

const req = (body) => ({ json: () => Promise.resolve(body), headers: { get: () => '' } })
const COPY_A_TO_B = { from_location_id: STUDIO_A, to_location_id: STUDIO_B }

async function run(user, body, dbOpts) {
  getCurrentUser.mockResolvedValue(user)
  const fake = fakeDb(dbOpts)
  createServerClient.mockReturnValue(fake.db)
  const res = await POST(req(body))
  return { status: res.status, json: await res.json(), calls: fake.calls }
}

beforeEach(() => {
  createServerClient.mockReset()
  getCurrentUser.mockReset()
  generateBlocksForTemplate.mockReset()
  generateBlocksForTemplate.mockResolvedValue({ inserted: 8, skipped: 0, removed: 0 })
})

describe('POST /api/schedule/templates/clone — who may copy (TPLCLONE.1)', () => {
  it('a master cannot copy between organisations, and no template is read', async () => {
    const { status, json, calls } = await run(MASTER, { from_location_id: STUDIO_X, to_location_id: STUDIO_B }, { templates: [FOREIGN] })
    expect(status).toBe(403)
    expect(json.error).toMatch(/same organisation/)
    expect(calls.reads).toEqual(['locations'])
    expect(calls.upserts).toEqual([])
  })

  it('a manager at studios in two organisations cannot copy between them either', async () => {
    const twoOrgs = member({ [STUDIO_X]: 'owner', [STUDIO_B]: 'manager' })
    const { status, calls } = await run(twoOrgs, { from_location_id: STUDIO_X, to_location_id: STUDIO_B }, { templates: [FOREIGN] })
    expect(status).toBe(403)
    expect(calls.upserts).toEqual([])
  })

  it('an organisation that cannot be read is never "the same"', async () => {
    const locations = [studio(STUDIO_A), { ...studio(STUDIO_B), organization_id: null }]
    const { status, calls } = await run(MASTER, COPY_A_TO_B, { locations })
    expect(status).toBe(403)
    expect(calls.upserts).toEqual([])
  })

  it('a studio row that is gone answers 404', async () => {
    const { status } = await run(MASTER, COPY_A_TO_B, { locations: [studio(STUDIO_A)] })
    expect(status).toBe(404)
  })

  it('refuses a caller who is only staff at the TARGET, and writes nothing', async () => {
    const { status, json, calls } = await run(member({ [STUDIO_A]: 'manager', [STUDIO_B]: 'staff' }), COPY_A_TO_B)
    expect(status).toBe(403)
    expect(json.error).toMatch(/manager at both studios/)
    expect(calls.reads).toEqual([])
    expect(calls.upserts).toEqual([])
  })

  it('refuses a caller who is only staff at the SOURCE', async () => {
    const { status, calls } = await run(member({ [STUDIO_A]: 'staff', [STUDIO_B]: 'manager' }), COPY_A_TO_B)
    expect(status).toBe(403)
    expect(calls.upserts).toEqual([])
  })

  it('refuses a target the caller does not belong to (membership before role)', async () => {
    const { status, json, calls } = await run(member({ [STUDIO_A]: 'manager' }), COPY_A_TO_B)
    expect(status).toBe(403)
    expect(json.error).toBe('Forbidden — location not in your assignments')
    expect(calls.reads).toEqual([])
  })

  it('refuses a caller who manages nowhere, and a signed-out caller', async () => {
    expect((await run(member({ [STUDIO_A]: 'staff', [STUDIO_B]: 'staff' }), COPY_A_TO_B)).status).toBe(403)
    expect((await run(null, COPY_A_TO_B)).status).toBe(403)
  })

  it('refuses copying a studio onto itself, and an empty template_ids list', async () => {
    expect((await run(BOTH, { from_location_id: STUDIO_A, to_location_id: STUDIO_A })).status).toBe(400)
    expect((await run(BOTH, { ...COPY_A_TO_B, template_ids: [] })).status).toBe(400)
  })

  it('a failed studio read stops it before any template is read', async () => {
    const { status, calls } = await run(BOTH, COPY_A_TO_B, { fail: { locations: true } })
    expect(status).toBe(500)
    expect(calls.reads).toEqual(['locations'])
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/schedule/templates/clone/route.test.js`
Expected: FAIL, `Failed to load url ./route.js` (the file does not exist).

- [ ] **Step 3: Minimal implementation**

Create `src/app/api/schedule/templates/clone/route.js`:

```js
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'
import { organizationCheck } from '@/lib/shift-template-clone'

// TPLCLONE.1 — POST /api/schedule/templates/clone
//
// Copy shift templates from one studio into another studio of the SAME
// organisation. The caller needs a manager role (MANAGER_ROLES, the set that
// may create a template) AT BOTH studios; a master passes that, and is still
// held to one organisation.
//
// Why the organisation is read and not inferred: membership proves nothing
// about it. A master's user.locations is every active studio on the estate, an
// org admin's is every studio of every org they administer, and nothing keeps a
// person inside one organisation (ORGSCOPE.1). So both studios' rows are read
// and their organization_id compared, both present AND equal.
//
// 403 on every refusal of a body-param studio (assertLocationAccess's
// convention). The cross-organisation 403 discloses nothing: only a caller who
// is already a member of both studios can reach it.
const CloneTemplatesSchema = z.object({
  from_location_id: uuidLike,
  to_location_id: uuidLike,
  template_ids: z.array(uuidLike).min(1).max(200).optional(),
  dry_run: z.boolean().optional(),
}).refine((b) => b.from_location_id !== b.to_location_id, {
  message: 'Choose a different studio to copy from',
  path: ['from_location_id'],
})

const refuse = (status, error) => NextResponse.json({ success: false, error }, { status })

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) return refuse(403, 'Unauthorized')

  const validation = await validateBody(request, CloneTemplatesSchema)
  if (!validation.ok) return validation.response
  const { from_location_id: fromId, to_location_id: toId } = validation.data

  // Membership first, so a studio the caller is not at is answered as that,
  // not with a role complaint that confirms it exists.
  for (const id of [fromId, toId]) {
    const guard = assertLocationAccess(user, id)
    if (guard) return guard
  }
  if (!hasRoleAtLocation(user, fromId, MANAGER_ROLES) || !hasRoleAtLocation(user, toId, MANAGER_ROLES)) {
    return refuse(403, 'You need to be a manager at both studios to copy templates between them.')
  }

  const db = createServerClient()

  const { data: studios, error: studiosErr } = await db
    .from('locations')
    .select('id, organization_id')
    .in('id', [fromId, toId])
  if (studiosErr) return refuse(500, 'Could not check the two studios; nothing was copied.')
  const org = organizationCheck(studios, fromId, toId)
  if (org === 'not_found') return refuse(404, 'Studio not found')
  if (org !== 'same_org') return refuse(403, 'Templates can only be copied between studios in the same organisation.')

  // The copy itself lands in Task 5. Until then the gates answer an empty dry run.
  return NextResponse.json({ success: true, data: { dry_run: true, created: [], skipped: [], generated_blocks: 0 } })
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/schedule/templates/clone/route.test.js`
Expected: all 10 pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/templates/clone/route.js src/app/api/schedule/templates/clone/route.test.js
git commit -m "TPLCLONE.1 — template copy route: manager at both studios, one organisation only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: the copy itself

**Files:** Modify `src/app/api/schedule/templates/clone/route.js`, `src/app/api/schedule/templates/clone/route.test.js`.

- [ ] **Step 1: Write the failing tests**

Append to `src/app/api/schedule/templates/clone/route.test.js`:

```js
describe('POST /api/schedule/templates/clone — the copy (TPLCLONE.1)', () => {
  it('copies the source\'s active templates into a same-org studio, after its existing ones', async () => {
    const existing = tpl({ id: T9, location_id: STUDIO_B, name: 'Open gym', display_order: 4 })
    const { status, json, calls } = await run(BOTH, COPY_A_TO_B, { templates: [EARLY, LATE, existing] })
    expect(status).toBe(201)
    expect(calls.upserts).toHaveLength(1)
    expect(calls.upserts[0].opts).toEqual({ onConflict: 'location_id,name', ignoreDuplicates: true })
    // No id, no created_at/updated_at, the target's studio, active, ordered after 4.
    expect(calls.upserts[0].rows).toEqual([
      { location_id: STUDIO_B, name: 'Early', start_time: '06:00:00', end_time: '09:00:00', color: '#10B981', role_label: 'Floor', days_of_week: ['mon', 'wed'], min_coaches: 2, max_coaches: 4, active: true, display_order: 5 },
      { location_id: STUDIO_B, name: 'Late', start_time: '18:00:00', end_time: '21:00:00', color: '#10B981', role_label: 'Floor', days_of_week: [], min_coaches: 1, max_coaches: 3, active: true, display_order: 6 },
    ])
    expect(json.data.dry_run).toBe(false)
    expect(json.data.created).toEqual([
      { id: 'new-1', source_id: T1, name: 'Early', start_time: '06:00:00', end_time: '09:00:00', days_of_week: ['mon', 'wed'] },
      { id: 'new-2', source_id: T2, name: 'Late', start_time: '18:00:00', end_time: '21:00:00', days_of_week: [] },
    ])
    expect(json.data.skipped).toEqual([])
  })

  it('a master and a head coach at both studios may copy too', async () => {
    expect((await run(MASTER, COPY_A_TO_B)).status).toBe(201)
    expect((await run(member({ [STUDIO_A]: 'head_coach', [STUDIO_B]: 'owner' }), COPY_A_TO_B)).status).toBe(201)
  })

  it('skips a name the target already has, whatever its case', async () => {
    const existing = tpl({ id: T9, location_id: STUDIO_B, name: 'early ', display_order: 0 })
    const { json, calls } = await run(BOTH, COPY_A_TO_B, { templates: [EARLY, LATE, existing] })
    expect(calls.upserts[0].rows.map((r) => r.name)).toEqual(['Late'])
    expect(json.data.created.map((c) => c.name)).toEqual(['Late'])
    expect(json.data.skipped).toEqual([{ source_id: T1, name: 'Early', reason: 'name_exists' }])
  })

  it('a name the target gained while the copy ran is skipped, not an error', async () => {
    const { status, json } = await run(BOTH, COPY_A_TO_B, { takenMeanwhile: ['Late'] })
    expect(status).toBe(201)
    expect(json.data.created.map((c) => c.name)).toEqual(['Early'])
    expect(json.data.skipped).toEqual([{ source_id: T2, name: 'Late', reason: 'name_exists' }])
  })

  it('leaves inactive templates out by default, without reporting them', async () => {
    const { json, calls } = await run(BOTH, COPY_A_TO_B, { templates: [EARLY, LATE, OLD] })
    expect(calls.upserts[0].rows.map((r) => r.name)).toEqual(['Early', 'Late'])
    expect(json.data.skipped).toEqual([])
  })

  it('template_ids copies only those; an inactive one, another studio\'s and an unknown one come back skipped, nameless where not the source\'s', async () => {
    const { json, calls } = await run(BOTH, { ...COPY_A_TO_B, template_ids: [T2, T3, T_FOREIGN, T_UNKNOWN] }, { templates: [EARLY, LATE, OLD, FOREIGN] })
    expect(calls.upserts[0].rows.map((r) => r.name)).toEqual(['Late'])
    expect(json.data.skipped).toEqual([
      { source_id: T3, name: 'Old', reason: 'inactive' },
      // The source read is pinned to from_location_id, so another studio's
      // template is simply not there: no name comes back for it.
      { source_id: T_FOREIGN, name: null, reason: 'not_found' },
      { source_id: T_UNKNOWN, name: null, reason: 'not_found' },
    ])
  })

  it('dry_run answers the same lists and writes nothing', async () => {
    const { status, json, calls } = await run(BOTH, { ...COPY_A_TO_B, dry_run: true })
    expect(status).toBe(200)
    expect(json.data.dry_run).toBe(true)
    expect(json.data.created.map((c) => c.name)).toEqual(['Early', 'Late'])
    expect(json.data.created[0]).not.toHaveProperty('id')
    expect(calls.upserts).toEqual([])
    expect(generateBlocksForTemplate).not.toHaveBeenCalled()
  })

  it('nothing left to create writes nothing and answers 200', async () => {
    const taken = [tpl({ id: T9, location_id: STUDIO_B, name: 'Early' }), tpl({ id: T3, location_id: STUDIO_B, name: 'Late' })]
    const { status, json, calls } = await run(BOTH, COPY_A_TO_B, { templates: [EARLY, LATE, ...taken] })
    expect(status).toBe(200)
    expect(json.data.created).toEqual([])
    expect(json.data.skipped.map((s) => s.reason)).toEqual(['name_exists', 'name_exists'])
    expect(calls.upserts).toEqual([])
  })

  it('fills the next 8 weeks for copied templates that run on weekdays, and only those', async () => {
    const { json } = await run(BOTH, COPY_A_TO_B)
    expect(generateBlocksForTemplate).toHaveBeenCalledTimes(1)
    expect(generateBlocksForTemplate.mock.calls[0][1]).toMatchObject({
      id: 'new-1', location_id: STUDIO_B, name: 'Early', days_of_week: ['mon', 'wed'], min_coaches: 2, max_coaches: 4,
    })
    expect(json.data.generated_blocks).toBe(8)
    expect(json).not.toHaveProperty('warning')
  })

  it('a calendar fill that fails keeps the copy and says so', async () => {
    generateBlocksForTemplate.mockRejectedValueOnce(new Error('upsert refused'))
    const { status, json } = await run(BOTH, COPY_A_TO_B)
    expect(status).toBe(201)
    expect(json.data.created).toHaveLength(2)
    expect(json.data.generated_blocks).toBe(0)
    expect(json.warning).toMatch(/Early/)
    expect(json.warning).toMatch(/nightly/)
  })

  it('a failed template read writes nothing', async () => {
    const { status, calls } = await run(BOTH, COPY_A_TO_B, { fail: { shift_templates: true } })
    expect(status).toBe(500)
    expect(calls.upserts).toEqual([])
  })

  it('a failed insert is a 500, and nothing is filled', async () => {
    const { status, json } = await run(BOTH, COPY_A_TO_B, { fail: { upsert: true } })
    expect(status).toBe(500)
    expect(json.error).toMatch(/nothing was copied/)
    expect(generateBlocksForTemplate).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/schedule/templates/clone/route.test.js -t "the copy"`
Expected: most fail against the Task 4 stub, e.g. `expected 200 to be 201` and `expected [] to have a length of 1`. The Task 4 describe still passes.

- [ ] **Step 3: Implementation**

Replace the whole of `src/app/api/schedule/templates/clone/route.js` with:

```js
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'
import { generateBlocksForTemplate } from '@/lib/roster'
import { logWarn } from '@/lib/log'
import { planTemplateClone, organizationCheck, CLONE_SKIP_REASONS } from '@/lib/shift-template-clone'

// TPLCLONE.1 — POST /api/schedule/templates/clone
//
// Copy shift templates from one studio into another studio of the SAME
// organisation. The caller needs a manager role (MANAGER_ROLES, the set that
// may create a template) AT BOTH studios; a master passes that, and is still
// held to one organisation.
//
// Why the organisation is read and not inferred: membership proves nothing
// about it. A master's user.locations is every active studio on the estate, an
// org admin's is every studio of every org they administer, and nothing keeps a
// person inside one organisation (ORGSCOPE.1). So both studios' rows are read
// and their organization_id compared, both present AND equal.
//
// 403 on every refusal of a body-param studio (assertLocationAccess's
// convention). The cross-organisation 403 discloses nothing: only a caller who
// is already a member of both studios can reach it.
//
// Every read and the write stay in THIS file, each pinned to its studio in the
// chain itself: check:location-scoping reads route files, not src/lib, and
// tests/shift-template-clone.guards.test.js checks each chain.
//
// The copy is one multi-row upsert, ON CONFLICT (location_id, name) DO
// NOTHING (the mig 010 unique key): all or nothing, and a template the target
// gains while this runs comes back as skipped rather than failing the batch.
// dry_run answers the same lists and writes nothing; the template manager's
// preview IS a dry run, so preview and copy cannot disagree.
//
// Filling the calendar is a follow-on, not the copy. A copied template with
// weekdays gets its next 8 weeks of blocks now, as creating one by hand does;
// if that fails the copy stands, the answer carries a warning, and the nightly
// extend-roster-horizon run fills them.
const CloneTemplatesSchema = z.object({
  from_location_id: uuidLike,
  to_location_id: uuidLike,
  template_ids: z.array(uuidLike).min(1).max(200).optional(),
  dry_run: z.boolean().optional(),
}).refine((b) => b.from_location_id !== b.to_location_id, {
  message: 'Choose a different studio to copy from',
  path: ['from_location_id'],
})

const refuse = (status, error) => NextResponse.json({ success: false, error }, { status })

function previewOf({ source_id, row }) {
  return {
    source_id,
    name: row.name,
    start_time: row.start_time,
    end_time: row.end_time,
    days_of_week: row.days_of_week || [],
  }
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) return refuse(403, 'Unauthorized')

  const validation = await validateBody(request, CloneTemplatesSchema)
  if (!validation.ok) return validation.response
  const {
    from_location_id: fromId,
    to_location_id: toId,
    template_ids: templateIds = null,
    dry_run: dryRun = false,
  } = validation.data

  // Membership first, so a studio the caller is not at is answered as that,
  // not with a role complaint that confirms it exists.
  for (const id of [fromId, toId]) {
    const guard = assertLocationAccess(user, id)
    if (guard) return guard
  }
  if (!hasRoleAtLocation(user, fromId, MANAGER_ROLES) || !hasRoleAtLocation(user, toId, MANAGER_ROLES)) {
    return refuse(403, 'You need to be a manager at both studios to copy templates between them.')
  }

  const db = createServerClient()

  const { data: studios, error: studiosErr } = await db
    .from('locations')
    .select('id, organization_id')
    .in('id', [fromId, toId])
  if (studiosErr) return refuse(500, 'Could not check the two studios; nothing was copied.')
  const org = organizationCheck(studios, fromId, toId)
  if (org === 'not_found') return refuse(404, 'Studio not found')
  if (org !== 'same_org') return refuse(403, 'Templates can only be copied between studios in the same organisation.')

  // Neither read pages: a studio has tens of templates (the estate's largest
  // has 22), and the nightly horizon cron reads every template unpaged too.
  // select('*') on the source is deliberate: TEMPLATE_CLONE_COLUMNS decides
  // what is copied, so SHIFTTYPE.1's `kind` is a one-line change there.
  let sourceQuery = db
    .from('shift_templates')
    .select('*')
    .eq('location_id', fromId)
    .order('display_order')
    .order('start_time')
    .order('name')
  if (templateIds) sourceQuery = sourceQuery.in('id', templateIds)
  const [
    { data: source, error: sourceErr },
    { data: target, error: targetErr },
  ] = await Promise.all([
    sourceQuery,
    db.from('shift_templates').select('name, display_order').eq('location_id', toId),
  ])
  if (sourceErr || targetErr) return refuse(500, 'Could not read the templates; nothing was copied.')

  const plan = planTemplateClone({ sourceTemplates: source, targetTemplates: target, templateIds })

  if (dryRun || plan.toCreate.length === 0) {
    return NextResponse.json({
      success: true,
      data: {
        dry_run: dryRun,
        created: dryRun ? plan.toCreate.map(previewOf) : [],
        skipped: plan.skipped,
        generated_blocks: 0,
      },
    })
  }

  const { data: inserted, error: insertErr } = await db
    .from('shift_templates')
    .upsert(
      plan.toCreate.map(({ row }) => ({ ...row, location_id: toId })),
      { onConflict: 'location_id,name', ignoreDuplicates: true },
    )
    .select('id, location_id, name, start_time, end_time, days_of_week, min_coaches, max_coaches')
  if (insertErr) {
    logWarn('schedule/templates/clone', 'template copy insert failed', { from: fromId, to: toId, error: insertErr.message })
    return refuse(500, 'Could not copy the templates; nothing was copied.')
  }

  // ON CONFLICT DO NOTHING returns only the rows it inserted. A planned row
  // that is missing lost a race to a template of the same name.
  const insertedByName = new Map((inserted || []).map((t) => [t.name, t]))
  const created = []
  const skipped = [...plan.skipped]
  for (const p of plan.toCreate) {
    const t = insertedByName.get(p.row.name)
    if (t) created.push({ id: t.id, ...previewOf(p) })
    else skipped.push({ source_id: p.source_id, name: p.row.name, reason: CLONE_SKIP_REASONS.nameExists })
  }

  let generatedBlocks = 0
  const unfilled = []
  for (const t of inserted || []) {
    if (!(t.days_of_week || []).length) continue
    try {
      const res = await generateBlocksForTemplate(db, t)
      generatedBlocks += res?.inserted || 0
    } catch (e) {
      unfilled.push(t.name)
      logWarn('schedule/templates/clone', 'block generation failed after a template copy', {
        template_id: t.id, location_id: toId, error: e?.message,
      })
    }
  }

  const body = { success: true, data: { dry_run: false, created, skipped, generated_blocks: generatedBlocks } }
  if (unfilled.length > 0) {
    body.warning = `Templates copied, but the calendar could not be filled for ${unfilled.join(', ')} yet. The nightly schedule run adds those shifts.`
  }
  return NextResponse.json(body, { status: 201 })
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/schedule/templates/clone/route.test.js`
Expected: all 22 pass (10 gates + 12 copy).

Then: `npm run check:select-columns && npm run check:guardrails && npm run check:route-guards`
Expected: all three green. (`select-columns` resolves `locations(id, organization_id)` and `shift_templates(name, display_order)` plus the upsert's `.select(...)`; `select('*')` is not a column claim. `route-guards` sees `getCurrentUser`.)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/templates/clone/route.js src/app/api/schedule/templates/clone/route.test.js
git commit -m "TPLCLONE.1 — copy templates in one upsert, skip taken names, fill the calendar after

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: the route passes `check:location-scoping` on every chain

**Files:** Modify `tests/shift-template-clone.guards.test.js`.

`npm run check:location-scoping` passes a file that has ANY scoping evidence anywhere (`fileHasTenantEvidence`, `scripts/check-location-scoping.mjs:510-521`), and this route has `assertLocationAccess`, so the gate alone would stay green even if one of the three `shift_templates` chains lost its studio filter. This test holds each chain to chain-level evidence (`chainHasTenantEvidence`, `:500-507`).

- [ ] **Step 1: Write the test**

In `tests/shift-template-clone.guards.test.js`, replace the two import lines under `vitest` with:

```js
import fs from 'node:fs'
import { collectSchema } from '../scripts/check-select-columns.mjs'
import {
  collectLocationTables,
  classifyRoute,
  extractQueryChains,
  chainHasTenantEvidence,
} from '../scripts/check-location-scoping.mjs'
import { TEMPLATE_CLONE_COLUMNS, TEMPLATE_CLONE_MANAGED_COLUMNS } from '../src/lib/shift-template-clone.js'
```

Add to the header comment:

```js
// 2. The clone route passes check:location-scoping, and more strictly than the
//    gate asks: EVERY shift_templates chain carries its studio in the chain
//    itself. The gate accepts evidence anywhere in the file, and this route has
//    assertLocationAccess, so a chain that lost .eq('location_id', …) would
//    still pass it.
```

Append at the end of the file:

```js
describe('TPLCLONE.1 — the clone route is scoped to a studio on every chain', () => {
  const rel = 'src/app/api/schedule/templates/clone/route.js'
  const src = fs.readFileSync(rel, 'utf8')
  const tables = collectLocationTables('supabase/migrations')

  it('check:location-scoping finds nothing unscoped and needs no exemption', () => {
    expect(classifyRoute(rel, src, tables)).toEqual({ findings: [] })
  })

  it('the source read, the target read and the insert each name the studio in the chain', () => {
    const chains = extractQueryChains(src, 'shift_templates')
    expect(chains).toHaveLength(3)
    expect(chains.filter((c) => !chainHasTenantEvidence(c))).toEqual([])
  })
})
```

- [ ] **Step 2: Run it, expect PASS (and prove it can fail)**

Run: `npx vitest run tests/shift-template-clone.guards.test.js`
Expected: 5 pass.

Prove it bites: in the route, temporarily change the target read to `db.from('shift_templates').select('name, display_order')` (drop the `.eq`), re-run, expect `the source read, the target read and the insert…` to fail with one chain listed. Restore, re-run, green.

Then: `npm run check:location-scoping`
Expected: `✓ location scoping: …` and the route count one higher than the baseline (817 routes on `2f0b35ba`).

- [ ] **Step 3: Commit**

```bash
git add tests/shift-template-clone.guards.test.js
git commit -m "TPLCLONE.1 — pin every template chain in the clone route to its studio

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: OpenAPI

**Files:** Modify `src/lib/openapi.js`, `src/lib/openapi.test.js`.

- [ ] **Step 1: Write the failing test**

In `src/lib/openapi.test.js`, insert directly before `it('declares webhook + bridge auth schemes', () => {` (line 313):

```js
  // TPLCLONE.1
  it('documents the template copy, including the one-organisation rule', () => {
    const op = spec.paths['/api/schedule/templates/clone']?.post
    expect(op).toBeDefined()
    expect(op.security).toContainEqual({ CookieAuth: [] })
    expect(op.description).toMatch(/same organisation/i)
    expect(op.description).toMatch(/both/i)
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['200', '201', '400', '403', '404', '500']))
    expect(spec.components.schemas).toHaveProperty('TemplateCloneRequest')
    expect(spec.components.schemas).toHaveProperty('TemplateCloneResponse')
  })

```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/openapi.test.js`
Expected: the new test fails with `expected undefined to be defined`.

- [ ] **Step 3: Register the route**

In `src/lib/openapi.js`, insert directly before the comment line `// ROSTER-FIX.6c — the FTE weekly-hours panel's arithmetic, moved off the` (line 4441, right after the copy-month `registry.registerPath({ … })` closes):

```js
// TPLCLONE.1 — copy shift templates between two studios of ONE organisation.
const TemplateCloneItem = z.object({
  id: z.string().optional().openapi({ description: 'The new template id. Absent on a dry run.' }),
  source_id: z.string(),
  name: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  days_of_week: z.array(z.string()),
})
const TemplateCloneResponse = z.object({
  success: z.literal(true),
  data: z.object({
    dry_run: z.boolean(),
    created: z.array(TemplateCloneItem).openapi({ description: 'What was created, or on a dry run what would be.' }),
    skipped: z.array(z.object({
      source_id: z.string(),
      name: z.string().nullable().openapi({ description: 'Null for not_found: an id that is not a template of the source studio is never answered with a name.' }),
      reason: z.enum(['name_exists', 'duplicate_in_source', 'inactive', 'not_found']),
    })),
    generated_blocks: z.number().int().openapi({ description: 'Empty shift slots added over the next 8 weeks for copied templates with weekdays.' }),
  }),
  warning: z.string().optional().openapi({ description: 'The templates were copied but the calendar could not be filled for some; the nightly schedule run adds them.' }),
}).openapi('TemplateCloneResponse')

registry.registerPath({
  method: 'post',
  path: '/api/schedule/templates/clone',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'Copy shift templates from another studio in the same organisation (manager at both)',
  description: 'Copies shift templates from from_location_id into to_location_id. Both studios must belong to the same organisation (403 otherwise, a master included) and the caller needs a manager role (owner, manager or head coach, or master) at BOTH. Only active templates are copied; template_ids narrows the copy, and an inactive one named there comes back skipped `inactive`, an id that is not a template of the source studio `not_found`. Copied: name, times, colour, role label, weekdays, minimum and maximum coaches. The copies are active and ordered after the target\'s existing templates, in the source order. A name the target already has (any case, active or not) is skipped `name_exists`, as is one the target gained while the copy ran; a second source template of the same name is skipped `duplicate_in_source`. The insert is one statement: all or nothing. dry_run answers the same lists and writes nothing. A copied template with weekdays gets its next 8 weeks of empty shifts at once, as creating one does; if that fails the copy stands, the answer carries `warning`, and the nightly schedule run adds them.',
  request: {
    body: { content: { 'application/json': { schema: z.object({
      from_location_id: uuidLike,
      to_location_id: uuidLike.openapi({ description: 'Must differ from from_location_id.' }),
      template_ids: z.array(uuidLike).min(1).max(200).optional().openapi({ description: 'Source template ids to copy. Omitted: every active template at the source.' }),
      dry_run: z.boolean().optional().openapi({ description: 'Answer what would be created and skipped; write nothing.' }),
    }).openapi('TemplateCloneRequest') } } },
  },
  responses: {
    200: { description: 'Dry run, or nothing left to create (created is empty)', content: { 'application/json': { schema: TemplateCloneResponse } } },
    201: { description: 'Copied', content: { 'application/json': { schema: TemplateCloneResponse } } },
    400: { description: 'Validation error (including copying a studio onto itself)', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Not a member of both studios, not a manager at both, or the studios are in different organisations', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'A studio no longer exists', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'The studios or templates could not be read, or the insert failed; nothing was copied', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/openapi.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openapi.js src/lib/openapi.test.js
git commit -m "TPLCLONE.1 — document POST /api/schedule/templates/clone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: the copy dialog

**Files:** Create `src/components/schedule/CopyTemplatesModal.jsx`, `src/components/schedule/CopyTemplatesModal.test.jsx`.

The dialog copies INTO the studio on screen (the template manager is always about `user.activeLocation`). With one possible source it previews at once; with more than one (a master at Hatch Street would see Stillorgan, Test Studio and the host-events location) nothing is requested until a studio is chosen, so the first request is never a guess.

- [ ] **Step 1: Write the failing tests**

Create `src/components/schedule/CopyTemplatesModal.test.jsx`:

```jsx
// @vitest-environment jsdom
//
// TPLCLONE.1 — the "copy templates from another studio" dialog. It previews
// with a dry run of the real route, copies only what stays ticked, and hands
// the route's answer back to the template manager.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'

import CopyTemplatesModal from './CopyTemplatesModal'

const TARGET = { id: 'studio-b', name: 'Studio B' }
const ONE_SOURCE = [{ id: 'studio-a', name: 'Studio A' }]
const PREVIEW = {
  dry_run: true,
  created: [
    { source_id: 'src-1', name: 'Early', start_time: '06:00:00', end_time: '09:00:00', days_of_week: ['mon', 'wed'] },
    { source_id: 'src-2', name: 'Late', start_time: '18:00:00', end_time: '21:00:00', days_of_week: [] },
  ],
  skipped: [{ source_id: 'src-3', name: 'Open gym', reason: 'name_exists' }],
  generated_blocks: 0,
}
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

function mockRoute(handler) {
  global.fetch = vi.fn(async (url, opts) => handler(JSON.parse(opts.body), String(url)))
}
const bodies = () => global.fetch.mock.calls.map(([, o]) => JSON.parse(o.body))

async function open(props = {}) {
  const onDone = vi.fn()
  const onClose = vi.fn()
  await act(async () => {
    render(<CopyTemplatesModal sources={ONE_SOURCE} target={TARGET} onDone={onDone} onClose={onClose} {...props} />)
  })
  return { onDone, onClose }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('CopyTemplatesModal (TPLCLONE.1)', () => {
  it('previews the only sibling studio with a dry run, and lists what would be created and skipped', async () => {
    mockRoute(() => reply({ success: true, data: PREVIEW }))
    await open()
    await screen.findByText('Early')
    expect(global.fetch.mock.calls[0][0]).toBe('/api/schedule/templates/clone')
    expect(bodies()[0]).toEqual({ from_location_id: 'studio-a', to_location_id: 'studio-b', dry_run: true })
    expect(screen.getByText('Late')).toBeTruthy()
    expect(screen.getByText('Open gym')).toBeTruthy()
    expect(screen.getByText(/a template with this name is already here/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy 2 templates' })).toBeTruthy()
  })

  it('copies only the ticked templates, for real, and hands the answer back', async () => {
    mockRoute((b) => (b.dry_run
      ? reply({ success: true, data: PREVIEW })
      : reply({ success: true, data: { dry_run: false, created: [{ id: 'new-1', ...PREVIEW.created[0] }], skipped: [], generated_blocks: 16 } }, 201)))
    const { onDone } = await open()
    await screen.findByText('Early')
    fireEvent.click(screen.getByRole('checkbox', { name: /Late/ }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy 1 template' })) })
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(bodies()[1]).toEqual({ from_location_id: 'studio-a', to_location_id: 'studio-b', template_ids: ['src-1'] })
    expect(onDone.mock.calls[0][0]).toMatchObject({
      created: [{ name: 'Early' }], generated_blocks: 16, fromName: 'Studio A', warning: null,
    })
  })

  it('warns that weekday templates put empty shifts on the calendar, only while one is ticked', async () => {
    mockRoute(() => reply({ success: true, data: PREVIEW }))
    await open()
    await screen.findByText('Early')
    expect(screen.getByText(/1 of these runs on set weekdays/)).toBeTruthy()
    expect(screen.getByText(/next 8 weeks/)).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /Early/ }))
    expect(screen.queryByText(/on set weekdays/)).toBeNull()
  })

  it('shows the route\'s refusal and offers no copy', async () => {
    mockRoute(() => reply({ success: false, error: 'Templates can only be copied between studios in the same organisation.' }, 403))
    await open()
    expect(await screen.findByText('Templates can only be copied between studios in the same organisation.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy templates' }).disabled).toBe(true)
  })

  it('says so when there is nothing to copy', async () => {
    mockRoute(() => reply({ success: true, data: { dry_run: true, created: [], skipped: PREVIEW.skipped, generated_blocks: 0 } }))
    await open()
    expect(await screen.findByText(/Nothing to copy/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy templates' }).disabled).toBe(true)
  })

  it('with two possible studios, asks first and previews the one chosen', async () => {
    mockRoute(() => reply({ success: true, data: PREVIEW }))
    await open({ sources: [{ id: 'studio-a', name: 'Studio A' }, { id: 'studio-c', name: 'Studio C' }] })
    expect(global.fetch).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Copy from'), { target: { value: 'studio-c' } })
    })
    await screen.findByText('Early')
    expect(bodies()[0]).toMatchObject({ from_location_id: 'studio-c', dry_run: true })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/components/schedule/CopyTemplatesModal.test.jsx`
Expected: FAIL, `Failed to resolve import "./CopyTemplatesModal"`.

- [ ] **Step 3: Implementation**

Create `src/components/schedule/CopyTemplatesModal.jsx`:

```jsx
'use client'

// TPLCLONE.1 — copy shift templates INTO the studio on screen from another
// studio of the same organisation.
//
// The preview is a dry run of the same route that copies, so what it calls
// "already here" is the server's rule, not a second copy of it in the browser.
// The copy then sends only the templates still ticked; the answer (created,
// skipped, the shifts it put on the calendar, any warning) goes back to the
// template manager, which owns the notice.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import Modal from '@/components/ui/Modal'
import { formatTime12h as formatTime } from '@/lib/schedule-overlap'
import { CLONE_SKIP_LABELS } from '@/lib/shift-template-clone'
import ScheduleErrorBanner from './ScheduleErrorBanner'
import { readJson } from './useScheduleData'

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

function daysLabel(days) {
  const on = DAY_ORDER.filter((d) => (days || []).includes(d))
  return on.length ? on.map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(', ') : 'One-off'
}

export default function CopyTemplatesModal({ sources, target, onClose, onDone }) {
  const selectId = useId()
  const [fromId, setFromId] = useState(sources.length === 1 ? sources[0].id : '')
  const [preview, setPreview] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  // A slow preview of the studio chosen first must not land over the one chosen after it.
  const requestSeq = useRef(0)
  const fromName = sources.find((s) => s.id === fromId)?.name || 'the other studio'

  const post = useCallback((extra) => readJson('/api/schedule/templates/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_location_id: fromId, to_location_id: target.id, ...extra }),
  }), [fromId, target.id])

  const loadPreview = useCallback(async () => {
    if (!fromId) return
    const mine = ++requestSeq.current
    setLoading(true)
    setError(null)
    setPreview(null)
    try {
      const res = await post({ dry_run: true })
      if (mine !== requestSeq.current) return
      const data = res.data || { created: [], skipped: [] }
      setPreview(data)
      setSelected(new Set((data.created || []).map((c) => c.source_id)))
    } catch (e) {
      if (mine === requestSeq.current) setError(e?.message || 'Could not read the templates to copy')
    } finally {
      if (mine === requestSeq.current) setLoading(false)
    }
  }, [fromId, post])

  useEffect(() => { loadPreview() }, [loadPreview])

  const created = preview?.created || []
  const skipped = preview?.skipped || []
  const chosen = created.filter((c) => selected.has(c.source_id))
  const withDays = chosen.filter((c) => (c.days_of_week || []).length > 0).length

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function confirmCopy() {
    if (saving || chosen.length === 0) return
    setSaving(true)
    setError(null)
    try {
      const res = await post({ template_ids: chosen.map((c) => c.source_id) })
      onDone({ ...(res.data || {}), warning: res.warning || null, fromName })
    } catch (e) {
      setError(e?.message || 'Could not copy the templates')
    } finally {
      setSaving(false)
    }
  }

  const copyLabel = saving
    ? 'Copying…'
    : chosen.length > 0
      ? `Copy ${chosen.length} template${chosen.length === 1 ? '' : 's'}`
      : 'Copy templates'

  return (
    <Modal
      open
      onClose={onClose}
      title={`Copy templates to ${target.name}`}
      dismissOnBackdrop={false}
      footer={(
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md border border-un1t-border text-un1t-text hover:bg-un1t-border/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirmCopy}
            disabled={saving || loading || chosen.length === 0}
            className="px-4 py-2 text-sm font-medium rounded-md bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
          >
            {copyLabel}
          </button>
        </>
      )}
    >
      <div className="space-y-4">
        {sources.length > 1 ? (
          <div>
            <label htmlFor={selectId} className="block text-xs text-un1t-subtle mb-1">Copy from</label>
            <select
              id={selectId}
              value={fromId}
              onChange={(e) => setFromId(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            >
              <option value="">Choose a studio</option>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        ) : (
          <p className="text-sm text-un1t-subtle">From {fromName}.</p>
        )}
        <p className="text-xs text-un1t-subtle">
          Only active templates are copied. A template whose name is already used here is left alone.
        </p>

        {error && (
          <ScheduleErrorBanner
            title="Could not copy templates"
            message={error}
            onRetry={preview ? undefined : loadPreview}
            busy={loading}
            onDismiss={() => setError(null)}
          />
        )}

        {loading && <p className="text-sm text-un1t-subtle">Reading templates at {fromName}…</p>}

        {preview && created.length === 0 && (
          <p className="text-sm text-un1t-subtle">
            Nothing to copy: every active template at {fromName} already has a template of the same name here.
          </p>
        )}

        {created.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-muted mb-2">
              Will be created ({chosen.length} of {created.length})
            </h3>
            <ul className="space-y-1 max-h-64 overflow-y-auto">
              {created.map((c) => (
                <li key={c.source_id}>
                  <label className="flex items-center gap-2 text-sm text-un1t-text">
                    <input
                      type="checkbox"
                      checked={selected.has(c.source_id)}
                      onChange={() => toggle(c.source_id)}
                    />
                    <span className="font-medium">{c.name}</span>
                    <span className="text-un1t-subtle">
                      {formatTime(c.start_time)} – {formatTime(c.end_time)} · {daysLabel(c.days_of_week)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        {skipped.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-muted mb-2">
              Skipped ({skipped.length})
            </h3>
            <ul className="space-y-1 max-h-40 overflow-y-auto text-sm text-un1t-subtle">
              {skipped.map((s) => (
                <li key={`${s.source_id}|${s.reason}`}>
                  <span className="font-medium text-un1t-text">{s.name || 'A template'}</span> — {CLONE_SKIP_LABELS[s.reason] || s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {withDays > 0 && (
          <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-sm text-amber-700">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            <div>
              {withDays} of these {withDays === 1 ? 'runs' : 'run'} on set weekdays, so {target.name} gets empty shifts for {withDays === 1 ? 'it' : 'them'} over the next 8 weeks, and {withDays === 1 ? 'it counts' : 'they count'} toward its roster alerts.
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
```

Contrast: the warning uses `bg-amber-500/10` + `text-amber-700`, the chip recipe `check:guardrails` (`no-low-contrast-chip`) accepts; `text-un1t-muted`/`text-un1t-subtle` are live tokens (`no-dead-un1t-token`).

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/components/schedule/CopyTemplatesModal.test.jsx`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/schedule/CopyTemplatesModal.jsx src/components/schedule/CopyTemplatesModal.test.jsx
git commit -m "TPLCLONE.1 — copy dialog: dry-run preview, untick what you don't want, confirm

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: wire it into the template manager

**Files:** Modify `src/components/ShiftTemplateManager.jsx`; create `src/components/ShiftTemplateManager.clone.test.jsx`.

The existing test fixtures (`MANAGER = { id, role, activeLocation }` in `ShiftTemplateManager.list.test.jsx:21`, `ShiftTemplateManager.a11y.test.jsx:11`) carry no `locations`, so `cloneSourceStudios` answers `[]` for them and no existing test sees the new button.

- [ ] **Step 1: Write the failing tests**

Create `src/components/ShiftTemplateManager.clone.test.jsx`:

```jsx
// @vitest-environment jsdom
//
// TPLCLONE.1 — the template manager offers "Copy from another studio" only
// where the route would allow it (same organisation, a manager at both), and
// reports what the copy did.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'

import ShiftTemplateManager from '@/components/ShiftTemplateManager'

const STUDIO_A = { id: 'studio-a', name: 'Studio A', organization_id: 'org-1' }
const STUDIO_B = { id: 'studio-b', name: 'Studio B', organization_id: 'org-1' }
const STUDIO_X = { id: 'studio-x', name: 'Studio X', organization_id: 'org-2' }
const user = (locations, rolesByLocation) => ({
  id: 'u1', role: 'manager', profileRole: 'staff', activeLocation: STUDIO_B, locations, rolesByLocation,
})
const MANAGES_BOTH = user([STUDIO_A, STUDIO_B], { 'studio-a': 'manager', 'studio-b': 'manager' })

const COPIED = {
  id: 'new-1', name: 'Early', start_time: '06:00:00', end_time: '09:00:00', color: '#10B981',
  active: true, max_coaches: 4, min_coaches: 2, days_of_week: ['mon'], role_label: null, display_order: 0,
}

function mockApi({ copied = false } = {}) {
  let templates = []
  global.fetch = vi.fn(async (url, opts) => {
    if (String(url).startsWith('/api/schedule/templates/clone')) {
      const body = JSON.parse(opts.body)
      if (body.dry_run) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { dry_run: true, created: [{ source_id: 'src-1', name: 'Early', start_time: '06:00:00', end_time: '09:00:00', days_of_week: ['mon'] }], skipped: [], generated_blocks: 0 } }) }
      }
      templates = [COPIED]
      return { ok: true, status: 201, json: async () => ({ success: true, data: { dry_run: false, created: [{ id: 'new-1', source_id: 'src-1', name: 'Early', start_time: '06:00:00', end_time: '09:00:00', days_of_week: ['mon'] }], skipped: [], generated_blocks: 8 } }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: copied ? [COPIED] : templates }) }
  })
}

async function renderFor(u) {
  await act(async () => { render(<ShiftTemplateManager user={u} />) })
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ShiftTemplateManager — copy from another studio (TPLCLONE.1)', () => {
  it('offers it to a manager of a sibling studio, in the header and on the empty state', async () => {
    mockApi()
    await renderFor(MANAGES_BOTH)
    expect(screen.getAllByRole('button', { name: 'Copy from another studio' })).toHaveLength(2)
  })

  it('does not offer a studio in another organisation', async () => {
    mockApi()
    await renderFor(user([STUDIO_X, STUDIO_B], { 'studio-x': 'owner', 'studio-b': 'manager' }))
    expect(screen.queryByRole('button', { name: 'Copy from another studio' })).toBeNull()
  })

  it('does not offer a sibling where the caller is only staff', async () => {
    mockApi()
    await renderFor(user([STUDIO_A, STUDIO_B], { 'studio-a': 'staff', 'studio-b': 'manager' }))
    expect(screen.queryByRole('button', { name: 'Copy from another studio' })).toBeNull()
  })

  it('copies, re-reads the list and says what it did', async () => {
    mockApi()
    await renderFor(MANAGES_BOTH)
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy from another studio' })[0])
    await screen.findByRole('button', { name: 'Copy 1 template' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy 1 template' })) })
    await waitFor(() => expect(screen.getByTestId('template-notice').textContent)
      .toBe('Copied 1 template from Studio A. 8 empty shifts added over the next 8 weeks.'))
    expect(screen.queryByRole('dialog')).toBeNull()
    // The list was read again and now shows the copy.
    expect(global.fetch.mock.calls.filter(([u]) => String(u).startsWith('/api/schedule/templates?')).length).toBe(2)
    expect(screen.getByText('Early')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/components/ShiftTemplateManager.clone.test.jsx`
Expected: the first and last tests fail (`Unable to find role="button" and name "Copy from another studio"`); the two "does not offer" tests pass already.

- [ ] **Step 3: Implementation**

In `src/components/ShiftTemplateManager.jsx`:

(a) Line 3, replace with:

```js
import { useState, useEffect, useCallback, useMemo } from 'react'
```

Line 4, replace with:

```js
import { Plus, Clock, Pencil, Trash2, Users, Ban, ChevronUp, ChevronDown, Check, Copy } from 'lucide-react'
```

After line 13 (`import { formatTime12h as formatTime } from '@/lib/schedule-overlap'`), add:

```js
// TPLCLONE.1 — copy templates in from another studio of the same organisation.
import CopyTemplatesModal from './schedule/CopyTemplatesModal'
import { cloneSourceStudios, cloneResultNotice } from '@/lib/shift-template-clone'
```

(b) Directly after line 87 (`const locationId = user.activeLocation?.id`), add:

```js
  // TPLCLONE.1 — the studios this caller could copy templates FROM into this
  // one: same organisation, and a manager at both. Only what the screen
  // offers; the route re-checks all of it.
  const copySources = useMemo(() => cloneSourceStudios(user, locationId), [user, locationId])
  const [showCopy, setShowCopy] = useState(false)
```

(c) Directly after `handleDelete` (its closing `}` is line 216), add:

```js
  // TPLCLONE.1 — fetchTemplates clears the error banner as it starts, so it
  // runs FIRST and the outcome is written after it: a warning set before the
  // re-read would be wiped by it.
  async function handleCopied(result) {
    setShowCopy(false)
    await fetchTemplates()
    setNotice(cloneResultNotice(result, result.fromName))
    if (result.warning) failWith('Templates copied, but the calendar did not fully follow', result.warning)
  }
```

(d) Replace the header button (lines 269-275):

```jsx
        <button
          type="button"
          onClick={() => setShowForm('new')}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
        >
          <Plus size={16} /> New Shift
        </button>
```

with:

```jsx
        <div className="flex items-center gap-2">
          {copySources.length > 0 && (
            <button
              type="button"
              onClick={() => { setNotice(null); setShowCopy(true) }}
              className="flex items-center gap-2 border border-un1t-border bg-un1t-surface hover:bg-un1t-border/50 text-un1t-text text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
            >
              <Copy size={16} aria-hidden="true" /> Copy from another studio
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowForm('new')}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
          >
            <Plus size={16} /> New Shift
          </button>
        </div>
```

(e) In the empty state, replace the Create Shift button (lines 314-321):

```jsx
          <button
            type="button"
            onClick={() => setShowForm('new')}
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
          >
            <Plus size={16} /> Create Shift
          </button>
```

with:

```jsx
          <div className="flex items-center justify-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setShowForm('new')}
              className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
            >
              <Plus size={16} /> Create Shift
            </button>
            {/* TPLCLONE.1 — an empty studio (Hatch Street had none) is exactly
                where copying another studio's templates saves the most typing. */}
            {copySources.length > 0 && (
              <button
                type="button"
                onClick={() => { setNotice(null); setShowCopy(true) }}
                className="inline-flex items-center gap-2 border border-un1t-border bg-un1t-surface hover:bg-un1t-border/50 text-un1t-text text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
              >
                <Copy size={16} aria-hidden="true" /> Copy from another studio
              </button>
            )}
          </div>
```

(f) Directly after the `TemplateFormModal` block (the `)}` on line 455), add:

```jsx
      {showCopy && (
        <CopyTemplatesModal
          sources={copySources}
          target={{ id: locationId, name: user.activeLocation?.name || 'this studio' }}
          onClose={() => setShowCopy(false)}
          onDone={handleCopied}
        />
      )}
```

- [ ] **Step 4: Run it, expect PASS (new and existing)**

Run: `npx vitest run src/components/ShiftTemplateManager.clone.test.jsx src/components/ShiftTemplateManager.list.test.jsx src/components/ShiftTemplateManager.a11y.test.jsx src/components/schedule-managers.errors.test.jsx src/components/schedule/CopyTemplatesModal.test.jsx`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/ShiftTemplateManager.jsx src/components/ShiftTemplateManager.clone.test.jsx
git commit -m "TPLCLONE.1 — template manager offers Copy from another studio where the route allows it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: PR and changelog

- [ ] **Step 1: Push and open the PR** (after the gate below is green)

```bash
git push -u origin HEAD
gh pr create --base main --title "TPLCLONE.1 — copy shift templates from another studio in the same organisation" --body-file /private/tmp/claude-501/<scratchpad>/tplclone-pr-body.md
```

PR body points (write them into the body file; end it with the attribution line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`):
- What: `POST /api/schedule/templates/clone` + a "Copy from another studio" action on `/settings/shifts` (header and empty state), with a dry-run preview (created / skipped with reasons, per-template ticks) and a notice with counts.
- Who: a manager role (owner, manager, head coach) at BOTH studios, or a master. Same organisation only, a master included: `locations.organization_id` is read for both and must be present and equal. Refusals are 403 (body-param convention); a vanished studio 404.
- What is copied: name, times, colour, role label, weekdays, min and max coaches, through one allow-list constant (`TEMPLATE_CLONE_COLUMNS`). New rows are active and ordered after the target's existing ones. **SHIFTTYPE.1 adds `kind` in one line there**, and `tests/shift-template-clone.guards.test.js` fails until any new `shift_templates` column is classified.
- Skips: a name already at the target (any case, active or not), a same-name duplicate in the source, an inactive template asked for by id, an id that is not the source's (answered with no name). One `upsert … ON CONFLICT (location_id, name) DO NOTHING`: all or nothing, and a race comes back as a skip.
- Side effect, said in the preview: copied weekday templates get 8 weeks of empty shifts at once (as a hand-made template does), and the target's roster runway alerts start counting them (`fetchRosterRunways` skips a studio with no weekday template until then). A failed fill keeps the copy, answers a `warning`, and the nightly horizon run fills it.
- Scoping: every DB call is in the route file; each `shift_templates` chain carries its studio in the chain (pinned by a test stricter than `check:location-scoping`).
- **No migration** (the unique key is mig 010's, verified live). **No OTA**: nothing under `mobile/` or `shared/`.
- Not done on purpose: no copy from a studio in another organisation, no "copy without weekdays" option (see review notes), no copy of blocks or assignments.

- [ ] **Step 2: Changelog row**

Add ONE new row directly under the `| # / PR | Item | Notes |` / `|---|------|-------|` header rows of `docs/CHANGELOG.md`, keyed by the PR number `gh` printed. Never edit a pushed row (`merge=union` duplicates it).

```
| #<PR> | TPLCLONE.1 — copy shift templates from another studio in the same organisation | 2026-09-25. No migration; nothing under `mobile/` or `shared/`, so **no OTA**. New `POST /api/schedule/templates/clone` { from_location_id, to_location_id, template_ids?, dry_run? } and a "Copy from another studio" action on `/settings/shifts` (header + empty state) with a dry-run preview, per-template ticks and a count notice. Caller needs MANAGER_ROLES at BOTH studios (master passes); the studios' `organization_id`s must be present and equal, so a master cannot copy across organisations (403). Copies name, times, colour, role label, weekdays, min/max through `TEMPLATE_CLONE_COLUMNS` (`src/lib/shift-template-clone.js`), active, ordered after the target's; skips `name_exists` (case-insensitive, active or not), `duplicate_in_source`, `inactive` (by id only), `not_found` (no name leaked). One `upsert ON CONFLICT (location_id,name) DO NOTHING` on mig 010's unique key, so a race is a skip. Copied weekday templates get 8 weeks of blocks at once (a failed fill keeps the copy, `warning`, nightly horizon catches up) and switch the target's roster runway alerts on. `tests/shift-template-clone.guards.test.js`: every `shift_templates` column must be copied or managed (SHIFTTYPE.1's `kind` = one line), and every template chain in the route names its studio. Hatch Street had 0 templates; Stillorgan 19 active. |
```

```bash
git add docs/CHANGELOG.md
git commit -m "TPLCLONE.1 — changelog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### PR gate

Focused tests while iterating:

```bash
npx vitest run src/lib/shift-template-clone.test.js tests/shift-template-clone.guards.test.js \
  src/app/api/schedule/templates/clone/route.test.js src/app/api/schedule/templates/route.test.js \
  src/lib/openapi.test.js \
  src/components/schedule/CopyTemplatesModal.test.jsx src/components/ShiftTemplateManager.clone.test.jsx \
  src/components/ShiftTemplateManager.list.test.jsx src/components/ShiftTemplateManager.a11y.test.jsx \
  src/components/schedule-managers.errors.test.jsx \
  tests/location-scoping-check.test.js tests/select-columns-check.test.js
```

Then the full CI mirror, once, immediately before pushing (all twelve):

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
```

Expected:
- `check:location-scoping`: green, one more route than the `2f0b35ba` baseline (817), no new EXEMPT entry.
- `check:select-columns`: green with no allowlist entry. A red here is a wrong column name; fix the name, never allowlist.
- `check:route-guards`: green (`getCurrentUser` present).
- `check:guardrails`: green (every supabase result destructures `error`; the chip and tokens are the approved recipes).
- `check:mobile-parity`: unchanged (no new `WEB_PERMISSIONS` key). `check:ota-paths`: unchanged (no path under `mobile/` or `shared/`).

Then, once: `npm run build` (new route, new component, new lib import from a client component).

Manual check on the Vercel PREVIEW (local dev has no database; the preview runs on PROD data, so **dry run only**): as a master or a manager of both studios, switch the active studio to UN1T Hatch Street, open `/settings/shifts`, click "Copy from another studio", choose UN1T Stillorgan, and confirm the preview lists 19 templates to create and the weekday warning names the 11 with weekdays. Press **Cancel**. Then switch the active studio to a studio of another organisation (CCF Autos) and confirm the action is not offered. The real copy into Hatch Street is an operator decision for Richard after merge, not part of the check.

---

### Review notes / open questions

1. **Richard's call: copy weekdays, or copy as one-offs?** Copying Stillorgan's 11 weekday templates into Hatch Street puts Stillorgan's weekly pattern on Hatch Street's calendar as empty slots for 8 weeks (at once, and nightly after that via `extend-roster-horizon`), and switches Hatch Street's roster runway chip and daily push on (`src/lib/roster-runway-data.js:23-27`). The plan copies weekdays because a template's weekdays are what make it a template, a hand-made one does the same, and the nightly cron would generate the blocks anyway. The preview says so plainly and lets the manager untick templates. If Richard would rather copy the shapes without the weekly pattern, it is a `copy_weekdays: false` option that sets `days_of_week: []` in `planTemplateClone` and one checkbox; not built.
2. **Head coaches can copy.** "Manager" here is `MANAGER_ROLES` (includes `head_coach`) because that is exactly the set allowed to create and edit templates today (`templates/route.js:58-72`, `[id]/route.js:62-100`). Narrowing the copy alone would make it stricter than typing the same templates in by hand. One constant if he wants otherwise.
3. **Cross-organisation is 403, not 404.** The convention is 404 on DETAIL routes (location from a fetched row) and 403 for a body-param studio (`assertLocationAccess`). The cross-organisation refusal is only reachable by someone who is already a member of both studios, so there is nothing to enumerate. Reachable today by a master (every active location) and by anyone with memberships in two organisations.
4. **An explicitly named inactive template is skipped, not copied.** The brief said "inactive excluded by default"; the plan does not add an "include inactive" path because the UI only ever lists active ones. Easy to change in `planTemplateClone` if wanted.
5. **Name matching is stricter in the app than in the DB.** The app treats `Early` and ` early` as the same name; the DB unique key is exact. A concurrent request adding a case-variant between the preview read and the insert could leave both; accepted (two managers copying into the same studio in the same second).
6. **Numbers differ from the index.** Stillorgan has 19 active templates (not 18), 3 inactive, 11 active with weekdays; every template's `display_order` on the estate is 0 today, so "source order" is effectively start time then name. Hatch Street's id is `28c78d6b-f7b3-4edf-8c7c-840bd047b3f4`; the id in the commissioning brief had a wrong last two segments.
7. **A master at Hatch Street will be offered three sources**: UN1T Stillorgan, Test Studio (1 template) and "Pride Training Club (host events)" (0 templates), all in organisation `f117b7b8-…`. That is why the dialog asks first when there is more than one source rather than preselecting.
8. **No migration.** `UNIQUE (location_id, name)` is `shift_templates_location_id_name_key` (mig 010:27, verified live 25 Sep), which is what `onConflict: 'location_id,name'` needs.
9. **Block generation runs in the request**: up to ~11 templates × 3 queries, sequential, as the single-template create does. Fine at this size; if a studio ever copied hundreds, move it to the nightly cron by skipping it here.
10. **Pre-existing bug seen, not fixed here (out of scope):** `ShiftTemplateManager.setTemplateActive` (lines 173-175) calls `failWith(…, data.warning)` BEFORE `await fetchTemplates()`, and `fetchTemplates` starts with `setError(null)` (line 101), so a deactivate/reactivate `warning` is wiped before it renders. The new `handleCopied` does it in the safe order and says why. Worth a one-line follow-up PR.
11. **For SHIFTTYPE.1 (PR 13):** add `'kind'` to `TEMPLATE_CLONE_COLUMNS` in `src/lib/shift-template-clone.js` (one line). `tests/shift-template-clone.guards.test.js` will fail on PR 13's migration until it does, so it cannot be forgotten. If PR 13 wants a copied template's kind to be anything other than the source's, it goes on `TEMPLATE_CLONE_MANAGED_COLUMNS` instead and `planTemplateClone` sets it.
