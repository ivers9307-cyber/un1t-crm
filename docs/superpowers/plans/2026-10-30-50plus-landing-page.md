# /50plus Landing Page (FIFTYPLUS.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public `/50plus` page that books a brand-new person into UN1T Stillorgan's THE 50+ CLUB class and grants them The Elites Trial, offering only that class's slots, with every word, the video and the configuration editable on the Stillorgan landing row.

**Architecture:** One new editor-only block type, `campaign_funnel`, on `landing_page_settings.blocks` carries the page's copy, video, class allow-list, Glofox trial pair and attribution. The two existing public routes (`GET /api/public/classes`, `POST /api/public/class-booking`) gain an optional `campaign` key that selects that block instead of the `class_funnel` block, and `readPublicClasses` gains an allow-list option that both routes apply to the same read. A new server page composes a light hero (video + date-tile booking card, a new client component) over the existing block renderers given a `tone="light"` prop.

**Tech Stack:** Next.js 16 App Router (server page + client island), supabase-js service role, Zod, Tailwind (light `un1t-*` theme on public pages uses the `lp-*` classes in `globals.css`), vitest with `@testing-library/react` for components.

**Spec:** `docs/superpowers/specs/2026-10-30-50plus-landing-page-design.md`

## Global Constraints

- Class allow-list keyword default is exactly `50+`; empty list offers nothing, never the whole timetable. Match is case-insensitive substring on the class name, applied **after** the location's hidden-keyword deny-list.
- Campaign key is exactly `50plus`; tag default `stillorgan-50plus`; lead source default `meta_50plus`; `eventSourceUrl` default `https://www.un1tdublin.com/50plus`; funnel-event name `50plus`.
- The trial pair (`trial_membership_id` + `trial_plan_code`) is REQUIRED for a campaign booking; missing or half-set ⇒ `409 { success:false, code:'not_configured' }`, never a fallback to the location default trial.
- `price_cents` is always 0 on a campaign booking (no payment branch).
- Class window for a campaign read is 14 days.
- Public class JSON carries exactly `PUBLIC_CLASS_KEYS` (never a capacity figure).
- `/50plus` is in `src/proxy.js` publicPaths, `AppShell` PUBLIC_PATHS and `brands.js` un1t-marketing allowedPaths; NOT in `DB_BRAND_DEFAULTS.allowedPaths`; listed in the test's `TENANT_PINNED_OFF`. `noindex`. `export const dynamic = 'force-dynamic'`.
- No new `console.log`; every `<button>` inside a `<form>` carries `type`; no em-dashes in customer copy; light-page text uses black-on-light ramps (`text-black/60` etc., never `text-*-300/400`).
- No DB migration. No change to `/trial`, `/start`, `/stillorgan` rendering, or `class_funnel` behaviour.
- Video `autoplay muted loop playsInline` with `poster`; unmute is one tap.
- Commit after every task; branch `fiftyplus-landing-page` off fresh `origin/main`; commit subjects `FIFTYPLUS.1 — …`, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **A class whose name contains `50+` but is at another studio or is hidden** must never appear: the allow-list runs only on the already deny-filtered list of the resolved location (Task 2 test "deny-list applies before the allow-list").
2. **A forged `event_id` for a real Stillorgan class outside the allow-list** (e.g. the 06:30 S&C) must be refused `class_unavailable`, not booked on The Elites Trial (Task 4 test "refuses an event outside the allow-list").
3. **A block saved with the trial picker left at "Not set"** must refuse with `not_configured` and the page must show the operator's not-configured message, never book on the generic trial (Task 4 test "refuses not_configured"; Task 7 test "shows the not configured message").
4. **The booking route with a `campaign` the row does not know** (typo in a copied URL, a stale page) must refuse `not_configured`, not silently fall back to the `class_funnel` block's tag and trial (Task 3 test "unknown campaign resolves null"; Task 4 test "unknown campaign is not_configured").
5. **A fortnight with no 50+ slots left** (bank holiday week, class full) must show the block's `no_classes_text`, not an empty card with a dead button (Task 7 test "empty list shows no_classes_text").

---

### Task 1: Branch, block type and defaults

**Files:**
- Modify: `src/lib/landing-page-blocks.js` (add `CAMPAIGN_FUNNEL_DEFAULT`, register in `BLOCK_TYPES`)
- Create: `src/lib/campaign-funnel.js`
- Test: `src/lib/campaign-funnel.test.js`

**Interfaces:**
- Produces: `CAMPAIGN_FUNNEL_DEFAULT({ brand }) → block` (type `'campaign_funnel'`), registered so `newBlockOfType('campaign_funnel', { brand })` works and `blocksOrDefault` keeps the block.
- Produces: in `src/lib/campaign-funnel.js` (pure, no IO, importable from the client bundle):
  - `export const CAMPAIGN_FUNNEL_TYPE = 'campaign_funnel'`
  - `export function parseAllowKeywords(raw) → string[]` (same normalisation as `parseHiddenKeywords`: array or comma/newline string → trimmed lowercase, blanks dropped)
  - `export function campaignFunnelBlock(blocks, campaign) → block|null` (the first `campaign_funnel` block whose `campaign === campaign`, exact string match; null otherwise)
  - `export function campaignFunnelConfig(block, { landingPath }) → { campaign, tag, leadSource, eventSourceUrl, trialMembershipId, trialPlanCode, allowKeywords, configured }` where `configured` is `Boolean(trialMembershipId && trialPlanCode)`, both ids trimmed strings or null, defaults: tag `${landingPath}-${campaign}`, leadSource `meta_${campaign}`, eventSourceUrl `https://www.un1tdublin.com/${campaign}`, allowKeywords `parseAllowKeywords(block.class_keywords)`.
  - `export function resolveCampaignKey(raw) → string|null` (trim, lowercase, strip to `[a-z0-9-]`, ≤ 64 chars; null when absent or blank after cleaning)
  - `export function campaignFunnelCopy(block, { brand }) → object` every customer-facing string resolved to the block's value or its default (list below); `CAMPAIGN_FUNNEL_CLIENT_FIELDS` the frozen list of keys the page sends to the browser (no ids, no keywords, no tag).

- [ ] **Step 1: Branch**

```bash
cd ~/code/un1t-crm && git fetch origin main && git checkout -b fiftyplus-landing-page origin/main && npm ci --silent
```
Expected: on `fiftyplus-landing-page`, `node_modules` present.

- [ ] **Step 2: Write the failing tests** in `src/lib/campaign-funnel.test.js`

```js
import { describe, it, expect } from 'vitest'
import { parseAllowKeywords, resolveCampaignKey, campaignFunnelBlock, campaignFunnelConfig, campaignFunnelCopy, CAMPAIGN_FUNNEL_CLIENT_FIELDS } from './campaign-funnel'
import { newBlockOfType, blocksOrDefault } from './landing-page-blocks'

describe('campaign_funnel block', () => {
  it('factory seeds the 50plus defaults', () => {
    const b = newBlockOfType('campaign_funnel', { brand: 'UN1T Stillorgan' })
    expect(b.type).toBe('campaign_funnel')
    expect(b.campaign).toBe('50plus')
    expect(b.class_keywords).toBe('50+')
    expect(b.heading).toBe('A free trial of The 50+ Club')
    expect(b.trial_membership_id).toBe('')
    expect(b.trial_plan_code).toBe('')
    expect(b.consent_label).toContain('UN1T Stillorgan')
  })
  it('blocksOrDefault keeps the block', () => {
    const b = newBlockOfType('campaign_funnel')
    expect(blocksOrDefault([b])).toEqual([b])
  })
})

describe('parseAllowKeywords', () => {
  it('normalises string and array forms', () => {
    expect(parseAllowKeywords('50+\n The Elites ,')).toEqual(['50+', 'the elites'])
    expect(parseAllowKeywords([' 50+ ', ''])).toEqual(['50+'])
    expect(parseAllowKeywords(null)).toEqual([])
  })
})

describe('resolveCampaignKey', () => {
  it('sanitises like a landing path and nulls a blank', () => {
    expect(resolveCampaignKey(' 50Plus ')).toBe('50plus')
    expect(resolveCampaignKey('50plus?x=1')).toBe('50plusx1')
    expect(resolveCampaignKey('')).toBe(null)
    expect(resolveCampaignKey(undefined)).toBe(null)
  })
})

describe('campaignFunnelBlock', () => {
  const blocks = [{ type: 'class_funnel' }, { type: 'campaign_funnel', campaign: '50plus', heading: 'x' }]
  it('finds by exact campaign key', () => {
    expect(campaignFunnelBlock(blocks, '50plus').heading).toBe('x')
    expect(campaignFunnelBlock(blocks, '50PLUS')).toBe(null)
    expect(campaignFunnelBlock(blocks, 'hyrox')).toBe(null)
    expect(campaignFunnelBlock(null, '50plus')).toBe(null)
  })
})

describe('campaignFunnelConfig', () => {
  const base = { type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+' }
  it('derives defaults from the path and campaign', () => {
    const c = campaignFunnelConfig(base, { landingPath: 'stillorgan' })
    expect(c).toMatchObject({ campaign: '50plus', tag: 'stillorgan-50plus', leadSource: 'meta_50plus', eventSourceUrl: 'https://www.un1tdublin.com/50plus', allowKeywords: ['50+'], configured: false, trialMembershipId: null, trialPlanCode: null })
  })
  it('a half-set trial pair is not configured', () => {
    expect(campaignFunnelConfig({ ...base, trial_membership_id: 'm1' }, { landingPath: 'stillorgan' }).configured).toBe(false)
    expect(campaignFunnelConfig({ ...base, trial_membership_id: ' m1 ', trial_plan_code: 'p1' }, { landingPath: 'stillorgan' })).toMatchObject({ configured: true, trialMembershipId: 'm1', trialPlanCode: 'p1' })
  })
  it('operator overrides win', () => {
    const c = campaignFunnelConfig({ ...base, tag: 'custom-tag', lead_source: 'meta_x', event_source_url: 'https://x.test/p' }, { landingPath: 'stillorgan' })
    expect(c).toMatchObject({ tag: 'custom-tag', leadSource: 'meta_x', eventSourceUrl: 'https://x.test/p' })
  })
  it('an empty keyword list stays empty (offers nothing)', () => {
    expect(campaignFunnelConfig({ ...base, class_keywords: '' }, { landingPath: 'stillorgan' }).allowKeywords).toEqual([])
  })
})

describe('campaignFunnelCopy', () => {
  it('every client field has a non-empty default and no em-dash', () => {
    const copy = campaignFunnelCopy({}, { brand: '' })
    for (const k of CAMPAIGN_FUNNEL_CLIENT_FIELDS) {
      if (k === 'video_url' || k === 'poster_url') continue // media: null until uploaded
      const v = copy[k]
      if (Array.isArray(v)) { expect(v.length).toBeGreaterThan(0); continue }
      expect(typeof v === 'string' && v.trim().length > 0, k).toBe(true)
      expect(v).not.toContain('—')
    }
  })
  it('a blank field falls back to its default, a set one wins', () => {
    expect(campaignFunnelCopy({ heading: '  ' }, {}).heading).toBe('A free trial of The 50+ Club')
    expect(campaignFunnelCopy({ heading: 'Hello' }, {}).heading).toBe('Hello')
  })
  it('never carries ids, keywords or the tag', () => {
    for (const k of ['trial_membership_id', 'trial_plan_code', 'class_keywords', 'tag', 'lead_source', 'event_source_url']) {
      expect(CAMPAIGN_FUNNEL_CLIENT_FIELDS).not.toContain(k)
    }
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/lib/campaign-funnel.test.js`
Expected: FAIL, module `./campaign-funnel` not found.

- [ ] **Step 4: Add the factory and registry entry** in `src/lib/landing-page-blocks.js`

`CAMPAIGN_FUNNEL_DEFAULT = ({ brand = '' } = {}) => ({...})` with `id: newBlockId()`, `type: 'campaign_funnel'`, and these fields (defaults in quotes):
- `campaign: '50plus'`, `class_keywords: '50+'`, `trial_membership_id: ''`, `trial_plan_code: ''`, `tag: ''`, `lead_source: ''`, `event_source_url: ''`
- `video_url: null`, `poster_url: null`
- `eyebrow: 'The 50+ Club · Stillorgan'`, `heading: 'A free trial of The 50+ Club'`, `subhead: 'Coach-led strength and mobility for the over-50s. Small group, a coach beside you, three mornings a week.'`, `sound_label: 'Tap for sound'`
- `pick_title: 'Pick your first morning'`, `pick_body: "We'll have a coach waiting at the door."`, `cta_label: 'Book {day} {time}'`, `reassurance: 'Free · no card needed · 60 minutes'`, `consent_label: classFunnelConsentDefault(brand)`, `details_title: 'Last step'`, `details_body: 'We just need these to book you in.'`
- `done_title: "You're booked in"`, `done_body: "That's your first 50+ Club class. Watch for a WhatsApp confirming it. See you at the door."`
- `no_classes_text: 'No 50+ Club classes are open to book in the next two weeks. Message us and we will sort you out.'`, `not_configured_text: 'Booking is not open online right now. Message us and we will book you in.'`, `timetable_unavailable_text: 'We could not check the timetable just now. Please try again in a minute.'`
- `expect_eyebrow: 'What to expect'`, `expect_heading: 'Built for where you are now'`, `expect_cards: [ { title: 'A coach beside you', body: 'Every movement shown and scaled to you. Never thrown in at the deep end.' }, { title: 'Strength that lasts', body: 'Bone density, balance and joints. The things that keep you independent.' }, { title: 'Your own crowd', body: 'The same faces every Monday, Wednesday and Friday. Coffee after, usually.' } ]`
- `show_sections: ['stats', 'video_testimonials', 'reviews']`

Register in `BLOCK_TYPES` after `paid_trial`: `{ type: 'campaign_funnel', label: 'Campaign funnel (own page)', description: 'A booking page for one class and one trial plan at /<campaign>: coach video, date tiles, details, booked. Edited here, never shown on this landing page.', factory: CAMPAIGN_FUNNEL_DEFAULT }`.

- [ ] **Step 5: Implement `src/lib/campaign-funnel.js`** with the five functions and the constants from Interfaces. `campaignFunnelCopy` resolves every field named in Step 4 from `eyebrow` through `show_sections` (not the ids/keywords/attribution) using the same `str(v) || default` rule as `paidTrialCopyFromBlock`; `expect_cards` falls back to the default three when the block's list is not an array of `{title, body}` with at least one non-blank title; `show_sections` is filtered to the three known names. `CAMPAIGN_FUNNEL_CLIENT_FIELDS` is `Object.freeze([...those keys, 'video_url', 'poster_url'])`. Keep the default strings in ONE place: export `CAMPAIGN_FUNNEL_COPY_DEFAULTS` from `campaign-funnel.js` and have `CAMPAIGN_FUNNEL_DEFAULT` in `landing-page-blocks.js` spread it (the blocks file already imports from `paid-trial.js` the same way).

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run src/lib/campaign-funnel.test.js src/lib/landing-page-blocks.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/campaign-funnel.js src/lib/campaign-funnel.test.js src/lib/landing-page-blocks.js
git commit -m "FIFTYPLUS.1 — campaign_funnel block type and pure config helpers"
```

---

### Task 2: Allow-list in `readPublicClasses`

**Files:**
- Modify: `src/lib/public-classes.js` (`readPublicClasses`, `readNoGlofoxClasses`, `readUn1tClasses` signatures)
- Test: `src/lib/public-classes.test.js` (append a describe)

**Interfaces:**
- Produces: `readPublicClasses(db, locationId, days = 7, { allowKeywords = null } = {})`. `null`/`undefined` ⇒ today's behaviour. An array ⇒ after the existing hidden-keyword filter, keep only classes where `allowKeywords.some((k) => name.toLowerCase().includes(k))`; an EMPTY array ⇒ `{ classes: [], error: null }` (with the read still performed so an unreadable timetable still reports its error). Applies on all three branches (Glofox, manual timetable, un1t.online).
- Produces: `export function isClassAllowed(name, allowKeywords) → boolean` (true when `allowKeywords` is null).

- [ ] **Step 1: Write the failing tests** (append to `src/lib/public-classes.test.js`, reusing its mocks; `fetchUpcomingEvents` is the mock from the file header)

```js
describe('FIFTYPLUS.1 — allowKeywords', () => {
  const events = [
    { _id: 'a', name: 'THE 50+ CLUB', time_start: 4102444800, active: true, private: false },
    { _id: 'b', name: 'S&C', time_start: 4102448400, active: true, private: false },
    { _id: 'c', name: 'ELITES 50+ open gym', time_start: 4102452000, active: true, private: false },
  ]
  it('keeps only classes matching any keyword, case-insensitively', async () => {
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events })
    const r = await readPublicClasses(makeDb({}), 'loc-1', 14, { allowKeywords: ['50+'] })
    expect(r.error).toBe(null)
    expect(r.classes.map((c) => c.event_id)).toEqual(['a', 'c'])
  })
  it('deny-list applies before the allow-list', async () => {
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: 'b', apiKey: 'k', apiToken: 't', hiddenClassKeywords: 'open gym' })
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events })
    const r = await readPublicClasses(makeDb({}), 'loc-1', 14, { allowKeywords: ['50+'] })
    expect(r.classes.map((c) => c.event_id)).toEqual(['a'])
  })
  it('an empty allow-list offers nothing', async () => {
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events })
    const r = await readPublicClasses(makeDb({}), 'loc-1', 14, { allowKeywords: [] })
    expect(r).toEqual({ classes: [], error: null })
  })
  it('an unreadable timetable still reports the error under an allow-list', async () => {
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: false })
    const r = await readPublicClasses(makeDb({}), 'loc-1', 14, { allowKeywords: ['50+'] })
    expect(r.error).toBe('glofox_unreachable')
  })
  it('null keeps every class (today\'s behaviour)', async () => {
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events })
    const r = await readPublicClasses(makeDb({}), 'loc-1', 14)
    expect(r.classes).toHaveLength(3)
  })
  it('isClassAllowed', () => {
    expect(isClassAllowed('THE 50+ CLUB', ['50+'])).toBe(true)
    expect(isClassAllowed('S&C', ['50+'])).toBe(false)
    expect(isClassAllowed('S&C', null)).toBe(true)
    expect(isClassAllowed('S&C', [])).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/public-classes.test.js -t FIFTYPLUS`
Expected: FAIL (`isClassAllowed` not exported; three classes returned).

- [ ] **Step 3: Implement** `isClassAllowed` and thread `{ allowKeywords }` through `readPublicClasses` → `readNoGlofoxClasses(db, locationId, days, opts)` → `readUn1tClasses(…, { blocks, hidden, allowKeywords })`, applying `.filter((c) => isClassAllowed(c.name, allowKeywords))` immediately after each `isClassHidden` filter. Update the JSDoc on `readPublicClasses`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/public-classes.test.js src/lib/public-classes.un1t.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/public-classes.js src/lib/public-classes.test.js
git commit -m "FIFTYPLUS.1 — readPublicClasses takes an allow-list, applied after the deny-list"
```

---

### Task 3: `GET /api/public/classes?campaign=`

**Files:**
- Modify: `src/app/api/public/classes/route.js`
- Test: `src/app/api/public/classes/route.campaign.test.js`

**Interfaces:**
- Consumes: `campaignFunnelBlock`, `campaignFunnelConfig` (Task 1); `readPublicClasses(db, loc, 14, { allowKeywords })` (Task 2).
- Produces: with `?campaign=<key>` (sanitised like `resolveLandingPath`: lowercase, `[a-z0-9-]`, ≤ 64) the route answers `{ success: true, data: { classes, terms, campaign: { configured: boolean } } }`; classes come from the block's allow-list over 14 days; an unknown campaign answers `classes: []`, `campaign: { configured: false }`. Without `campaign` the response is unchanged.

- [ ] **Step 1: Write the failing test** `src/app/api/public/classes/route.campaign.test.js` (copy the mock header of `route.test.js`; `makeDb` returns `{ location_id: 'loc-1', public_path: 'stillorgan', blocks }` where `blocks` is a `let` the test sets)

```js
const EVENTS = [
  { _id: 'a', name: 'THE 50+ CLUB', time_start: 4102444800, size: 12, booked: 2, active: true, private: false },
  { _id: 'b', name: 'S&C', time_start: 4102448400, size: 12, booked: 2, active: true, private: false },
]
it('lists only the allow-listed class for a known campaign and says whether it is configured', async () => {
  blocks = [{ type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+', trial_membership_id: 'm', trial_plan_code: 'p' }]
  fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
  const res = await GET(new Request('https://crm.example/api/public/classes?path=stillorgan&campaign=50plus'))
  const body = await res.json()
  expect(body.data.classes.map((c) => c.event_id)).toEqual(['a'])
  expect(body.data.campaign).toEqual({ configured: true })
  expect(fetchUpcomingEvents.mock.calls[0][1].end - fetchUpcomingEvents.mock.calls[0][1].start).toBe(14 * 86400)
})
it('unknown campaign resolves null: no classes, not configured', async () => {
  blocks = [{ type: 'class_funnel' }]
  fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
  const body = await (await GET(new Request('https://crm.example/api/public/classes?path=stillorgan&campaign=50plus'))).json()
  expect(body.data.classes).toEqual([])
  expect(body.data.campaign).toEqual({ configured: false })
})
it('no campaign param keeps the full list and no campaign key', async () => {
  blocks = [{ type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+' }]
  fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
  const body = await (await GET(new Request('https://crm.example/api/public/classes?path=stillorgan'))).json()
  expect(body.data.classes).toHaveLength(2)
  expect(body.data.campaign).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/public/classes/route.campaign.test.js`
Expected: FAIL (two classes listed, `campaign` undefined).

- [ ] **Step 3: Implement** in `route.js`: import `resolveCampaignKey`, `campaignFunnelBlock`, `campaignFunnelConfig` from `@/lib/campaign-funnel`; `const key = resolveCampaignKey(searchParams.get('campaign'))`; in `GET`, when a key is present, `const block = campaignFunnelBlock(page.blocks, key)`; if null answer the empty/unconfigured shape; else `const cfg = campaignFunnelConfig(block, { landingPath: path })` and call `readPublicClasses(db, page.location_id, 14, { allowKeywords: cfg.allowKeywords })` (through a local `listCampaignClasses` that returns `.classes`, keeping the old `[]`-on-failure contract) and add `campaign: { configured: cfg.configured }`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/app/api/public/classes/`
Expected: PASS (including the existing PUBCAP and un1t-terms suites).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/public/classes/
git commit -m "FIFTYPLUS.1 — public classes route takes a campaign and answers its allow-listed slots"
```

---

### Task 4: `POST /api/public/class-booking` with `campaign`

**Files:**
- Modify: `src/app/api/public/class-booking/route.js`
- Test: `src/app/api/public/class-booking/route.campaign.test.js`

**Interfaces:**
- Consumes: Task 1 helpers (`resolveCampaignKey`, `campaignFunnelBlock`, `campaignFunnelConfig`, `campaignFunnelCopy`), Task 2 `readPublicClasses` option.
- Produces: body gains `campaign: z.string().trim().max(64).optional()`. When present: the block is resolved; null or `!configured` ⇒ `409 { success:false, code:'not_configured', error: campaignFunnelCopy(block || {}).not_configured_text }`; otherwise `tag`, `leadSource`, `eventSourceUrl`, `trialMembershipId`, `trialPlanCode` come from `campaignFunnelConfig`, `priceCents = 0`, and the validation read is `readPublicClasses(db, locationId, 14, { allowKeywords: cfg.allowKeywords })`. `timetable_unavailable` uses the block's `timetable_unavailable_text`. Everything after validation is unchanged. Without `campaign`, behaviour is byte-for-byte today's.

- [ ] **Step 1: Write the failing tests** `route.campaign.test.js` (copy the mock scaffold from `route.timetable.test.js`; add `vi.mock('@/lib/marketing-consent', …)`, `vi.mock('@/lib/meta-capi', …)` as `route.capi.test.js` does; make `db.from('class_booking_requests').insert(...).select().maybeSingle()` resolve `{ data: { id: 'req-1', class_name: 'THE 50+ CLUB' } }` and capture the inserted row in a `let inserted`)

```js
const CFG = { type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+', trial_membership_id: 'elite-m', trial_plan_code: 'elite-p' }
const book = (extra = {}) => POST(new Request('http://localhost/api/public/class-booking', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: 'stillorgan', campaign: '50plus', event_id: 'ev-50', first_name: 'Mary', last_name: 'Byrne', email: 'mary@example.com', phone: '0871234567', consent: true, ...extra }) }))

it('books on the campaign block: allow-list read, its trial pair and tag, price 0', async () => {
  pageBlocks = [{ type: 'class_funnel', tag: 'stillorgan-start', trial_membership_id: 'gen-m', trial_plan_code: 'gen-p', price_cents: 2000 }, CFG]
  readPublicClasses.mockResolvedValueOnce({ classes: [{ event_id: 'ev-50', name: 'THE 50+ CLUB', starts_at: '2099-01-05T11:00:00.000Z' }], error: null })
  findOrCreateRaceContact.mockResolvedValueOnce('c1')
  const res = await book()
  expect(res.status).toBe(200)
  expect(readPublicClasses).toHaveBeenCalledWith(expect.anything(), 'L1', 14, { allowKeywords: ['50+'] })
  expect(inserted).toMatchObject({ trial_membership_id: 'elite-m', trial_plan_code: 'elite-p', status: 'queued' })
  expect(writeContactTag).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tag: 'stillorgan-50plus' }))
  expect(createClassBookingPayment).not.toHaveBeenCalled()
})
it('refuses an event outside the allow-list even though it is a real class', async () => {
  pageBlocks = [CFG]
  readPublicClasses.mockResolvedValueOnce({ classes: [{ event_id: 'ev-50', name: 'THE 50+ CLUB', starts_at: '2099-01-05T11:00:00.000Z' }], error: null })
  const res = await book({ event_id: 'ev-sc' })
  expect(res.status).toBe(400)
  expect((await res.json()).code).toBe('class_unavailable')
  expect(findOrCreateRaceContact).not.toHaveBeenCalled()
})
it('refuses not_configured when the trial pair is missing, in the operator\'s words', async () => {
  pageBlocks = [{ ...CFG, trial_plan_code: '', not_configured_text: 'Ring us.' }]
  const res = await book()
  expect(res.status).toBe(409)
  expect(await res.json()).toMatchObject({ success: false, code: 'not_configured', error: 'Ring us.' })
  expect(readPublicClasses).not.toHaveBeenCalled()
})
it('unknown campaign is not_configured, never the class_funnel fallback', async () => {
  pageBlocks = [{ type: 'class_funnel', trial_membership_id: 'gen-m', trial_plan_code: 'gen-p' }]
  const res = await book()
  expect(res.status).toBe(409)
  expect((await res.json()).code).toBe('not_configured')
})
it('timetable_unavailable uses the block\'s text', async () => {
  pageBlocks = [{ ...CFG, timetable_unavailable_text: 'Try again shortly.' }]
  readPublicClasses.mockResolvedValueOnce({ classes: [], error: 'glofox_unreachable' })
  const res = await book()
  expect(res.status).toBe(503)
  expect(await res.json()).toMatchObject({ code: 'timetable_unavailable', error: 'Try again shortly.' })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/public/class-booking/route.campaign.test.js`
Expected: FAIL (campaign ignored: generic trial pair inserted, read called with no options).

- [ ] **Step 3: Implement** in `route.js` per Interfaces. Resolve the campaign right after `page` is read and before the un1t terms block; build one `funnel` object `{ tag, leadSource, eventSourceUrl, trialMembershipId, trialPlanCode, priceCents, currency, allowKeywords, timetableUnavailableText }` from either `classFunnelConfigFromBlocks` (no campaign; `allowKeywords: null`, text via `classFunnelTimetableUnavailableMessage`) or `campaignFunnelConfig` + `campaignFunnelCopy`, and use it below so the rest of the handler has one source. Rate-limit key stays `classbook:${landingPath}:${ip}`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/app/api/public/class-booking/ src/app/api/public/classes/ src/lib/campaign-funnel.test.js`
Expected: PASS, including the three pre-existing booking suites.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/public/class-booking/ src/app/api/public/classes/ src/lib/campaign-funnel.js src/lib/campaign-funnel.test.js
git commit -m "FIFTYPLUS.1 — class-booking takes a campaign: its trial pair, tag and allow-listed validation"
```

---

### Task 5: Public path allowlists

**Files:**
- Modify: `src/proxy.js:218` (publicPaths), `src/components/AppShell.jsx:82` (PUBLIC_PATHS), `src/lib/brands.js:99` (un1t-marketing allowedPaths, after `/trial`)
- Modify: `src/public-compliance-paths.test.jsx:610` (`TENANT_PINNED_OFF` gains `'/50plus'`) plus a new describe
- Modify: `src/lib/meta-pixel-paths.js` — no change (site pixel loads everywhere; note it in the PR body)

**Interfaces:** none beyond the three lists.

- [ ] **Step 1: Write the failing tests** (append to `src/public-compliance-paths.test.jsx`, using its `makeReq`, `proxy`, `rewrittenTo`, `admitted`, `renderShell` helpers exactly as the `/account-deletion` describe does)

```js
describe('FIFTYPLUS.1 — /50plus is public on UN1T hosts and pinned off tenant defaults', () => {
  it('CRM host admits /50plus anonymously', async () => {
    expect(admitted(await proxy(makeReq({ host: CRM_HOST, path: '/50plus' })))).toBe(true)
  })
  it('marketing host does not rewrite /50plus to /welcome', async () => {
    expect(rewrittenTo(await proxy(makeReq({ host: 'www.un1tdublin.com', path: '/50plus' })))).toBe(null)
  })
  it('AppShell renders /50plus with no session', () => {
    pathnameImpl = '/50plus'
    expect(renderShell()).toContain('child-marker')
  })
  it('the marketing allowlist names it explicitly', () => {
    expect(BRANDS.find((b) => b.id === 'un1t-marketing').allowedPaths).toContain('/50plus')
  })
})
```
(Adapt the helper names to the ones the file actually defines; `TENANT_PINNED_OFF` already drives "stays OFF the default" and "not in DB_BRAND_DEFAULTS" cases, so adding `'/50plus'` there covers tier 4.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/public-compliance-paths.test.jsx -t FIFTYPLUS`
Expected: FAIL (proxy 307s to /login; marketing host rewrites).

- [ ] **Step 3: Add `'/50plus'`** to the three lists (with a one-line comment `// FIFTYPLUS.1 — Meta-ad 50+ Club trial page (src/app/50plus)` beside `/trial` in each) and to `TENANT_PINNED_OFF`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/public-compliance-paths.test.jsx src/proxy.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proxy.js src/components/AppShell.jsx src/lib/brands.js src/public-compliance-paths.test.jsx
git commit -m "FIFTYPLUS.1 — /50plus on the three UN1T public lists, pinned off tenant defaults"
```

---

### Task 6: Light tone for three block renderers

**Files:**
- Modify: `src/components/landing-page/BlockRenderers.jsx` (`BlockRenderer` default export gains `tone = 'dark'`; `StatsBlock`, `Stat`, `VideoTestimonialsBlock`, `ReviewsBlock`, `ReviewCard` take `tone`)
- Test: `src/components/landing-page/BlockRenderers.tone.test.jsx`

**Interfaces:**
- Produces: `<BlockRenderer block tone="light" …/>` renders those three block types on a white/off-white surface with black text; every other block ignores `tone`. `tone` is a prop, never read from the block data.

- [ ] **Step 1: Write the failing test** (render with `renderToStaticMarkup` as `public-compliance-paths.test.jsx` does; mock `./VideoTestimonials` and `./CountUp` to simple stubs)

```js
import { renderToStaticMarkup } from 'react-dom/server'
import BlockRenderer from './BlockRenderers'
const stats = { id: 's', type: 'stats', items: [{ number: '4.9', label: 'Google rating' }] }
const videos = { id: 'v', type: 'video_testimonials', title: 'Hear from members', items: [{ video_url: 'https://x/a.mp4', poster_url: 'https://x/a.jpg' }] }
const reviews = { id: 'r', type: 'reviews', title: 'Reviews', min_rating: 4 }
const reviewsData = { reviews: [{ id: 1, rating: 5, comment: 'Great', author_name: 'A' }] }
it.each([['stats', stats], ['video_testimonials', videos], ['reviews', reviews]])('%s renders light on tone=light', (_, block) => {
  const html = renderToStaticMarkup(<BlockRenderer block={block} tone="light" reviewsData={reviewsData} />)
  expect(html).toContain('bg-white')
  expect(html).not.toContain('bg-black')
  expect(html).not.toMatch(/text-white(?![-\w])/)
})
it('default tone is unchanged (dark)', () => {
  expect(renderToStaticMarkup(<BlockRenderer block={stats} />)).toContain('bg-black')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/landing-page/BlockRenderers.tone.test.jsx`
Expected: FAIL (`bg-black` present).

- [ ] **Step 3: Implement.** In each of the three sections pick classes from a tiny `const t = tone === 'light' ? {...} : {...}` map: section `bg-white text-black border-t border-black/10` vs today's; stat label `text-black/55` vs `text-white/55`; divide `md:divide-black/10`; review card `bg-black/[0.04] border-black/10 hover:bg-black/[0.07]`, quote `text-black/80`, byline `text-black/55`; title classes unchanged (they inherit colour). Pass `tone` from `BlockRenderer`'s switch to the three only.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/landing-page/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/landing-page/BlockRenderers.jsx src/components/landing-page/BlockRenderers.tone.test.jsx
git commit -m "FIFTYPLUS.1 — light tone for the stats, video testimonial and reviews blocks"
```

---

### Task 7: `CampaignFunnel` client component

**Files:**
- Create: `src/components/landing-page/CampaignFunnel.jsx`
- Create: `src/lib/campaign-funnel-attribution.js` (client-safe: the attribution/session/lead-id plumbing lifted from `ClassFunnel.jsx:118-160` as pure functions; `ClassFunnel` is NOT modified in this PR)
- Test: `src/components/landing-page/CampaignFunnel.test.jsx`

**Interfaces:**
- Consumes: `GET /api/public/classes?path=&campaign=` (Task 3 shape), `POST /api/public/class-booking` with `campaign` (Task 4 codes `not_configured`, `class_unavailable`, `timetable_unavailable`).
- Produces: `export default function CampaignFunnel({ publicPath, campaign, copy, locationName })` where `copy` is `campaignFunnelCopy(block, { brand })` narrowed to `CAMPAIGN_FUNNEL_CLIENT_FIELDS`. Steps `pick | details | done`; on load the first slot is preselected. Also exports `export function cadenceGroups(classes) → Array<{ day, day_label, classes }>` (pure, grouped and ordered by `day`) and `export function ctaLabelFor(template, cls) → string` (`{day}` → first word of `day_label`, `{time}` → `cls.time`).
- Produces: `src/lib/campaign-funnel-attribution.js`: `readAttributionFromUrl(search) → object` (utm_*, meta_ad_id, fbclid), `buildAttribution(raw, fbp) → object|undefined` (same rule as `ClassFunnel.buildAttribution`), `funnelSessionId(storage) → string` (key `campaign_sid`).

- [ ] **Step 1: Write the failing tests** (`@testing-library/react`, `vi.stubGlobal('fetch', …)`; follow `ClassFunnel.test.jsx`'s setup)

```js
const COPY = { eyebrow: 'E', heading: 'H', subhead: 'S', pick_title: 'Pick your first morning', pick_body: 'B', cta_label: 'Book {day} {time}', reassurance: 'Free', consent_label: 'OK?', details_title: 'Last step', details_body: 'D', done_title: 'Booked', done_body: 'See you', no_classes_text: 'Nothing open', not_configured_text: 'Not open online', timetable_unavailable_text: 'Try later', sound_label: 'Tap for sound', expect_eyebrow: '', expect_heading: '', expect_cards: [], show_sections: [] }
const CLASSES = [
  { event_id: 'a', name: 'THE 50+ CLUB', starts_at: '2099-01-05T11:00:00.000Z', day: '2099-01-05', day_label: 'Mon 5 Jan', time: '11:00' },
  { event_id: 'b', name: 'THE 50+ CLUB', starts_at: '2099-01-07T11:00:00.000Z', day: '2099-01-07', day_label: 'Wed 7 Jan', time: '11:00' },
]
const listOk = (classes, configured = true) => Response.json({ success: true, data: { classes, terms: { required: false }, campaign: { configured } } })

it('renders one tile per slot and the CTA names the chosen slot', async () => {
  fetch.mockResolvedValueOnce(listOk(CLASSES))
  render(<CampaignFunnel publicPath="stillorgan" campaign="50plus" copy={COPY} />)
  expect(await screen.findByText('Mon 5 Jan')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Book Mon 11:00' })).toBeTruthy()
  fireEvent.click(screen.getByText('Wed 7 Jan'))
  expect(screen.getByRole('button', { name: 'Book Wed 11:00' })).toBeTruthy()
})
it('empty list shows no_classes_text and no CTA', async () => {
  fetch.mockResolvedValueOnce(listOk([]))
  render(<CampaignFunnel publicPath="stillorgan" campaign="50plus" copy={COPY} />)
  expect(await screen.findByText('Nothing open')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Book/ })).toBe(null)
})
it('shows the not configured message when the server says so', async () => {
  fetch.mockResolvedValueOnce(listOk(CLASSES, false))
  render(<CampaignFunnel publicPath="stillorgan" campaign="50plus" copy={COPY} />)
  expect(await screen.findByText('Not open online')).toBeTruthy()
})
it('details keeps the slot visible, Change returns to the tiles, booking posts campaign and shows done copy', async () => {
  fetch.mockResolvedValueOnce(listOk(CLASSES))
  render(<CampaignFunnel publicPath="stillorgan" campaign="50plus" copy={COPY} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Book Mon 11:00' }))
  expect(screen.getByText('Last step')).toBeTruthy()
  expect(screen.getByText(/Mon 5 Jan/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Change' }))
  expect(screen.getByText('Pick your first morning')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Book Mon 11:00' }))
  fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Mary' } })
  fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Byrne' } })
  fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'mary@example.com' } })
  fireEvent.change(screen.getByPlaceholderText('Phone'), { target: { value: '0871234567' } })
  fetch.mockResolvedValueOnce(Response.json({ success: true, data: { queued: true } }))
  fireEvent.click(screen.getByRole('button', { name: /Book/ }))
  expect(await screen.findByText('Booked')).toBeTruthy()
  const body = JSON.parse(fetch.mock.calls[1][1].body)
  expect(body).toMatchObject({ path: 'stillorgan', campaign: '50plus', event_id: 'a' })
})
it('class_unavailable returns to the tiles with details kept', async () => {
  fetch.mockResolvedValueOnce(listOk(CLASSES))
  render(<CampaignFunnel publicPath="stillorgan" campaign="50plus" copy={COPY} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Book Mon 11:00' }))
  fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Mary' } })
  fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Byrne' } })
  fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'mary@example.com' } })
  fireEvent.change(screen.getByPlaceholderText('Phone'), { target: { value: '0871234567' } })
  fetch.mockResolvedValueOnce(Response.json({ success: false, code: 'class_unavailable', error: 'gone' }, { status: 400 }))
  fireEvent.click(screen.getByRole('button', { name: /Book/ }))
  expect(await screen.findByText('Pick your first morning')).toBeTruthy()
  expect(screen.getByText(/filled up while you were typing/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Book Mon 11:00' }))
  expect(screen.getByPlaceholderText('First name').value).toBe('Mary')
})
it('every button inside the form has a type', async () => {
  fetch.mockResolvedValueOnce(listOk(CLASSES))
  const { container } = render(<CampaignFunnel publicPath="stillorgan" campaign="50plus" copy={COPY} />)
  await screen.findByText('Mon 5 Jan')
  for (const b of container.querySelectorAll('form button')) expect(b.getAttribute('type')).toBeTruthy()
})
describe('cadenceGroups / ctaLabelFor', () => {
  it('groups by day in order', () => { expect(cadenceGroups(CLASSES).map((g) => g.day)).toEqual(['2099-01-05', '2099-01-07']) })
  it('fills the template', () => { expect(ctaLabelFor('Book {day} {time}', CLASSES[0])).toBe('Book Mon 11:00') })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/landing-page/CampaignFunnel.test.jsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `CampaignFunnel.jsx`** ('use client'). Light card: `rounded-3xl bg-[#f6f3ec] text-black p-6 sm:p-8`, tiles `grid grid-cols-3 gap-2.5` each a `<button type="button">` with weekday (`text-xs text-black/60`), date number (`font-display font-extrabold text-2xl`), time (`text-xs`), selected `bg-black text-white`, unselected `bg-white border border-black/15`. First 3 tiles always visible; the rest behind a `<button type="button">More dates</button>` toggle (`showAll` state). The CTA is `lp-btn`-shaped but black (`bg-black text-white rounded-full py-4 font-bold text-base`). Details form: four inputs (placeholders exactly `First name`, `Last name`, `Email`, `Phone`, `autoComplete` as `ClassFunnel`), consent checkbox pre-ticked with `copy.consent_label` + `/privacy` link, the chosen slot panel with a `Change` button. On submit: POST as in `ClassFunnel.handleClassBooking` with `campaign`, `attribution: buildAttribution(...)`, `visit: readVisitOrigin()`, `lead_event_id: newLeadEventId()`; then `fireBrowserLead(...)` (pixel ids from `metaPixelIdsForPath(window.location.pathname)`); `not_configured` and `timetable_unavailable` show the server's `error` in the card; `class_unavailable` returns to `pick` with `error` "That class filled up while you were typing. Pick another one, your details are saved." Funnel steps via `trackFunnelStep` are named `50plus_view`, `50plus_pick`, `50plus_details`, `50plus_booked`, `50plus_empty`, `50plus_not_configured`; `/api/public/funnel-event` posts use `funnel: '50plus'` (copy the `fireStep` shape from `ClassFunnel.jsx:140-160`). Input text size `text-base` (never smaller: an older reader on a phone).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/landing-page/CampaignFunnel.test.jsx src/lib/campaign-funnel-attribution.test.js`
Expected: PASS. (Write `campaign-funnel-attribution.test.js` with one case each for the three helpers; `buildAttribution` returns `undefined` with no signal and `{ ad_provider: 'meta', ad_external_id }` when `meta_ad_id` is set, exactly as `ClassFunnel.buildAttribution` does.)

- [ ] **Step 5: Commit**

```bash
git add src/components/landing-page/CampaignFunnel.jsx src/components/landing-page/CampaignFunnel.test.jsx src/lib/campaign-funnel-attribution.js src/lib/campaign-funnel-attribution.test.js
git commit -m "FIFTYPLUS.1 — CampaignFunnel: date tiles, details, booked"
```

---

### Task 8: The `/50plus` page

**Files:**
- Create: `src/app/50plus/page.js`
- Create: `src/components/landing-page/CampaignHero.jsx` ('use client', the video with the unmute pill)
- Create: `src/components/landing-page/ExpectStrip.jsx` (server-safe, the three cards)
- Test: `src/app/50plus/page.test.jsx`

**Interfaces:**
- Consumes: `campaignFunnelBlock`, `campaignFunnelCopy`, `CAMPAIGN_FUNNEL_CLIENT_FIELDS` (Task 1); `CampaignFunnel` (Task 7); `BlockRenderer tone="light"` (Task 6); `SiteHeader`, `SiteFooter`, `RevealArmScript`, `RevealManager`, `VisitOriginCapture`, `getLandingLogo`, `resolveOrgChrome`, `resolveLocationBrand` exactly as `src/app/trial/page.js` uses them.
- Produces: `export default async function FiftyPlusPage()`, `export async function generateMetadata()` (title `The 50+ Club Trial — <org name>`, `robots: { index: false, follow: false }`), `export const dynamic = 'force-dynamic'`. `CampaignHero({ videoUrl, posterUrl, soundLabel, eyebrow, heading, subhead, children })` renders the two-column `lg:grid-cols-[1.6fr_1fr]` hero with `children` (the funnel) in the right column; on phones video then card. `ExpectStrip({ eyebrow, heading, cards })`.

- [ ] **Step 1: Write the failing test** `src/app/50plus/page.test.jsx` (mock `@/lib/supabase` with a db whose `landing_page_settings` read returns `{ location_id: 'loc-s', public_path: 'stillorgan', blocks }`, mock `@/lib/host-brand` (`resolveOrgChrome → { companyName: 'UN1T', shortName: 'UN1T', studios: [], legalName: '' }`, `resolveLocationBrand → { companyName: 'UN1T Stillorgan' }`), `@/lib/landing-logo`, `./CampaignFunnel` to a stub that prints its props as JSON, `google_reviews` read returning `[]`)

```js
it('renders hero copy, the funnel with client-safe copy only, the expect strip and the chosen sections in light tone', async () => {
  blocks = [{ type: 'campaign_funnel', campaign: '50plus', heading: 'A free trial of The 50+ Club', trial_membership_id: 'm', trial_plan_code: 'p', class_keywords: '50+', video_url: 'https://x/v.mp4', poster_url: 'https://x/p.jpg', show_sections: ['stats'] }, { id: 's1', type: 'stats', items: [{ number: '4.9', label: 'Rating' }] }, { id: 'v1', type: 'video_testimonials', items: [{ video_url: 'https://x/a.mp4' }] }]
  const html = renderToStaticMarkup(await FiftyPlusPage({ searchParams: Promise.resolve({}) }))
  expect(html).toContain('A free trial of The 50+ Club')
  expect(html).toContain('https://x/v.mp4')
  expect(html).not.toContain('trial_membership_id')
  expect(html).not.toContain('"m"')
  expect(html).toContain('Built for where you are now')
  expect(html).toContain('4.9')           // stats shown
  expect(html).not.toContain('https://x/a.mp4') // video_testimonials not in show_sections
  expect(html).toContain('bg-white')
})
it('renders the hero and card on an unreadable row (never a 404)', async () => {
  dbFails = true
  const html = renderToStaticMarkup(await FiftyPlusPage({ searchParams: Promise.resolve({}) }))
  expect(html).toContain('A free trial of The 50+ Club')
})
it('metadata is noindex', async () => {
  expect((await generateMetadata()).robots).toEqual({ index: false, follow: false })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/50plus/page.test.jsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement.** Page: `const CAMPAIGN = '50plus'`, `const PUBLIC_PATH = 'stillorgan'`, `const STILLORGAN_LOCATION_ID = 'a0000000-0000-0000-0000-000000000001'`, `const CTA_HREF = '#book'`. `loadRow(db)` reads `location_id, public_path, blocks` for `PUBLIC_PATH` inside try/catch (`logWarn('50plus-page', …)` on failure → `{ blocks: [] }`). `copy = campaignFunnelCopy(block, { brand })`; `clientCopy = pick(copy, CAMPAIGN_FUNNEL_CLIENT_FIELDS)`. Sections: for each name in `copy.show_sections`, the first block of that type on the row, rendered with `tone="light"`; `reviewsData` loaded exactly as `src/app/welcome/[location]/page.js:99-115` only when `reviews` is among them. Wrapper `min-h-screen bg-white text-black antialiased`; `SiteHeader` as `/trial` (it is dark: acceptable; the page below it is light), `sticky`, `ctaHref="#book"`, `ctaLabel="Book a free class"`; `SiteFooter` as `/trial`. `CampaignHero`: `<video autoPlay muted loop playsInline poster={posterUrl}>` in a `relative rounded-3xl overflow-hidden bg-black aspect-[4/5] lg:aspect-auto lg:min-h-[560px]` box, gradient `from-transparent to-black/75` bottom, eyebrow/heading/subhead over the lower edge in white (the one dark island: put `bg-black` on the video box so `no-low-contrast-accent-text` is satisfied), and a `<button type="button" aria-pressed>` top-right that toggles `videoRef.current.muted` and its label between `soundLabel` and `'Sound on'`. No video_url ⇒ poster image only; neither ⇒ a `bg-black` box with the words.

- [ ] **Step 4: Run to verify it passes, then build**

Run: `npx vitest run src/app/50plus/ src/components/landing-page/` then `npm run build`
Expected: PASS; build succeeds (a new route and new imports are exactly what only the build catches).

- [ ] **Step 5: Commit**

```bash
git add src/app/50plus/ src/components/landing-page/CampaignHero.jsx src/components/landing-page/ExpectStrip.jsx
git commit -m "FIFTYPLUS.1 — /50plus page: coach video, date tiles, light sections"
```

---

### Task 9: Editor panel

**Files:**
- Modify: `src/components/LandingPageSettingsForm.jsx` (`BlockEditPanel` case, `blockSummary` case, `addBlock` guard)
- Create: `src/components/CampaignFunnelEdit.test.jsx`

**Interfaces:**
- Consumes: `buildTrialOptions` (already imported there), `MediaUpload`/`uploadMedia` as `HeroEdit` and `VideoTestimonialsEdit` use them, `Field`/`Input`/`Textarea`.
- Produces: `export function CampaignFunnelEdit({ block, onUpdate, locationId, uploadMedia, uploading, uploadErr, progress, brandName })`. `addBlock('campaign_funnel')` refuses (no-op + `window.alert`-free: a small inline notice state) when a block with the same `campaign` already exists.

- [ ] **Step 1: Write the failing test** (pattern: `PaidTrialEdit.test.jsx`)

```js
it('shows the trial picker as required, the keyword list, the video upload and every copy field', () => {
  render(<CampaignFunnelEdit block={newBlockOfType('campaign_funnel')} onUpdate={vi.fn()} locationId="loc-s" uploadMedia={vi.fn()} uploading={{}} uploadErr={{}} progress={{}} />)
  expect(screen.getByText(/REQUIRED/)).toBeTruthy()
  expect(screen.getByDisplayValue('50+')).toBeTruthy()
  expect(screen.getByText('Add video')).toBeTruthy()
  for (const label of ['Heading', 'Sub-copy', 'Button label', 'Booked — title', 'Booked — message', 'No classes — message', 'Not configured — message'])
    expect(screen.getByText(label)).toBeTruthy()
  expect(screen.getByDisplayValue('50plus')).toHaveProperty('readOnly', true)
})
it('writes the trial pair from the picker', () => {
  const onUpdate = vi.fn()
  const block = { ...newBlockOfType('campaign_funnel'), trial_membership_id: 'm', trial_plan_code: 'p' } // saved value stays selectable with no catalogue
  render(<CampaignFunnelEdit block={block} onUpdate={onUpdate} locationId="loc-s" uploadMedia={vi.fn()} uploading={{}} uploadErr={{}} progress={{}} />)
  fireEvent.change(screen.getByRole('combobox', { name: /Glofox trial plan/ }), { target: { value: '' } })
  expect(onUpdate).toHaveBeenCalledWith({ trial_membership_id: '', trial_plan_code: '' })
})
it('ticks choose the sections', () => {
  const onUpdate = vi.fn()
  render(<CampaignFunnelEdit block={newBlockOfType('campaign_funnel')} onUpdate={onUpdate} locationId="loc-s" uploadMedia={vi.fn()} uploading={{}} uploadErr={{}} progress={{}} />)
  fireEvent.click(screen.getByLabelText('Numbers (stats)'))
  expect(onUpdate).toHaveBeenCalledWith({ show_sections: ['video_testimonials', 'reviews'] })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/CampaignFunnelEdit.test.jsx`
Expected: FAIL (not exported).

- [ ] **Step 3: Implement** `CampaignFunnelEdit` beside `PaidTrialEdit`: campaign key read-only input; keyword `Textarea` (hint: one per line, a class is offered when its name contains any of them); trial `<select>` built from `/api/locations/${locationId}/glofox-memberships` like `PaidTrialEdit` with the `— Not set (page takes no bookings) —` option and a `REQUIRED` hint; poster `MediaUpload kind="image"` + video `MediaUpload kind="video"` using `uploadMedia({ file, kind: 'video', key: `${block.id}-video`, autoplay: true })` (poster captured with `captureVideoPoster` when none set, as `VideoTestimonialsEdit` does); the copy fields in Task 1 Step 4 order; three `expect_cards` title/body pairs; three checkboxes for `show_sections` labelled exactly `Numbers (stats)`, `Member videos`, `Google reviews`; the trial `<select>` carries `aria-label="Glofox trial plan"`; attribution overrides (`tag`, `lead_source`, `event_source_url`) under a "Tracking (advanced)" label with their derived defaults as placeholders. Add the `BlockEditPanel` case, a `blockSummary` case (`'50plus · ' + (block.trial_membership_id ? 'trial set' : 'NO TRIAL SET')`), and the `addBlock` duplicate guard.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/CampaignFunnelEdit.test.jsx src/components/PaidTrialEdit.test.jsx src/components/LandingPageSettingsForm.test.jsx`
Expected: PASS (adapt the last file name to whatever form tests exist).

- [ ] **Step 5: Commit**

```bash
git add src/components/LandingPageSettingsForm.jsx src/components/CampaignFunnelEdit.test.jsx
git commit -m "FIFTYPLUS.1 — campaign funnel editor panel"
```

---

### Task 10: CI mirror, browser check, PR

**Files:**
- Create: `docs/changelog/entries/<PR>.md` (after `gh pr create`)
- Modify: `docs/superpowers/specs/2026-10-30-50plus-landing-page-design.md` status line → `shipped as #<PR>`

- [ ] **Step 1: Run the CI mirror** (never the full suite beside a build on this machine; build was run in Task 8)

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:rpc-names && npm run check:bundle-sql && npm run check:ota-paths
```
Expected: every command exits 0. `check:route-guards` must list no new unguarded route (the two public routes are already in its `EXEMPT` map; the page is not a route). `check:location-scoping` must accept `src/app/50plus/page.js` (its read is keyed by `public_path`, the same shape as `/trial`; if it flags, register the read the way `/trial` is, never `EXEMPT`).

- [ ] **Step 2: Browser check** with the dev server (`npm run dev`, `http://localhost:3000/50plus`): with no block on the row the page renders hero + card with the not-configured message; add a `campaign_funnel` block via `/settings/landing-page` on Stillorgan (do NOT pick a trial in dev unless the dev DB is a copy), reload: tiles appear for THE 50+ CLUB only, phone width (375) stacks video over card, desktop shows two columns. Screenshot both widths into the PR.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "FIFTYPLUS.1 — /50plus: The 50+ Club trial landing page" --body-file /dev/stdin <<'EOF'
(What: campaign_funnel block, allow-listed class read, campaign-aware public routes, /50plus page, editor panel, light tone for three blocks. Why: the 50+ Meta ad. Risk: none to /trial, /start, /stillorgan (no campaign ⇒ byte-for-byte old path, pinned by the existing suites). Go-live: add the block on Stillorgan's row, pick The Elites Trial, upload the captioned coach video, check /api/public/classes?path=stillorgan&campaign=50plus lists only THE 50+ CLUB, confirm in Glofox the plan books that class, point the ad at https://www.un1tdublin.com/50plus. Meta: site pixel already loads; CAPI Lead goes to Stillorgan's dataset (= site dataset), check Events Manager for a server Lead after the first booking.)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 4: Changelog entry and spec status**, then commit and push

`docs/changelog/entries/<n>.md`: `| #<n> | FIFTYPLUS.1 — /50plus The 50+ Club trial landing page | 2026-10-30. A campaign_funnel block on the Stillorgan row drives a new public page that offers only THE 50+ CLUB's slots (allow-list on the class read, applied by both public routes) and grants The Elites Trial; light-tone variants for stats, video testimonials and reviews; editor panel; /50plus on the three UN1T public lists, pinned off tenant defaults. |`

```bash
git add docs/changelog/entries/<n>.md docs/superpowers/specs/2026-10-30-50plus-landing-page-design.md docs/superpowers/plans/2026-10-30-50plus-landing-page.md
git commit -m "FIFTYPLUS.1 — changelog entry" && git push
```
Expected: PR shows Test & lint and Next build green.
