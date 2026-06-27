# Apple Health body-metric auto-fill (Slice 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Keep each member's weight fresh and pre-fill dob/gender from Apple Health — on-device HealthKit reads `bodyMass` + `dateOfBirth` + `biologicalSex` and uploads them; the un1t-crm ingest receiver applies the weight (freshest-wins) and fills dob/gender **only-if-null**. Completes the "works from day 1, no asking" vision: a connected member never types their weight.

**Spans two repos, two parts (Part A ships first — it's the dependency):**
- **Part A — un1t-crm:** extend the existing Apple Health ingest receiver to accept + apply a `body` block. Ship/deploy.
- **Part B — champ-app:** read the new HealthKit types on-device + include them in the upload; add body-mass to background delivery.

**Spec:** `un1t-crm docs/superpowers/specs/2026-06-27-profile-setup-body-metrics-calories-design.md` (Slice 2).

**Already shipped (depend on these):** un1t-crm `applyWeightObservation(db,{contactId,weightKg,source,observedAt})` + `contacts.{dob,gender,weight_kg,weight_kg_source,weight_kg_at}` (Slice 1, live). The Apple Health pipe: champ-app `mobile/lib/apple-health-sync.js` (`HEALTHKIT_READ_TYPES`, `syncAppleHealth`, `requestAppleHealthAuthorization`, `enableAppleHealthBackground`) + pure `shared/apple-health-payload.js` (`buildAppleHealthPayload`) → POST un1t-crm `/api/wearables/apple-health/ingest` (customer-auth via `resolveCustomerContact`; schema currently `{ workouts?, healthMetrics? }.passthrough()`).

**Key design points:**
- **Weight ≠ a health metric.** It must become the canonical `contacts.weight_kg` (so the calorie calc reads it), NOT a `member_health_metrics` row. So it rides a NEW `body` block in the payload, not `healthMetrics[]`.
- **dob/gender are only-if-null** — never overwrite a Glofox value or an explicit member choice. Legacy `gender='P'` counts as "set" (don't overwrite it either; only fill when null).
- HealthKit `biologicalSex` → our gender enum via a pure mapper (`female|male|other`; `notSet`/unknown → null = don't write).

---

## PART A — un1t-crm receiver

### File structure (Part A)
| File | Change |
|---|---|
| `src/lib/apple-health-body.js` *(new)* | Pure `mapBiologicalSexToGender`, `parseBodyBlock` |
| `src/lib/apple-health-body.test.js` *(new)* | Unit tests |
| `src/app/api/wearables/apple-health/ingest/route.js` | Accept + apply the `body` block |
| `docs/CHANGELOG.md` | Done entry |

### Task A1: Pure body-block mappers

**Files:** Create `src/lib/apple-health-body.js`, `src/lib/apple-health-body.test.js`.

- [ ] **Step 1: Failing test** — `src/lib/apple-health-body.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { mapBiologicalSexToGender, parseBodyBlock } from './apple-health-body.js'

describe('mapBiologicalSexToGender', () => {
  it('maps HealthKit values to our enum', () => {
    expect(mapBiologicalSexToGender('female')).toBe('female')
    expect(mapBiologicalSexToGender('male')).toBe('male')
    expect(mapBiologicalSexToGender('other')).toBe('other')
  })
  it('is case-insensitive', () => {
    expect(mapBiologicalSexToGender('Female')).toBe('female')
  })
  it('returns null for notSet / unknown / junk', () => {
    expect(mapBiologicalSexToGender('notSet')).toBeNull()
    expect(mapBiologicalSexToGender(null)).toBeNull()
    expect(mapBiologicalSexToGender('xyz')).toBeNull()
  })
})

describe('parseBodyBlock', () => {
  it('extracts a clean weight + iso timestamp', () => {
    const out = parseBodyBlock({ weight_kg: 70.4, weight_at: '2026-06-27T08:00:00Z' })
    expect(out.weightKg).toBe(70.4)
    expect(out.weightAt).toBe('2026-06-27T08:00:00Z')
  })
  it('defaults weight_at to null and ignores an out-of-range weight', () => {
    expect(parseBodyBlock({ weight_kg: 5 }).weightKg).toBeNull()
    expect(parseBodyBlock({ weight_kg: 500 }).weightKg).toBeNull()
    expect(parseBodyBlock({ weight_kg: 70 }).weightAt).toBeNull()
  })
  it('passes through a valid dob and maps biological_sex', () => {
    const out = parseBodyBlock({ dob: '1990-03-12', biological_sex: 'male' })
    expect(out.dob).toBe('1990-03-12')
    expect(out.gender).toBe('male')
  })
  it('nulls a malformed dob and unknown sex', () => {
    const out = parseBodyBlock({ dob: '12/03/1990', biological_sex: 'notSet' })
    expect(out.dob).toBeNull()
    expect(out.gender).toBeNull()
  })
  it('handles an empty/absent block', () => {
    expect(parseBodyBlock(undefined)).toEqual({ weightKg: null, weightAt: null, dob: null, gender: null })
  })
})
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/lib/apple-health-body.test.js`.

- [ ] **Step 3: Implement** `src/lib/apple-health-body.js`:
```js
// Pure mappers for the Apple Health `body` block (weight + dob + biological sex).
// No DB. The ingest route applies the parsed values (weight freshest-wins;
// dob/gender only-if-null).

const GENDERS = ['female', 'male', 'other']

export function mapBiologicalSexToGender(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  return GENDERS.includes(v) ? v : null
}

/**
 * @returns {{ weightKg:number|null, weightAt:string|null, dob:string|null, gender:string|null }}
 */
export function parseBodyBlock(body) {
  const b = body || {}
  const wRaw = Number(b.weight_kg)
  const weightKg = Number.isFinite(wRaw) && wRaw >= 20 && wRaw <= 300 ? wRaw : null
  const weightAt = typeof b.weight_at === 'string' && Number.isFinite(Date.parse(b.weight_at)) ? b.weight_at : null
  let dob = null
  if (typeof b.dob === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.dob)) {
    const t = Date.parse(`${b.dob}T00:00:00Z`)
    if (Number.isFinite(t) && t <= Date.now()) dob = b.dob
  }
  return { weightKg, weightAt, dob, gender: mapBiologicalSexToGender(b.biological_sex) }
}
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/lib/apple-health-body.test.js`.

- [ ] **Step 5: Commit**
```bash
git add src/lib/apple-health-body.js src/lib/apple-health-body.test.js
git commit -m "AH-BODY.1 — pure Apple Health body-block mappers (sex→gender, weight/dob parse)"
```

### Task A2: Apply the body block in the ingest route

**Files:** Modify `src/app/api/wearables/apple-health/ingest/route.js`.

- [ ] **Step 1: Read** the route. Note: `AppleHealthIngestSchema` (currently `{ workouts?, healthMetrics? }.passthrough()`), the `body` variable from `validateBody`, the `contact` (has `id`, and the route already re-reads `contacts` for `glofox_member_id`), and the final `NextResponse.json({ success, ingested, deduped, finalised, metricsUpserted })`.

- [ ] **Step 2: Implement**
1. Add imports:
```js
import { applyWeightObservation } from '@/lib/body-metrics'
import { parseBodyBlock } from '@/lib/apple-health-body'
```
2. Extend the schema to validate the optional `body` block (keep `.passthrough()`):
```js
const AppleHealthIngestSchema = z.object({
  workouts: z.array(z.any()).optional(),
  healthMetrics: z.array(z.any()).optional(),
  body: z.object({
    weight_kg: z.number().optional(),
    weight_at: z.string().optional(),
    dob: z.string().optional(),
    biological_sex: z.string().optional(),
  }).optional(),
}).passthrough()
```
3. After the workouts + healthMetrics processing (just before building the response), add the body-block application:
```js
  // Body metrics (weight + dob + biological sex) → canonical contacts fields.
  // Weight freshest-wins; dob/gender only-if-null (never clobber Glofox / an
  // explicit member choice). Best-effort — never fails the ingest.
  let bodyApplied = null
  try {
    const { weightKg, weightAt, dob, gender } = parseBodyBlock(body?.body)
    if (weightKg != null) {
      await applyWeightObservation(db, {
        contactId: contact.id, weightKg, source: 'apple_health', observedAt: weightAt || new Date().toISOString(),
      })
    }
    if (dob || gender) {
      const { data: cur } = await db.from('contacts').select('dob, gender').eq('id', contact.id).maybeSingle()
      const patch = {}
      if (dob && !cur?.dob) patch.dob = dob
      if (gender && !cur?.gender) patch.gender = gender
      if (Object.keys(patch).length) await db.from('contacts').update(patch).eq('id', contact.id)
    }
    bodyApplied = { weight: weightKg != null, dob: !!dob, gender: !!gender }
  } catch (e) {
    console.warn(`[apple-health-ingest] body block failed for contact ${contact.id}: ${e?.message || e}`)
  }
```
4. Add `bodyApplied` to the response JSON object.

- [ ] **Step 3: Add a test** — find the existing ingest route test (`route.test.js` beside it) and add a case: a payload with a `body` block calls `applyWeightObservation` and fills `dob`/`gender` only when currently null (mock `contacts` select to return `{ dob: null, gender: null }` for the fill case, and `{ dob: '1980-01-01', gender: 'female' }` for the no-overwrite case). Mirror the file's existing mocking. If the route test mocks at module boundaries, mock `@/lib/body-metrics` to spy on `applyWeightObservation`.

- [ ] **Step 4: Verify** — `npx vitest run src/app/api/wearables/apple-health/ingest/route.test.js`; `npm test`; `npm run lint`; `npm run check:route-guards` (unchanged — still `resolveCustomerContact`-guarded); `npm run build`.

- [ ] **Step 5: Commit**
```bash
git add 'src/app/api/wearables/apple-health/ingest/route.js' 'src/app/api/wearables/apple-health/ingest/route.test.js'
git commit -m "AH-BODY.2 — apply Apple Health body block: weight (freshest-wins) + dob/gender only-if-null"
```

### Task A3: Ship Part A (un1t-crm)
- [ ] **Step 1: CHANGELOG** entry — Apple Health now also syncs body metrics (weight → canonical, dob/gender only-if-null); cite spec. Note champ-app native read is Part B.
- [ ] **Step 2: Full CI mirror** — `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails` + `npm run build`. All green.
- [ ] **Step 3: Commit + push + PR** — `git push -u origin HEAD && gh pr create --base main --fill`. Report PR URL. (No migration; rides Slice 1's schema. Receiver is backward-compatible — old clients that don't send `body` are unaffected.)

---

## PART B — champ-app native reads (after Part A is deployed)

> Execute in a champ-app worktree off champ-app `origin/main`. The controller sets this up. The un1t-crm receiver (Part A) must be live first so the uploaded `body` block is accepted.

### File structure (Part B)
| File | Change |
|---|---|
| `shared/apple-health-payload.js` | `buildAppleHealthPayload` emits a `body` block |
| `shared/apple-health-payload.test.js` | + body-block tests |
| `mobile/lib/apple-health-sync.js` | read bodyMass + dob + biologicalSex; add to read types + background; pass to payload |

### Task B1: Pure payload extension (`shared/`)

**Files:** Modify `shared/apple-health-payload.js` + its test.

- [ ] **Step 1: Add failing tests** to `shared/apple-health-payload.test.js`:
```js
describe('buildAppleHealthPayload — body block', () => {
  it('emits a body block from weight + characteristics', () => {
    const out = buildAppleHealthPayload({ body: { weightKg: 70.2, weightAt: '2026-06-27T08:00:00Z', dob: '1990-03-12', biologicalSex: 'male' } })
    expect(out.body).toEqual({ weight_kg: 70.2, weight_at: '2026-06-27T08:00:00.000Z', dob: '1990-03-12', biological_sex: 'male' })
  })
  it('omits the body block entirely when there is nothing to send', () => {
    expect(buildAppleHealthPayload({}).body).toBeUndefined()
    expect(buildAppleHealthPayload({ body: { weightKg: null, dob: null, biologicalSex: null } }).body).toBeUndefined()
  })
  it('includes only the present fields', () => {
    const out = buildAppleHealthPayload({ body: { weightKg: 68 } })
    expect(out.body).toEqual({ weight_kg: 68 })
  })
})
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run shared/apple-health-payload.test.js`.

- [ ] **Step 3: Implement** — extend `buildAppleHealthPayload`'s signature to accept `body` and emit it. Add before the `return`:
```js
  // Body block (weight + dob + biological sex) — only-present fields, omit if empty.
  const b = body || {}
  const bodyOut = {}
  if (num(b.weightKg) != null) {
    bodyOut.weight_kg = num(b.weightKg)
    const wAt = toIso(b.weightAt)
    if (wAt) bodyOut.weight_at = wAt
  }
  if (typeof b.dob === 'string' && b.dob) bodyOut.dob = b.dob
  if (b.biologicalSex) bodyOut.biological_sex = String(b.biologicalSex)
```
Change the signature to `buildAppleHealthPayload({ workouts = [], hrSamples = [], metrics = [], body = null } = {})` and the return to `return { workouts: outWorkouts, healthMetrics, ...(Object.keys(bodyOut).length ? { body: bodyOut } : {}) }`.

- [ ] **Step 4: Run, verify PASS** — `npx vitest run shared/apple-health-payload.test.js` + `npm test`.

- [ ] **Step 5: Commit**
```bash
git add shared/apple-health-payload.js shared/apple-health-payload.test.js
git commit -m "AH-BODY.3 — buildAppleHealthPayload emits an optional body block"
```

### Task B2: Read body metrics on-device

**Files:** Modify `mobile/lib/apple-health-sync.js`.

- [ ] **Step 1: Find the HealthKit characteristic API.** In `mobile/lib/apple-health-sync.js` the lib is `@kingstinct/react-native-healthkit`. Grep the installed package for how to read characteristics + a single latest quantity sample:
  - characteristics: look for exports like `getDateOfBirth` / `getBiologicalSex` (or `getDateOfBirthAsync` / `queryCharacteristic`) — `grep -rn "DateOfBirth\|BiologicalSex\|Characteristic" node_modules/@kingstinct/react-native-healthkit/lib 2>/dev/null | head` (or the package's `.d.ts`). Use the actual exported function names.
  - latest weight: the file already uses `queryQuantitySamples(id, { limit, unit, ascending, filter })` — query `HKQuantityTypeIdentifierBodyMass` with `{ limit: 1, unit: 'kg', ascending: false }` and take row[0] (value + its `startDate`/`endDate` for `weightAt`).

- [ ] **Step 2: Implement**
1. Add to `HEALTHKIT_READ_TYPES`: `'HKQuantityTypeIdentifierBodyMass'`, `'HKCharacteristicTypeIdentifierDateOfBirth'`, `'HKCharacteristicTypeIdentifierBiologicalSex'`. (This widens `requestAppleHealthAuthorization`'s permission request automatically.)
2. Add `'HKQuantityTypeIdentifierBodyMass'` to the `configureBackgroundTypes([...])` list in `enableAppleHealthBackground` so a new weigh-in wakes a background sync (characteristics don't change, so they don't need background).
3. In `syncAppleHealth`, after gathering workouts/metrics and before `buildAppleHealthPayload`, read the body metrics (best-effort each — never throw):
```js
  let body = null
  try {
    const wRows = (await queryQuantitySamples('HKQuantityTypeIdentifierBodyMass', { limit: 1, unit: 'kg', ascending: false })) || []
    const latest = wRows[0]
    const weightKg = latest ? Number(latest.quantity ?? latest.value) : null   // confirm the value field name from the lib's sample shape
    const weightAt = latest ? (latest.endDate || latest.startDate || null) : null
    const dob = /* call the characteristic getter found in Step 1; coerce to 'YYYY-MM-DD' */ null
    const biologicalSex = /* call the characteristic getter; coerce to 'female'|'male'|'other'|'notSet' string */ null
    if ((weightKg != null) || dob || biologicalSex) body = { weightKg, weightAt, dob, biologicalSex }
  } catch (e) { if (debug) dbg.bodyError = String(e?.message || e) }
```
   Then pass `body` into `buildAppleHealthPayload({ workouts, hrSamples, metrics, body })`. NOTE: the characteristic getters return native shapes — coerce DOB to a `YYYY-MM-DD` string (HealthKit DOB is date components or a Date; format with zero-padded month/day) and biologicalSex to the lib's string/enum (map the enum to `'female'|'male'|'other'|'notSet'` — the un1t-crm mapper lower-cases + validates, so passing the lib's string label is fine). Keep it best-effort: a missing characteristic → null, no crash.
4. The existing "nothing to send → skip POST" guard checks `payload.workouts.length === 0 && payload.healthMetrics.length === 0` — update it to also send when `payload.body` exists:
```js
  if (payload.workouts.length === 0 && payload.healthMetrics.length === 0 && !payload.body) { /* skip */ }
```

- [ ] **Step 3: Verify** — `npm run lint` (root) clean; `npm test` (the shared payload tests cover the pure shaping; native reads aren't unit-tested here). `npm run build` (web bundle) compiles. NOTE: mobile-native lint/build can't run in a fresh worktree (`mobile/node_modules` separate) — verify the @kingstinct function/sample-field names by READING the package's types, and confirm imports resolve.

- [ ] **Step 4: Commit**
```bash
git add mobile/lib/apple-health-sync.js
git commit -m "AH-BODY.4 — read bodyMass + dob + biological sex from HealthKit and upload them"
```

### Task B3: Ship Part B (champ-app)
- [ ] **Step 1: CHANGELOG** — Apple Health now syncs body metrics to auto-fill weight/dob/gender.
- [ ] **Step 2: Checks** — `npm test && npm run lint && npm run build` green.
- [ ] **Step 3: Push + PR** — report URL. ⚠️ **DEPLOY CAUTION:** adding HealthKit read types + reading characteristics changes the on-device permission set. This MAY be OTA-eligible (no new native module — @kingstinct is already linked with HealthKit entitlements + usage strings), but **a new read-permission prompt + characteristic access should be device-verified before relying on OTA**; if a config-plugin/usage-string or entitlement change turns out to be needed, BUMP `runtimeVersion` and ship a native build instead of OTA. Flag this for the operator (Richard) — do NOT assume OTA is safe here without a device check.

---

## Self-review (plan author)
**Spec coverage (Slice 2):** receiver accepts body block → A1/A2; weight freshest-wins via `applyWeightObservation` → A2; dob/gender only-if-null → A2; HealthKit reads bodyMass + characteristics → B2; payload carries them → B1; background delivery for weight → B2. **Placeholder scan:** pure tasks (A1, B1) have full code+tests; the two genuinely-unknown native specifics (the exact @kingstinct characteristic getter names + the sample value field) are called out as explicit "read the package types" steps, not guessed. **Type consistency:** the wire `body` block is `{ weight_kg, weight_at?, dob?, biological_sex? }` on BOTH sides (B1 emits it, A1 `parseBodyBlock` consumes it); `applyWeightObservation(db,{contactId,weightKg,source,observedAt})` matches the Slice-1 export; gender enum `female|male|other` consistent. **Ordering:** Part A deploys before Part B so the receiver accepts the new field (and is backward-compatible regardless).
