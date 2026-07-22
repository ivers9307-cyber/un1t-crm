# Per-funnel Trial Product Override — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `class_funnel` landing-page block pick which Glofox trial membership/plan it grants on booking (empty ⇒ today's per-location default), captured at booking time and used in fulfillment.

**Architecture:** Extend the existing `classFunnelConfigFromBlocks` helper to also read a per-block trial product; the class-booking route persists it on the queued `class_booking_requests` row (new columns via a forward-only migration); the async processor passes it as a `trialOverride` into `findOrCreateGlofoxMember`, which uses it in `purchaseGlofoxMembership` instead of the location default. Editor reuses the existing `/api/locations/[id]/glofox-memberships` route + `buildTrialOptions`.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase (service-role routes + MCP migration), Glofox API, Zod, Vitest.

**Worktree:** `~/code/un1t-crm-trial` (branch `class-funnel-trial-product`, off `origin/main` — has #1050 + #1051).

**Spec:** `docs/superpowers/specs/2026-07-22-class-funnel-trial-product-design.md`

**⚠️ Deploy order:** the migration (Task 1) must be applied to the un1t-crm Supabase project BEFORE the code that reads/writes the new columns deploys. It's additive + nullable, so applying it early is safe.

---

## File Structure

**Migration (via Supabase MCP, not a file the app builds):**
- `class_booking_requests` gains nullable `trial_membership_id text`, `trial_plan_code text`.

**Modify:**
- `src/lib/public-landing.js` — `classFunnelConfigFromBlocks` also returns `{ trialMembershipId, trialPlanCode }`.
- `src/lib/public-landing.test.js` — cover the new return fields.
- `src/app/api/public/class-booking/route.js` — persist the two values on insert.
- `src/lib/glofox-push.js` — `findOrCreateGlofoxMember` accepts `trialOverride`.
- `src/lib/class-booking-processor.js` — pass `trialOverride` from the request row.
- `src/components/landing-page/BlockRenderers.jsx` — factory default fields (see note) — **NO**, factory lives in landing-page-blocks.js.
- `src/lib/landing-page-blocks.js` — add the two default fields to `CLASS_FUNNEL_DEFAULT`.
- `src/components/LandingPageSettingsForm.jsx` — thread `locationId` to `BlockEditPanel`; add the trial-product field to `ClassFunnelEdit`; extend `summaryFor`.

**Reused as-is (no change):**
- `GET /api/locations/[id]/glofox-memberships` (catalogue).
- `src/lib/glofox-trial-options.js` `buildTrialOptions(memberships, trialKey)`.

---

## Task 1: Migration — trial columns on `class_booking_requests`

Additive, forward-only, applied via Supabase MCP against the **un1t-crm** project (ref `iyvtbjjxdggiadzwwvdj` — confirm via `list_projects`, NOT the sentinel project).

**Files:** none in-repo (MCP migration).

- [ ] **Step 1: Confirm the target project**

Use MCP `list_projects`; confirm the project whose ref is `iyvtbjjxdggiadzwwvdj` is un1t-crm. Do NOT apply to any other project.

- [ ] **Step 2: Apply the migration**

MCP `apply_migration`, name `add_trial_product_to_class_booking_requests`, SQL:
```sql
alter table public.class_booking_requests
  add column if not exists trial_membership_id text,
  add column if not exists trial_plan_code text;

comment on column public.class_booking_requests.trial_membership_id is
  'Optional per-funnel trial product override captured at booking time from the class_funnel block; NULL ⇒ use the location default (locations.settings.glofox).';
comment on column public.class_booking_requests.trial_plan_code is
  'Plan code paired with trial_membership_id. Both must be set to override.';
```

- [ ] **Step 3: Run security advisors**

MCP `get_advisors` (type=security). Expected: no NEW findings attributable to these columns (nullable text on an existing table adds no RLS surface — the table is written only by service-role routes).

- [ ] **Step 4: Verify columns exist**

MCP `execute_sql`:
```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name='class_booking_requests'
  and column_name in ('trial_membership_id','trial_plan_code');
```
Expected: two rows, both `text`, `is_nullable = YES`.

- [ ] **Step 5: Record the migration in-repo (documentation mirror)**

This repo keeps a `supabase/migrations/` mirror. The highest existing number is
`436` (there are intentional duplicate 435 prefixes — do NOT renumber those).
Use `437`. Create `supabase/migrations/437_add_trial_product_to_class_booking_requests.sql`
with the exact SQL from Step 2, then commit:
```bash
cd ~/code/un1t-crm-trial
git add supabase/migrations/437_add_trial_product_to_class_booking_requests.sql
git commit -m "TRIAL-PRODUCT.1 — mig: trial_membership_id/plan_code on class_booking_requests"
```

---

## Task 2: `classFunnelConfigFromBlocks` returns the trial override (TDD)

**Files:**
- Modify: `src/lib/public-landing.js`
- Test: `src/lib/public-landing.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/public-landing.test.js` (the file already imports from `./public-landing`; add an import for `classFunnelConfigFromBlocks` to the existing import if not already present, then add this describe):
```js
describe('classFunnelConfigFromBlocks — trial product', () => {
  const withBlock = (extra) => [{ id: 'b1', type: 'class_funnel', ...extra }]

  it('returns both trial ids when both are set on the block', () => {
    const r = classFunnelConfigFromBlocks(withBlock({ trial_membership_id: 'm1', trial_plan_code: 'p1' }), 'stillorgan')
    expect(r.trialMembershipId).toBe('m1')
    expect(r.trialPlanCode).toBe('p1')
  })

  it('returns nulls when neither is set (use location default)', () => {
    const r = classFunnelConfigFromBlocks(withBlock({}), 'stillorgan')
    expect(r.trialMembershipId).toBeNull()
    expect(r.trialPlanCode).toBeNull()
  })

  it('returns nulls when only one of the pair is set (half-configured guard)', () => {
    const r1 = classFunnelConfigFromBlocks(withBlock({ trial_membership_id: 'm1' }), 'stillorgan')
    expect(r1.trialMembershipId).toBeNull()
    expect(r1.trialPlanCode).toBeNull()
    const r2 = classFunnelConfigFromBlocks(withBlock({ trial_plan_code: 'p1' }), 'stillorgan')
    expect(r2.trialMembershipId).toBeNull()
    expect(r2.trialPlanCode).toBeNull()
  })

  it('trims whitespace-only trial values to null', () => {
    const r = classFunnelConfigFromBlocks(withBlock({ trial_membership_id: '  ', trial_plan_code: 'p1' }), 'stillorgan')
    expect(r.trialMembershipId).toBeNull()
    expect(r.trialPlanCode).toBeNull()
  })

  it('still returns the existing tag/leadSource/eventSourceUrl fields', () => {
    const r = classFunnelConfigFromBlocks([], 'stillorgan')
    expect(r.tag).toBe('stillorgan-start')
    expect(r.leadSource).toBe('meta_book')
    expect(r.eventSourceUrl).toBe('https://www.un1tdublin.com/start')
    expect(r.trialMembershipId).toBeNull()
    expect(r.trialPlanCode).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/code/un1t-crm-trial && npx vitest run src/lib/public-landing.test.js`
Expected: the new trial tests fail (`trialMembershipId` undefined).

- [ ] **Step 3: Implement**

In `src/lib/public-landing.js`, replace the body of `classFunnelConfigFromBlocks` — keep everything as-is and add the trial pair before the return. The final function:
```js
export function classFunnelConfigFromBlocks(blocks, landingPath) {
  const path = resolveLandingPath(landingPath)
  const list = Array.isArray(blocks) ? blocks : []
  const cf = list.find((b) => b && typeof b === 'object' && b.type === 'class_funnel')
  const override = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const tag = override(cf?.tag) || `${path}-start`
  const leadSource = override(cf?.lead_source) || DEFAULT_CLASS_FUNNEL_LEAD_SOURCE
  const eventSourceUrl = override(cf?.event_source_url)
    || CLASS_FUNNEL_EVENT_SOURCE_URL_BY_PATH[path]
    || `https://www.un1tdublin.com/${path}`
  // Per-funnel trial product override — BOTH ids must be present to count;
  // a half-configured block (only one set) falls back to the location default.
  const trialMembershipId = override(cf?.trial_membership_id)
  const trialPlanCode = override(cf?.trial_plan_code)
  const bothTrial = trialMembershipId && trialPlanCode
  return {
    tag, leadSource, eventSourceUrl,
    trialMembershipId: bothTrial ? trialMembershipId : null,
    trialPlanCode: bothTrial ? trialPlanCode : null,
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ~/code/un1t-crm-trial && npx vitest run src/lib/public-landing.test.js`
Expected: all pass (existing + new).

- [ ] **Step 5: Commit**

```bash
cd ~/code/un1t-crm-trial
git add src/lib/public-landing.js src/lib/public-landing.test.js
git commit -m "TRIAL-PRODUCT.2 — classFunnelConfigFromBlocks returns per-funnel trial override"
```

---

## Task 3: Route persists the trial override on the queued row

**Files:**
- Modify: `src/app/api/public/class-booking/route.js`

- [ ] **Step 1: Destructure the new fields from the helper**

Find this line (~72):
```js
  const { tag, leadSource, eventSourceUrl } = classFunnelConfigFromBlocks(page.blocks, landingPath)
```
Replace with:
```js
  const { tag, leadSource, eventSourceUrl, trialMembershipId, trialPlanCode } = classFunnelConfigFromBlocks(page.blocks, landingPath)
```

- [ ] **Step 2: Persist them on the insert**

Find the insert (~133):
```js
  const { data: queuedRow, error: insErr } = await db.from('class_booking_requests').insert({
    location_id: locationId, contact_id: contactId,
    glofox_event_id: b.event_id, class_name: chosen.name,
    starts_at: chosen.starts_at,
    customer_name: name, customer_email: b.email.toLowerCase(), customer_phone: b.phone,
    status: 'queued',
  }).select('id').maybeSingle()
```
Add the two fields (null when no override):
```js
  const { data: queuedRow, error: insErr } = await db.from('class_booking_requests').insert({
    location_id: locationId, contact_id: contactId,
    glofox_event_id: b.event_id, class_name: chosen.name,
    starts_at: chosen.starts_at,
    customer_name: name, customer_email: b.email.toLowerCase(), customer_phone: b.phone,
    trial_membership_id: trialMembershipId, trial_plan_code: trialPlanCode,
    status: 'queued',
  }).select('id').maybeSingle()
```

- [ ] **Step 3: Lint**

Run: `cd ~/code/un1t-crm-trial && npm run lint 2>&1 | tail -3`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
cd ~/code/un1t-crm-trial
git add src/app/api/public/class-booking/route.js
git commit -m "TRIAL-PRODUCT.3 — class-booking route persists per-funnel trial override on the queued row"
```

---

## Task 4: `findOrCreateGlofoxMember` accepts a `trialOverride`

**Files:**
- Modify: `src/lib/glofox-push.js`
- Test: `src/lib/glofox-push.test.js` (create if absent)

- [ ] **Step 1: Write the failing test**

Read the top of `src/lib/glofox-push.js` for its exact imports so the mock matches. Then create/append `src/lib/glofox-push.test.js`. This test drives ONLY the trial-selection branch by mocking the Glofox client so no network happens. Use `vi.mock` for `./glofox.js` and `./glofox-sync.js` and `./contact-tags.js`; stub the DB. Because the create path is long, assert specifically that `purchaseGlofoxMembership` receives the override pair when given, and the location default when not:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const purchaseGlofoxMembership = vi.fn(async () => ({ ok: true }))
vi.mock('./glofox.js', () => ({
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  searchGlofoxByEmail: vi.fn(async () => ({ ok: true, members: [] })),
  registerGlofoxMember: vi.fn(async () => ({ ok: true, glofoxId: 'NEWID', passcode: '1234' })),
  purchaseGlofoxMembership: (...a) => purchaseGlofoxMembership(...a),
  generateGlofoxPasscode: vi.fn(() => '1234'),
  glofoxFetch: vi.fn(),
}))
vi.mock('./glofox-sync.js', () => ({ applyMemberSync: vi.fn(async () => ({})) }))
vi.mock('./contact-tags.js', () => ({ writeContactTag: vi.fn(async () => {}) }))
vi.mock('./connection-registry.js', () => ({ getGlofoxConfig: vi.fn(async () => ({ trial_membership_id: 'LOC_M', trial_plan_code: 'LOC_P' })) }))

import { findOrCreateGlofoxMember } from './glofox-push.js'

// Minimal chainable supabase stub: every call resolves to { data: null } unless overridden.
function makeDb() {
  const chain = {
    from: () => chain, select: () => chain, eq: () => chain, insert: () => chain,
    update: () => chain, maybeSingle: async () => ({ data: null }), single: async () => ({ data: null }),
  }
  return chain
}

const contact = { id: 'c1', email: 'x@y.com', first_name: 'A', last_name: 'B' }

beforeEach(() => { purchaseGlofoxMembership.mockClear() })

describe('findOrCreateGlofoxMember trialOverride', () => {
  it('uses the override pair when provided', async () => {
    await findOrCreateGlofoxMember({
      db: makeDb(), locationId: 'loc1', contact, source: 'booking_form',
      createIfMissing: true, attachTrial: true,
      trialOverride: { membershipId: 'BLK_M', planCode: 'BLK_P' },
    })
    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(
      expect.anything(), 'NEWID', 'BLK_M', 'BLK_P',
    )
  })

  it('falls back to the location default when no override', async () => {
    await findOrCreateGlofoxMember({
      db: makeDb(), locationId: 'loc1', contact, source: 'booking_form',
      createIfMissing: true, attachTrial: true,
    })
    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(
      expect.anything(), 'NEWID', 'LOC_M', 'LOC_P',
    )
  })
})
```

NOTE: the real function has more steps (audit writes, passcode stash, sync). If the mocks above are insufficient for the create path to reach Step 5 (e.g. it calls another import), read the function top-to-bottom and add the missing `vi.mock` for whatever it imports, and extend `makeDb()` so the specific `.select(...).maybeSingle()` calls the create path makes return shapes that let it proceed to the trial step. Keep mocks minimal and behaviour-focused. If the create path proves too entangled to unit-test cleanly, STOP and report — we'll fall back to asserting the selection logic via a tiny extracted helper instead (see Step 3 alt).

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/code/un1t-crm-trial && npx vitest run src/lib/glofox-push.test.js`
Expected: FAIL — `trialOverride` ignored, so the override test sees `LOC_M/LOC_P` (or the fn signature doesn't accept it yet).

- [ ] **Step 3: Implement — accept + prefer the override**

In `src/lib/glofox-push.js`, add `trialOverride = null` to the destructured args of `findOrCreateGlofoxMember`:
```js
export async function findOrCreateGlofoxMember({
  db, locationId, contact, source,
  createIfMissing = false,
  attachTrial = false,
  trialOverride = null,
}) {
```
Then in the `attachTrial` block, prefer the override. Replace:
```js
    const glofoxCfg = await getGlofoxConfig(db, locationId)
    const trial = getLocationTrialConfig({ settings: { glofox: glofoxCfg } })
```
with:
```js
    // Per-funnel override (from the class_funnel block, captured on the booking
    // row) wins over the location default when BOTH ids are present.
    const trial = (trialOverride?.membershipId && trialOverride?.planCode)
      ? { membershipId: trialOverride.membershipId, planCode: trialOverride.planCode }
      : getLocationTrialConfig({ settings: { glofox: await getGlofoxConfig(db, locationId) } })
```

**Step 3 alt (only if Step 1 was reported un-unit-testable):** extract the two lines above into an exported pure helper `resolveTrialConfig(trialOverride, locationGlofoxCfg)` in `glofox-push.js`, unit-test THAT (override present → override; absent/half → location default), and call it from the attachTrial block. Adjust the Task's tests accordingly.

- [ ] **Step 4: Run to verify pass**

Run: `cd ~/code/un1t-crm-trial && npx vitest run src/lib/glofox-push.test.js`
Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/code/un1t-crm-trial
git add src/lib/glofox-push.js src/lib/glofox-push.test.js
git commit -m "TRIAL-PRODUCT.4 — findOrCreateGlofoxMember prefers a per-funnel trialOverride"
```

---

## Task 5: Processor passes the row's trial override

**Files:**
- Modify: `src/lib/class-booking-processor.js`

- [ ] **Step 1: Pass `trialOverride` at the create call**

Find (~104):
```js
    const res = await findOrCreateGlofoxMember({ db, locationId: request.location_id, contact, source: 'booking_form', createIfMissing: true, attachTrial: true })
```
Replace with:
```js
    const trialOverride = (request.trial_membership_id && request.trial_plan_code)
      ? { membershipId: request.trial_membership_id, planCode: request.trial_plan_code }
      : null
    const res = await findOrCreateGlofoxMember({ db, locationId: request.location_id, contact, source: 'booking_form', createIfMissing: true, attachTrial: true, trialOverride })
```
(The cron sweeper and QStash worker both fetch the row with `.select('*')`, so `request.trial_membership_id` / `request.trial_plan_code` are already present — no fetch change needed.)

- [ ] **Step 2: Lint + full test (nothing should break)**

Run: `cd ~/code/un1t-crm-trial && npm run lint 2>&1 | tail -3 && npx vitest run src/lib/class-booking-processor.test.js 2>&1 | tail -8`
Expected: 0 lint errors; if a processor test file exists it stays green (the change is additive; existing tests pass `null`).

- [ ] **Step 3: Commit**

```bash
cd ~/code/un1t-crm-trial
git add src/lib/class-booking-processor.js
git commit -m "TRIAL-PRODUCT.5 — processor threads the booking row's trial override into fulfillment"
```

---

## Task 6: Block factory defaults

**Files:**
- Modify: `src/lib/landing-page-blocks.js`

- [ ] **Step 1: Add the two default fields to `CLASS_FUNNEL_DEFAULT`**

Find the `CLASS_FUNNEL_DEFAULT` factory (ends with `consult_slug: '',` then `})`). Add the two fields before the closing:
```js
  trial_membership_id: '', // '' ⇒ grant the location's default trial product
  trial_plan_code:     '',
```

- [ ] **Step 2: Test — a fresh block carries the empty defaults**

Append to `src/lib/landing-page-blocks.test.js` (imports already present):
```js
describe('class_funnel trial product defaults', () => {
  it('newBlockOfType seeds empty trial fields', () => {
    const b = newBlockOfType('class_funnel')
    expect(b.trial_membership_id).toBe('')
    expect(b.trial_plan_code).toBe('')
  })
})
```

- [ ] **Step 3: Run test**

Run: `cd ~/code/un1t-crm-trial && npx vitest run src/lib/landing-page-blocks.test.js`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
cd ~/code/un1t-crm-trial
git add src/lib/landing-page-blocks.js src/lib/landing-page-blocks.test.js
git commit -m "TRIAL-PRODUCT.6 — class_funnel factory seeds empty trial product fields"
```

---

## Task 7: Editor — thread `locationId` + add the trial-product picker

**Files:**
- Modify: `src/components/LandingPageSettingsForm.jsx`

- [ ] **Step 1: Thread `locationId` into `BlockEditPanel`**

At the `BlockEditPanel` call site (inside `BlockCard`, ~618) add `locationId`:
```jsx
          <BlockEditPanel
            block={block}
            onUpdate={onUpdate}
            locationId={locationId}
            availableBookingTypes={availableBookingTypes}
            availableEvents={availableEvents}
            uploadMedia={uploadMedia}
            uploading={uploading}
            uploadErr={uploadErr}
            progress={progress}
          />
```
Then ensure `BlockCard` receives `locationId`. Find `BlockCard`'s props destructure (the function that renders the above; its destructure currently includes `availableBookingTypes, availableEvents, uploadMedia, uploading, uploadErr, progress,`). Add `locationId,` to it. Then find where `BlockCard` is rendered (the `.map` over blocks) and pass `locationId={locationId}` there too. `locationId` is a top-level prop of `LandingPageSettingsForm` so it is in scope at the map.

VERIFY by reading: trace `locationId` from `LandingPageSettingsForm({ locationId, ... })` → the block `.map` → `BlockCard` → `BlockEditPanel`. If any hop already forwards `{...props}` that includes it, don't double-add.

- [ ] **Step 2: Import `buildTrialOptions` and React hooks**

At the top of `src/components/LandingPageSettingsForm.jsx`, confirm `useState`/`useEffect` are imported (they are — the form is a client component). Add:
```js
import { buildTrialOptions } from '@/lib/glofox-trial-options'
```

- [ ] **Step 3: Add the trial-product field to `ClassFunnelEdit`**

Change the signature to accept `locationId`:
```js
function ClassFunnelEdit({ block, onUpdate, availableBookingTypes, locationId }) {
```
Inside, before the `return`, add the lazy catalogue fetch:
```js
  const bts = availableBookingTypes || []
  const [memberships, setMemberships] = useState([])
  const [membershipsLoading, setMembershipsLoading] = useState(false)
  useEffect(() => {
    if (!locationId) return
    let alive = true
    setMembershipsLoading(true)
    fetch(`/api/locations/${locationId}/glofox-memberships`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (alive && j && j.success !== false) setMemberships(j.memberships || j.data || []) })
      .catch(() => {})
      .finally(() => { if (alive) setMembershipsLoading(false) })
    return () => { alive = false }
  }, [locationId])
  const trialKey = (block.trial_membership_id && block.trial_plan_code)
    ? `${block.trial_membership_id}:${block.trial_plan_code}` : ''
  const setTrial = (value) => {
    const [mid, pc] = value ? value.split(':') : ['', '']
    onUpdate({ trial_membership_id: mid || '', trial_plan_code: pc || '' })
  }
  const trialOptions = buildTrialOptions(memberships, trialKey)
```
Then add this `<Field>` to the returned JSX — place it right after the "Class booked — message" field and before the "Free-consult upsell" field:
```jsx
      <Field
        label="Trial product granted on booking"
        hint="Which Glofox membership/plan a NEW member gets on booking. Leave on the location default unless this funnel should grant a different intro offer."
      >
        {trialOptions.length > 0 ? (
          <select
            value={trialKey}
            onChange={(e) => setTrial(e.target.value)}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
          >
            <option value="">— Use location default —</option>
            {trialOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        ) : (
          <Input
            value={trialKey}
            onChange={(v) => setTrial(v)}
            maxLength={120}
            placeholder={membershipsLoading ? 'Loading Glofox products…' : 'membershipId:planCode (optional)'}
          />
        )}
        {membershipsLoading && trialOptions.length > 0 && (
          <p className="text-[11px] text-un1t-muted mt-1">Loading membership list…</p>
        )}
      </Field>
```
(`buildTrialOptions` keeps a stale saved value visible as an option and returns `[]` for an empty catalogue, which drives the free-text fallback.)

- [ ] **Step 4: Extend `summaryFor` for class_funnel**

Find (~644):
```js
    case 'class_funnel': return block.consult_slug ? `consult: ${block.consult_slug}` : 'no consult upsell'
```
Replace with:
```js
    case 'class_funnel': {
      const base = block.consult_slug ? `consult: ${block.consult_slug}` : 'no consult upsell'
      return block.trial_membership_id ? `${base} · trial set` : base
    }
```

- [ ] **Step 5: Build + lint**

Run: `cd ~/code/un1t-crm-trial && npm run build 2>&1 | tail -12 && npm run lint 2>&1 | tail -3`
Expected: build succeeds; 0 lint errors.

- [ ] **Step 6: Commit**

```bash
cd ~/code/un1t-crm-trial
git add src/components/LandingPageSettingsForm.jsx
git commit -m "TRIAL-PRODUCT.7 — editor: per-funnel trial product picker (reuses buildTrialOptions + memberships route)"
```

---

## Task 8: Full verification

**Files:** none.

- [ ] **Step 1: Full test suite**

Run: `cd ~/code/un1t-crm-trial && npm test 2>&1 | tail -12`
Expected: all pass (incl. new public-landing, glofox-push, landing-page-blocks tests).

- [ ] **Step 2: CI mirror (all six)**

Run:
```bash
cd ~/code/un1t-crm-trial && npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
```
Expected: every command exits 0. (No `WEB_PERMISSIONS` change — this is operator landing-page config, not a permissioned surface.)

- [ ] **Step 3: Production build**

Run: `cd ~/code/un1t-crm-trial && npm run build 2>&1 | tail -15`
Expected: success.

- [ ] **Step 4: Manual smoke (dev, Stillorgan)**

Confirm the **migration is already applied** (Task 1). Then `npm run dev` and:
- Settings → Landing page (Stillorgan): edit the Glofox Class Booking Funnel block → the "Trial product granted on booking" dropdown lists Stillorgan's Glofox memberships; pick one; save.
- Book as a brand-new lead (fresh email/phone) through that funnel → the async processor creates the member and purchases **the chosen** product (verify in Glofox, or in the `class_booking_requests` row + push logs).
- A funnel block left on "Use location default" → new-member booking grants the location default product (unchanged behaviour).

- [ ] **Step 5: Push + open PR**

```bash
cd ~/code/un1t-crm-trial
git push -u origin class-funnel-trial-product
gh pr create --base main --fill
```
Report the PR URL. Note in the PR body that the migration was applied to un1t-crm ahead of merge. The Vercel preview check is the real build gate.

---

## Self-review notes (spec coverage)

- Block config fields → Task 6. ✅
- Editor picker reusing existing route + buildTrialOptions, locationId threaded → Task 7. ✅
- Capture at booking time (helper + route + migration) → Tasks 1–3. ✅
- Fulfillment override (glofox-push + processor) → Tasks 4–5. ✅
- Non-goals honoured: existing-no-credit path untouched (processor change is only inside the `createIfMissing:true` branch; the `needs_credit_grant` path is not modified); no integer credits; no other flow changes. ✅
- Backwards-compat: empty block → nulls → location default; pre-migration rows read null → default → Tasks 2/5. ✅
- Deploy order (migration first) called out in header + Task 1. ✅

**Property-name consistency:** the pair is `trial_membership_id` / `trial_plan_code` everywhere on-disk (block config, DB columns, request row) and camelCase `trialMembershipId` / `trialPlanCode` only as the helper's return + local vars; the fulfillment override object uses `{ membershipId, planCode }` consistently in Tasks 4 (param), 5 (processor), and the glofox-push branch. `buildTrialOptions` value format `"<membershipId>:<planCode>"` is split back into the two snake_case block fields in Task 7 Step 3. ✅
