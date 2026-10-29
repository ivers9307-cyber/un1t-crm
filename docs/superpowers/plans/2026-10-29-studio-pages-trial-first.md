# Studio Pages Trial-First (TRIALFIRST.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the paid-trial buy card in the hero of `/stillorgan` and `/hatch-street` with the studio pre-chosen, and give those two pages, `/trial` and `/corp` one modernised "Editorial" look (black hero, pale body sections, one white card style).

**Architecture:** Everything renders through the existing block system (`landing_page_settings.blocks` → `BlockRenderer`). The studio page loads its own trial config through `loadTrialStudios`, hands a client-safe studio view to `HeroBlock`, which lays the existing `PaidTrialFunnel` beside the hero copy. `pageCtas` learns that a shown trial owns the primary CTA. The card's classes move into one shared module so the four pages share a look. A validated `return_path` on the purchase POST brings a redirected buyer back to the page they started on.

**Tech Stack:** Next.js 16 App Router (server pages + client islands), React 19, Tailwind, Zod, vitest (`renderToStaticMarkup` for renderers in node env; jsdom + Testing Library for the funnel), supabase-js service-role client.

**Spec:** `docs/superpowers/specs/2026-10-29-studio-pages-trial-first-design.md`

## Global Constraints

- Branch off fresh `origin/main` (`git fetch origin main && git checkout -b trial-first-studio-pages origin/main`); this worktree's branch predates `/corp`.
- No database migration. Only `landing_page_settings.blocks` JSONB and code change.
- No new fonts, no colour. Black / white / grey, Poppins (`font-display`/`font-body`).
- Every customer-facing string comes from a block field or an existing default; no new hard-coded copy except the two fine-print lines already in the funnels.
- Low-ramp text on pale sections uses the `-700` ramp or black alpha; chips are `bg-<c>-500/10 text-<c>-700` (`check:guardrails` enforces chips).
- No `.select()` names a column the migrations do not define (`check:select-columns`). This plan adds no selects.
- `mobile/**` untouched.
- Run the CI mirror from CLAUDE.md before pushing, plus `npm run build`.
- Commit messages: `TRIALFIRST.1 — <summary>`, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. `?purchase=` that is not a UUID on a studio page: treated as no return (classic flow), never an error. Test in Task 1.
2. A studio row whose blocks have no `hero` block but a sellable trial: the card must still show, in a hero with the wordmark backdrop. Test in Task 7.
3. A Hatch lead form with `offer.enabled: true` and `second_path: 'class_funnel'` on a trial-first page: no offer panel, no funnel button, the compact capture form. Test in Task 6.
4. `return_path` with a query, hash, trailing slash or different case (`/Trial`, `/stillorgan/`, `/hatch-street?x=1`): normalised to `/trial`, never passed through. Test in Task 1.
5. `PaidTrialFunnel` given one studio that is NOT sellable (the switch went off after the page loaded): no "Change studio", the picker's "not available online" text, no form. Test in Task 4.

---

### Task 1: Return path helper and the purchase POST

**Files:**
- Create: `src/lib/trial-return-path.js`
- Create: `src/lib/trial-return-path.test.js`
- Modify: `src/app/api/public/trial-purchases/route.js` (Schema ~line 41; the two call sites: `startUn1tTrialCheckout(` ~line 287, `createTrialPurchasePayment(` ~line 296)
- Modify: `src/lib/trial-purchase-un1t-checkout.js:111-113`
- Modify: `src/app/api/public/trial-purchases/route.test.js`, `src/lib/trial-purchase-un1t-checkout.test.js`

**Interfaces:**
- Produces:
  - `TRIAL_RETURN_PATHS: readonly ['/trial', '/stillorgan', '/hatch-street']`
  - `normalizeTrialReturnPath(value: unknown): '/trial' | '/stillorgan' | '/hatch-street'` — exact string match against the list, else `'/trial'`.
  - `trialReturnPathFor(publicPath: string): '/stillorgan' | '/hatch-street' | '/trial'` — `'stillorgan' → '/stillorgan'`, `'hatch-street' → '/hatch-street'`, anything else `'/trial'`.
  - `parseTrialReturn(searchParams: object | undefined): { resumePurchaseId: string | null, initialStudio: 'stillorgan' | 'hatch' | null, cancelled: boolean }` — the exact logic now inline in `src/app/trial/page.js` (`/^[0-9a-f-]{36}$/i` on `purchase`, `studio` in `['stillorgan','hatch']`, `cancelled === '1'`).
  - POST body field `return_path` (optional string); `startUn1tTrialCheckout(db, { row, location, contact, returnPath })`.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/trial-return-path.test.js
import { describe, it, expect } from 'vitest'
import { normalizeTrialReturnPath, trialReturnPathFor, parseTrialReturn, TRIAL_RETURN_PATHS } from './trial-return-path'

describe('normalizeTrialReturnPath', () => {
  it('passes the three allowed paths through', () => {
    for (const p of TRIAL_RETURN_PATHS) expect(normalizeTrialReturnPath(p)).toBe(p)
  })
  it('answers /trial for anything else', () => {
    for (const v of ['/Trial', '/stillorgan/', '/hatch-street?x=1', '/hatch-street#trial', '/start', '', null, undefined, 42, 'https://un1tdublin.com/stillorgan'])
      expect(normalizeTrialReturnPath(v)).toBe('/trial')
  })
})
describe('trialReturnPathFor', () => {
  it('maps the two studio paths and falls back to /trial', () => {
    expect(trialReturnPathFor('stillorgan')).toBe('/stillorgan')
    expect(trialReturnPathFor('hatch-street')).toBe('/hatch-street')
    expect(trialReturnPathFor('other')).toBe('/trial')
  })
})
describe('parseTrialReturn', () => {
  it('reads a uuid purchase, a known studio and cancelled=1', () => {
    expect(parseTrialReturn({ purchase: '11111111-1111-1111-1111-111111111111', studio: 'hatch', cancelled: '1' }))
      .toEqual({ resumePurchaseId: '11111111-1111-1111-1111-111111111111', initialStudio: 'hatch', cancelled: true })
  })
  it('drops a non-uuid purchase, an unknown studio and a missing cancelled', () => {
    expect(parseTrialReturn({ purchase: 'abc', studio: 'HATCH' })).toEqual({ resumePurchaseId: null, initialStudio: null, cancelled: false })
    expect(parseTrialReturn(undefined)).toEqual({ resumePurchaseId: null, initialStudio: null, cancelled: false })
  })
})
```

Add to `src/app/api/public/trial-purchases/route.test.js` (follow the file's existing Stillorgan and Hatch happy-path tests; reuse their fixtures):

```js
it('a Stillorgan buyer from /stillorgan has the Revolut order return there', async () => {
  // …same setup as the existing "clean Stillorgan buyer opens the Revolut payment" test, body + { return_path: '/stillorgan' }
  expect(mocks.payment).toHaveBeenCalledWith(expect.objectContaining({ returnPath: '/stillorgan' }))
})
it('a Hatch buyer from /hatch-street is sent back there by un1t.online', async () => {
  // …same setup as the existing Hatch redirect test, body + { return_path: '/hatch-street' }
  expect(mocks.checkout).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    successUrl: 'https://un1tdublin.com/hatch-street?purchase=' + encodeURIComponent(ROW_ID) + '&studio=hatch',
  }))
})
it('an unknown return_path falls back to /trial', async () => {
  // body + { return_path: '/evil' } → mocks.payment called with returnPath '/trial'
})
```

(Use whatever base URL `mocks.baseUrl` resolves to in that file; if `mocks.checkout` is not asserted on `successUrl` today, assert on the second argument's `successUrl` property as above.)

Add to `src/lib/trial-purchase-un1t-checkout.test.js`:

```js
it('builds the success and cancel URLs on the caller\'s returnPath', async () => {
  // …happy path fixture, call startUn1tTrialCheckout(db, { row, location, contact, returnPath: '/hatch-street' })
  expect(createCheckoutLink).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    successUrl: `${BASE}/hatch-street?purchase=${encodeURIComponent(row.id)}&studio=hatch`,
    cancelUrl: `${BASE}/hatch-street?purchase=${encodeURIComponent(row.id)}&studio=hatch&cancelled=1`,
  }))
})
it('defaults to /trial when no returnPath is given', async () => { /* same, without returnPath → `${BASE}/trial?purchase=…` */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/trial-return-path.test.js src/app/api/public/trial-purchases/route.test.js src/lib/trial-purchase-un1t-checkout.test.js`
Expected: FAIL (module not found; `returnPath` undefined / `successUrl` on `/trial`).

- [ ] **Step 3: Implement `src/lib/trial-return-path.js`**

Pure module, no imports. Freeze `TRIAL_RETURN_PATHS`. `parseTrialReturn` is the three lines moved out of `src/app/trial/page.js:124-126`.

- [ ] **Step 4: Thread `return_path` through the route and the un1t checkout**

In the route's `Schema`: `return_path: z.string().max(64).optional()`. After validation: `const returnPath = normalizeTrialReturnPath(b.return_path)`. Pass `returnPath` to `createTrialPurchasePayment({ …, returnPath })` and to `startUn1tTrialCheckout(db, { row, location, contact, returnPath })`. In `trial-purchase-un1t-checkout.js`, `startUn1tTrialCheckout` takes `returnPath = '/trial'` and builds `successUrl = \`${base}${returnPath}?purchase=${encodeURIComponent(purchaseId)}&studio=hatch\``; update its header comment ("back to the page the buyer started on").

- [ ] **Step 5: Run the tests to verify they pass**

Run: the same command as Step 2. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/trial-return-path.js src/lib/trial-return-path.test.js src/app/api/public/trial-purchases/route.js src/app/api/public/trial-purchases/route.test.js src/lib/trial-purchase-un1t-checkout.js src/lib/trial-purchase-un1t-checkout.test.js
git commit -m "TRIALFIRST.1 — purchase POST takes a validated return_path"
```

---

### Task 2: `pageCtas` knows a shown trial, and `cta_label_short`

**Files:**
- Modify: `src/lib/landing-page-blocks.js` (`PAID_TRIAL_DEFAULT` ~line 237; `pageCtas` ~line 392)
- Modify: `src/lib/landing-page-blocks.test.js`
- Modify: `src/components/LandingPageSettingsForm.jsx` (`PaidTrialEdit`, after the "Heading" field ~line 1200)
- Modify: `src/components/landing-page/BlockRenderers.jsx` (`PaidTrialBlock` stub text ~line 465)

**Interfaces:**
- Produces:
  - `paidTrialBlockOf(blocks: unknown): object | null` — the first block with `type === 'paid_trial'`, else null.
  - `pageCtas(blocks, { trialShown = false } = {})` — when `trialShown` and `paidTrialBlockOf(blocks)` is non-null: `primary = { href: '#trial', label: (block.cta_label || 'Start my trial'), labelShort: (block.cta_label_short || '').trim() }`, `secondary = { href: '#waitlist', label: leadForm.button_label || 'Join the waitlist' }` when a `lead_form` block exists, else `null`. Otherwise unchanged.
  - `PAID_TRIAL_DEFAULT` gains `cta_label_short: ''`.

- [ ] **Step 1: Write the failing tests** (append to `src/lib/landing-page-blocks.test.js`)

```js
describe('pageCtas with a shown paid trial (TRIALFIRST.1)', () => {
  const trial = { id: 't', type: 'paid_trial', cta_label: 'Start my 14 Day Reset', cta_label_short: '€39 →' }
  const lead = { id: 'l', type: 'lead_form', button_label: 'Keep me posted', offer: { enabled: true, cta_url: 'https://x', cta_label: 'Claim' } }
  it('the trial owns the primary and the lead form is secondary; the offer is ignored', () => {
    expect(pageCtas([{ id: 'h', type: 'hero' }, lead, trial], { trialShown: true })).toEqual({
      primary: { href: '#trial', label: 'Start my 14 Day Reset', labelShort: '€39 →' },
      secondary: { href: '#waitlist', label: 'Keep me posted' },
    })
  })
  it('no lead form → no secondary; blank short label → empty string', () => {
    expect(pageCtas([{ ...trial, cta_label_short: '  ' }], { trialShown: true }))
      .toEqual({ primary: { href: '#trial', label: 'Start my 14 Day Reset', labelShort: '' }, secondary: null })
  })
  it('trialShown without a paid_trial block, or a trial block without trialShown, changes nothing', () => {
    expect(pageCtas([lead], { trialShown: true })).toEqual(pageCtas([lead]))
    expect(pageCtas([lead, trial])).toEqual(pageCtas([lead]))
  })
  it('the factory default carries cta_label_short', () => {
    expect(newBlockOfType('paid_trial').cta_label_short).toBe('')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/landing-page-blocks.test.js`
Expected: FAIL (primary resolves to the offer; `cta_label_short` undefined).

- [ ] **Step 3: Implement**

Add `paidTrialBlockOf` (export) and the first rule in `pageCtas` as specified; add the default field; update the comment above `pageCtas` ("a shown paid trial > a live offer > …").

- [ ] **Step 4: Editor field and stub note**

In `PaidTrialEdit`, after the "Heading" field: `<Field label="Short button label (phone header)" hint="Fits beside the logo on a phone, e.g. “€39 →”. Blank uses the full button label."><Input value={block.cta_label_short || ''} onChange={(v) => onUpdate({ cta_label_short: v })} maxLength={24} /></Field>`. In `PaidTrialBlock` change "Sold at /trial for {price}." to "Shown in this page's hero and at /trial for {price}."

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/lib/landing-page-blocks.test.js src/app/settings/landing-page/page.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/landing-page-blocks.js src/lib/landing-page-blocks.test.js src/components/LandingPageSettingsForm.jsx src/components/landing-page/BlockRenderers.jsx
git commit -m "TRIALFIRST.1 — a shown paid trial owns the page CTA; cta_label_short"
```

---

### Task 3: Shared client-safe studio view

**Files:**
- Create: `src/lib/trial-studio-view.js`
- Create: `src/lib/trial-studio-view.test.js`
- Modify: `src/app/trial/page.js` (replace `CLIENT_BLOCK_FIELDS`, `clientBlock`, the `studios` mapping and the `?purchase`/`?studio`/`?cancelled` parsing with the helpers)

**Interfaces:**
- Consumes: `loadTrialStudios` entries (`src/lib/trial-studios.js`), `paidTrialCopyFromBlock` (`src/lib/paid-trial.js`), `parseTrialReturn` (Task 1).
- Produces:
  - `clientTrialBlock(block: object | null): object` — exactly today's `clientBlock` in `src/app/trial/page.js` (the `CLIENT_BLOCK_FIELDS` pick plus the five resolved copy fields), moved.
  - `trialStudioView(entry, brand): { key, label, sellable, block, priceCents, currency, durationDays, productName }` — exactly today's per-studio mapping in `TrialPage` (`label` from `block.studio_label` else `brand.companyName || brand.locationName || ('Hatch Street' | 'Stillorgan')`; `sellable` only when `entry.sellable && entry.locationId && entry.config?.provider === (key === 'hatch' ? 'un1t_online' : 'glofox')`).
  - `STILLORGAN_LOCATION_ID` stays in the page.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/trial-studio-view.test.js
import { describe, it, expect } from 'vitest'
import { clientTrialBlock, trialStudioView } from './trial-studio-view'

const block = { eyebrow: 'e', heading: 'h', cta_label: 'Go', membership_id: 'm1', plan_code: 'p1', un1t_product_id: 'u1', tag: 't', studio_label: '' }
describe('clientTrialBlock', () => {
  it('keeps only the card words and resolves the refusal copy', () => {
    const out = clientTrialBlock(block)
    expect(out).toMatchObject({ eyebrow: 'e', heading: 'h', cta_label: 'Go' })
    for (const k of ['membership_id', 'plan_code', 'un1t_product_id', 'tag', 'studio_label']) expect(out).not.toHaveProperty(k)
    expect(typeof out.trial_used_text).toBe('string')
    expect(typeof out.help_cta_label).toBe('string')
  })
})
describe('trialStudioView', () => {
  const entry = { key: 'hatch', locationId: 'loc', sellable: true, block, config: { provider: 'un1t_online', priceCents: 3900, currency: 'EUR', durationDays: 14, productName: 'Reset' } }
  it('labels from the brand when studio_label is blank and marks the right provider sellable', () => {
    expect(trialStudioView(entry, { companyName: 'UN1T Hatch Street' })).toEqual({
      key: 'hatch', label: 'UN1T Hatch Street', sellable: true, block: clientTrialBlock(block),
      priceCents: 3900, currency: 'EUR', durationDays: 14, productName: 'Reset',
    })
  })
  it('a Glofox-provider block at hatch is not sellable; no brand falls back to the studio name', () => {
    const v = trialStudioView({ ...entry, config: { ...entry.config, provider: 'glofox' } }, null)
    expect(v.sellable).toBe(false)
    expect(v.label).toBe('Hatch Street')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/trial-studio-view.test.js` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement the module and switch `/trial/page.js` to it**

Move, do not rewrite. `/trial/page.js` keeps its behaviour byte-for-byte: `const { resumePurchaseId, initialStudio, cancelled } = parseTrialReturn(sp)`; `studios = entries.map((s, i) => trialStudioView(s, brands[i]))`.

- [ ] **Step 4: Run to verify they pass, and nothing else moved**

Run: `npx vitest run src/lib/trial-studio-view.test.js src/lib/paid-trial.test.js src/lib/trial-studios.test.js && npm run check:select-columns`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/trial-studio-view.js src/lib/trial-studio-view.test.js src/app/trial/page.js
git commit -m "TRIALFIRST.1 — client-safe trial studio view shared by the pages"
```

---

### Task 4: One white card style; the funnel learns single-studio, preview and returnPath

**Files:**
- Create: `src/components/landing-page/trial-card.js`
- Modify: `src/components/landing-page/PaidTrialFunnel.jsx`
- Modify: `src/components/landing-page/TrialStudioPicker.jsx`
- Modify: `src/components/landing-page/TrialTermsTick.jsx`
- Modify: `src/components/landing-page/ClassFunnelCheckout.jsx:103-118`
- Modify: `src/components/landing-page/CorpPromoFunnel.jsx`
- Modify: `src/components/landing-page/PaidTrialFunnel.test.jsx`

**Interfaces:**
- Produces (`trial-card.js`, a plain module of class strings, importable from client components):
  - `TRIAL_CARD = 'w-full max-w-lg rounded border border-black/10 bg-white text-black shadow-[0_24px_60px_-24px_rgba(0,0,0,0.6)] px-6 py-7 md:px-8'`
  - `TRIAL_INPUT = 'w-full bg-white border-0 border-b border-black/25 rounded-none px-0 py-3 text-base text-black placeholder-black/40 focus:outline-none focus:border-black'`
  - `TRIAL_BTN = 'lp-btn lp-btn-invert w-full disabled:opacity-50'`
  - `TRIAL_MUTED = 'text-black/60'`, `TRIAL_FINE = 'text-center text-[11px] text-black/50'`, `TRIAL_ERROR = 'text-sm text-red-700'`, `TRIAL_LINK = 'underline hover:text-black'`
- `PaidTrialFunnel` props gain `returnPath = '/trial'` (sent as `return_path` in the POST body) and `preview = false` (renders the form with every input and the button `disabled`, submits nothing, fires no `trackFunnelStep`).
- Single-studio rule: when `studios.length === 1` the "Change studio" button is not rendered; `restart()` after a failed resume goes to `'form'` when that one studio is sellable, else `'choose'` (which shows the picker's one disabled tile and the "not available online right now" line).

- [ ] **Step 1: Write the failing tests** (append to `PaidTrialFunnel.test.jsx`, reuse its fixtures and `fillDetails`)

```js
describe('single studio (TRIALFIRST.1)', () => {
  it('opens on the form with no studio picker and no Change studio', () => {
    render(<PaidTrialFunnel studios={[STILLORGAN]} initialStudio="stillorgan" />)
    expect(screen.queryByText('Choose your studio')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Change studio' })).toBeNull()
    expect(screen.getByPlaceholderText('First name')).toBeTruthy()
  })
  it('one studio that is not sellable shows the not-available line and no form', () => {
    render(<PaidTrialFunnel studios={[{ ...STILLORGAN, sellable: false }]} initialStudio="stillorgan" />)
    expect(screen.getByText(/not available online right now/)).toBeTruthy()
    expect(screen.queryByPlaceholderText('First name')).toBeNull()
  })
  it('posts return_path with the details', async () => {
    answers['/api/public/trial-purchases'] = { status: 200, body: { success: true, data: { purchaseId: PURCHASE_ID, checkout: {}, amount_cents: 3900, currency: 'EUR', product_name: 'The 14 Day Reset' } } }
    render(<PaidTrialFunnel studios={[STILLORGAN]} initialStudio="stillorgan" returnPath="/stillorgan" />)
    fillDetails()
    fireEvent.click(submitButton())
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body.return_path).toBe('/stillorgan')
  })
  it('preview renders a disabled form and never posts', () => {
    render(<PaidTrialFunnel studios={[STILLORGAN]} initialStudio="stillorgan" preview />)
    expect(screen.getByPlaceholderText('First name').disabled).toBe(true)
    expect(submitButton().disabled).toBe(true)
    fireEvent.click(submitButton())
    expect(posts).toHaveLength(0)
  })
})
```

Also update the existing assertions that look for dark-card classes if any do (grep the test for `text-white`; none expected).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/landing-page/PaidTrialFunnel.test.jsx`
Expected: FAIL on "Change studio" present / `return_path` undefined / preview inputs enabled.

- [ ] **Step 3: Create `trial-card.js` and restyle the five components**

Mechanical: replace each component's local `card`/`inputCls` with the module constants; flip `text-white*` to `text-black*` equivalents (`text-white/70` → `TRIAL_MUTED`, `text-white/45` fine print → `TRIAL_FINE`, `text-red-300` → `TRIAL_ERROR`, `accent-white` → `accent-black`, headings keep `font-display font-extrabold` and drop `uppercase` on the card's `h1`s so they read mixed-case). The price panel inside `PaidTrialFunnel` (`rounded-2xl bg-white text-black p-6`) becomes a plain top region of the card: eyebrow, heading, price top-right, subhead, ticks (the `rounded-full bg-black` tick marks stay). `TrialStudioPicker` tiles: `border border-black/15 bg-white hover:border-black`, text black. `ClassFunnelCheckout`'s "Secure checkout" heading and `← Back` go black on white. `CorpPromoFunnel` the same. Wire `preview` (every `<input>`/`<button>` gets `disabled={preview || …}`; `submit` returns early when `preview`; the mount `trackFunnelStep('trial_view')` is skipped when `preview`) and `returnPath` (`return_path: returnPath` in the POST body). Single-studio rule as in Interfaces.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/components/landing-page && npm run check:guardrails`
Expected: PASS (`no-low-contrast-chip` has nothing to flag; the card uses no chips).

- [ ] **Step 5: Commit**

```bash
git add src/components/landing-page/trial-card.js src/components/landing-page/PaidTrialFunnel.jsx src/components/landing-page/PaidTrialFunnel.test.jsx src/components/landing-page/TrialStudioPicker.jsx src/components/landing-page/TrialTermsTick.jsx src/components/landing-page/ClassFunnelCheckout.jsx src/components/landing-page/CorpPromoFunnel.jsx
git commit -m "TRIALFIRST.1 — one white trial card; single-studio, preview and returnPath on the funnel"
```

---

### Task 5: The Editorial body sections

**Files:**
- Modify: `tailwind.config.js` (`theme.extend.colors`: add `lp: { pale: '#F5F5F3' }`)
- Modify: `src/components/landing-page/BlockRenderers.jsx` — `Eyebrow`, `StatsBlock` + `Stat`, `PillarsBlock` + `Pillar`, `TestimonialBlock`, `ReviewsBlock` + `ReviewCard`
- Create: `src/components/landing-page/EditorialSections.test.jsx`

**Interfaces:**
- Produces: no new props. Visual contract, asserted by class presence:
  - `StatsBlock` section: `bg-lp-pale text-black py-20 md:py-28`; `Stat` number `text-[clamp(3rem,6.5vw,5rem)]`, label `text-black/55`; dividers `md:divide-black/10`.
  - `PillarsBlock` section: `bg-lp-pale text-black py-20 md:py-28`; each `Pillar` wrapped in `bg-white border border-black/10 rounded p-7`; number `text-3xl font-extrabold text-black/20`.
  - `TestimonialBlock` section stays `bg-black text-white`; the faint giant quote mark is removed; stars `text-white` (not amber); quote keeps its length-based size; author `text-white/60`.
  - `ReviewsBlock` section: `bg-lp-pale text-black py-20 md:py-28`; edge fades `from-lp-pale`; `ReviewCard`: `bg-white border border-black/10 rounded`, text `text-black/80`, name `text-black`, stars keep `text-amber-400` (Google's own mark), Google label `text-black/45`.
  - `Eyebrow` on pale sections is called with `dark={false}` (`text-black/45`, hairline `bg-black/25`).

- [ ] **Step 1: Write the failing test**

```jsx
// src/components/landing-page/EditorialSections.test.jsx
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatsBlock, PillarsBlock, TestimonialBlock, ReviewsBlock } from './BlockRenderers.jsx'

const stats = { id: 's', type: 'stats', items: [{ number: '200+', label: 'members' }] }
const pillars = { id: 'p', type: 'pillars', items: [{ number: '01', title: 'Coach-led', body: 'x' }] }
const quote = { id: 'q', type: 'testimonial', quote: 'Best gym', author: 'Nikki M' }
const reviews = { id: 'r', type: 'reviews', min_rating: 4 }
const reviewsData = { reviews: [{ id: '1', rating: 5, comment: 'Great', author_name: 'A', review_time: '2026-01-01', hidden: false }] }

describe('Editorial sections (TRIALFIRST.1)', () => {
  it('stats, pillars and reviews sit on the pale token with black type', () => {
    for (const html of [renderToStaticMarkup(<StatsBlock block={stats} />), renderToStaticMarkup(<PillarsBlock block={pillars} wordmark="UN1T" />), renderToStaticMarkup(<ReviewsBlock block={reviews} reviewsData={reviewsData} />)]) {
      expect(html).toContain('bg-lp-pale')
      expect(html).not.toContain('bg-black ')
      expect(html).not.toMatch(/text-white(\/\d+)?["\s]/)
    }
  })
  it('the quote band stays black with white stars and no giant quote mark', () => {
    const html = renderToStaticMarkup(<TestimonialBlock block={quote} />)
    expect(html).toContain('bg-black')
    expect(html).not.toContain('text-amber-400')
    expect(html).not.toContain('text-[12rem]')
  })
  it('a review card is white with a hairline', () => {
    const html = renderToStaticMarkup(<ReviewsBlock block={reviews} reviewsData={reviewsData} />)
    expect(html).toContain('bg-white border border-black/10')
    expect(html).toContain('from-lp-pale')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/landing-page/EditorialSections.test.jsx` — Expected: FAIL (`bg-lp-pale` absent).

- [ ] **Step 3: Implement the token and the four sections** as the Interfaces block specifies. Keep every `lp-reveal`/`lp-d*` class and every `<E>` edit path exactly where it is (the editor depends on them). The edit-mode placeholder branches (reviews with no data, video testimonials) follow the same surface as their live branch.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/landing-page && npm run check:guardrails && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tailwind.config.js src/components/landing-page/BlockRenderers.jsx src/components/landing-page/EditorialSections.test.jsx
git commit -m "TRIALFIRST.1 — Editorial body: pale stats, pillars and reviews; black quote band"
```

---

### Task 6: Trial-first hero and the compact lead form

**Files:**
- Modify: `src/components/landing-page/BlockRenderers.jsx` — `BlockRenderer` (new props), `HeroBlock`, `LeadFormBlock`
- Modify: `src/components/WaitlistWidget.jsx` (new `tone` prop)
- Modify: `src/components/landing-page/LeadFormBlock.test.jsx`
- Create: `src/components/landing-page/HeroTrialFirst.test.jsx`

**Interfaces:**
- Consumes: `PaidTrialFunnel` with `studios=[studio]`, `initialStudio`, `returnPath`, `resumePurchaseId`, `cancelled`, `hatchTerms`, `preview` (Task 4); `trial-card.js` is not needed here.
- Produces:
  - `BlockRenderer` props: `trial = null` (object below, forwarded to `HeroBlock` only) and `trialShown = false` (forwarded to `LeadFormBlock` as `compact`).
  - `trial: { studio: <trialStudioView>, returnPath: string, resumePurchaseId: string|null, cancelled: boolean, hatchTerms: object|null, preview: boolean } | null`.
  - `HeroBlock({ …existing, trial })`: when `trial` is non-null renders the trial-first layout: `<section id="trial" class="scroll-mt-20 relative min-h-[92svh] … lp-grain">`, the media backdrop as today (video > image > wordmark), scrim `linear-gradient(90deg, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0.55) 55%, rgba(0,0,0,0.35) 100%)` plus a bottom fade `linear-gradient(180deg, transparent 60%, rgba(0,0,0,0.9) 100%)`, a `max-w-6xl` grid `md:grid-cols-[1.05fr_1fr] gap-10 items-center`, left column: eyebrow (`text-white/60`), `<h1 class="font-display font-extrabold text-[clamp(2.4rem,6vw,5rem)] leading-[0.98] tracking-tight">` headline + subhead as `<span class="block text-white/50">` (NO `uppercase`), subtext `hidden md:block text-white/75`; right column: `<PaidTrialFunnel studios={[trial.studio]} initialStudio={trial.studio.key} returnPath={trial.returnPath} resumePurchaseId={trial.resumePurchaseId} cancelled={trial.cancelled} hatchTerms={trial.hatchTerms} preview={trial.preview} />`. No hero CTA buttons, no scroll cue, no `HeroMarquee`. `HeroMediaTools` still renders in edit mode. When `trial` is null the hero is byte-for-byte today's.
  - `LeadFormBlock({ …existing, compact = false })`: when `compact`: `<section id="waitlist" class="scroll-mt-20 bg-lp-pale text-black py-16 md:py-20 border-t border-black/10">`, no watermark, no offer panel, no funnel link (whatever `offer`/`second_path` say), a `max-w-6xl` grid `md:grid-cols-[1fr_1.2fr] gap-10 items-center`: heading (`font-display font-extrabold text-2xl md:text-3xl tracking-tight`, mixed case) + subtext (`text-black/65`) left, `<WaitlistWidget …same props… tone="light" />` right. `WaitlistWidget` gains `tone = 'dark' | 'light'` that swaps its input, label, success and fine-print classes to the `trial-card.js` constants when `'light'`.

- [ ] **Step 1: Write the failing tests**

```jsx
// src/components/landing-page/HeroTrialFirst.test.jsx
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.mock('./PaidTrialFunnel', () => ({ default: (p) => <div data-funnel={JSON.stringify({ keys: p.studios.map((s) => s.key), initial: p.initialStudio, returnPath: p.returnPath, preview: p.preview })} /> }))
import { HeroBlock } from './BlockRenderers.jsx'

const hero = { id: 'h', type: 'hero', eyebrow: 'Stillorgan, Dublin', headline: 'Fourteen days.', subhead: 'Every class.', subtext: 'Pay once.', image_url: 'https://x/y.jpg' }
const studio = { key: 'stillorgan', label: 'UN1T Stillorgan', sellable: true, block: {}, priceCents: 3900, currency: 'EUR', durationDays: 14, productName: 'Reset' }
const trial = { studio, returnPath: '/stillorgan', resumePurchaseId: null, cancelled: false, hatchTerms: null, preview: false }

describe('HeroBlock trial-first (TRIALFIRST.1)', () => {
  it('renders the card beside mixed-case copy under id=trial, with no marquee, cue or hero button', () => {
    const html = renderToStaticMarkup(<HeroBlock block={hero} trial={trial} ctaHref="#trial" ctaLabel="Start" />)
    expect(html).toContain('id="trial"')
    expect(html).toContain('"keys":["stillorgan"],"initial":"stillorgan","returnPath":"/stillorgan","preview":false')
    expect(html).toContain('Fourteen days.')
    expect(html).not.toMatch(/<h1[^>]*uppercase/)
    expect(html).not.toContain('lp-marquee-track')
    expect(html).not.toContain('lp-cue')
    expect(html).not.toContain('class="lp-btn')
  })
  it('without trial the classic hero is unchanged (marquee, cue, button)', () => {
    const html = renderToStaticMarkup(<HeroBlock block={hero} ctaHref="#waitlist" ctaLabel="Join" />)
    expect(html).toContain('lp-marquee-track')
    expect(html).toContain('lp-cue')
    expect(html).toContain('Join')
    expect(html).not.toContain('id="trial"')
  })
  it('an empty hero block still renders the card on the wordmark backdrop', () => {
    const html = renderToStaticMarkup(<HeroBlock block={{ id: 'h', type: 'hero' }} trial={trial} wordmark="UN1T" />)
    expect(html).toContain('id="trial"')
    expect(html).toContain('lp-outline')
    expect(html).toContain('"keys":["stillorgan"]')
  })
})
```

Append to `LeadFormBlock.test.jsx`:

```jsx
describe('LeadFormBlock compact soft path (TRIALFIRST.1)', () => {
  it('ignores a live offer and a funnel second path; renders the pale capture strip', () => {
    const html = renderToStaticMarkup(<LeadFormBlock block={{ ...base, offer, second_path: 'class_funnel' }} publicPath="hatch-street" compact ctaSecondaryHref="#start" ctaSecondaryLabel="Book" />)
    expect(html).toContain('id="waitlist"')
    expect(html).toContain('bg-lp-pale')
    expect(html).not.toContain('€189')
    expect(html).not.toContain('lp-was-strike')
    expect(html).not.toContain('href="#start"')
    expect(html).toContain('placeholder="Email"')
    expect(html).not.toContain('lp-outline')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/landing-page/HeroTrialFirst.test.jsx src/components/landing-page/LeadFormBlock.test.jsx`
Expected: FAIL (`id="trial"` absent; offer still rendered).

- [ ] **Step 3: Implement `HeroBlock` trial-first branch, `LeadFormBlock` compact branch, `WaitlistWidget` tone, and the two new `BlockRenderer` props**

In `BlockRenderer`'s switch: `case 'hero'` adds `trial={trial}`; `case 'lead_form'` adds `compact={trialShown}`. Split `HeroBlock`'s backdrop into a small `HeroBackdrop({ block, wordmark, scrim })` helper used by both branches so the media precedence is written once.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/components/landing-page src/components && npm run check:guardrails && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/landing-page/BlockRenderers.jsx src/components/WaitlistWidget.jsx src/components/landing-page/HeroTrialFirst.test.jsx src/components/landing-page/LeadFormBlock.test.jsx
git commit -m "TRIALFIRST.1 — trial-first hero with the card; compact lead form as the soft path"
```

---

### Task 7: Wire the studio page and the editor preview

**Files:**
- Modify: `src/app/welcome/[location]/page.js`
- Create: `src/app/welcome/[location]/page.test.js`
- Modify: `src/components/landing-page/EditModeOverlay.jsx` (new prop `trialPreview`, passed to the hero's `BlockRenderer` as `trial`, and `trialShown` to every block)
- Modify: `src/app/welcome/preview/page.js` (call `pageCtas(blocks, { trialShown: false })`; no behaviour change, keeps the signature honest)

**Interfaces:**
- Consumes: `loadTrialStudios(db)` and `TRIAL_STUDIOS` (`src/lib/trial-studios.js`), `trialStudioView`/`clientTrialBlock` (Task 3), `parseTrialReturn`/`trialReturnPathFor` (Task 1), `pageCtas(blocks, { trialShown })` (Task 2), `un1tTermsPayload` (`src/lib/un1t-online-funnel-copy`), `resolveLocationBrand`.
- Produces, in `page.js`:
  - `async function loadPageTrial(db, { row, publicPath, brand, resumePurchaseId, cancelled }): { trial: object|null, trialShown: boolean, studio: object|null }` (called after `brand` is resolved; `resuming = Boolean(resumePurchaseId)`) — finds the `TRIAL_STUDIOS` entry whose `publicPath` matches; if none → `{ trial: null, trialShown: false }`. Otherwise `entries = await loadTrialStudios(db)`, `entry = entries.find(e => e.publicPath === publicPath)`, `studio = trialStudioView(entry, brand)`. `trialShown = studio.sellable || resuming`. When shown: `trial = { studio, returnPath: trialReturnPathFor(publicPath), resumePurchaseId, cancelled, hatchTerms: entry.key === 'hatch' && studio.sellable ? un1tTermsPayload({ blocks: row.blocks, studioName: brand.locationName || studio.label, publicPath }) : null, preview: false }`. A thrown `loadTrialStudios` is caught → not shown (`logWarn('studio-page', …)`), unless `resuming`, in which case the card is still shown with `sellable: false` (resume overrides degrade).
  - Row missing or not publicly visible AND `resumePurchaseId` present → `redirect(\`/trial?purchase=${id}&studio=${key}${cancelled ? '&cancelled=1' : ''}\`)` (`key` from the path: `hatch-street → hatch`, else `stillorgan`), before the `notFound()`.
  - `pageCtas(blocks, { trialShown })`; `SiteFooter ctaHref={cta?.href || '#trial'}`.
  - Edit preview: `<EditModeOverlay … trialPreview={studio ? { studio, returnPath, resumePurchaseId: null, cancelled: false, hatchTerms, preview: true } : null} />` (built even when not sellable so the operator sees the card).

- [ ] **Step 1: Write the failing tests**

```js
// src/app/welcome/[location]/page.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = vi.hoisted(() => ({ row: null, entries: [], redirect: vi.fn(), notFound: vi.fn(() => { throw new Error('404') }) }))
vi.mock('next/navigation', () => ({ redirect: (u) => { mocks.redirect(u); throw new Error('redirect') }, notFound: mocks.notFound }))
vi.mock('next/headers', () => ({ headers: async () => new Map([['host', 'un1tdublin.com']]) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.row, error: null }) }) }) }) }) }))
vi.mock('@/lib/trial-studios', async (orig) => ({ ...(await orig()), loadTrialStudios: async () => mocks.entries }))
vi.mock('@/lib/host-brand', () => ({ resolveLocationBrand: async () => ({ companyName: 'UN1T Stillorgan', locationName: 'Stillorgan', shortName: 'UN1T' }), resolveOrgChrome: async () => ({ companyName: 'UN1T Dublin', studios: [], legalName: '' }) }))
vi.mock('@/lib/default-site-name', () => ({ resolveGymSiteName: async () => 'UN1T' }))
vi.mock('@/components/landing-page/PaidTrialFunnel', () => ({ default: (p) => <div data-funnel={p.studios[0].key} data-resume={p.resumePurchaseId || ''} /> }))
vi.mock('@/components/landing-page/RevealManager', () => ({ default: () => null }))
vi.mock('@/components/landing-page/reveal-arm', () => ({ RevealArmScript: () => null }))

import StudioLandingPage from './page.js'

const BLOCK = { id: 't', type: 'paid_trial', cta_label: 'Start my 14 Day Reset', membership_id: 'm', plan_code: 'p', price_cents: 3900 }
const sellable = { key: 'stillorgan', publicPath: 'stillorgan', locationId: 'loc', sellable: true, block: BLOCK, config: { provider: 'glofox', priceCents: 3900, currency: 'EUR', durationDays: 14, productName: 'Reset' } }
const page = (sp = {}) => StudioLandingPage({ params: Promise.resolve({ location: 'stillorgan' }), searchParams: Promise.resolve(sp) })
const html = async (sp) => renderToStaticMarkup(await page(sp))

beforeEach(() => {
  mocks.redirect.mockClear()
  mocks.row = { location_id: 'loc', public_path: 'stillorgan', publish_state: 'live', blocks: [{ id: 'h', type: 'hero', headline: 'Hi' }, BLOCK], locations: { id: 'loc', name: 'UN1T Stillorgan', organization_id: 'org' } }
  mocks.entries = [sellable]
})

describe('/welcome/[location] trial-first (TRIALFIRST.1)', () => {
  it('a sellable trial renders the card in the hero and the CTA points at #trial', async () => {
    const out = await html()
    expect(out).toContain('id="trial"')
    expect(out).toContain('data-funnel="stillorgan"')
    expect(out).toContain('href="#trial"')
    expect(out).not.toContain('lp-marquee-track')
  })
  it('an unsellable trial renders the classic hero with no card', async () => {
    mocks.entries = [{ ...sellable, sellable: false, config: null }]
    const out = await html()
    expect(out).not.toContain('id="trial"')
    expect(out).toContain('lp-marquee-track')
  })
  it('a return with ?purchase= shows the card even when the trial is no longer sellable', async () => {
    mocks.entries = [{ ...sellable, sellable: false, config: null }]
    const out = await html({ purchase: '11111111-1111-1111-1111-111111111111' })
    expect(out).toContain('data-resume="11111111-1111-1111-1111-111111111111"')
  })
  it('a missing row with ?purchase= redirects to /trial with the query intact', async () => {
    mocks.row = null
    await expect(page({ purchase: '11111111-1111-1111-1111-111111111111', cancelled: '1' })).rejects.toThrow('redirect')
    expect(mocks.redirect).toHaveBeenCalledWith('/trial?purchase=11111111-1111-1111-1111-111111111111&studio=stillorgan&cancelled=1')
  })
  it('a missing row without a return still 404s', async () => {
    mocks.row = null
    await expect(page()).rejects.toThrow('404')
    expect(mocks.redirect).not.toHaveBeenCalled()
  })
})
```

(`vi.mock` with the `async (orig)` importOriginal form keeps `TRIAL_STUDIOS` real. If `page.js` also renders `JsonLd` or reads `reviews`, they run fine against the fake client; add a mock only if one throws.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run 'src/app/welcome/[location]/page.test.js'`
Expected: FAIL (`id="trial"` absent; no redirect).

- [ ] **Step 3: Implement `loadPageTrial`, the redirect rule, the props, and the editor preview wiring** as the Interfaces block specifies. In `EditModeOverlay`, `trialPreview` goes to the `BlockRenderer` of every `hero` block as `trial`, and `trialShown={Boolean(trialPreview)}` to every block.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run 'src/app/welcome' src/components/landing-page && npm run check:location-scoping && npm run check:select-columns && npm run check:route-guards`
Expected: PASS (`check:location-scoping` already accepts this page; the new reads are through `loadTrialStudios`, scoped by `public_path`).

- [ ] **Step 5: Commit**

```bash
git add 'src/app/welcome/[location]/page.js' 'src/app/welcome/[location]/page.test.js' src/components/landing-page/EditModeOverlay.jsx src/app/welcome/preview/page.js
git commit -m "TRIALFIRST.1 — studio pages render the trial card in the hero; returns come home"
```

---

### Task 8: `/trial` and `/corp` on the new look, full verification, PR

**Files:**
- Modify: `src/app/trial/page.js` (pass `returnPath="/trial"` to `PaidTrialFunnel`; nothing else should be needed)
- Modify: `src/app/corp/corp-page.jsx` (nothing expected; verify the card renders white through Task 4)
- Create: `docs/changelog/entries/<PR>.md` (after `gh pr create`)
- Modify: `CLAUDE.md` is NOT touched (no new invariant); `docs/LESSONS.md` gets no entry unless a surprise turns up.

- [ ] **Step 1: Run the whole CI mirror**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:rpc-names && npm run check:bundle-sql && npm run check:ota-paths
```
Expected: every command exits 0. Fix anything red before going on.

- [ ] **Step 2: Production build**

Run: `npm run build` — Expected: completes with no errors (import resolution and Turbopack).

- [ ] **Step 3: Look at all four pages in the browser**

Run `npm run dev`; open `http://localhost:3000/welcome/stillorgan`, `/welcome/hatch-street`, `/trial`, `/corp` at desktop and at 375px wide. Check: the card is white; the hero copy is mixed-case; stats, pillars and reviews are pale; the quote band is black; the header button and the footer button scroll to the card; on the studio pages no "Change studio"; `/trial` still shows the studio chooser; `/corp` the claim form. In `/settings/landing-page` (signed in) the preview iframe shows the card disabled. Local reads the live `landing_page_settings` rows only if `.env.local` points at a database; if it does not, the dev preview harness at `/welcome/preview?p=stillorgan` exercises the renderers with fixtures (add a `paid_trial` block to its `FIXTURES` and pass a fake `trial` if needed, as a dev-only change).

- [ ] **Step 4: Push, open the PR, add the changelog entry**

```bash
git push -u origin HEAD
gh pr create --base main --title "TRIALFIRST.1 — studio pages sell the trial from the hero; Editorial look on all four funnel pages" --body-file - <<'EOF'
<summary of the spec's "The design" section, the go-live checklist copied in full, the reviewer's three calls>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```
Then write `docs/changelog/entries/<PR number>.md` (one row keyed `#<PR>`, the format of the newest entry in that folder), commit it `TRIALFIRST.1 — changelog entry`, push.

- [ ] **Step 5: Hand the go-live checklist to Richard**

The spec's section 8, before and after the merge, with the hero copy still to be written by him in the editor.
