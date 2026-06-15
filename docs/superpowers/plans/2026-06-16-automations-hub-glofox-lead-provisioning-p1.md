# Automations Hub + Glofox lead-provisioning — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a curated `/automations` hub and its first automation — when a new lead is created, create their Glofox account and attach the studio trial — on a per-location toggle, off by default.

**Architecture:** Registry pattern (mirrors `src/lib/approvals/registry.js`). Config in a new `location_automations` table. A pure qualifier + a fire-and-forget hook (`maybeProvisionLeadInGlofox`) replace the existing link-only `findOrCreateGlofoxMember` calls at the three lead-creation sites; when the automation is enabled the call flips to `createIfMissing:true, attachTrial:true`. Failures reuse the existing `glofox_push_events` Review queue. A new sidebar section + `automations` permission gate the hub.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role routes), Vitest, Tailwind (`un1t-*` tokens), lucide-react.

**Spec:** `docs/superpowers/specs/2026-06-16-automations-hub-glofox-lead-provisioning-design.md`. Phase 2 (the "push existing un-linked leads" backfill button) is a **separate plan/PR** after this lands.

**Branch:** `feat/automations-hub` (already created off `main`; the spec commit is the first commit on it).

---

### Task 1: Migration — `location_automations` table

**Files:**
- Create: `supabase/migrations/NNN_location_automations.sql` (NNN = next number; check `ls supabase/migrations | sort | tail -1` — currently 275, so **276**).

- [ ] **Step 1: Write the migration SQL**

```sql
-- 276_location_automations.sql — AUTOMATIONS hub config.
-- One row per (location, automation_key). Absent row = disabled
-- (opt-in; never silently auto-enabled). config jsonb future-proofs
-- per-automation options. Staff-in-location read; writes are
-- service-role only (the PUT /api/automations/[key] route).
create table public.location_automations (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  automation_key text not null,
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id),
  unique (location_id, automation_key)
);
create index idx_location_automations_loc on public.location_automations(location_id);

alter table public.location_automations enable row level security;

create policy location_automations_loc on public.location_automations for all to authenticated
  using (private.auth_is_in_location(location_id))
  with check (private.auth_is_in_location(location_id));
```

- [ ] **Step 2: Apply via Supabase MCP**

Apply with `apply_migration` (name `276_location_automations`). Then run `get_advisors` (type=security) and confirm **no new** findings reference `location_automations` (RLS is enabled + policy present, so it should be clean).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/276_location_automations.sql
git commit -m "feat(automations): mig 276 location_automations config table"
```

---

### Task 2: `automations` web permission + parity allowance

**Files:**
- Modify: `shared/permissions.js` (add to `WEB_PERMISSIONS` + each role block in `DEFAULT_WEB_PERMISSIONS_BY_ROLE`)
- Modify: `scripts/check-mobile-parity.mjs` (`WEB_ONLY_OK`)

- [ ] **Step 1: Add the permission entry**

In `shared/permissions.js`, add to the `WEB_PERMISSIONS` array (near the other `*_inbox`/admin keys):

```js
  { key: 'automations', label: 'Automations', hint: 'Operational-automation hub at /automations — toggle per-location automations like auto-creating new leads in Glofox. Master + owner + manager by default.' },
```

- [ ] **Step 2: Add the per-role defaults**

In `DEFAULT_WEB_PERMISSIONS_BY_ROLE`, add `automations:` to each role block, matching the pattern used by `approvals_inbox`:
- master block: `automations: true,`
- owner block: `automations: true,`
- manager block: `automations: true,`
- head_coach block: `automations: false,`
- staff block: `automations: false,`

- [ ] **Step 3: Allow it as web-only in the parity linter**

In `scripts/check-mobile-parity.mjs`, add to the `WEB_ONLY_OK` map:

```js
  automations: 'operational-automation admin hub; web/operator surface, no mobile counterpart',
```

- [ ] **Step 4: Run the parity check (expect PASS)**

Run: `npm run check:mobile-parity`
Expected: exits 0 (the new key is covered by `WEB_ONLY_OK`).

- [ ] **Step 5: Run the permissions tests (expect PASS)**

Run: `npx vitest run shared/permissions.test.js` (if present) — otherwise `npx vitest run` and confirm no permissions-contract test breaks.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/permissions.js scripts/check-mobile-parity.mjs
git commit -m "feat(automations): add automations web permission (web-only)"
```

---

### Task 3: Registry + pure `glofoxConnected` helper

**Files:**
- Create: `src/lib/automations/registry.js`
- Create: `src/lib/automations/registry.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/automations/registry.test.js
import { describe, it, expect } from 'vitest'
import { AUTOMATIONS, getAutomation, glofoxConnected, automationStatus } from './registry.js'

const connected = { settings: { glofox: { branch_id: 'b', api_key: 'k', api_token: 't', trial_membership_id: 'm', trial_plan_code: 'p' } } }
const noTrial   = { settings: { glofox: { branch_id: 'b', api_key: 'k', api_token: 't' } } }
const notConn   = { settings: { glofox: { branch_id: 'your-glofox-branch-id' } } }

describe('automations registry', () => {
  it('registers the glofox_lead_provisioning automation', () => {
    expect(AUTOMATIONS.map((a) => a.key)).toContain('glofox_lead_provisioning')
    expect(getAutomation('glofox_lead_provisioning').label).toBeTruthy()
    expect(getAutomation('nope')).toBeNull()
  })

  it('glofoxConnected requires branch_id + api_key + api_token', () => {
    expect(glofoxConnected(connected)).toBe(true)
    expect(glofoxConnected(noTrial)).toBe(true)   // connected but no trial
    expect(glofoxConnected(notConn)).toBe(false)  // placeholder branch, no key/token
    expect(glofoxConnected(null)).toBe(false)
    expect(glofoxConnected({})).toBe(false)
  })

  it('automationStatus reports connection + trial config', () => {
    expect(automationStatus('glofox_lead_provisioning', connected))
      .toEqual({ available: true, trialConfigured: true })
    expect(automationStatus('glofox_lead_provisioning', noTrial))
      .toEqual({ available: true, trialConfigured: false })
    expect(automationStatus('glofox_lead_provisioning', notConn))
      .toEqual({ available: false, trialConfigured: false })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/automations/registry.test.js`
Expected: FAIL (`Cannot find module './registry.js'`).

- [ ] **Step 3: Write the registry**

```js
// src/lib/automations/registry.js
//
// AUTOMATIONS hub registry — mirrors src/lib/approvals/registry.js.
// To add an automation later: add a definition here + (if it acts on
// data) a hook the relevant code path calls. The hub page renders a
// card per definition automatically.
//
// Definition contract:
//   key:          stable id, used in URLs + the location_automations row
//   label:        operator-facing card title
//   description:  one line under the title
//   supportsBackfill: boolean — does the card show a "push existing" button (Phase 2)
//   reviewBase:   path operators jump to for failures (existing Glofox review)

export const AUTOMATIONS = Object.freeze([
  {
    key: 'glofox_lead_provisioning',
    label: 'Auto-create leads in Glofox',
    description: 'When a new lead is created, create their Glofox account and attach the studio trial membership.',
    supportsBackfill: true,
    reviewBase: '/approvals',
  },
])

export function getAutomation(key) {
  return AUTOMATIONS.find((a) => a.key === key) || null
}

/**
 * Pure: is Glofox actually connected at this location? Reads the
 * location row's settings.glofox (no DB). Mirrors the three-header
 * v3 requirement (branch_id + api_key + api_token).
 */
export function glofoxConnected(location) {
  const g = location?.settings?.glofox
  if (!g) return false
  return Boolean(g.branch_id && g.api_key && g.api_token)
}

/**
 * Pure status summary for a card. Currently glofox-specific (the only
 * automation); when a second automation arrives, branch on key.
 * @returns {{ available: boolean, trialConfigured: boolean }}
 */
export function automationStatus(key, location) {
  if (key !== 'glofox_lead_provisioning') return { available: false, trialConfigured: false }
  const g = location?.settings?.glofox || {}
  const available = glofoxConnected(location)
  const trialConfigured = Boolean(g.trial_membership_id && g.trial_plan_code)
  return { available, trialConfigured }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/automations/registry.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/automations/registry.js src/lib/automations/registry.test.js
git commit -m "feat(automations): registry + glofoxConnected/automationStatus helpers"
```

---

### Task 4: Qualifier + provisioning hook

**Files:**
- Create: `src/lib/automations/glofox-lead-provisioning.js`
- Create: `src/lib/automations/glofox-lead-provisioning.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/automations/glofox-lead-provisioning.test.js
import { describe, it, expect, vi } from 'vitest'
import { qualifiesForGlofoxProvisioning, maybeProvisionLeadInGlofox } from './glofox-lead-provisioning.js'

describe('qualifiesForGlofoxProvisioning', () => {
  it('true for a fresh emailed lead not yet in Glofox', () => {
    expect(qualifiesForGlofoxProvisioning({ email: 'a@b.com', glofox_member_id: null, source: 'manual' })).toBe(true)
  })
  it('false when already linked to a Glofox member', () => {
    expect(qualifiesForGlofoxProvisioning({ email: 'a@b.com', glofox_member_id: 'gm_1' })).toBe(false)
  })
  it('false with no email', () => {
    expect(qualifiesForGlofoxProvisioning({ email: null, glofox_member_id: null })).toBe(false)
  })
  it('false for ClassPass shadow contacts', () => {
    expect(qualifiesForGlofoxProvisioning({ email: 'a@b.com', source: 'classpass' })).toBe(false)
  })
  it('false for null/garbage input', () => {
    expect(qualifiesForGlofoxProvisioning(null)).toBe(false)
  })
})

describe('maybeProvisionLeadInGlofox', () => {
  // Minimal db stub: location_automations lookup returns `enabledRow`.
  function makeDb(enabledRow) {
    return {
      from(table) {
        if (table !== 'location_automations') throw new Error(`unexpected table ${table}`)
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: enabledRow }) }) }) }),
        }
      },
    }
  }

  it('calls findOrCreateGlofoxMember in CREATE+TRIAL mode when enabled and eligible', async () => {
    const spy = vi.fn(async () => ({ status: 'created' }))
    const db = makeDb({ enabled: true })
    await maybeProvisionLeadInGlofox({
      db, locationId: 'loc1', source: 'manual',
      contact: { id: 'c1', email: 'a@b.com', glofox_member_id: null, location_id: 'loc1' },
      _findOrCreateGlofoxMember: spy,
    })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toMatchObject({ createIfMissing: true, attachTrial: true })
  })

  it('falls back to LINK-ONLY (createIfMissing:false) when the automation is disabled', async () => {
    const spy = vi.fn(async () => ({ status: 'linked' }))
    const db = makeDb({ enabled: false })
    await maybeProvisionLeadInGlofox({
      db, locationId: 'loc1', source: 'manual',
      contact: { id: 'c1', email: 'a@b.com', glofox_member_id: null, location_id: 'loc1' },
      _findOrCreateGlofoxMember: spy,
    })
    expect(spy.mock.calls[0][0]).toMatchObject({ createIfMissing: false, attachTrial: false })
  })

  it('falls back to LINK-ONLY when enabled but the lead is ineligible (already linked)', async () => {
    const spy = vi.fn(async () => ({}))
    const db = makeDb({ enabled: true })
    await maybeProvisionLeadInGlofox({
      db, locationId: 'loc1', source: 'manual',
      contact: { id: 'c1', email: 'a@b.com', glofox_member_id: 'gm_1', location_id: 'loc1' },
      _findOrCreateGlofoxMember: spy,
    })
    expect(spy.mock.calls[0][0]).toMatchObject({ createIfMissing: false, attachTrial: false })
  })

  it('never throws when the helper throws', async () => {
    const spy = vi.fn(async () => { throw new Error('glofox down') })
    const db = makeDb({ enabled: true })
    await expect(maybeProvisionLeadInGlofox({
      db, locationId: 'loc1', source: 'manual',
      contact: { id: 'c1', email: 'a@b.com', glofox_member_id: null, location_id: 'loc1' },
      _findOrCreateGlofoxMember: spy,
    })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/automations/glofox-lead-provisioning.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```js
// src/lib/automations/glofox-lead-provisioning.js
//
// The "auto-create new leads in Glofox + attach trial" automation.
// qualifiesForGlofoxProvisioning is pure; maybeProvisionLeadInGlofox
// is the fire-and-forget hook the three lead-creation sites call in
// place of their old inline findOrCreateGlofoxMember dup-check.
//
// When the automation is OFF (or the lead is ineligible) behaviour is
// byte-identical to today: a link-only dup-check (createIfMissing:false).
// When ON + eligible: create-and-trial.

import { logWarn } from '@/lib/log'

const AUTOMATION_KEY = 'glofox_lead_provisioning'

/**
 * Pure eligibility check for a single contact row.
 * Excludes: already-linked, no-email, ClassPass shadows.
 * (Bulk-import + Glofox-sync paths are excluded by NOT calling the
 * hook at all — see the wiring task.)
 */
export function qualifiesForGlofoxProvisioning(contact) {
  if (!contact) return false
  if (contact.glofox_member_id) return false
  if (!contact.email) return false
  if (contact.source === 'classpass') return false
  return true
}

/**
 * Fire-and-forget. Never throws. Reads the per-location toggle, then
 * calls findOrCreateGlofoxMember in the right mode.
 *
 * @param {object}  args
 * @param {object}  args.db          service-role client
 * @param {string}  args.locationId
 * @param {object}  args.contact     the just-created contact row (needs id,email,glofox_member_id,location_id; name/first/last help)
 * @param {string}  args.source      label for glofox_push_events (e.g. 'manual','website_lead','assistant')
 * @param {Function} [args._findOrCreateGlofoxMember]  test seam
 */
export async function maybeProvisionLeadInGlofox({ db, locationId, contact, source, _findOrCreateGlofoxMember }) {
  try {
    if (!db || !locationId || !contact) return

    const findOrCreate = _findOrCreateGlofoxMember
      || (await import('@/lib/glofox-push')).findOrCreateGlofoxMember

    // Read the per-location toggle. Absent row = disabled.
    let enabled = false
    try {
      const { data } = await db
        .from('location_automations')
        .select('enabled')
        .eq('location_id', locationId)
        .eq('automation_key', AUTOMATION_KEY)
        .maybeSingle()
      enabled = Boolean(data?.enabled)
    } catch (e) {
      logWarn('automations.glofox-lead', 'toggle read failed; treating as disabled', { err: e })
      enabled = false
    }

    const create = enabled && qualifiesForGlofoxProvisioning(contact)

    await findOrCreate({
      db,
      locationId,
      contact,
      source: source || 'lead',
      createIfMissing: create,
      attachTrial: create,
    })
  } catch (e) {
    logWarn('automations.glofox-lead', 'provisioning hook failed', { err: e })
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/automations/glofox-lead-provisioning.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/automations/glofox-lead-provisioning.js src/lib/automations/glofox-lead-provisioning.test.js
git commit -m "feat(automations): qualifier + maybeProvisionLeadInGlofox hook"
```

---

### Task 5: Wire the hook into the three lead-creation sites

**Files:**
- Modify: `src/app/api/contacts/route.js` (the GLOFOX3.1 dup_check block, ~lines 86–99)
- Modify: `src/app/api/public/leads/route.js` (after `contactId` resolved, ~line 54)
- Modify: `src/app/api/assistant/chat/route.js` (`create_contact` case, after the insert ~line 99)

- [ ] **Step 1: Replace the dup-check call in `/api/contacts`**

Find the existing block (GLOFOX3.1) that calls `findOrCreateGlofoxMember({ ... createIfMissing: false, attachTrial: false ... }).catch(...)` and replace it with the hook. `data` is the just-inserted contact row.

```js
  // AUTOMATIONS: glofox_lead_provisioning. Link-only dup-check today;
  // create-and-trial when the per-location automation is enabled.
  if (data.location_id && data.email && !data.glofox_member_id) {
    const { maybeProvisionLeadInGlofox } = await import('@/lib/automations/glofox-lead-provisioning')
    maybeProvisionLeadInGlofox({ db, locationId: data.location_id, contact: data, source: 'manual' })
      .catch(() => {}) // hook never throws, but belt-and-braces
  }
```

Remove the now-replaced `import { findOrCreateGlofoxMember } from '@/lib/glofox-push'` line at the top **only if** nothing else in the file uses it (grep first: `grep -n findOrCreateGlofoxMember src/app/api/contacts/route.js`). If still used elsewhere, leave the import.

- [ ] **Step 2: Add the hook to `/api/public/leads`**

After the `contactId` is resolved (the `if (!contactId) return ...` guard) and the contact row exists, fetch the row and fire the hook. Insert right after the consent/tag best-effort blocks, before the `return`:

```js
  // AUTOMATIONS: glofox_lead_provisioning (website lead path).
  try {
    const { data: contactRow } = await db
      .from('contacts')
      .select('id, name, email, first_name, last_name, phone, source, glofox_member_id, location_id')
      .eq('id', contactId)
      .maybeSingle()
    if (contactRow) {
      const { maybeProvisionLeadInGlofox } = await import('@/lib/automations/glofox-lead-provisioning')
      await maybeProvisionLeadInGlofox({ db, locationId, contact: contactRow, source: 'website_lead' })
    }
  } catch (e) { logWarn('leads', 'glofox provisioning hook failed', { err: e }) }
```

(`logWarn` is already imported in this file.)

- [ ] **Step 3: Add the hook to the assistant `create_contact` tool**

In `src/app/api/assistant/chat/route.js`, in the `create_contact` case, after the successful insert (`if (error) return { error: error.message }`) and before `return { success: true, ... }`, the inserted row is `data`. Add:

```js
      // AUTOMATIONS: glofox_lead_provisioning (assistant-created lead).
      try {
        const { maybeProvisionLeadInGlofox } = await import('@/lib/automations/glofox-lead-provisioning')
        await maybeProvisionLeadInGlofox({ db, locationId, contact: data, source: 'assistant' })
      } catch { /* hook never throws */ }
```

(The insert's `.select().single()` returns the full row as `data`, which includes `email`, `glofox_member_id` (null on insert), `location_id`, `source`.)

- [ ] **Step 4: Run the affected route + lib tests**

Run: `npx vitest run src/lib/automations/ src/app/api/contacts src/app/api/public/leads`
Expected: PASS (existing tests still green; no behaviour change while the toggle is off).

- [ ] **Step 5: Build to catch import resolution**

Run: `npm run build`
Expected: build completes (the dynamic import path `@/lib/automations/glofox-lead-provisioning` resolves).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/contacts/route.js src/app/api/public/leads/route.js src/app/api/assistant/chat/route.js
git commit -m "feat(automations): wire glofox lead-provisioning hook into the 3 lead-create paths"
```

---

### Task 6: `PUT /api/automations/[key]` toggle route

**Files:**
- Create: `src/app/api/automations/[key]/route.js`
- Create: `src/app/api/automations/[key]/route.test.js`
- Modify: `src/lib/openapi.js` (register the route)

- [ ] **Step 1: Write the failing test**

```js
// src/app/api/automations/[key]/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { PUT } from './route.js'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

function req(body) {
  return { json: async () => body }
}

beforeEach(() => {
  vi.clearAllMocks()
  assertLocationAccess.mockReturnValue(null)
})

describe('PUT /api/automations/[key]', () => {
  it('403 when not a manager+', async () => {
    getCurrentUser.mockResolvedValue({ role: 'staff', id: 'u1' })
    const res = await PUT(req({ location_id: 'loc1', enabled: true }), { params: Promise.resolve({ key: 'glofox_lead_provisioning' }) })
    expect(res.status).toBe(403)
  })

  it('400 on an unknown automation key', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1' })
    const res = await PUT(req({ location_id: 'loc1', enabled: true }), { params: Promise.resolve({ key: 'nope' }) })
    expect(res.status).toBe(400)
  })

  it('upserts the toggle and returns success', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1' })
    const upsert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { location_id: 'loc1', automation_key: 'glofox_lead_provisioning', enabled: true }, error: null }) }) }))
    createServerClient.mockReturnValue({ from: () => ({ upsert }) })
    const res = await PUT(req({ location_id: 'loc1', enabled: true }), { params: Promise.resolve({ key: 'glofox_lead_provisioning' }) })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(upsert).toHaveBeenCalled()
    expect(upsert.mock.calls[0][0]).toMatchObject({ location_id: 'loc1', automation_key: 'glofox_lead_provisioning', enabled: true })
  })

  it('honours the location guard (403 from assertLocationAccess)', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1' })
    const { NextResponse } = await import('next/server')
    assertLocationAccess.mockReturnValue(NextResponse.json({ success: false }, { status: 403 }))
    const res = await PUT(req({ location_id: 'other', enabled: true }), { params: Promise.resolve({ key: 'glofox_lead_provisioning' }) })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run "src/app/api/automations/[key]/route.test.js"`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the route**

```js
// PUT /api/automations/[key] — toggle/configure a per-location automation.
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { getAutomation } from '@/lib/automations/registry'

export const runtime = 'nodejs'

const Schema = z.object({
  location_id: uuidLike,
  enabled: z.boolean(),
  config: z.record(z.any()).optional(),
})

export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { key } = await params
  if (!getAutomation(key)) {
    return NextResponse.json({ success: false, error: 'unknown_automation' }, { status: 400 })
  }

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db
    .from('location_automations')
    .upsert({
      location_id: body.location_id,
      automation_key: key,
      enabled: body.enabled,
      config: body.config || {},
      updated_at: new Date().toISOString(),
      updated_by: user.id,
    }, { onConflict: 'location_id,automation_key' })
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run "src/app/api/automations/[key]/route.test.js"`
Expected: PASS (4 tests).

- [ ] **Step 5: Register in openapi**

In `src/lib/openapi.js`, add a registry entry for `PUT /api/automations/{key}` following the nearest existing `registry.registerPath({...})` example in that file (method `put`, path `/api/automations/{key}`, a short summary, the `Schema` body, standard `{success,data}` response). Match the surrounding style exactly.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/automations/[key]/route.js" "src/app/api/automations/[key]/route.test.js" src/lib/openapi.js
git commit -m "feat(automations): PUT /api/automations/[key] toggle route"
```

---

### Task 7: Hub page + card + nav entry

**Files:**
- Create: `src/app/automations/page.js` (server)
- Create: `src/components/automations/AutomationsView.jsx` (client)
- Modify: `src/lib/nav-items.js` (new section + entry + icon import)

- [ ] **Step 1: Add the nav section + entry**

In `src/lib/nav-items.js`:
1. Add `Workflow` to the lucide-react import line at the top (e.g. `import { ..., Workflow } from 'lucide-react'`).
2. Add the nav item to the items array (place it with the other top-level entries):

```js
  { href: '/automations', label: 'Automations', icon: Workflow, permission: 'automations', section: 'automations' },
```

3. Add the section to `NAV_SECTIONS` (after `gym`, before `studio` reads well; it groups with the operational areas):

```js
  { id: 'automations', label: 'Automations' },
```

- [ ] **Step 2: Verify the nav contract test still passes**

Run: `npx vitest run src/lib/nav-items.test.js`
Expected: PASS (if the test enumerates sections, it tolerates the new one; if it asserts an exact section list, update that assertion to include `'automations'` — show the diff in the commit).

- [ ] **Step 3: Write the server page**

```js
// src/app/automations/page.js — Automations hub.
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { AUTOMATIONS, automationStatus } from '@/lib/automations/registry'
import AutomationsView from '@/components/automations/AutomationsView'

export const dynamic = 'force-dynamic'

export default async function AutomationsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'automations')) redirect('/dashboard')

  const location = user.activeLocation
  const db = createServerClient()

  // Current toggle state for this location.
  const { data: rows } = await db
    .from('location_automations')
    .select('automation_key, enabled')
    .eq('location_id', location?.id || '00000000-0000-0000-0000-000000000000')
  const enabledByKey = Object.fromEntries((rows || []).map((r) => [r.automation_key, r.enabled]))

  const cards = AUTOMATIONS.map((a) => ({
    key: a.key,
    label: a.label,
    description: a.description,
    supportsBackfill: a.supportsBackfill,
    reviewBase: a.reviewBase,
    enabled: Boolean(enabledByKey[a.key]),
    status: automationStatus(a.key, location),
  }))

  return (
    <AutomationsView
      locationId={location?.id || null}
      locationName={location?.name || ''}
      cards={cards}
    />
  )
}
```

- [ ] **Step 4: Write the client view**

```jsx
// src/components/automations/AutomationsView.jsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2, Zap, AlertCircle, ExternalLink } from 'lucide-react'

export default function AutomationsView({ locationId, locationName, cards }) {
  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-un1t-white">Automations</h1>
        <p className="text-sm text-un1t-light">
          Things that run automatically for {locationName || 'this location'}. Each one is off until you turn it on.
        </p>
      </div>

      {cards.map((card) => (
        <AutomationCard key={card.key} card={card} locationId={locationId} />
      ))}

      <div className="text-xs text-un1t-light border-t border-un1t-gray pt-3">
        See also:{' '}
        <Link href="/communications/sequences" className="underline">Sequences</Link> (message automations) ·{' '}
        <Link href="/settings/customer-agent" className="underline">Mia agent</Link>
      </div>
    </div>
  )
}

function AutomationCard({ card, locationId }) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(card.enabled)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const disabled = busy || !card.status.available || !locationId

  async function toggle() {
    const next = !enabled
    setBusy(true); setError(null)
    setEnabled(next) // optimistic
    try {
      const res = await fetch(`/api/automations/${card.key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, enabled: next }),
      })
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.message || j.error || 'Save failed')
      router.refresh()
    } catch (e) {
      setEnabled(!next) // revert
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Zap size={16} className="text-un1t-light" />
            <h2 className="font-semibold text-un1t-white">{card.label}</h2>
          </div>
          <p className="text-sm text-un1t-light mt-1">{card.description}</p>
        </div>
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          aria-pressed={enabled}
          className={`shrink-0 inline-flex h-6 w-11 items-center rounded-full transition ${enabled ? 'bg-emerald-500' : 'bg-un1t-gray'} disabled:opacity-40`}
        >
          <span className={`h-5 w-5 rounded-full bg-white transition ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
      </div>

      <div className="mt-3 text-xs">
        {!card.status.available && (
          <p className="text-amber-700">Glofox isn’t connected at this location — connect it in Settings → Locations → Glofox Integration to use this.</p>
        )}
        {card.status.available && !card.status.trialConfigured && (
          <p className="text-amber-700 inline-flex items-center gap-1">
            <AlertCircle size={12} /> No trial membership set — accounts will be created without a trial.{' '}
            <Link href="/settings" className="underline">Set it</Link>
          </p>
        )}
        {card.status.available && card.status.trialConfigured && (
          <p className="text-emerald-700">Glofox connected · trial configured ✓</p>
        )}
      </div>

      {busy && <p className="mt-2 text-[11px] text-un1t-light inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Saving…</p>}
      {error && <p className="mt-2 text-[11px] text-red-700">{error}</p>}

      <div className="mt-3 border-t border-un1t-gray/60 pt-2">
        <Link href={card.reviewBase} className="text-[11px] text-un1t-light underline inline-flex items-center gap-1">
          Recent failures <ExternalLink size={11} />
        </Link>
        {/* Phase 2: "Push existing un-linked leads" button renders here when card.supportsBackfill */}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: build completes; `/automations` appears in the route list.

- [ ] **Step 6: Commit**

```bash
git add "src/app/automations/page.js" src/components/automations/AutomationsView.jsx src/lib/nav-items.js
git commit -m "feat(automations): /automations hub page + card + sidebar entry"
```

---

### Task 8: Full CI mirror + ship

- [ ] **Step 1: Run the full local CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run build
```
Expected: all pass. (`check:route-guards` must still pass — the new route has `getCurrentUser` so it's session-guarded.)

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin feat/automations-hub
gh pr create --title "feat: Automations hub + Glofox lead-provisioning (Phase 1)" --body "<summary: hub at /automations, glofox_lead_provisioning automation off-by-default, mig 276, reuses findOrCreateGlofoxMember + glofox_push_events. Phase 2 = backfill button. Spec + plan in docs/superpowers.>"
```

- [ ] **Step 3: Watch CI + merge on green**

```bash
gh pr checks <PR#> --watch --interval 20
gh pr merge <PR#> --squash --delete-branch
```

- [ ] **Step 4: Post-merge sanity**

After merge, confirm `gh run list --branch main --limit 1` shows Web CI success on the merge commit. The automation is **off by default** — enabling it for Stillorgan is an operator action in the new hub.

---

## Self-Review

**1. Spec coverage:**
- Curated hub (registry) → Task 3 + Task 7. ✓
- Trigger on lead creation across 3 paths → Task 5 (contacts, public/leads, assistant). ✓
- Exclusions (sync/import excluded by no-hook; classpass/already-linked/no-email in qualifier) → Task 4. ✓
- Reuse findOrCreateGlofoxMember + glofox_push_events failures → Task 4 (hook) + Task 7 (review link). ✓
- location_automations table → Task 1. ✓
- automations permission + nav section → Task 2 + Task 7. ✓
- Off by default → table default `enabled false` (Task 1) + page reads absent=false (Task 7). ✓
- Phase 2 backfill → explicitly deferred; card leaves a placeholder comment. ✓

**2. Placeholder scan:** `NNN` migration number is resolved in Task 1 Step 1 (276). The openapi registration (Task 6 Step 5) says "follow the nearest existing registerPath" rather than reproducing code — acceptable because openapi.js entries are mechanical and the file's own examples are the spec; the engineer copies the adjacent pattern. No other TBDs.

**3. Type consistency:** `automation_key` / `enabled` / `config` column names match across mig (Task 1), hook query (Task 4), route upsert (Task 6), page read (Task 7). `glofox_lead_provisioning` key string identical in registry, hook (`AUTOMATION_KEY`), tests. `maybeProvisionLeadInGlofox({ db, locationId, contact, source })` signature identical at definition (Task 4) and all three call sites (Task 5). `automationStatus` returns `{available, trialConfigured}` consumed verbatim by the card (Task 7).
