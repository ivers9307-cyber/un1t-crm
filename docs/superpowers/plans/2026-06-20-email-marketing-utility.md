# Email Marketing/Utility Send Type — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator pick **Marketing** or **Utility** when composing an email — Utility ignores the marketing opt-out (honors the transactional opt-out + hard signals) and sends via Postmark's transactional stream.

**Architecture:** Drives the already-existing-but-dormant `campaigns.postmark_stream` (`broadcast`/`outbound`). The audience consent gate is parameterized (`email_marketing` vs `email_administrative`); `email_administrative` is denormalized onto `contacts` (mig 301, mirroring mig 155) to keep the query single-table. API/UI speak `email_type` (marketing/utility); only the DB layer uses `postmark_stream`.

**Tech Stack:** Next.js 16, Supabase/Postgres, Postmark (two streams), Vitest, Zod.

**Spec:** `docs/EMAIL_MARKETING_UTILITY_2026-06.md`

**Working directory:** `/Users/richardivers/code/un1t-crm-event-filter` (worktree, branch `email-marketing-utility`, off the post-#612 `main`). All paths repo-relative; run commands from here.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `supabase/migrations/301_denormalise_email_administrative.sql` | Denormalize `email_administrative` onto `contacts` + sync trigger | Create |
| `src/lib/postmark.js` | `consentFieldForStream` helper; `consentField` option on `buildAudienceQuery`/`buildAudienceQueryAsync` (whitelisted) | Modify |
| `src/lib/postmark.test.js` | Unit tests for the helper + the gate | Modify |
| `src/lib/campaign-sender.js` | Stream-driven consent gate + Postmark stream + skip unsubscribe for `outbound` + recipient stream | Modify |
| `src/app/api/communications/email-draft/route.js` | Accept `email_type` → set `postmark_stream` on insert | Modify |
| `src/app/api/communications/email-draft/route.test.js` | Route test | Create |
| `src/app/api/campaigns/[id]/route.js` | Accept `email_type` on PUT → map to `postmark_stream` | Modify |
| `src/app/api/campaigns/[id]/preview/route.js` | Pass `consentField` from the campaign's stream | Modify |
| `src/components/communications/UnifiedSendComposer.jsx` | Marketing/Utility toggle (default Marketing) + helper; include in both email-draft payloads | Modify |
| `src/components/CampaignEditor.jsx` | Same toggle in the Settings tab; include in the PUT payload | Modify |

---

## Task 1: Migration 301 — denormalize `email_administrative`

**Files:**
- Create: `supabase/migrations/301_denormalise_email_administrative.sql`

- [ ] **Step 1: Write the migration** (mirrors mig 155's `email_marketing` pattern exactly; no index — `email_administrative=true` is the ~universal default, so a partial index on it is low-selectivity)

```sql
-- ============================================================
-- 301: denormalise email_administrative onto contacts
--
-- Mirrors mig 155 (email_marketing). Lets the single-table audience
-- query gate a Utility (transactional) email on the administrative
-- opt-out without a PostgREST embed on contact_preferences (which
-- breaks count-under-head:true — see CLAUDE.md). contact_preferences
-- stays the source of truth; the contacts column is a trigger-synced
-- read-only mirror.
--
-- No index: unlike email_marketing (many opt-outs → selective partial
-- index), email_administrative=true is the near-universal default, so
-- a partial WHERE email_administrative=true index covers ~all rows.
-- ============================================================

BEGIN;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_administrative BOOLEAN NOT NULL DEFAULT TRUE;

-- BACKFILL from contact_preferences
UPDATE contacts c
SET email_administrative = COALESCE(p.email_administrative, true)
FROM contact_preferences p
WHERE p.contact_id = c.id
  AND c.email_administrative IS DISTINCT FROM COALESCE(p.email_administrative, true);

-- TRIGGER — keep contacts.email_administrative in sync
CREATE OR REPLACE FUNCTION sync_contacts_email_administrative()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE contacts
  SET email_administrative = NEW.email_administrative
  WHERE id = NEW.contact_id
    AND email_administrative IS DISTINCT FROM NEW.email_administrative;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_contacts_email_administrative_trigger ON contact_preferences;
CREATE TRIGGER sync_contacts_email_administrative_trigger
AFTER INSERT OR UPDATE OF email_administrative ON contact_preferences
FOR EACH ROW
EXECUTE FUNCTION sync_contacts_email_administrative();

COMMENT ON COLUMN contacts.email_administrative IS
  'Denormalised mirror of contact_preferences.email_administrative (mig 301). Trigger-synced, read-only to app code. Powers the Utility (transactional) email audience gate.';

COMMIT;
```

- [ ] **Step 2: Apply to prod via the Supabase MCP**

Use the `apply_migration` MCP tool with name `301_denormalise_email_administrative` and the SQL above. (Low-risk: additive column with default + idempotent backfill + trigger. The mirror column is harmless on prod even before any code reads it; it MUST exist before the new code deploys — apply BEFORE merging.)

- [ ] **Step 3: Verify the column + trigger + run the security advisor**

Via MCP `execute_sql`:
```sql
SELECT count(*) FILTER (WHERE email_administrative) AS opted_in,
       count(*) FILTER (WHERE NOT email_administrative) AS opted_out
FROM contacts;
```
Then run `get_advisors` (type=security) — expect no NEW findings (the `SET search_path = public` + `SECURITY DEFINER` matches mig 155, which is already clean).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/301_denormalise_email_administrative.sql
git commit -m "feat(db): denormalise email_administrative onto contacts (mig 301)"
```

---

## Task 2: `consentField` gate + `consentFieldForStream` helper

**Files:**
- Modify: `src/lib/postmark.js`
- Test: `src/lib/postmark.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/postmark.test.js`. First ensure the import includes the new names — find the existing import from `./postmark.js` and add `buildAudienceQuery`, `consentFieldForStream` to it (e.g. `import { applyMergeTags, buildUnsubscribeUrl, appendUnsubscribeFooter, toListUnsubscribeUrl, buildAudienceQuery, consentFieldForStream } from './postmark.js'`). Then add:

```js
// Fluent fake recording method calls (mirrors sms.test.js).
function makeFakeQuery() {
  const calls = []
  const builder = new Proxy({}, {
    get(_, method) {
      if (method === 'then') return undefined
      return (...args) => { calls.push({ method, args }); return builder }
    },
  })
  return { builder, calls }
}

describe('consentFieldForStream', () => {
  it('maps outbound → email_administrative, everything else → email_marketing', () => {
    expect(consentFieldForStream('outbound')).toBe('email_administrative')
    expect(consentFieldForStream('broadcast')).toBe('email_marketing')
    expect(consentFieldForStream(undefined)).toBe('email_marketing')
  })
})

describe('buildAudienceQuery — consent gate', () => {
  it('defaults to gating on email_marketing', () => {
    const { builder, calls } = makeFakeQuery()
    const db = { from: () => builder }
    buildAudienceQuery(db, { logic: 'and', filters: [] }, 'loc-uuid')
    expect(calls).toContainEqual({ method: 'eq', args: ['email_marketing', true] })
    expect(calls).toContainEqual({ method: 'not', args: ['email_status', 'in', '("bounced","complained")'] })
  })

  it('gates on email_administrative when consentField is passed', () => {
    const { builder, calls } = makeFakeQuery()
    const db = { from: () => builder }
    buildAudienceQuery(db, { logic: 'and', filters: [] }, 'loc-uuid', { consentField: 'email_administrative' })
    expect(calls).toContainEqual({ method: 'eq', args: ['email_administrative', true] })
    expect(calls).not.toContainEqual({ method: 'eq', args: ['email_marketing', true] })
  })

  it('rejects an unknown consentField (no arbitrary columns)', () => {
    const { builder } = makeFakeQuery()
    const db = { from: () => builder }
    expect(() => buildAudienceQuery(db, { logic: 'and', filters: [] }, 'loc-uuid', { consentField: 'profiles.role' }))
      .toThrow(/consentField/)
  })
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run src/lib/postmark.test.js -t "consentField|consent gate|consentFieldForStream"`
Expected: FAIL — `consentFieldForStream` not exported; `consentField` option ignored.

- [ ] **Step 3: Implement the helper + parameterize the gate**

In `src/lib/postmark.js`, add near the top of the audience-query section (just above `export function buildAudienceQuery`):

```js
// Email consent columns the audience gate may filter on. Whitelisted so a
// caller can never smuggle an arbitrary column into the .eq(). 'broadcast'
// (marketing) gates on email_marketing; 'outbound' (transactional/Utility)
// gates on email_administrative.
const ALLOWED_CONSENT_FIELDS = new Set(['email_marketing', 'email_administrative'])

export function consentFieldForStream(stream) {
  return stream === 'outbound' ? 'email_administrative' : 'email_marketing'
}

function assertConsentField(consentField) {
  if (!ALLOWED_CONSENT_FIELDS.has(consentField)) {
    throw new Error(`Invalid consentField: ${consentField}`)
  }
  return consentField
}
```

Then change `buildAudienceQuery`'s signature + gate. Replace:

```js
export function buildAudienceQuery(db, filter, locationId, { columns = '*', selectOpts } = {}) {
```
with:
```js
export function buildAudienceQuery(db, filter, locationId, { columns = '*', selectOpts, consentField = 'email_marketing' } = {}) {
```
and inside it replace the line `.eq('email_marketing', true)` with `.eq(assertConsentField(consentField), true)`.

Do the same for `buildAudienceQueryAsync`: change its signature to add `consentField = 'email_marketing'` to the options bag, and replace its `.eq('email_marketing', true)` with `.eq(assertConsentField(consentField), true)`.

- [ ] **Step 4: Run — verify it passes**

Run: `npx vitest run src/lib/postmark.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/postmark.js src/lib/postmark.test.js
git commit -m "feat(email): parameterise audience consent gate (email_marketing/email_administrative)"
```

---

## Task 3: `email-draft` route — `email_type` → `postmark_stream`

**Files:**
- Modify: `src/app/api/communications/email-draft/route.js`
- Test: `src/app/api/communications/email-draft/route.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `src/app/api/communications/email-draft/route.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

beforeEach(() => { vi.clearAllMocks() })

function dbCapturingInsert(captured) {
  const chain = {
    insert: (row) => { captured.row = row; return chain },
    select: () => chain,
    single: () => Promise.resolve({ data: { id: 'camp-1' }, error: null }),
  }
  return { from: () => chain }
}

function req(body) {
  return new Request('http://localhost/api/communications/email-draft', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

it('maps email_type=utility → postmark_stream=outbound on insert', async () => {
  getCurrentUser.mockResolvedValue({ id: 'u1', activeLocation: { id: 'loc-1' }, role: 'owner' })
  const captured = {}
  createServerClient.mockReturnValue(dbCapturingInsert(captured))
  const res = await POST(req({ location_id: 'loc-1', name: 'Workshop logistics', email_type: 'utility' }))
  expect(res.status).toBe(200)
  expect(captured.row.postmark_stream).toBe('outbound')
})

it('defaults to postmark_stream=broadcast when email_type omitted', async () => {
  getCurrentUser.mockResolvedValue({ id: 'u1', activeLocation: { id: 'loc-1' }, role: 'owner' })
  const captured = {}
  createServerClient.mockReturnValue(dbCapturingInsert(captured))
  const res = await POST(req({ location_id: 'loc-1', name: 'June newsletter' }))
  expect(res.status).toBe(200)
  expect(captured.row.postmark_stream).toBe('broadcast')
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run src/app/api/communications/email-draft/route.test.js`
Expected: FAIL — `postmark_stream` is undefined on the captured row.

- [ ] **Step 3: Implement**

In `src/app/api/communications/email-draft/route.js`:
- Add to the Zod `Schema`: `email_type: z.enum(['marketing', 'utility']).optional(),`
- Add `email_type` to the destructure: `const { location_id, name, subject, audience_filter, html_content, design_json, action = 'draft', scheduled_at, email_type = 'marketing' } = validation.data`
- Add to the `row` object: `postmark_stream: email_type === 'utility' ? 'outbound' : 'broadcast',`

- [ ] **Step 4: Run — verify it passes**

Run: `npx vitest run src/app/api/communications/email-draft/route.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/communications/email-draft/route.js src/app/api/communications/email-draft/route.test.js
git commit -m "feat(email-draft): email_type → campaigns.postmark_stream"
```

---

## Task 4: Campaign PUT — `email_type` → `postmark_stream`

**Files:**
- Modify: `src/app/api/campaigns/[id]/route.js`

- [ ] **Step 1: Add `email_type` to the update schema**

In `src/app/api/campaigns/[id]/route.js`, add to `CampaignUpdateSchema`:

```js
  email_type: z.enum(['marketing', 'utility']).optional(),
```

- [ ] **Step 2: Map it to `postmark_stream` in the handler**

In the `PUT` handler, right after `const updates = { ...validation.data }`, add:

```js
  // API speaks email_type (marketing/utility); the column is postmark_stream.
  if (updates.email_type !== undefined) {
    updates.postmark_stream = updates.email_type === 'utility' ? 'outbound' : 'broadcast'
    delete updates.email_type
  }
```

- [ ] **Step 3: Verify nothing regressed**

Run: `npx vitest run`
Expected: PASS (no test references `email_type` on this route yet; this is plumbing covered by the composer/editor + the email-draft test).

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/campaigns/[id]/route.js"
git commit -m "feat(campaigns): accept email_type on PUT → postmark_stream"
```

---

## Task 5: `campaign-sender` — drive stream + consent + suppress unsubscribe for Utility

**Files:**
- Modify: `src/lib/campaign-sender.js`

The sender is integration-shaped (no unit harness — "integration-tested implicitly through the API route + manual sends"); the testable logic lives in the Task 2 helper + audience gate. This task wires them in.

- [ ] **Step 1: Confirm the campaign object carries `postmark_stream`**

Run: `grep -rn "postmark_stream\|select(" src/app/api/cron/run-campaigns/route.js src/lib/campaign-sender.js | grep -i "campaign\|select\|postmark" | head`

The `campaign` object is passed into the tick function. Ensure whatever query loads it selects `postmark_stream` (or `*`). If it selects an explicit column list **without** `postmark_stream`, add `postmark_stream` to that select. (If it uses `select('*')`, nothing to change.)

- [ ] **Step 2: Import the helper + derive stream/consent**

In `src/lib/campaign-sender.js`, add `consentFieldForStream` to the existing import from `./postmark.js`:

```js
import { buildAudienceQueryAsync, applyMergeTags, buildUnsubscribeUrl, appendUnsubscribeFooter, sendBatch, consentFieldForStream } from './postmark.js'
```

At the top of the tick function (right after `const campaignId = campaign.id`), add:

```js
  // Marketing (broadcast) vs Utility (outbound). Drives the consent gate,
  // the Postmark stream, and whether an unsubscribe footer is appended.
  const stream = campaign.postmark_stream === 'outbound' ? 'outbound' : 'broadcast'
  const consentField = consentFieldForStream(stream)
```

- [ ] **Step 3: Gate the audience populate by consentField**

In Phase 1 (populate), change the audience call:

```js
      const { query } = await buildAudienceQueryAsync(db, campaign.audience_filter, campaign.location_id)
```
to:
```js
      const { query } = await buildAudienceQueryAsync(db, campaign.audience_filter, campaign.location_id, { consentField })
```

- [ ] **Step 4: Stream-aware unsubscribe + send in Phase 2**

In the Phase 2 send loop, make the unsubscribe URL conditional and thread the stream. Replace the per-recipient block that currently reads (around the `buildUnsubscribeUrl` / `appendUnsubscribeFooter` / `emailBatch.push` lines):

```js
    const unsubscribeUrl = buildUnsubscribeUrl(contact, baseUrl)
```
with:
```js
    // Utility (outbound) emails carry no marketing chrome — no unsubscribe
    // footer, no List-Unsubscribe header, empty {{unsubscribe_url}} merge tag.
    const unsubscribeUrl = stream === 'broadcast' ? buildUnsubscribeUrl(contact, baseUrl) : null
```

Replace the footer line:
```js
    const personalizedHtml = appendUnsubscribeFooter(merged, unsubscribeUrl)
```
with:
```js
    const personalizedHtml = unsubscribeUrl ? appendUnsubscribeFooter(merged, unsubscribeUrl) : merged
```

In the `emailBatch.push({...})` object, change the hardcoded `stream: 'broadcast'` to `stream,` (the derived value). `unsubscribeUrl` is already passed and is now `null` for outbound (the sender drops the `List-Unsubscribe` header when stream is `outbound`).

- [ ] **Step 5: Stamp the recipient row's stream**

Find the recipient/send-record write that hardcodes `postmark_stream: 'broadcast'` and change it to `postmark_stream: stream,`.

- [ ] **Step 6: Verify build + suite**

Run: `npx vitest run && npm run build`
Expected: tests PASS; build succeeds (catches any import/typo in the sender).

- [ ] **Step 7: Commit**

```bash
git add src/lib/campaign-sender.js
git commit -m "feat(campaign-sender): drive Postmark stream + consent gate from postmark_stream"
```

---

## Task 6: Campaign preview reflects the type

**Files:**
- Modify: `src/app/api/campaigns/[id]/preview/route.js`

- [ ] **Step 1: Ensure the campaign select includes `postmark_stream`**

Run: `grep -n "select(\|postmark_stream\|buildAudienceQueryAsync\|audience_filter" "src/app/api/campaigns/[id]/preview/route.js"`

If the route loads the campaign with an explicit column list lacking `postmark_stream`, add it (or it already uses `*`).

- [ ] **Step 2: Pass `consentField` derived from the stream**

Import the helper and pass it. Add to the import from `@/lib/postmark`: `consentFieldForStream`. Then change the `buildAudienceQueryAsync(...)` call to include `{ consentField: consentFieldForStream(campaign.postmark_stream), ... }` (merge with any existing options like `columns`/`selectOpts` it already passes).

- [ ] **Step 3: Verify**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/campaigns/[id]/preview/route.js"
git commit -m "feat(campaigns): preview reflects marketing/utility consent gate"
```

---

## Task 7: UnifiedSendComposer — Marketing/Utility toggle

**Files:**
- Modify: `src/components/communications/UnifiedSendComposer.jsx`

UI wiring — verified by build + manual click-test (codebase convention for client components).

- [ ] **Step 1: Add the state**

Near the other email state (`const [subject, setSubject] = useState('')`, ~line 35), add:

```js
  const [emailType, setEmailType] = useState('marketing') // 'marketing' | 'utility'
```

- [ ] **Step 2: Render the toggle in the email compose section**

Immediately above the Subject `<label>` block (the one at ~line 373 with `Subject` / `value={subject}`), insert:

```jsx
              <div className="mb-3">
                <span className="block text-xs font-medium text-un1t-subtle mb-1">Email type</span>
                <div className="inline-flex rounded-md border border-un1t-border overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setEmailType('marketing')}
                    className={`px-3 py-1.5 text-sm ${emailType === 'marketing' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
                  >Marketing</button>
                  <button
                    type="button"
                    onClick={() => setEmailType('utility')}
                    className={`px-3 py-1.5 text-sm border-l border-un1t-border ${emailType === 'utility' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
                  >Utility</button>
                </div>
                {emailType === 'utility' && (
                  <p className="mt-1 text-xs text-amber-700">
                    Booking/transactional only — ignores marketing opt-out. Using this for marketing breaches consent.
                  </p>
                )}
              </div>
```

- [ ] **Step 3: Include `email_type` in both email-draft payloads**

In the send handler payload (~line 180) and in `openFullEditor`'s payload (~line 203), add `email_type: emailType,` to each `postJson('/api/communications/email-draft', { ... })` object.

- [ ] **Step 4: Verify lint + build**

Run: `npm run lint && npm run build`
Expected: lint clean (use `type="button"` on the toggle buttons — already included — so they don't submit any wrapping form); build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/communications/UnifiedSendComposer.jsx
git commit -m "feat(send-ui): Marketing/Utility toggle in the unified composer"
```

---

## Task 8: CampaignEditor — Marketing/Utility toggle in Settings

**Files:**
- Modify: `src/components/CampaignEditor.jsx`

- [ ] **Step 1: Add the state (seeded from the loaded campaign)**

Near the other settings state (`const [fromName, setFromName] = useState(...)`, ~line 19), add:

```js
  const [emailType, setEmailType] = useState(campaign?.postmark_stream === 'outbound' ? 'utility' : 'marketing')
```

- [ ] **Step 2: Render the toggle in the Settings tab**

In the Settings tab JSX (where `from_name` / `preview_text` are edited; the tab is gated by `tab === 'settings'`), add the same toggle block as Task 7 Step 2 (Marketing/Utility buttons + the Utility helper line). Reuse identical markup so the two surfaces look the same.

- [ ] **Step 3: Include `email_type` in the PUT payload**

Find the save handler that PUTs to `/api/campaigns/${campaign.id}` (the body object passed to the fetch/postJson). Add `email_type: emailType,` to that body.

- [ ] **Step 4: Verify lint + build**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/CampaignEditor.jsx
git commit -m "feat(campaign-editor): Marketing/Utility toggle in Settings"
```

---

## Task 9: Full verification + PR

**Files:** none.

- [ ] **Step 1: Full CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards
```
Expected: all green. (No `shared/permissions.js` change → parity unaffected — reuses the existing `email` permission.)

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Confirm migration 301 is applied to prod** (Task 1 Step 2). The code reads `contacts.email_administrative`, so prod MUST have the column before this merges. Re-verify via MCP `execute_sql`: `SELECT email_administrative FROM contacts LIMIT 1;` returns a row (not a "column does not exist" error).

- [ ] **Step 4: Push + open PR (base main)**

```bash
git push -u origin email-marketing-utility
```
Open a PR titled **"feat(email): Marketing/Utility send type"**, body covering: the dormant `postmark_stream` now driven, the `email_administrative` denormalization (mig 301 — applied to prod), the parameterized consent gate, the `outbound` stream suppressing unsubscribe chrome, and the two UI toggles. **Call out the migration ordering** (mig 301 applied to prod before merge). End with the `Verified:` line (tests/lint/build).

- [ ] **Step 5: Manual click-test (post-deploy, auth-gated)**

At `/communications/send` → Email → toggle **Utility** → audience "Registered for event X" → send a test to yourself with a marketing-opted-out contact in the audience and confirm it arrives (no unsubscribe footer). Confirm a **Marketing** send to the same audience excludes the opted-out contact.

---

## Self-Review

**Spec coverage:**
- §2 denormalize email_administrative → Task 1. ✅
- §3 parameterized consent gate (+whitelist) → Task 2. ✅
- §4 send path (stream + consent + suppress unsubscribe + recipient stream) → Task 5; preview → Task 6. ✅
- §5 composer toggle + email-draft `email_type`→`postmark_stream` → Tasks 3, 7; CampaignEditor + PUT → Tasks 4, 8. ✅
- §6 count unchanged → no task (deliberate non-goal). ✅
- §8 testing → Tasks 2, 3 (TDD); 5/6/7/8 build+manual; migration verified via MCP (no vitest migration harness in this repo). ✅

**Placeholder scan:** none — every code step has concrete code. Two "confirm the select includes postmark_stream" steps (Task 5.1, 6.1) are genuine verification-with-conditional-edit, not placeholders.

**Type/name consistency:** `consentFieldForStream(stream)`, `consentField` option, `email_type: 'marketing'|'utility'`, `postmark_stream: 'broadcast'|'outbound'`, `emailType` React state — used consistently across all tasks. The API boundary is always `email_type`; the DB column is always `postmark_stream`; the audience option is always `consentField`.

**Note for the implementer:** Tasks are sequential. Task 5/6 depend on Task 2's `consentFieldForStream`. Line numbers are approximate — anchor on the quoted surrounding code. Task 1 Step 2 (apply migration to prod) is the one step touching the live DB; it's additive + idempotent, but must precede merge.
