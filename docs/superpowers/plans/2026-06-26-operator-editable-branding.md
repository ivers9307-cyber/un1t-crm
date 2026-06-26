# Operator-editable branding (de-hard-code "UN1T" / "Tesla") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hard-coded `"UN1T"` brand name and `"Tesla"` car copy in customer-facing send paths with operator-editable values (the existing per-location `company_settings.company_name`, and the actual vehicle make), so CCF Autos / a second tenant stop receiving mis-branded messages.

**Architecture:** One new server-side resolver `getLocationBranding(db, locationId)` over the existing `company_settings` table (fallback `'UN1T'`), threaded into the Mia agent, WhatsApp template-variable, and churn-winback send paths. Separately, the CCF car deposit copy is de-Tesla'd to use the real `car.make`/label it already computes. No new schema. The whole `src/lib/xero/` module and the `cars/route.js` create-default are intentionally left untouched.

**Tech Stack:** Next.js 16 App Router, supabase-js, Vitest. champ-app (Component 6) is a separate Expo/Next repo at `~/code/champ-app`.

**Spec:** `docs/superpowers/specs/2026-06-26-operator-editable-branding-design.md`

**Conventions for every commit below:** branch `p1-3-operator-editable-branding` (already created off fresh `origin/main`) for un1t-crm Tasks 1–5; a separate champ-app branch for Task 6. End every commit message with the standard `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer. Run a single test file with `npx vitest run <path>`.

**Guardrail note:** the new code stays clean against `check:guardrails` — `getLocationBranding` uses `.limit(1)` (not ≥1000), `try/await/catch` (no `.catch` on a builder), and no UTC-date helpers.

---

### Task 1: `getLocationBranding` helper + reuse in the public branding route

**Files:**
- Create: `src/lib/location-branding.js`
- Create: `src/lib/location-branding.test.js`
- Modify: `src/app/api/public/branding/route.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/location-branding.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { getLocationBranding } from './location-branding.js'

// Minimal supabase-builder mock: from().select().eq().limit() resolves to `result`.
function mockDb(result) {
  const builder = {
    from() { return this },
    select() { return this },
    eq() { return this },
    limit() { return Promise.resolve(result) },
  }
  return builder
}

describe('getLocationBranding', () => {
  it('returns the configured company name + assets', async () => {
    const db = mockDb({ data: [{ company_name: 'CCF Autos', logo_url: 'l.png', favicon_url: 'f.ico' }], error: null })
    expect(await getLocationBranding(db, 'loc1')).toEqual({ companyName: 'CCF Autos', logoUrl: 'l.png', faviconUrl: 'f.ico' })
  })

  it('falls back to UN1T when no row exists', async () => {
    const db = mockDb({ data: [], error: null })
    expect((await getLocationBranding(db, 'loc1')).companyName).toBe('UN1T')
  })

  it('falls back to UN1T when company_name is blank', async () => {
    const db = mockDb({ data: [{ company_name: '   ', logo_url: null, favicon_url: null }], error: null })
    expect((await getLocationBranding(db, 'loc1')).companyName).toBe('UN1T')
  })

  it('returns defaults (never throws) on a query error', async () => {
    const db = mockDb({ data: null, error: { message: 'boom' } })
    expect(await getLocationBranding(db, 'loc1')).toEqual({ companyName: 'UN1T', logoUrl: null, faviconUrl: null })
  })

  it('returns defaults when locationId is missing', async () => {
    expect(await getLocationBranding(mockDb({}), null)).toEqual({ companyName: 'UN1T', logoUrl: null, faviconUrl: null })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/location-branding.test.js`
Expected: FAIL — `getLocationBranding` is not defined / module not found.

- [ ] **Step 3: Write the helper**

Create `src/lib/location-branding.js`:

```js
// Resolve operator-editable branding for one location from company_settings.
// Server-side send paths (Mia agent, WhatsApp template vars, churn win-back)
// use this so customer-facing copy reflects the location's configured brand
// instead of a hard-coded "UN1T". The login/reset-password screens read the
// same table via /api/public/branding (which reuses this helper).
//
// Takes an explicit `db` so it works under both the service-role and the
// request-scoped client. Never throws — a branding lookup must not break a
// send path; on any miss/error it returns the brand-neutral default.

const DEFAULT_COMPANY_NAME = 'UN1T'

/**
 * @param {object} db          a supabase-js client
 * @param {string} locationId  the location whose branding to resolve
 * @returns {Promise<{ companyName: string, logoUrl: string|null, faviconUrl: string|null }>}
 *          companyName is always a non-empty string (defaults to 'UN1T').
 */
export async function getLocationBranding(db, locationId) {
  const fallback = { companyName: DEFAULT_COMPANY_NAME, logoUrl: null, faviconUrl: null }
  if (!db || !locationId) return fallback
  try {
    const { data, error } = await db
      .from('company_settings')
      .select('company_name, logo_url, favicon_url')
      .eq('location_id', locationId)
      .limit(1)
    if (error || !data || data.length === 0) return fallback
    const row = data[0]
    const name = (row.company_name || '').trim()
    return {
      companyName: name || DEFAULT_COMPANY_NAME,
      logoUrl: row.logo_url || null,
      faviconUrl: row.favicon_url || null,
    }
  } catch {
    return fallback
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/location-branding.test.js`
Expected: PASS (5 passing).

- [ ] **Step 5: Reuse the helper in the public branding route (DRY — single source of truth for the per-location query)**

In `src/app/api/public/branding/route.js`, add the import at the top (alongside the existing imports):

```js
import { getLocationBranding } from '@/lib/location-branding'
```

Replace the body of `GET` so the `location_id` branch goes through the helper, leaving the anonymous (no-id) branch byte-identical to today:

```js
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const db = createServerClient()

  if (locationId) {
    const b = await getLocationBranding(db, locationId)
    return NextResponse.json({
      success: true,
      data: { logo_url: b.logoUrl, favicon_url: b.faviconUrl, company_name: b.companyName },
    })
  }

  // Anonymous visitor (login screen, no location yet) — first configured row.
  const { data } = await db
    .from('company_settings')
    .select('logo_url, favicon_url, company_name')
    .limit(1)
    .single()

  return NextResponse.json({
    success: true,
    data: data || { logo_url: null, favicon_url: null, company_name: null },
  })
}
```

- [ ] **Step 6: Verify the route still builds + helper test passes**

Run: `npx vitest run src/lib/location-branding.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/location-branding.js src/lib/location-branding.test.js src/app/api/public/branding/route.js
git commit -m "feat(branding): add getLocationBranding helper over company_settings"
```

---

### Task 2: Thread `companyName` into the WhatsApp `location_name` template variable

The `{{n}} → location_name` substitution hard-codes `'UN1T'`. Thread an optional
`opts.companyName` through the three template functions (optional trailing arg →
existing tests stay green) and resolve branding once per send batch in the
auto-built send paths: broadcast blast, drip tick, and sequence steps. The inbox
"send" route is intentionally excluded — it sends operator-supplied
`template_components`, so it never hits this hard-coded path.

**Files:**
- Modify: `src/lib/whatsapp.js` (`resolveTemplateVariableValues`, `buildTemplateComponents`, `renderTemplateBody`, blast caller ~554, drip caller ~707)
- Modify: `src/lib/sequences/steps.js` (build caller ~143, render caller ~170)
- Modify: `src/lib/whatsapp-template-components.test.js` (add cases)

- [ ] **Step 1: Write the failing test**

In `src/lib/whatsapp-template-components.test.js`, add `resolveTemplateVariableValues` to the existing import from `./whatsapp.js`, then append:

```js
describe('resolveTemplateVariableValues — location_name branding', () => {
  const tpl = { components: [{ type: 'BODY', text: 'Hi {{1}}, from {{2}}' }] }
  const contact = { first_name: 'Sam', name: 'Sam Lee' }

  it('resolves location_name from opts.companyName', () => {
    const vals = resolveTemplateVariableValues(tpl, contact, { 1: 'first_name', 2: 'location_name' }, { companyName: 'CCF Autos' })
    expect(vals[1]).toBe('CCF Autos')
  })

  it('falls back to UN1T when no companyName is passed', () => {
    const vals = resolveTemplateVariableValues(tpl, contact, { 1: 'first_name', 2: 'location_name' })
    expect(vals[1]).toBe('UN1T')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/whatsapp-template-components.test.js`
Expected: FAIL — first case gets `'UN1T'` (opts ignored) instead of `'CCF Autos'`.

- [ ] **Step 3: Add the `opts` param to the three functions**

In `src/lib/whatsapp.js`:

`resolveTemplateVariableValues` — add `opts = {}` and use it for `location_name`:

```js
export function resolveTemplateVariableValues(template, contact, variableMapping, opts = {}) {
  const bodyComp = (template.components || []).find(c => c.type === 'BODY')
  const varMatches = bodyComp?.text?.match(/\{\{\d+\}\}/g) || []
  return varMatches.map((_, i) => {
    const fieldName = (variableMapping || {})[String(i + 1)]
    let value = ''
    if (fieldName === 'first_name') value = contact.first_name || contact.name?.split(' ')[0] || ''
    else if (fieldName === 'name') value = contact.name || ''
    else if (fieldName === 'email') value = contact.email || ''
    else if (fieldName === 'phone') value = contact.phone || contact.wa_phone || ''
    else if (fieldName === 'location_name') value = opts.companyName || 'UN1T'
    else if (fieldName) value = contact[fieldName] || fieldName  // Use as literal if not a field
    return value
  })
}
```

`buildTemplateComponents` — add `opts = {}` to the signature and pass it through at the `resolveTemplateVariableValues(...)` call (~line 801):

```js
export function buildTemplateComponents(template, contact, variableMapping, headerMediaUrl, opts = {}) {
```
```js
    const values = resolveTemplateVariableValues(template, contact, variableMapping, opts)
```

`renderTemplateBody` — add `opts = {}` and pass it through:

```js
export function renderTemplateBody(template, contact, variableMapping, opts = {}) {
  const bodyComp = (template.components || []).find(c => c.type === 'BODY')
  if (!bodyComp?.text) return null
  return substituteTemplateBody(bodyComp.text, resolveTemplateVariableValues(template, contact, variableMapping, opts))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/whatsapp-template-components.test.js`
Expected: PASS (existing cases + 2 new).

- [ ] **Step 5: Resolve branding in the whatsapp.js send paths and pass it in**

At the top of `src/lib/whatsapp.js`, add the import (match the file's existing `@/lib` import style):

```js
import { getLocationBranding } from '@/lib/location-branding'
```

**Blast path** (~line 535, the function that loops `for (const contact of contacts)`): immediately before that loop, add:

```js
  const branding = await getLocationBranding(db, broadcast.location_id)
```

and at the `buildTemplateComponents(...)` call inside the loop (~554), pass the opts:

```js
      const components = buildTemplateComponents(template, contact, variableMapping, broadcast.header_media_url, { companyName: branding.companyName })
```

**Drip path** (~line 701, right after `const config = await getWhatsAppConfig(broadcast.location_id)`): add:

```js
  const branding = await getLocationBranding(db, broadcast.location_id)
```

and at the `buildTemplateComponents(...)` call (~707):

```js
      const components = buildTemplateComponents(template, contact, variableMapping, broadcast.header_media_url, { companyName: branding.companyName })
```

- [ ] **Step 6: Resolve branding in the sequence-step send path**

In `src/lib/sequences/steps.js`, add the import (match the file's existing import style):

```js
import { getLocationBranding } from '@/lib/location-branding'
```

After the template is validated and before `const components = buildTemplateComponents(` (~line 143), add:

```js
  const branding = await getLocationBranding(db, sequence.location_id)
```

Pass opts to both calls:

```js
  const components = buildTemplateComponents(
    template,
    contact,
    variableMapping,
    step.whatsapp_header_media_url || null,
    { companyName: branding.companyName },
  )
```
```js
      body: renderTemplateBody(template, contact, variableMapping, { companyName: branding.companyName }),
```

- [ ] **Step 7: Run the WhatsApp + sequences tests**

Run: `npx vitest run src/lib/whatsapp-template-components.test.js src/lib/sequences/steps.test.js`
Expected: PASS. (steps.test.js mocks `buildTemplateComponents`; the extra arg is ignored by the mock — still green.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/whatsapp.js src/lib/sequences/steps.js src/lib/whatsapp-template-components.test.js
git commit -m "feat(branding): resolve WhatsApp location_name from company_settings"
```

---

### Task 3: Thread `companyName` into the Mia agent system prompt

`businessName` feeds the agent's system prompt (already `businessName || 'UN1T'`
in `prompt.js`); the live-reply (`auto-reply.js`) and proactive (`followups.js`)
paths hard-code `'UN1T'` at the call sites. Resolve branding where `db` +
location are in scope and pass it. The prompt rendering is the unit-tested seam.

**Files:**
- Modify: `src/lib/agent/prompt.test.js` (add cases)
- Modify: `src/lib/agent/auto-reply.js` (~line 291)
- Modify: `src/lib/agent/followups.js` (`composeAgentText` signature ~266, callers ~304 and ~567)

- [ ] **Step 1: Write the failing test**

In `src/lib/agent/prompt.test.js`, ensure `buildCustomerSystemPromptParts` is imported from `./prompt.js`, then append:

```js
describe('buildCustomerSystemPromptParts — businessName', () => {
  it('uses the provided businessName', () => {
    const parts = buildCustomerSystemPromptParts({ businessName: 'CCF Autos' })
    expect(JSON.stringify(parts)).toContain('CCF Autos')
  })

  it('falls back to UN1T when businessName is absent', () => {
    const parts = buildCustomerSystemPromptParts({})
    expect(JSON.stringify(parts)).toContain('UN1T')
  })
})
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/lib/agent/prompt.test.js`
Expected: PASS already (the fallback logic exists). This test pins the contract the threading relies on — if it does not pass, stop and inspect `buildCustomerSystemPromptParts` before wiring callers.

- [ ] **Step 3: Wire `auto-reply.js`**

In `src/lib/agent/auto-reply.js`, add the import:

```js
import { getLocationBranding } from '@/lib/location-branding'
```

Inside `runChannelAgentInner`, right after `const settings = loc?.settings?.customer_agent || null` (~line 164), add:

```js
  const branding = await getLocationBranding(db, locationId)
```

Change the `buildCachedSystem({ ... })` call (~line 291) from `businessName: 'UN1T',` to:

```js
      businessName: branding.companyName,
```

- [ ] **Step 4: Wire `followups.js`**

In `src/lib/agent/followups.js`, add the import:

```js
import { getLocationBranding } from '@/lib/location-branding'
```

Change `composeAgentText` to accept a `companyName` argument (~line 266) and use it:

```js
async function composeAgentText(location, settings, historyRows, instruction, companyName) {
```

Inside it, change `businessName: 'UN1T',` to:

```js
    businessName: companyName || 'UN1T',
```

At the nudge call site (`sendNudge`, ~line 304), resolve branding (db + location are in scope) and pass it:

```js
  const branding = await getLocationBranding(db, location.id)
  const composed = await composeAgentText(location, settings, facts.rows, NUDGE_INSTRUCTION, branding.companyName)
```

At the check-in call site (~line 567): resolve `const branding = await getLocationBranding(db, location.id)` **once, just before the `for` loop** over check-in candidates in that function, then pass `branding.companyName` as the 5th arg:

```js
          const composed = await composeAgentText(
            location, settings, facts.rows, checkinInstruction(className), branding.companyName,
          )
```

- [ ] **Step 5: Run the agent tests**

Run: `npx vitest run src/lib/agent/prompt.test.js src/lib/agent/auto-reply.test.js src/lib/agent/followups.test.js`
Expected: PASS. (auto-reply/followups tests mock the Anthropic call; the added `db` branding read uses the same mocked client and falls back to `'UN1T'` if unmocked — assertions unchanged.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/prompt.test.js src/lib/agent/auto-reply.js src/lib/agent/followups.js
git commit -m "feat(branding): Mia agent businessName from company_settings"
```

---

### Task 4: De-hard-code the churn win-back message ("team at UN1T")

Extract the default win-back copy into a pure, tested helper, then resolve
branding in the route.

**Files:**
- Create: `src/lib/churn-winback.js`
- Create: `src/lib/churn-winback.test.js`
- Modify: `src/app/api/churn-radar/action/route.js` (~line 137)

- [ ] **Step 1: Write the failing test**

Create `src/lib/churn-winback.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { defaultWinbackMessage } from './churn-winback.js'

describe('defaultWinbackMessage', () => {
  it('uses the brand name', () => {
    expect(defaultWinbackMessage('Sam', 'CCF Autos')).toContain("team at CCF Autos")
  })

  it('falls back to UN1T when brand is blank', () => {
    expect(defaultWinbackMessage('Sam', '')).toContain('team at UN1T')
  })

  it('greets the member by first name', () => {
    expect(defaultWinbackMessage('Sam', 'UN1T')).toContain('Hi Sam,')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/churn-winback.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

Create `src/lib/churn-winback.js`:

```js
// Default win-back copy for the churn radar's "winback_sent" action, when the
// operator hasn't typed their own message. Pure + tested so the brand name is
// operator-driven (company_settings.company_name) rather than hard-coded.
export function defaultWinbackMessage(firstName, companyName) {
  const brand = (companyName || '').trim() || 'UN1T'
  return (
    `Hi ${firstName}, it's the team at ${brand} — we've noticed you've not been in for a bit and wanted to check in. ` +
    "Anything we can do to help you get back to it? We'd love to see you in class soon."
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/churn-winback.test.js`
Expected: PASS (3 passing).

- [ ] **Step 5: Wire the route**

In `src/app/api/churn-radar/action/route.js`, add imports:

```js
import { getLocationBranding } from '@/lib/location-branding'
import { defaultWinbackMessage } from '@/lib/churn-winback'
```

Inside the `winback_sent` branch, after `firstName` is computed and before building `message`, resolve branding (`db` + `locationId` are already in scope) and use the helper:

```js
    const branding = await getLocationBranding(db, locationId)
    const message = body?.message
      ? String(body.message).slice(0, 1000)
      : defaultWinbackMessage(firstName, branding.companyName)
```

- [ ] **Step 6: Verify**

Run: `npx vitest run src/lib/churn-winback.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/churn-winback.js src/lib/churn-winback.test.js src/app/api/churn-radar/action/route.js
git commit -m "feat(branding): churn win-back copy uses company_settings brand"
```

---

### Task 5: De-Tesla the CCF car deposit copy (no Xero)

The deposit SMS hard-codes "Tesla Car Deposit" even though `carLabel` is the
real make/model — a non-Tesla buyer gets the wrong copy. Fix the SMS (via a
tested helper), the deposit-return page title, and the `'Tesla'` fallbacks.
`src/lib/xero/**` and `cars/route.js` are deliberately untouched.

**Files:**
- Modify: `src/lib/deposit-receipts.js` (`buildReceiptBody` fallback ~135; add `buildDepositSmsBody`)
- Create or Modify: `src/lib/deposit-receipts.test.js`
- Modify: `src/app/api/cars/[id]/issue-deposit-link/route.js` (~lines 113, 119)
- Modify: `src/app/deposit/[token]/return/page.js` (~line 12)
- Modify: `src/app/api/public/deposit/[token]/accept-and-pay/route.js` (~line 131)

- [ ] **Step 1: Write the failing test**

Check whether a test file exists: `ls src/lib/deposit-receipts.test.js`.
If it exists, add the two `describe` blocks below to it (and ensure
`buildDepositSmsBody` is added to its import). If not, create
`src/lib/deposit-receipts.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { buildReceiptBody, buildDepositSmsBody } from './deposit-receipts.js'

describe('buildReceiptBody — no hard-coded make', () => {
  it('uses "your car" when the make is missing', () => {
    const body = buildReceiptBody({ car: { buyer_name: 'Sam Lee', deposit_amount: 500 }, location: { name: 'CCF Autos' } })
    expect(body).toContain('your car')
    expect(body).not.toContain('Tesla')
  })

  it('uses the actual make and model when present', () => {
    const body = buildReceiptBody({ car: { buyer_name: 'Sam', make: 'BMW', model: '3 Series', deposit_amount: 500 }, location: {} })
    expect(body).toContain('BMW 3 Series')
  })
})

describe('buildDepositSmsBody', () => {
  it('has no hard-coded Tesla and includes the real car label + amount', () => {
    const sms = buildDepositSmsBody({ firstName: 'Sam', amount: 500, carLabel: 'BMW 3 Series', link: 'https://pay/x' })
    expect(sms).not.toContain('Tesla')
    expect(sms).toContain('BMW 3 Series')
    expect(sms).toContain('€500.00')
    expect(sms).toContain('https://pay/x')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/deposit-receipts.test.js`
Expected: FAIL — `buildDepositSmsBody` is not exported; `buildReceiptBody` still emits "your Tesla".

- [ ] **Step 3: Update `deposit-receipts.js`**

Change the `buildReceiptBody` carLabel fallback (~line 135) from `'your Tesla'` to `'your car'`:

```js
  const carLabel =
    [car.make, car.model, car.irish_reg].map((p) => (p || '').trim()).filter(Boolean).join(' ') ||
    'your car'
```

Add a new exported helper (place it next to `buildReceiptBody`):

```js
/**
 * Buyer-facing deposit-link SMS. Uses the actual car label (make/model/reg)
 * the caller already computed — no hard-coded make. Kept short for a single
 * Twilio segment where the label allows.
 * @param {object} args { firstName, amount, carLabel, link }
 */
export function buildDepositSmsBody({ firstName, amount, carLabel, link }) {
  return `Hi ${firstName}, your €${Number(amount).toFixed(2)} deposit for ${carLabel}: ${link} (link valid 24h)`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/deposit-receipts.test.js`
Expected: PASS.

- [ ] **Step 5: Wire `issue-deposit-link/route.js`**

Add the import:

```js
import { buildDepositSmsBody } from '@/lib/deposit-receipts'
```

Change the carLabel fallback (~line 113) from `'your Tesla'` to `'your car'`:

```js
  const carLabel = [car.make, car.model, car.irish_reg].filter(Boolean).join(' ').trim() || 'your car'
```

Replace the inline SMS body (~line 119) with the helper:

```js
  const smsBody = buildDepositSmsBody({ firstName: buyerFirstName, amount, carLabel, link })
```

- [ ] **Step 6: Fix the deposit-return page title**

In `src/app/deposit/[token]/return/page.js` (~line 12), change:

```js
export const metadata = {
  title: 'Car Deposit',
}
```

- [ ] **Step 7: Fix the accept-and-pay fallback**

In `src/app/api/public/deposit/[token]/accept-and-pay/route.js` (~line 131), change the fallback from `'Tesla'` to `'your car'`:

```js
    const carLabel = [car.make, car.model].filter(Boolean).join(' ') || 'your car'
```

- [ ] **Step 8: Verify + grep for stray customer-facing "Tesla"**

Run: `npx vitest run src/lib/deposit-receipts.test.js`
Expected: PASS.

Run: `grep -rn "Tesla" src/app/deposit src/app/api/public/deposit src/app/api/cars/\[id\]/issue-deposit-link src/lib/deposit-receipts.js`
Expected: no remaining customer-facing "Tesla" (the only hits, if any, should be none; `src/lib/xero/**` and `cars/route.js` are intentionally out of scope and not in this grep).

- [ ] **Step 9: Commit**

```bash
git add src/lib/deposit-receipts.js src/lib/deposit-receipts.test.js "src/app/api/cars/[id]/issue-deposit-link/route.js" "src/app/deposit/[token]/return/page.js" "src/app/api/public/deposit/[token]/accept-and-pay/route.js"
git commit -m "fix(cars): de-Tesla buyer deposit copy, use real vehicle label"
```

---

### Task 6: champ-app configurable support email (separate repo + PR)

**Repo:** `~/code/champ-app` — branch off its fresh `origin/main` first:
`git -C ~/code/champ-app fetch origin && git -C ~/code/champ-app checkout -b support-email-configurable origin/main`

**Files:**
- Create: `shared/brand.js`
- Create: `shared/brand.test.js`
- Modify: `src/app/page.jsx` (~line 47)

- [ ] **Step 1: Write the failing test**

Create `shared/brand.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { SUPPORT_EMAIL } from './brand.js'

describe('SUPPORT_EMAIL', () => {
  it('defaults to the champ fitness support address', () => {
    expect(SUPPORT_EMAIL).toBe('hello@champfitness.ie')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/code/champ-app && npx vitest run shared/brand.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the constant**

Create `shared/brand.js`:

```js
// Customer-facing support address. Lives in shared/ (the web↔mobile seam) so
// both the web app and the native app use one value. Overridable via
// EXPO_PUBLIC_SUPPORT_EMAIL so a rebrand needs no code change; defaults to the
// current address.
export const SUPPORT_EMAIL =
  (typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_SUPPORT_EMAIL) ||
  'hello@champfitness.ie'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/code/champ-app && npx vitest run shared/brand.test.js`
Expected: PASS.

- [ ] **Step 5: Use it in the error copy**

In `src/app/page.jsx`, add the import (top of file, with the other imports):

```js
import { SUPPORT_EMAIL } from '../../shared/brand.js'
```

Change the support-email line (~line 47) from the literal to the constant:

```jsx
          We couldn&apos;t load your profile. Please try refreshing — if it
          keeps happening, drop us a line at {SUPPORT_EMAIL}.
```

- [ ] **Step 6: Verify build + tests**

Run: `cd ~/code/champ-app && npx vitest run shared/brand.test.js && npm run build`
Expected: tests PASS; build succeeds. (If the repo has no `build` script, run its lint/test scripts as listed in `package.json` instead.)

- [ ] **Step 7: Commit**

```bash
git -C ~/code/champ-app add shared/brand.js shared/brand.test.js src/app/page.jsx
git -C ~/code/champ-app commit -m "feat(brand): configurable support email via shared/brand"
```

---

### Task 7: Full un1t-crm verification + push (Tasks 1–5)

- [ ] **Step 1: Run the full CI mirror (all 6 checks)**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
```
Expected: all pass. The guardrails step is the one most likely to react to new supabase calls — `getLocationBranding` is `.limit(1)` + `try/await/catch`, so it must stay clean.

- [ ] **Step 2: Production build (import/route changes)**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Manual smoke (live DB, optional but recommended)**

Set Stillorgan's `company_settings.company_name` to a test value and confirm the agent prompt and a WhatsApp `location_name` substitution reflect it; revert after. (The Stillorgan location id is `a0000000-…-0001`.)

- [ ] **Step 4: Push both branches and open the two PRs**

```bash
git push -u origin p1-3-operator-editable-branding
git -C ~/code/champ-app push -u origin support-email-configurable
```
Open one PR per repo. un1t-crm PR body lists Components 1–5; champ-app PR is Component 6. Reference the spec.

- [ ] **Step 5: File the two out-of-scope latent-bug follow-ups**

Note for separate tickets (do NOT fix here): (a) `src/lib/contracts-email.js:33` reads a non-existent `company_branding` table; (b) `src/lib/contractor-invoice-email.js:66` embeds `logo_url`/`company_name` off `locations` (columns live on `company_settings`).

---

## Self-Review

**Spec coverage:**
- Component 1 (helper + route reuse) → Task 1. ✓
- Component 2 Class A: Mia → Task 3; WhatsApp `location_name` → Task 2; churn win-back → Task 4; churn-digest → **investigated, no change needed** (passes `loc.name`, not a hard-coded leak — documented in Task 2's note and the spec's scope); `prompt.js` already has the fallback (Task 3 pins it). ✓
- Component 3 Class B (de-Tesla, no Xero) → Task 5. ✓
- Component 4 Class C (champ-app) → Task 6. ✓
- Out-of-scope latent bugs filed → Task 7 Step 5. ✓
- Tests + 6-check CI + build → Task 7. ✓

**Placeholder scan:** every code step shows complete code; no TBD/TODO. The only "~line N" references are anchors for edits whose exact before/after code is given. ✓

**Type/name consistency:** `getLocationBranding(db, locationId) → { companyName, logoUrl, faviconUrl }` used identically in Tasks 1–4; `companyName` (never `company_name`) on the resolved object throughout; `buildDepositSmsBody({ firstName, amount, carLabel, link })` defined and called with the same shape; `defaultWinbackMessage(firstName, companyName)` consistent; `SUPPORT_EMAIL` consistent. ✓
