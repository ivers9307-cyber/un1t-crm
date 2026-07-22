# Glofox Class Booking Funnel Block — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the hardcoded `/start` class-booking funnel into a prop-driven, location-aware landing-page block ("Glofox Class Booking Funnel") operators can insert on any editable page, and rewire `/start` onto the same component.

**Architecture:** Extract `StartFunnel.jsx` into a prop-driven `ClassFunnel.jsx` whose defaults ARE today's Stillorgan values (so `/start` stays byte-identical). The two location-hardcoded public routes (`classes`, `class-booking`) become location-aware by resolving `location_id` from a page's `public_path` (defaulting to `stillorgan` for back-compat). A new `class_funnel` block type wires it into the block registry, renderer, and editor. Only Stillorgan has live Glofox classes; elsewhere the picker shows the existing empty state.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase (service-role routes), Zod, Vitest, Tailwind.

**Worktree:** `~/code/un1t-crm-glofox` (branch `glofox-class-funnel-block`, off `origin/main`).

**Spec:** `docs/superpowers/specs/2026-07-22-glofox-class-funnel-block-design.md`

---

## File Structure

**Create:**
- `src/lib/public-landing.js` — pure `resolveLandingPath(raw)` helper (default + sanitize the `public_path` param before the DB lookup).
- `src/lib/public-landing.test.js` — its unit tests.
- `src/components/ClassFunnel.jsx` — prop-driven funnel component (generalised from `StartFunnel.jsx`).

**Modify:**
- `src/app/api/public/classes/route.js` — resolve location from `?path=` via the helper.
- `src/app/api/public/class-booking/route.js` — resolve location from `path` in body via the helper.
- `src/lib/landing-page-blocks.js` — add `CLASS_FUNNEL_DEFAULT`, `BLOCK_TYPES` entry, `primaryCta` case.
- `src/lib/landing-page-blocks.test.js` — registry + `primaryCta` tests (create if absent).
- `src/components/landing-page/BlockRenderers.jsx` — add `class_funnel` case + `ClassFunnelBlock`.
- `src/components/LandingPageSettingsForm.jsx` — add `ClassFunnelEdit`, `blockEditor` case, `summaryFor` case.
- `src/app/start/page.js` — import `ClassFunnel` instead of `StartFunnel`.

**Delete:**
- `src/components/StartFunnel.jsx` — replaced by `ClassFunnel.jsx` (only importer is `/start`).

---

## Task 1: `resolveLandingPath` helper (pure, TDD)

Both public routes currently hardcode `public_path='stillorgan'`. Extract the "which path do we look up" decision into one pure, tested helper so the routes stay thin and the default/sanitize behaviour is verified without a DB.

**Files:**
- Create: `src/lib/public-landing.js`
- Test: `src/lib/public-landing.test.js`

- [ ] **Step 1: Write the failing test**

`src/lib/public-landing.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { resolveLandingPath } from './public-landing'

describe('resolveLandingPath', () => {
  it('defaults to stillorgan when the param is absent', () => {
    expect(resolveLandingPath(null)).toBe('stillorgan')
    expect(resolveLandingPath(undefined)).toBe('stillorgan')
  })

  it('defaults to stillorgan for an empty/whitespace param', () => {
    expect(resolveLandingPath('')).toBe('stillorgan')
    expect(resolveLandingPath('   ')).toBe('stillorgan')
  })

  it('trims and lowercases a provided path', () => {
    expect(resolveLandingPath('  Hatch-Street ')).toBe('hatch-street')
  })

  it('passes a normal slug through unchanged', () => {
    expect(resolveLandingPath('stillorgan')).toBe('stillorgan')
  })

  it('strips characters outside the slug charset and caps length', () => {
    expect(resolveLandingPath('bad/../path')).toBe('badpath')
    expect(resolveLandingPath('a'.repeat(200))).toHaveLength(64)
  })

  it('falls back to stillorgan if sanitising empties the string', () => {
    expect(resolveLandingPath('/// ')).toBe('stillorgan')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/un1t-crm-glofox && npx vitest run src/lib/public-landing.test.js`
Expected: FAIL — `Failed to resolve import './public-landing'`.

- [ ] **Step 3: Write minimal implementation**

`src/lib/public-landing.js`:
```js
// Public landing pages are addressed by a URL-safe `public_path` slug
// (e.g. 'stillorgan', 'hatch-street') that maps 1:1 to a
// landing_page_settings row → location_id. Public funnel endpoints take
// this slug from the client; this helper sanitises it and defaults to
// Stillorgan (the original hard-coded target) so pre-existing callers
// that send no path keep working.
const DEFAULT_LANDING_PATH = 'stillorgan'

export function resolveLandingPath(raw) {
  if (raw == null) return DEFAULT_LANDING_PATH
  const cleaned = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '') // slug charset only — never trust the client
    .slice(0, 64)
  return cleaned || DEFAULT_LANDING_PATH
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/un1t-crm-glofox && npx vitest run src/lib/public-landing.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/code/un1t-crm-glofox
git add src/lib/public-landing.js src/lib/public-landing.test.js
git commit -m "GLOFOX-FUNNEL-BLOCK.1 — resolveLandingPath helper for location-aware public routes"
```

---

## Task 2: Location-aware `/api/public/classes`

Resolve the location from a `?path=` query param (helper-sanitised, defaults to `stillorgan`) instead of the hardcoded literal. Behaviour unchanged when no param is sent.

**Files:**
- Modify: `src/app/api/public/classes/route.js`

- [ ] **Step 1: Add the helper import**

At the top of `src/app/api/public/classes/route.js`, after the existing `import { listPublicClasses } from '@/lib/public-classes'` line, add:
```js
import { resolveLandingPath } from '@/lib/public-landing'
```

- [ ] **Step 2: Read + resolve the path inside `GET`**

Replace this block:
```js
  try {
    const { data: page } = await db.from('landing_page_settings')
      .select('location_id').eq('public_path', 'stillorgan').maybeSingle()
    if (!page?.location_id) return NextResponse.json({ success: true, data: { classes: [] } })
    const classes = await listPublicClasses(db, page.location_id, 7)
    return NextResponse.json({ success: true, data: { classes } })
  } catch (e) {
    logWarn('public-classes', 'list failed', { err: e })
    return NextResponse.json({ success: true, data: { classes: [] } })
  }
```
with:
```js
  try {
    const path = resolveLandingPath(new URL(request.url).searchParams.get('path'))
    const { data: page } = await db.from('landing_page_settings')
      .select('location_id').eq('public_path', path).maybeSingle()
    if (!page?.location_id) return NextResponse.json({ success: true, data: { classes: [] } })
    const classes = await listPublicClasses(db, page.location_id, 7)
    return NextResponse.json({ success: true, data: { classes } })
  } catch (e) {
    logWarn('public-classes', 'list failed', { err: e })
    return NextResponse.json({ success: true, data: { classes: [] } })
  }
```

- [ ] **Step 3: Update the route's header comment**

Change the top comment line:
```js
// GET /api/public/classes — live Glofox class list for the Stillorgan /start
// wizard. Public (display-safe data only); rate-limited. Stillorgan-scoped via
// the 'stillorgan' landing public_path so no arbitrary location can be queried.
```
to:
```js
// GET /api/public/classes?path=<public_path> — live Glofox class list for a
// location's landing page (the ClassFunnel block / /start wizard). Public
// (display-safe data only); rate-limited. Location is resolved ONLY from an
// existing landing_page_settings.public_path (defaults to 'stillorgan'), so no
// arbitrary location can be queried. Unknown/absent path → empty list.
```

- [ ] **Step 4: Verify the build compiles this route**

Run: `cd ~/code/un1t-crm-glofox && npm run lint 2>&1 | tail -5`
Expected: no new lint errors for `classes/route.js`.

- [ ] **Step 5: Commit**

```bash
cd ~/code/un1t-crm-glofox
git add src/app/api/public/classes/route.js
git commit -m "GLOFOX-FUNNEL-BLOCK.2 — /api/public/classes resolves location from ?path="
```

---

## Task 3: Location-aware `/api/public/class-booking`

Same treatment: accept an optional `path` in the JSON body, resolve the location via the helper, keep `stillorgan` as the default.

**Files:**
- Modify: `src/app/api/public/class-booking/route.js`

- [ ] **Step 1: Add the helper import**

After `import { logWarn } from '@/lib/log'` add:
```js
import { resolveLandingPath } from '@/lib/public-landing'
```

- [ ] **Step 2: Add `path` to the Zod schema**

In `const Schema = z.object({ ... })`, add this field (e.g. directly after the `event_id` line):
```js
  path: z.string().trim().max(64).optional(),
```

- [ ] **Step 3: Resolve the location from the body path**

Replace:
```js
  const { data: page } = await db.from('landing_page_settings')
    .select('location_id').eq('public_path', 'stillorgan').maybeSingle()
```
with:
```js
  const landingPath = resolveLandingPath(b.path)
  const { data: page } = await db.from('landing_page_settings')
    .select('location_id').eq('public_path', landingPath).maybeSingle()
```

Note: the rate-limit key and the `stillorgan-start` contact tag stay as-is in
this task — they are Stillorgan-correct today and re-keying them per-location is
out of scope (only Stillorgan books classes). Leave the existing
`classbook:stillorgan:${ip}` key and `tag: 'stillorgan-start'` unchanged.

- [ ] **Step 4: Update the route's header comment**

Change the first comment line from:
```js
// POST /api/public/class-booking — public enqueue for the /start wizard's class
```
to:
```js
// POST /api/public/class-booking — public enqueue for the ClassFunnel block /
// /start wizard's class path. Location resolved from the body `path`
// (public_path; defaults to 'stillorgan'); the chosen class is re-validated
// against that location's live bookable list.
```

- [ ] **Step 5: Verify lint**

Run: `cd ~/code/un1t-crm-glofox && npm run lint 2>&1 | tail -5`
Expected: no new lint errors.

- [ ] **Step 6: Commit**

```bash
cd ~/code/un1t-crm-glofox
git add src/app/api/public/class-booking/route.js
git commit -m "GLOFOX-FUNNEL-BLOCK.3 — /api/public/class-booking resolves location from body path"
```

---

## Task 4: Extract prop-driven `ClassFunnel.jsx`

Create `src/components/ClassFunnel.jsx` as a copy of `StartFunnel.jsx` generalised to props. **Defaults equal today's Stillorgan values**, so `<ClassFunnel />` with no props is byte-identical to the old `StartFunnel`. All copy is passed as complete strings (operator edits them directly — no `locationName` interpolation).

**Files:**
- Create: `src/components/ClassFunnel.jsx`

- [ ] **Step 1: Create the file as a copy of StartFunnel**

```bash
cd ~/code/un1t-crm-glofox
cp src/components/StartFunnel.jsx src/components/ClassFunnel.jsx
```

- [ ] **Step 2: Replace the top-of-file comment + `CONSULT_SLUG` constant**

In `src/components/ClassFunnel.jsx`, replace:
```js
// /start booking funnel. Details → pick a class → booked, then a skippable consult upsell.
// Consultation reuses the public booking APIs (POST /api/public/book, which
// fires a WhatsApp confirm on source='meta_book'). Class enqueues to the async
// pipeline (POST /api/public/class-booking) → the cron books + WhatsApp-confirms.

import { useState, useEffect, useRef } from 'react'
import { isValidMobileNumber } from '@/lib/phone-validate'
import { trackFunnelStep } from '@/lib/funnel-track'

const CONSULT_SLUG = 'free-un1t-consultation'
```
with:
```js
// Class-booking funnel. Details → pick a class → booked, then an optional
// consult upsell. Prop-driven + location-aware: `publicPath` scopes the class
// list + funnel telemetry; `consultSlug` selects the upsell booking type (empty
// ⇒ no upsell); all copy is passed in. Defaults reproduce the original
// Stillorgan /start funnel exactly. Rendered directly by /start and wrapped by
// the `class_funnel` landing-page block (see BlockRenderers.jsx).
//
// Class enqueues to POST /api/public/class-booking (async cron books +
// WhatsApp-confirms). Consult books via POST /api/public/book.

import { useState, useEffect, useRef } from 'react'
import { isValidMobileNumber } from '@/lib/phone-validate'
import { trackFunnelStep } from '@/lib/funnel-track'

// Default copy = today's live Stillorgan /start funnel, so a bare
// <ClassFunnel /> is unchanged from the old StartFunnel.
const DEFAULTS = {
  publicPath:       'stillorgan',
  consultSlug:      'free-un1t-consultation',
  heading:          'Your first 3 classes are free',
  subhead:          'Book your first class now — pop in your details to start.',
  consentLabel:     "I'd like to hear from UN1T Stillorgan by email, SMS and WhatsApp.",
  classDoneTitle:   "You're being booked in 🎉",
  classDoneBody:    "That's the first of your 3 free classes — watch for a WhatsApp confirming it. See you at UN1T Stillorgan!",
  consultDoneTitle: "You're booked 🎉",
  consultDoneBody:  "You'll get a WhatsApp confirming your consultation if we have your number. See you at UN1T Stillorgan!",
}
```

- [ ] **Step 3: Accept props with defaults in the component signature**

Replace:
```js
export default function StartFunnel() {
```
with:
```js
export default function ClassFunnel(props) {
  const {
    publicPath, consultSlug, heading, subhead, consentLabel,
    classDoneTitle, classDoneBody, consultDoneTitle, consultDoneBody,
  } = { ...DEFAULTS, ...Object.fromEntries(Object.entries(props || {}).filter(([, v]) => v != null && v !== '')) }
```
(This merge means an empty-string or missing prop falls back to the default —
except `consultSlug`, handled explicitly in Step 6.)

- [ ] **Step 4: Scope the class fetch to `publicPath`**

Replace:
```js
    fetch('/api/public/classes')
```
with:
```js
    fetch(`/api/public/classes?path=${encodeURIComponent(publicPath)}`)
```

- [ ] **Step 5: Send `publicPath` in the class-booking body + funnel-event**

In `bookClass`, replace the `body: JSON.stringify({ ... })` for `/api/public/class-booking` — add `path: publicPath,` as the first field:
```js
        body: JSON.stringify({
          path: publicPath,
          event_id: c.event_id, class_name: c.name, starts_at: c.starts_at,
          first_name: form.first_name.trim(), last_name: form.last_name.trim(),
          email: form.email.trim(), phone: form.phone.trim(), consent: form.consent,
          attribution: buildAttribution(),
        }),
```

In `fireStep`, replace `location_path: 'stillorgan', funnel: 'start', step,` with:
```js
          location_path: publicPath, funnel: 'start', step,
```

- [ ] **Step 6: Use `consultSlug` for the four consult fetches + guard the upsell**

Replace every `CONSULT_SLUG` occurrence with `consultSlug`:
- `fetch(\`/api/public/bookings/${consultSlug}\`)` (the `path === 'consultation'` effect)
- `fetch(\`/api/public/bookings/${consultSlug}/availability\`)` (the `step === 'calendar'` effect)
- `fetch(\`/api/public/bookings/${consultSlug}/slots?date=${date}\`)` (in `loadSlots`)

In the `path !== 'consultation'` guard effect, also bail when there is no consult
configured — replace:
```js
  useEffect(() => {
    if (path !== 'consultation') return
    fetch(`/api/public/bookings/${consultSlug}`)
```
with:
```js
  useEffect(() => {
    if (path !== 'consultation' || !consultSlug) return
    fetch(`/api/public/bookings/${consultSlug}`)
```

- [ ] **Step 7: Drive the visible copy from props**

Replace the details-step heading/subhead:
```js
            <h1 className="font-display font-extrabold uppercase text-3xl mb-2">Your first 3 classes are free</h1>
            <p className="text-white/60 text-sm">Book your first class now — pop in your details to start.</p>
```
with:
```js
            <h1 className="font-display font-extrabold uppercase text-3xl mb-2">{heading}</h1>
            <p className="text-white/60 text-sm">{subhead}</p>
```

Replace the consent `<span>` text:
```js
            <span>I&apos;d like to hear from UN1T Stillorgan by email, SMS and WhatsApp. <a href="/privacy" target="_blank" rel="noreferrer" className="underline">Privacy</a></span>
```
with:
```js
            <span>{consentLabel} <a href="/privacy" target="_blank" rel="noreferrer" className="underline">Privacy</a></span>
```

Replace the consult-done block copy:
```js
          <p className="font-display font-extrabold uppercase text-3xl text-white mb-3">You&apos;re booked 🎉</p>
          <p className="text-white/70">You&apos;ll get a WhatsApp confirming your consultation if we have your number. See you at UN1T Stillorgan!</p>
```
with:
```js
          <p className="font-display font-extrabold uppercase text-3xl text-white mb-3">{consultDoneTitle}</p>
          <p className="text-white/70">{consultDoneBody}</p>
```

Replace the class-done title/body:
```js
            <p className="font-display font-extrabold uppercase text-3xl text-white mb-3">You&apos;re being booked in 🎉</p>
            <p className="text-white/70">That&apos;s the first of your 3 free classes — watch for a WhatsApp confirming it. See you at UN1T Stillorgan!</p>
```
with:
```js
            <p className="font-display font-extrabold uppercase text-3xl text-white mb-3">{classDoneTitle}</p>
            <p className="text-white/70">{classDoneBody}</p>
```

- [ ] **Step 8: Hide the consult-upsell card when there is no consult configured**

The upsell card lives in the `step === 'classdone'` block. Wrap the "Want a coach in your corner?" card so it only renders when `consultSlug` is set. Replace:
```js
          <div className="rounded-2xl border border-white/15 bg-white/[0.04] p-5">
            <div className="font-bold text-lg">Want a coach in your corner?</div>
            <div className="text-white/60 text-sm mt-1 mb-4">Add a free consult — meet a coach, talk goals, get a plan. On us.</div>
            <button type="button" onClick={addConsult} className="lp-btn w-full">Add a free consult →</button>
          </div>
```
with:
```js
          {consultSlug && (
            <div className="rounded-2xl border border-white/15 bg-white/[0.04] p-5">
              <div className="font-bold text-lg">Want a coach in your corner?</div>
              <div className="text-white/60 text-sm mt-1 mb-4">Add a free consult — meet a coach, talk goals, get a plan. On us.</div>
              <button type="button" onClick={addConsult} className="lp-btn w-full">Add a free consult →</button>
            </div>
          )}
```

- [ ] **Step 9: Verify lint on the new component**

Run: `cd ~/code/un1t-crm-glofox && npm run lint 2>&1 | tail -5`
Expected: no new lint errors for `ClassFunnel.jsx`.

- [ ] **Step 10: Commit**

```bash
cd ~/code/un1t-crm-glofox
git add src/components/ClassFunnel.jsx
git commit -m "GLOFOX-FUNNEL-BLOCK.4 — prop-driven ClassFunnel (Stillorgan defaults) extracted from StartFunnel"
```

---

## Task 5: Rewire `/start` onto `ClassFunnel`, delete `StartFunnel`

`/start` renders the funnel with default props (⇒ identical behaviour). Then remove the now-orphaned `StartFunnel.jsx`.

**Files:**
- Modify: `src/app/start/page.js`
- Delete: `src/components/StartFunnel.jsx`

- [ ] **Step 1: Swap the import**

In `src/app/start/page.js`, replace:
```js
import StartFunnel from '@/components/StartFunnel'
```
with:
```js
import ClassFunnel from '@/components/ClassFunnel'
```

- [ ] **Step 2: Swap the render**

Replace:
```js
          <StartFunnel />
```
with:
```js
          <ClassFunnel />
```

- [ ] **Step 3: Delete the old component**

```bash
cd ~/code/un1t-crm-glofox
git rm src/components/StartFunnel.jsx
```

- [ ] **Step 4: Confirm nothing else imported StartFunnel**

Run: `cd ~/code/un1t-crm-glofox && grep -rn "StartFunnel" src/ || echo "NO REFERENCES — clean"`
Expected: `NO REFERENCES — clean`.

- [ ] **Step 5: Build to prove the page still resolves**

Run: `cd ~/code/un1t-crm-glofox && npm run build 2>&1 | tail -20`
Expected: build succeeds; `/start` in the route list; no import-resolution errors.

- [ ] **Step 6: Commit**

```bash
cd ~/code/un1t-crm-glofox
git add src/app/start/page.js
git commit -m "GLOFOX-FUNNEL-BLOCK.5 — rewire /start onto ClassFunnel; delete StartFunnel"
```

---

## Task 6: Register the `class_funnel` block type

Add the factory, palette entry, and `primaryCta` case so the block exists in the registry, passes validation (the Zod enum derives from `BLOCK_TYPES`), survives `blocksOrDefault`, and can drive a header CTA.

**Files:**
- Modify: `src/lib/landing-page-blocks.js`
- Test: `src/lib/landing-page-blocks.test.js`

- [ ] **Step 1: Write the failing tests**

`src/lib/landing-page-blocks.test.js` already exists and already imports
`newBlockOfType`, `BLOCK_TYPES`, `blocksOrDefault`, and `primaryCta`. Append ONLY
this new `describe` block to the end of the file (do NOT re-add the imports):
```js
describe('class_funnel block type', () => {
  it('is registered in the palette with the Glofox label', () => {
    const meta = BLOCK_TYPES.find((t) => t.type === 'class_funnel')
    expect(meta).toBeTruthy()
    expect(meta.label).toBe('Glofox Class Booking Funnel')
  })

  it('newBlockOfType builds a class_funnel with default copy', () => {
    const b = newBlockOfType('class_funnel')
    expect(b.type).toBe('class_funnel')
    expect(b.id).toBeTruthy()
    expect(b.heading).toBeTruthy()
    expect(b.consult_slug).toBe('') // no upsell until the operator picks one
  })

  it('blocksOrDefault keeps a saved class_funnel block', () => {
    const saved = [{ id: 'x1', type: 'class_funnel', heading: 'Hi' }]
    expect(blocksOrDefault(saved)).toHaveLength(1)
  })

  it('primaryCta points the header at the funnel anchor', () => {
    const cta = primaryCta([{ id: 'x1', type: 'class_funnel', heading: 'Book a class' }])
    expect(cta).toEqual({ href: '#start', label: 'Claim 3 free classes' })
  })

  it('lead_form still outranks class_funnel for the CTA', () => {
    const cta = primaryCta([
      { id: 'a', type: 'class_funnel' },
      { id: 'b', type: 'lead_form', button_label: 'Join' },
    ])
    expect(cta.href).toBe('#waitlist')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/code/un1t-crm-glofox && npx vitest run src/lib/landing-page-blocks.test.js`
Expected: FAIL — `class_funnel` not in `BLOCK_TYPES`; `newBlockOfType('class_funnel')` throws.

- [ ] **Step 3: Add the factory**

In `src/lib/landing-page-blocks.js`, directly after the `LEAD_FORM_DEFAULT` definition, add:
```js
const CLASS_FUNNEL_DEFAULT = () => ({
  id:                newBlockId(),
  type:              'class_funnel',
  heading:           'Your first 3 classes are free',
  subhead:           'Book your first class now — pop in your details to start.',
  consent_label:     "I'd like to hear from UN1T by email, SMS and WhatsApp.",
  class_done_title:  "You're being booked in 🎉",
  class_done_body:   "That's the first of your 3 free classes — watch for a WhatsApp confirming it. See you soon!",
  consult_done_title:"You're booked 🎉",
  consult_done_body: "You'll get a WhatsApp confirming your consultation if we have your number. See you soon!",
  consult_slug:      '', // operator picks a booking type; empty ⇒ no consult upsell
})
```

- [ ] **Step 4: Add the palette entry**

In the `BLOCK_TYPES` array, add after the `lead_form` line:
```js
  { type: 'class_funnel', label: 'Glofox Class Booking Funnel', description: 'Capture details, pick a live Glofox class, book. Optional free-consult upsell.', factory: CLASS_FUNNEL_DEFAULT },
```

- [ ] **Step 5: Add the `primaryCta` case**

In `primaryCta`, insert a `class_funnel` branch AFTER the `lead_form` block and BEFORE the `booking` block (lead capture keeps priority):
```js
  if (list.some((b) => b && b.type === 'class_funnel')) {
    return { href: '#start', label: 'Claim 3 free classes' }
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ~/code/un1t-crm-glofox && npx vitest run src/lib/landing-page-blocks.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd ~/code/un1t-crm-glofox
git add src/lib/landing-page-blocks.js src/lib/landing-page-blocks.test.js
git commit -m "GLOFOX-FUNNEL-BLOCK.6 — register class_funnel block type + CTA"
```

---

## Task 7: Render the block (`ClassFunnelBlock`)

Add the renderer case + component. It wraps `ClassFunnel` in a full-bleed hero-style section (matching `/start`'s frosted-card-over-image treatment) with `id="start"` so the header CTA anchor resolves. It passes `publicPath` (the location seam) + the operator's config.

**Files:**
- Modify: `src/components/landing-page/BlockRenderers.jsx`

- [ ] **Step 1: Import `ClassFunnel`**

Near the top of `src/components/landing-page/BlockRenderers.jsx`, alongside the existing `import WaitlistWidget from '@/components/WaitlistWidget'`, add:
```js
import ClassFunnel from '@/components/ClassFunnel'
```

- [ ] **Step 2: Add the renderer case**

In the `switch (block.type)` inside `BlockRenderer`, add after the `lead_form` case:
```js
    case 'class_funnel': return <ClassFunnelBlock block={block} onEdit={localOnEdit} publicPath={publicPath} />
```

- [ ] **Step 3: Add the `ClassFunnelBlock` component**

Add this component next to `LeadFormBlock` in the same file. In edit mode (`onEdit` set) the funnel would fire live fetches inside the operator editor, so render a static placeholder card there and only mount the live `ClassFunnel` on the public page:
```js
export function ClassFunnelBlock({ block, onEdit, publicPath }) {
  return (
    <section id="start" className="scroll-mt-20 relative min-h-[80svh] flex flex-col overflow-hidden bg-black text-white lp-grain border-t border-white/10">
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden="true"
        style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.5) 45%, rgba(0,0,0,0.85) 100%)' }}
      />
      <div className="relative z-10 flex-1 flex items-center justify-center px-5 py-20">
        {onEdit ? (
          <div className="w-full max-w-lg rounded-3xl border border-white/12 bg-black/45 backdrop-blur-xl px-6 py-8 text-center">
            <div className="font-display font-extrabold uppercase text-2xl mb-2">{block.heading || 'Glofox Class Booking Funnel'}</div>
            <p className="text-white/60 text-sm">Live class-booking funnel — shown to visitors on the published page. Edit copy and the consult upsell in the panel.</p>
          </div>
        ) : (
          <ClassFunnel
            publicPath={publicPath}
            consultSlug={block.consult_slug}
            heading={block.heading}
            subhead={block.subhead}
            consentLabel={block.consent_label}
            classDoneTitle={block.class_done_title}
            classDoneBody={block.class_done_body}
            consultDoneTitle={block.consult_done_title}
            consultDoneBody={block.consult_done_body}
          />
        )}
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Build to prove the renderer compiles**

Run: `cd ~/code/un1t-crm-glofox && npm run build 2>&1 | tail -20`
Expected: build succeeds, no import-resolution errors.

- [ ] **Step 5: Commit**

```bash
cd ~/code/un1t-crm-glofox
git add src/components/landing-page/BlockRenderers.jsx
git commit -m "GLOFOX-FUNNEL-BLOCK.7 — render class_funnel block (ClassFunnelBlock)"
```

---

## Task 8: Editor UI (`ClassFunnelEdit`)

Add the edit panel: copy fields + a consult booking-type dropdown reusing the
existing `availableBookingTypes` prop (identical pattern to `BookingEdit`).

**Files:**
- Modify: `src/components/LandingPageSettingsForm.jsx`

- [ ] **Step 1: Add the `summaryFor` case**

In `summaryFor`, add after the `lead_form` case:
```js
    case 'class_funnel': return block.consult_slug ? `consult: ${block.consult_slug}` : 'no consult upsell'
```

- [ ] **Step 2: Add the `BlockEditPanel` dispatch case**

In `BlockEditPanel`'s `switch`, add after the `lead_form` case:
```js
    case 'class_funnel': return <ClassFunnelEdit {...props} availableBookingTypes={props.availableBookingTypes} />
```
(`props` already carries `availableBookingTypes` — it is spread into every panel from `BlockEditPanel`'s parent; passing it explicitly here documents the dependency.)

- [ ] **Step 3: Add the `ClassFunnelEdit` component**

Add next to `LeadFormEdit`:
```js
function ClassFunnelEdit({ block, onUpdate, availableBookingTypes }) {
  const bts = availableBookingTypes || []
  return (
    <>
      <Field label="Heading">
        <Input value={block.heading || ''} onChange={(v) => onUpdate({ heading: v })} maxLength={200} placeholder="Your first 3 classes are free" />
      </Field>
      <Field label="Sub-copy" hint="Line under the heading on the details step.">
        <Textarea value={block.subhead || ''} onChange={(v) => onUpdate({ subhead: v })} maxLength={400} rows={2} />
      </Field>
      <Field label="Consent checkbox text" hint="Beside the opt-in checkbox. Keep it explicit for GDPR — name the channels (email/SMS/WhatsApp).">
        <Textarea value={block.consent_label || ''} onChange={(v) => onUpdate({ consent_label: v })} maxLength={400} rows={3} />
      </Field>
      <Field label="Class booked — title">
        <Input value={block.class_done_title || ''} onChange={(v) => onUpdate({ class_done_title: v })} maxLength={120} placeholder="You're being booked in 🎉" />
      </Field>
      <Field label="Class booked — message">
        <Textarea value={block.class_done_body || ''} onChange={(v) => onUpdate({ class_done_body: v })} maxLength={400} rows={2} />
      </Field>
      <Field
        label="Free-consult upsell"
        hint={bts.length === 0
          ? 'No active booking types here — leave empty for no upsell. Create one under Bookings → Booking types.'
          : 'Optional. Pick the booking type offered after a class is booked. Leave empty for no upsell.'}
      >
        {bts.length > 0 ? (
          <select
            value={block.consult_slug || ''}
            onChange={(e) => onUpdate({ consult_slug: e.target.value })}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
          >
            <option value="">— No consult upsell —</option>
            {bts.map((bt) => (
              <option key={bt.id} value={bt.slug}>{bt.name} ({bt.slug})</option>
            ))}
            {block.consult_slug && !bts.some((bt) => bt.slug === block.consult_slug) && (
              <option value={block.consult_slug}>{block.consult_slug} (no longer active)</option>
            )}
          </select>
        ) : (
          <Input value={block.consult_slug || ''} onChange={(v) => onUpdate({ consult_slug: v })} maxLength={200} placeholder="free-un1t-consultation" />
        )}
      </Field>
      {block.consult_slug && (
        <>
          <Field label="Consult booked — title">
            <Input value={block.consult_done_title || ''} onChange={(v) => onUpdate({ consult_done_title: v })} maxLength={120} placeholder="You're booked 🎉" />
          </Field>
          <Field label="Consult booked — message">
            <Textarea value={block.consult_done_body || ''} onChange={(v) => onUpdate({ consult_done_body: v })} maxLength={400} rows={2} />
          </Field>
        </>
      )}
    </>
  )
}
```

- [ ] **Step 4: Build to prove the editor compiles**

Run: `cd ~/code/un1t-crm-glofox && npm run build 2>&1 | tail -20`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
cd ~/code/un1t-crm-glofox
git add src/components/LandingPageSettingsForm.jsx
git commit -m "GLOFOX-FUNNEL-BLOCK.8 — editor panel for class_funnel (copy + consult picker)"
```

---

## Task 9: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full unit test run**

Run: `cd ~/code/un1t-crm-glofox && npm test 2>&1 | tail -15`
Expected: all pass, including `public-landing.test.js` and `landing-page-blocks.test.js`.

- [ ] **Step 2: CI mirror (all six checks)**

Run:
```bash
cd ~/code/un1t-crm-glofox && npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
```
Expected: every command exits 0. (No `WEB_PERMISSIONS` change here — the block
is public landing content, not a permissioned surface — so mobile-parity should
be unaffected; if it flags, re-check you added no gated key.)

- [ ] **Step 3: Production build**

Run: `cd ~/code/un1t-crm-glofox && npm run build 2>&1 | tail -20`
Expected: success; `/start`, `/api/public/classes`, `/api/public/class-booking` all present.

- [ ] **Step 4: Manual parity + smoke (dev server)**

Run: `cd ~/code/un1t-crm-glofox && npm run dev` then check:
- `/start` — details → pick a class → "being booked in" screen renders; the consult upsell card appears (default `consultSlug`), and "Add a free consult" loads the calendar. Confirm this matches production `/start` exactly.
- In the CRM, Settings → Landing page: the palette shows **"Glofox Class Booking Funnel"**; add it to Stillorgan's page; the consult dropdown lists booking types; save succeeds.
- Load that Stillorgan page publicly: the funnel books a class end-to-end.
- (Optional) Add the block to a non-Glofox location's page: the picker shows *"No classes are bookable online right now…"* — no crash.

- [ ] **Step 5: Push + open PR**

```bash
cd ~/code/un1t-crm-glofox
git push -u origin glofox-class-funnel-block
gh pr create --base main --fill
```
Report the PR URL. The Vercel preview check is the real build gate.

---

## Self-review notes (spec coverage)

- Location-aware via `public_path` (not `location_id`) → Tasks 1–3. ✅
- Single prop-driven component, `/start` rewired → Tasks 4–5. ✅
- New `class_funnel` block registered / rendered / editable → Tasks 6–8. ✅
- Operator-editable copy + consult picker reusing `availableBookingTypes` → Task 8. ✅
- Unrestricted palette availability (no Glofox-connection gate) → block added to `BLOCK_TYPES` unconditionally (Task 6). ✅
- Graceful empty state on non-Glofox pages → inherited from existing `ClassFunnel` copy; verified Task 9 Step 4. ✅
- Back-compat: absent `path` ⇒ `stillorgan`; `<ClassFunnel/>` defaults = today → Tasks 1–5. ✅
- Security: only real landing pages resolvable, display-safe data, no capacity → Tasks 2–3 comments + design. ✅
- Naming: "Glofox Class Booking Funnel" → Task 6. ✅

**Property-name consistency check:** block config keys are identical across
factory (Task 6), renderer props mapping (Task 7), and editor fields (Task 8):
`heading`, `subhead`, `consent_label`, `class_done_title`, `class_done_body`,
`consult_done_title`, `consult_done_body`, `consult_slug`. `ClassFunnel` props
(Task 4) are camelCase: `consentLabel`, `classDoneTitle`, `classDoneBody`,
`consultDoneTitle`, `consultDoneBody`, `consultSlug` — the snake→camel mapping
happens once, in `ClassFunnelBlock` (Task 7 Step 3). ✅
