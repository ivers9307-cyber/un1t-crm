# Session Report Slice 3 — next_action CTA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the report's `next_action` slot with a context-aware, operator-editable CTA — active members get "Book your next class", everyone else gets "Become a member" — with both the URLs and the button copy editable post-deploy (no code release).

**Architecture:** Three new operator-editable fields on `locations.settings.customer_agent` (JSONB, **no migration**) — `booking_url`, `booking_cta_label`, `membership_cta_label` — alongside the existing `membership_signup_url`. A pure `buildNextAction({stage, bookingUrl, bookingLabel, membershipSignupUrl, membershipLabel})` in the byte-identical report builder keys on `pipeline_stage_slug`. The loaders resolve a `cta` bundle (champ-app reads the location URLs via a service client since the customer RLS client can't read `locations`) and pass it in `ctx.cta`. Rendered as a button on the champ-app session view + the post-class email; `null` (no CTA) until URLs are set. `SESSION_REPORT_VERSION` stays 1.

**Tech Stack:** Next.js 16, Supabase, Vitest, Tailwind. Two repos: `un1t-crm` (`/Users/richardivers/code/un1t-crm`) + `champ-app` (`/Users/richardivers/code/champ-app`).

**Spec:** `docs/superpowers/specs/2026-06-18-session-report-slice3-next-action-design.md`

---

## File structure

**un1t-crm — modify:**
- `src/app/api/settings/customer-agent/route.js` — add 3 fields to `DEFAULTS`, `SettingsSchema`, and the PUT write.
- `src/app/settings/customer-agent/page.js` — add 3 inputs + 3 payload fields.
- `src/lib/hr-session-report.js` — add `buildNextAction` + consts; wire `next_action`.
- `src/lib/__fixtures__/session-report.fixture.json` — add a `cta` block.
- `src/lib/hr-session-report.test.js` — assert `next_action` + add `buildNextAction` unit cases.
- `src/lib/hr-post-class-email.js` — `loadContextForSession` resolves `cta`; `composeEmail` passes it + renders the button.
- `src/app/api/settings/customer-agent/route.test.js` — **create**: assert the 3 new fields persist.

**champ-app — modify:**
- `src/lib/hr-session-report.js` — mirror `buildNextAction` + wiring (byte-identical below line 1).
- `src/lib/__fixtures__/session-report.fixture.json` — mirror the `cta` block.
- `src/lib/hr-session-report.test.js` — mirror assertions.
- `src/lib/load-session-report.js` — read `pipeline_stage_slug` + location CTA (service client); pass `cta`.
- `src/app/api/sessions/[id]/report/route.js` + `src/app/sessions/[id]/page.jsx` — pass a service client to the loader; render the CTA button on the page.

**No migration.** No new permission key (settings route already `MANAGER_ROLES`-gated).

---

### Task 1: Settings — 3 operator-editable CTA fields

**Files:**
- Modify: `un1t-crm/src/app/api/settings/customer-agent/route.js`
- Modify: `un1t-crm/src/app/settings/customer-agent/page.js`
- Create: `un1t-crm/src/app/api/settings/customer-agent/route.test.js`

- [ ] **Step 1: route.js — add the fields to `DEFAULTS`**

In `DEFAULTS`, after `membership_signup_url: null,` add:
```js
  booking_url: null,
  booking_cta_label: null,
  membership_cta_label: null,
```

- [ ] **Step 2: route.js — add to `SettingsSchema`**

After the `membership_signup_url` schema line, add:
```js
  booking_url: z.string().url().max(512).nullable().optional()
    .or(z.literal('').transform(() => null)),
  booking_cta_label: z.string().max(60).nullable().optional(),
  membership_cta_label: z.string().max(60).nullable().optional(),
```

- [ ] **Step 3: route.js — write the fields in PUT**

In the `settings.customer_agent = { ... }` object, after `membership_signup_url: v.data.membership_signup_url || null,` add:
```js
    booking_url: v.data.booking_url || null,
    booking_cta_label: v.data.booking_cta_label?.trim() || null,
    membership_cta_label: v.data.membership_cta_label?.trim() || null,
```

- [ ] **Step 4: page.js — add the inputs**

In `src/app/settings/customer-agent/page.js`, immediately after the existing `membership_signup_url` `<div>` input block, add:
```jsx
      <div>
        <label className="block text-sm font-medium text-un1t-text mb-1">Class booking link</label>
        <input className={inputCls} maxLength={512} value={settings.booking_url || ''}
          onChange={e => setField('booking_url', e.target.value)}
          placeholder="https://…" />
        <p className="text-xs text-un1t-subtle mt-1">
          Where active members go to book their next class — used by the post-class report CTA. Leave blank and members see no booking button.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-un1t-text mb-1">Post-class CTA wording</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input className={inputCls} maxLength={60} value={settings.booking_cta_label || ''}
            onChange={e => setField('booking_cta_label', e.target.value)}
            placeholder="Book your next class" />
          <input className={inputCls} maxLength={60} value={settings.membership_cta_label || ''}
            onChange={e => setField('membership_cta_label', e.target.value)}
            placeholder="Become a member" />
        </div>
        <p className="text-xs text-un1t-subtle mt-1">
          Button text shown to members (left, booking) and to trials / prospects (right, join). Leave blank to use the defaults shown.
        </p>
      </div>
```

- [ ] **Step 5: page.js — add to the save payload**

In `saveSettings`'s `payload`, after `membership_signup_url: (settings.membership_signup_url || '').trim() || null,` add:
```js
        booking_url: (settings.booking_url || '').trim() || null,
        booking_cta_label: (settings.booking_cta_label || '').trim() || null,
        membership_cta_label: (settings.membership_cta_label || '').trim() || null,
```

- [ ] **Step 6: Write the route test**

`un1t-crm/src/app/api/settings/customer-agent/route.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { PUT } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

beforeEach(() => vi.clearAllMocks())

function putReq(body) {
  return new Request('http://x/api/settings/customer-agent', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('PUT /api/settings/customer-agent — CTA fields', () => {
  it('403 for a non-manager', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'staff', activeLocation: { id: 'loc1' } })
    expect((await PUT(putReq({ enabled: true }))).status).toBe(403)
  })

  it('persists booking_url + the two CTA labels into settings.customer_agent', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: 'loc1' } })
    let written = null
    createServerClient.mockReturnValue({
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { settings: {} }, error: null }) }) }),
        update: (patch) => { written = patch; return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'loc1' }, error: null }) }) }) } },
      }),
    })
    const res = await PUT(putReq({
      enabled: true,
      membership_signup_url: 'https://join.example',
      booking_url: 'https://book.example/ride',
      booking_cta_label: 'Book a class',
      membership_cta_label: 'Join us',
    }))
    expect(res.status).toBe(200)
    expect(written.settings.customer_agent).toMatchObject({
      membership_signup_url: 'https://join.example',
      booking_url: 'https://book.example/ride',
      booking_cta_label: 'Book a class',
      membership_cta_label: 'Join us',
    })
  })

  it('coerces blank/invalid to null', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: 'loc1' } })
    let written = null
    createServerClient.mockReturnValue({
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { settings: {} }, error: null }) }) }),
        update: (patch) => { written = patch; return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'loc1' }, error: null }) }) }) } },
      }),
    })
    const res = await PUT(putReq({ enabled: true, booking_url: '', booking_cta_label: '   ' }))
    expect(res.status).toBe(200)
    expect(written.settings.customer_agent.booking_url).toBeNull()
    expect(written.settings.customer_agent.booking_cta_label).toBeNull()
  })
})
```

- [ ] **Step 7: Run the test**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/app/api/settings/customer-agent/route.test.js`
Expected: PASS (3 tests). (If the existing route never had a test, this is the first — confirm `PUT` is exported, which it is.)

- [ ] **Step 8: Commit**

```bash
cd /Users/richardivers/code/un1t-crm
git add src/app/api/settings/customer-agent/route.js src/app/settings/customer-agent/page.js src/app/api/settings/customer-agent/route.test.js
git commit -m "SESSION-REPORT.3 — operator-editable booking_url + CTA labels on customer-agent settings

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `buildNextAction` + builder wiring (un1t-crm)

**Files:**
- Modify: `un1t-crm/src/lib/hr-session-report.js`
- Modify: `un1t-crm/src/lib/__fixtures__/session-report.fixture.json`
- Modify: `un1t-crm/src/lib/hr-session-report.test.js`

- [ ] **Step 1: Add a `cta` block to the fixture**

In `un1t-crm/src/lib/__fixtures__/session-report.fixture.json`, inside `ctx` (e.g. after `eventTypeName`), add:
```json
    "cta": {
      "stage": "active_member",
      "bookingUrl": "https://book.example/ride",
      "bookingLabel": "Book your next class",
      "membershipSignupUrl": "https://join.example",
      "membershipLabel": "Become a member"
    },
```

- [ ] **Step 2: Add the failing assertions**

In `un1t-crm/src/lib/hr-session-report.test.js`, add an import for the new exports at the top (extend the existing import):
```js
import { buildSessionReport, SESSION_REPORT_VERSION, buildNextAction, DEFAULT_BOOK_CTA, DEFAULT_JOIN_CTA } from './hr-session-report.js'
```
Add a `next_action` assertion to the main report block:
```js
  it('fills next_action for an active member (book branch)', () => {
    expect(report.next_action).toEqual({ type: 'book_class', label: 'Book your next class', url: 'https://book.example/ride' })
  })
```
And a `buildNextAction` unit block:
```js
describe('buildNextAction', () => {
  const base = { stage: 'active_member', bookingUrl: 'https://b', bookingLabel: 'Book', membershipSignupUrl: 'https://j', membershipLabel: 'Join' }
  it('members → book_class with custom label', () => {
    expect(buildNextAction(base)).toEqual({ type: 'book_class', label: 'Book', url: 'https://b' })
  })
  it('at_risk_member counts as a member', () => {
    expect(buildNextAction({ ...base, stage: 'at_risk_member' }).type).toBe('book_class')
  })
  it('prospect → join', () => {
    expect(buildNextAction({ ...base, stage: 'active_trial' })).toEqual({ type: 'join', label: 'Join', url: 'https://j' })
  })
  it('null/unknown stage → join', () => {
    expect(buildNextAction({ ...base, stage: null }).type).toBe('join')
  })
  it('blank label → default copy', () => {
    expect(buildNextAction({ ...base, bookingLabel: '' }).label).toBe(DEFAULT_BOOK_CTA)
    expect(buildNextAction({ ...base, stage: 'lapsed', membershipLabel: null }).label).toBe(DEFAULT_JOIN_CTA)
  })
  it('chosen branch URL unset → null', () => {
    expect(buildNextAction({ ...base, bookingUrl: null })).toBeNull()
    expect(buildNextAction({ ...base, stage: 'lapsed', membershipSignupUrl: null })).toBeNull()
  })
  it('null cta → null', () => {
    expect(buildNextAction(null)).toBeNull()
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/hr-session-report.test.js`
Expected: FAIL — `buildNextAction` not exported; `next_action` is `null`.

- [ ] **Step 4: Implement `buildNextAction` + wire it**

In `un1t-crm/src/lib/hr-session-report.js`, after `export const SESSION_REPORT_VERSION = 1`, add:
```js
export const DEFAULT_BOOK_CTA = 'Book your next class'
export const DEFAULT_JOIN_CTA = 'Become a member'
const MEMBER_STAGES = ['active_member', 'at_risk_member']

/**
 * Context-aware post-class CTA. Active members → book; everyone else → join.
 * Labels are operator-editable (cta.bookingLabel / cta.membershipLabel); the
 * DEFAULT_* consts are placeholder fallbacks only. Returns null when the chosen
 * branch's URL is unset (no broken/empty button). Pure.
 */
export function buildNextAction(cta) {
  if (!cta) return null
  const isMember = MEMBER_STAGES.includes(cta.stage)
  if (isMember) {
    if (!cta.bookingUrl) return null
    return { type: 'book_class', label: cta.bookingLabel || DEFAULT_BOOK_CTA, url: cta.bookingUrl }
  }
  if (!cta.membershipSignupUrl) return null
  return { type: 'join', label: cta.membershipLabel || DEFAULT_JOIN_CTA, url: cta.membershipSignupUrl }
}
```
Then change the return line `next_action: null,` to:
```js
    next_action: buildNextAction(ctx.cta),
```

- [ ] **Step 5: Run to verify pass**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/hr-session-report.test.js`
Expected: PASS (existing + new; the all-cardio `vs_this_class`/`vs_category` assertions from Slices 1-2 still green).

- [ ] **Step 6: Commit**

```bash
cd /Users/richardivers/code/un1t-crm
git add src/lib/hr-session-report.js src/lib/__fixtures__/session-report.fixture.json src/lib/hr-session-report.test.js
git commit -m "SESSION-REPORT.3 — buildNextAction + next_action wiring (un1t-crm builder)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Email loader + render (un1t-crm)

**Files:**
- Modify: `un1t-crm/src/lib/hr-post-class-email.js`

- [ ] **Step 1: `loadContextForSession` — load stage + location CTA, return `cta`**

(a) In the session `.select(...)` contact embed, add `pipeline_stage_slug`:
```js
      contact:contacts!heart_rate_sessions_contact_id_fkey ( id, name, email, hr_post_class_emails_enabled, pipeline_stage_slug ),
```

(b) After the `categoryFor` definition (before the history fetch), add the location CTA read + bundle:
```js
  const { data: loc } = await db.from('locations').select('settings').eq('id', session.location_id).single()
  const ca = loc?.settings?.customer_agent || {}
  const cta = {
    stage: session.contact?.pipeline_stage_slug ?? null,
    bookingUrl: ca.booking_url ?? null,
    bookingLabel: ca.booking_cta_label ?? null,
    membershipSignupUrl: ca.membership_signup_url ?? null,
    membershipLabel: ca.membership_cta_label ?? null,
  }
```

(c) Add `cta` to the returned object:
```js
  return {
    ok: true,
    session,
    thisSession,
    history,
    eventTypeName: className,
    cta,
    contact: session.contact,
  }
```

- [ ] **Step 2: `composeEmail` — pass `cta` to the builder + render the button**

(a) Find the `buildSessionReport({ ... })` call inside `composeEmail` and add `cta: ctx.cta` to its ctx argument (alongside `session, thisSession, history, eventTypeName, achievements`).

(b) Compute a CTA snippet near the existing `vcLine` (use `report.next_action`):
```js
  const na = report.next_action
```

(c) In `renderHtml`, immediately BEFORE the unsubscribe `<p>` footer (and after the "View the full session" button `<p>`), add the CTA button when present. Pass `na` into `renderHtml` (mirror how `vcLine`/other fields are threaded), then:
```js
    ${na ? `
    <p style="margin:16px 0 0 0;text-align:center;">
      <a href="${escapeHtml(na.url)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;">
        ${escapeHtml(na.label)}
      </a>
    </p>` : ''}
```

(d) In `renderText`, add a line when present (mirror the `vcLine` push):
```js
  if (na) {
    lines.push('')
    lines.push(`${na.label}: ${na.url}`)
  }
```

(Adapt the exact threading to the file's render-function signatures — the plan's snippets match the existing button markup + the `vcLine` pattern.)

- [ ] **Step 3: Verify the existing email test still passes**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/hr-post-class-email.test.js`
Expected: PASS. The CTA is null-gated; if the test's context has no `cta`/location settings, `next_action` is null and no button renders. If the test asserts exact body text, confirm it still matches (the additions are conditional on `na`). If the test builds a context lacking `cta`, that's fine — `buildNextAction(undefined)` → null.

- [ ] **Step 4: Commit**

```bash
cd /Users/richardivers/code/un1t-crm
git add src/lib/hr-post-class-email.js
git commit -m "SESSION-REPORT.3 — email resolves cta + renders next_action button

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: champ-app — builder mirror + loader + view

**Files:**
- Modify: `champ-app/src/lib/hr-session-report.js`, `src/lib/__fixtures__/session-report.fixture.json`, `src/lib/hr-session-report.test.js`
- Modify: `champ-app/src/lib/load-session-report.js`
- Modify: `champ-app/src/app/api/sessions/[id]/report/route.js`, `src/app/sessions/[id]/page.jsx`

- [ ] **Step 1: Create the champ-app branch**

```bash
cd /Users/richardivers/code/champ-app
git checkout main && git pull origin main
git checkout -b session-report-slice3-next-action
```

- [ ] **Step 2: Mirror the builder (byte-identical below line 1)**

Apply Task 2 steps 1 + 4 to the champ-app copies: add the `cta` block to `src/lib/__fixtures__/session-report.fixture.json` (identical), and add `buildNextAction` + consts + the `next_action: buildNextAction(ctx.cta)` wiring to `src/lib/hr-session-report.js`. Verify identical below the header:
```bash
diff <(tail -n +2 /Users/richardivers/code/un1t-crm/src/lib/hr-session-report.js) <(tail -n +2 /Users/richardivers/code/champ-app/src/lib/hr-session-report.js)
diff /Users/richardivers/code/un1t-crm/src/lib/__fixtures__/session-report.fixture.json /Users/richardivers/code/champ-app/src/lib/__fixtures__/session-report.fixture.json
```
Both MUST be empty. Mirror the test assertions from Task 2 step 2 into champ-app's `src/lib/hr-session-report.test.js`.

- [ ] **Step 3: Run champ-app builder tests**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run src/lib/hr-session-report.test.js`
Expected: PASS.

- [ ] **Step 4: Loader — read stage + location CTA via a service client**

In `champ-app/src/lib/load-session-report.js`:

(a) Change the signature to accept a service client:
```js
export async function loadSessionReport(supabase, sessionId, { nowMs = Date.now(), serviceSupabase = null } = {}) {
```

(b) In the session `.select(...)`, add the contact embed for the stage (alongside the existing columns):
```js
      contact:contacts!heart_rate_sessions_contact_id_fkey ( pipeline_stage_slug ),
```

(c) After `categoryFor` is defined, add the location CTA read (service client) + bundle:
```js
  let ca = {}
  if (serviceSupabase) {
    const { data: loc } = await serviceSupabase.from('locations').select('settings').eq('id', session.location_id).maybeSingle()
    ca = loc?.settings?.customer_agent || {}
  }
  const cta = {
    stage: session.contact?.pipeline_stage_slug ?? null,
    bookingUrl: ca.booking_url ?? null,
    bookingLabel: ca.booking_cta_label ?? null,
    membershipSignupUrl: ca.membership_signup_url ?? null,
    membershipLabel: ca.membership_cta_label ?? null,
  }
```

(d) Add `cta` to the `buildSessionReport` ctx:
```js
  const report = buildSessionReport(
    { session, thisSession, history, eventTypeName: className, cta, achievements: achRows || [] },
    { nowMs },
  )
```

- [ ] **Step 5: Both callers pass a service client**

In `champ-app/src/app/api/sessions/[id]/report/route.js`, import `createServiceClient` and pass it:
```js
import { createServerClient, createServiceClient } from '@/lib/supabase-server'
// …
  const out = await loadSessionReport(supabase, params.id, { serviceSupabase: createServiceClient() })
```
(Confirm the import path/style matches the file's existing `createServerClient` import.)

In `champ-app/src/app/sessions/[id]/page.jsx`, same — import `createServiceClient` (extend the existing supabase-server import) and:
```js
  const reportOut = await loadSessionReport(supabase, params.id, { serviceSupabase: createServiceClient() })
```

- [ ] **Step 6: Render the CTA button on the session view**

In `champ-app/src/app/sessions/[id]/page.jsx`, immediately BEFORE the closing `</main>` (after the Zone breakdown `</section>`), add:
```jsx
      {report?.next_action && (
        <section className="mt-6 text-center">
          <a
            href={report.next_action.url}
            target="_blank"
            rel="noreferrer"
            className="inline-block rounded-xl bg-neutral-900 px-5 py-3 text-sm font-semibold text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {report.next_action.label}
          </a>
        </section>
      )}
```

- [ ] **Step 7: Build champ-app**

Run: `cd /Users/richardivers/code/champ-app && npm run build`
Expected: compiles clean (catches the `createServiceClient` import + JSX).

- [ ] **Step 8: Commit (champ-app)**

```bash
cd /Users/richardivers/code/champ-app
noglob git add src/lib/hr-session-report.js src/lib/__fixtures__/session-report.fixture.json src/lib/hr-session-report.test.js src/lib/load-session-report.js 'src/app/api/sessions/[id]/report/route.js' 'src/app/sessions/[id]/page.jsx'
git commit -m "SESSION-REPORT.3 — next_action CTA: builder mirror + loader (service-client URLs) + session-view button

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Ship — CI both repos, PRs, merge

**Files:** none (release). **No migration** for this slice.

- [ ] **Step 1: un1t-crm full CI mirror + build**

```bash
cd /Users/richardivers/code/un1t-crm
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run build
```
Expected: all green. (No new permission key → parity clean; the route already has its auth guard.)

- [ ] **Step 2: champ-app checks**

```bash
cd /Users/richardivers/code/champ-app && npm test && npm run build
```
Expected: green (run `npm run lint` too if present).

- [ ] **Step 3: Push both + open PRs (base=main)**

```bash
cd /Users/richardivers/code/un1t-crm && git push -u origin session-report-slice3-next-action
gh pr create --base main --head session-report-slice3-next-action \
  --title "SESSION-REPORT.3 — post-class next_action CTA (book / join)" \
  --body "Fills the report's next_action slot with a context-aware, operator-editable CTA: active members → 'Book your next class', everyone else → 'Become a member'. URLs AND button copy are operator-editable post-deploy (no migration — rides locations.settings.customer_agent). Version stays 1. Paired champ-app PR carries the byte-identical builder + loader + session-view button.

Spec: docs/superpowers/specs/2026-06-18-session-report-slice3-next-action-design.md
Plan: docs/superpowers/plans/2026-06-18-session-report-slice3-next-action.md

Verified: vitest + lint + parity + mobile-imports + route-guards + next build green.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"

cd /Users/richardivers/code/champ-app && git push -u origin session-report-slice3-next-action
gh pr create --base main --head session-report-slice3-next-action \
  --title "SESSION-REPORT.3 — next_action CTA (champ-app)" \
  --body "Customer-app half of SESSION-REPORT.3 (pairs with un1t-crm). Byte-identical buildNextAction; loader reads the member's pipeline_stage_slug (customer RLS) + the location's CTA URLs/labels (service client) and passes the cta bundle; session view renders the CTA button. Version stays 1.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 4: Watch CI, then merge both**

```bash
gh pr checks <un1t-crm#> -R ivers9307-cyber/un1t-crm --watch && gh pr merge <un1t-crm#> -R ivers9307-cyber/un1t-crm --squash
gh pr checks <champ-app#> -R ivers9307-cyber/champ-app --watch && gh pr merge <champ-app#> -R ivers9307-cyber/champ-app --squash
```
Confirm each squash landed on its `origin/main`. Both auto-deploy. `next_action` stays null until an operator sets `booking_url` (and/or `membership_signup_url`) on Settings → Customer agent.

---

## Self-review notes

- **Spec coverage:** 3 editable fields (URLs + labels) on customer_agent settings + UI (Task 1) ✓; `buildNextAction` context-aware + null-when-URL-unset + default-label fallback (Task 2) ✓; byte-identical builder both repos + fixture (Tasks 2, 4) ✓; loaders resolve cta, champ-app via service client (Tasks 3, 4) ✓; render on view + email (Tasks 3, 4) ✓; no migration, version 1 (throughout) ✓; editable-copy requirement satisfied (labels are operator fields with placeholder-default fallbacks) ✓.
- **Type consistency:** `cta = { stage, bookingUrl, bookingLabel, membershipSignupUrl, membershipLabel }` is identical in both loaders + `buildNextAction`; the persisted fields (`booking_url`, `booking_cta_label`, `membership_cta_label`, `membership_signup_url`) map to the cta camelCase consistently; `next_action` payload `{ type, label, url }` matches builder ↔ view ↔ email; `MEMBER_STAGES` uses the canonical `pipeline_stage_slug` values.
- **Gotchas honoured:** `noglob`/quoted bracket paths in champ-app git add; `next build` is its own step in both repos; the fixture's existing Slice 1-2 assertions stay green (the `cta` block is additive; member-stage `active_member` yields the book branch without touching `vs_*`); champ-app reads `locations` via the **service client** (customer RLS can't read it); `createServiceClient` throws only if the service key is unset (present in champ-app prod); contact embed disambiguated via `!heart_rate_sessions_contact_id_fkey` (single FK).
