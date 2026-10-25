# Hatch Street Foundation Offer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the live €189 foundation offer on `un1tdublin.com/welcome/hatch-street` beside a rebranded "Keep me posted" capture form, replacing a page whose every CTA still says "Join the waitlist".

**Architecture:** The existing `lead_form` block gains an optional `offer` group. With the group absent or `enabled: false`, every renderer produces byte-identical output to today — so Stillorgan and every other page are untouched and Hatch reverts by clearing one checkbox. When enabled, that same section renders two columns: a white `OfferPanel` linking out to the booking platform's checkout, and today's dark `WaitlistWidget` card unchanged. A new `pageCtas()` returns `{ primary, secondary }` so the hero can show two buttons; `primaryCta()` becomes a one-line wrapper so its existing call sites and tests keep passing.

**Tech Stack:** Next.js 16 App Router, React server components, Tailwind 3.4, vitest (node environment, `react-dom/server` for component tests — there is no jsdom in this repo).

**Spec:** `docs/superpowers/specs/2026-09-08-hatch-foundation-offer-design.md`

**Worktree:** `~/code/un1t-crm-hatchoffer`, branch `hatch-foundation-offer` (already created off `origin/main`). Run every command from that directory.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/lib/landing-page-blocks.js` | Offer defaults, the `offerOf()` guard, `pageCtas()` | Modify |
| `src/lib/landing-page-blocks.test.js` | Unit tests for the above | Modify |
| `src/app/globals.css` | `.lp-was-strike`, `.lp-btn-invert` | Modify (insert after line 197) |
| `src/components/landing-page/EditableField.jsx` | The shared `E` inline-edit wrapper, lifted out of `BlockRenderers.jsx` so `OfferPanel` can use it without a circular import | Create |
| `src/components/landing-page/OfferPanel.jsx` | The white offer panel | Create |
| `src/components/landing-page/OfferPanel.test.jsx` | Render tests for the panel | Create |
| `src/components/landing-page/BlockRenderers.jsx` | `LeadFormBlock` two-column branch, `HeroBlock` second button, `BlockRenderer` prop pass-through | Modify |
| `src/components/landing-page/LeadFormBlock.test.jsx` | Render tests for the branch | Create |
| `src/app/welcome/[location]/page.js` | Use `pageCtas`, pass the secondary through | Modify |
| `src/app/welcome/preview/page.js` | Same, plus the Hatch fixture gains the offer | Modify |
| `src/components/LandingPageSettingsForm.jsx` | Operator fields in `LeadFormEdit` | Modify |
| `docs/CHANGELOG.md` | One row for the PR | Modify |

`E` moves rather than being duplicated: `OfferPanel` needs it, and importing it back out of `BlockRenderers.jsx` — which will import `OfferPanel` — would be a cycle. Its 17 call sites in `BlockRenderers.jsx` are unchanged by the move; only the definition becomes an import.

---

### Task 1: The `offer` group and its guard

**Files:**
- Modify: `src/lib/landing-page-blocks.js:90-99` (the `LEAD_FORM_DEFAULT` factory)
- Test: `src/lib/landing-page-blocks.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/landing-page-blocks.test.js`:

```js
describe('offerOf (HATCH-OFFER.1)', () => {
  const on = (extra = {}) => ({
    id: 'l', type: 'lead_form',
    offer: { enabled: true, price: '€189', cta_url: 'https://x.test/#join', cta_label: 'Claim your rate', ticks: ['a', 'b'], ...extra },
  })

  it('returns null when the block has no offer group', () => {
    expect(offerOf({ id: 'l', type: 'lead_form' })).toBeNull()
  })
  it('returns null when the offer is present but disabled', () => {
    expect(offerOf(on({ enabled: false }))).toBeNull()
  })
  it('returns null when enabled is anything but boolean true', () => {
    expect(offerOf(on({ enabled: 'yes' }))).toBeNull()
  })
  it('returns null for a non-object or array offer', () => {
    expect(offerOf({ id: 'l', type: 'lead_form', offer: 'nope' })).toBeNull()
    expect(offerOf({ id: 'l', type: 'lead_form', offer: ['nope'] })).toBeNull()
  })
  it('returns null for a null block', () => {
    expect(offerOf(null)).toBeNull()
  })
  it('coerces a missing or malformed ticks list to an empty array', () => {
    expect(offerOf(on({ ticks: undefined })).ticks).toEqual([])
    expect(offerOf(on({ ticks: 'a,b' })).ticks).toEqual([])
  })
  it('drops blank and non-string ticks', () => {
    expect(offerOf(on({ ticks: ['a', '  ', 7, 'b'] })).ticks).toEqual(['a', 'b'])
  })
  it('trims cta_url and falls back on a blank cta_label', () => {
    const o = offerOf(on({ cta_url: '  https://x.test/#join  ', cta_label: '   ' }))
    expect(o.cta_url).toBe('https://x.test/#join')
    expect(o.cta_label).toBe('Claim your rate')
  })
  it('treats a non-string cta_url as empty', () => {
    expect(offerOf(on({ cta_url: 42 })).cta_url).toBe('')
  })
})

describe('lead_form offer defaults (HATCH-OFFER.1)', () => {
  it('ships an offer group that is off by default', () => {
    const b = newBlockOfType('lead_form')
    expect(b.offer.enabled).toBe(false)
    expect(offerOf(b)).toBeNull()
  })
  it('says foundation, never founding, in the offer defaults', () => {
    const json = JSON.stringify(newBlockOfType('lead_form').offer).toLowerCase()
    expect(json).toContain('foundation')
    expect(json).not.toContain('founding')
  })
  it('defaults the claim link to the booking platform signup anchor', () => {
    expect(newBlockOfType('lead_form').offer.cta_url).toBe('https://hatchstreet.un1t.online/#join')
  })
  it('keeps a lead_form carrying a malformed offer renderable', () => {
    const kept = blocksOrDefault([{ id: 'l', type: 'lead_form', offer: 'broken' }])
    expect(kept).toHaveLength(1)
    expect(offerOf(kept[0])).toBeNull()
  })
})
```

Add `offerOf` to the import block at the top of the same file (line 2-11), which currently ends `primaryCta,`:

```js
  primaryCta,
  offerOf,
} from './landing-page-blocks.js'
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/lib/landing-page-blocks.test.js
```

Expected: FAIL — `offerOf is not a function`.

- [ ] **Step 3: Add the defaults and the guard**

In `src/lib/landing-page-blocks.js`, insert `OFFER_DEFAULT` immediately **above** `const LEAD_FORM_DEFAULT` (currently line 90):

```js
// Foundation-offer group on the lead-form block (HATCH-OFFER.1).
// Off by default: with `enabled` false the lead-form section renders
// exactly as it did before this group existed, so no other studio
// page changes. Every visitor-facing string is a field — including
// the prices and the deadline — so closing the offer on 19 September
// is an edit at /settings/landing-page, not a deploy.
//
// Prices are STRINGS, not cents. Nothing here computes with them:
// they are display copy pointing at a checkout this repo does not
// own (hatchstreet.un1t.online). Deliberately unlike
// class_funnel.price_cents, which actually charges.
const OFFER_DEFAULT = () => ({
  enabled:         false,
  section_eyebrow: 'Two ways in',
  section_heading: 'Fix your rate\nbefore we open',
  eyebrow:         'Foundation membership',
  price:           '€189',
  was_price:       '€219',
  was_price_note:  'a month from 19 September',
  unit:            'per month\nfixed for life',
  deadline:        'Offer ends 19 September',
  ticks: [
    'Unlimited classes, full access from day one',
    'Your rate never rises while your membership stays active',
    'Pay today, next payment October',
  ],
  cta_label:       'Claim your rate',
  cta_url:         'https://hatchstreet.un1t.online/#join',
})
```

Then add one line to `LEAD_FORM_DEFAULT`, after `lead_source`:

```js
  lead_source:     'hatch_launch',
  offer:           OFFER_DEFAULT(),
})
```

Add the exported guard directly below `LEAD_FORM_DEFAULT`:

```js
// Single reader for the offer group — every consumer (pageCtas, the
// renderer) goes through this, so "is there an offer to show?" is
// answered in exactly one place. Returns a normalised offer or null.
// A corrupted group must degrade to the no-offer render rather than
// throw: this is the public funnel and a bad JSONB blob must never
// 500 it.
export function offerOf(block) {
  const o = block && typeof block === 'object' ? block.offer : null
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  if (o.enabled !== true) return null
  return {
    ...o,
    ticks: Array.isArray(o.ticks)
      ? o.ticks.filter((t) => typeof t === 'string' && t.trim())
      : [],
    cta_url: typeof o.cta_url === 'string' ? o.cta_url.trim() : '',
    cta_label: (typeof o.cta_label === 'string' && o.cta_label.trim()) || 'Claim your rate',
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/lib/landing-page-blocks.test.js
```

Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/lib/landing-page-blocks.js src/lib/landing-page-blocks.test.js
git commit -m "HATCH-OFFER.1 — offer group on the lead_form block, off by default"
```

---

### Task 2: `pageCtas()` for the hero's two buttons

**Files:**
- Modify: `src/lib/landing-page-blocks.js:232-256` (the `primaryCta` function)
- Test: `src/lib/landing-page-blocks.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/landing-page-blocks.test.js`:

```js
describe('pageCtas (HATCH-OFFER.1)', () => {
  const leadForm = (offer) => ({ id: 'l', type: 'lead_form', button_label: 'Keep me posted', ...(offer ? { offer } : {}) })
  const liveOffer = { enabled: true, cta_url: 'https://hatchstreet.un1t.online/#join', cta_label: 'Claim your rate' }

  it('promotes the offer to primary and demotes the form to secondary', () => {
    expect(pageCtas([leadForm(liveOffer)])).toEqual({
      primary: { href: 'https://hatchstreet.un1t.online/#join', label: 'Claim your rate', external: true },
      secondary: { href: '#waitlist', label: 'Keep me posted' },
    })
  })
  it('falls back to the form as primary when the offer is off', () => {
    expect(pageCtas([leadForm({ ...liveOffer, enabled: false })])).toEqual({
      primary: { href: '#waitlist', label: 'Keep me posted' },
      secondary: null,
    })
  })
  it('falls back to the form as primary when the offer has no url', () => {
    expect(pageCtas([leadForm({ ...liveOffer, cta_url: '   ' })])).toEqual({
      primary: { href: '#waitlist', label: 'Keep me posted' },
      secondary: null,
    })
  })
  it('never returns a secondary when there is no lead form', () => {
    expect(pageCtas([{ id: 'b', type: 'booking', slug: 'x' }]).secondary).toBeNull()
    expect(pageCtas([]).secondary).toBeNull()
  })
  it('returns both null for a page with no funnel block', () => {
    expect(pageCtas([{ id: 'h', type: 'hero' }])).toEqual({ primary: null, secondary: null })
  })
})

describe('primaryCta wraps pageCtas (HATCH-OFFER.1)', () => {
  it('returns the offer url when the offer is live', () => {
    const blocks = [{ id: 'l', type: 'lead_form', button_label: 'Keep me posted', offer: { enabled: true, cta_url: 'https://x.test/#join', cta_label: 'Claim' } }]
    expect(primaryCta(blocks).href).toBe('https://x.test/#join')
  })
  it('is identical to pageCtas().primary', () => {
    const blocks = [{ id: 'b', type: 'booking', slug: 'x' }]
    expect(primaryCta(blocks)).toEqual(pageCtas(blocks).primary)
  })
})
```

Add `pageCtas` to the import block at the top of the file alongside `offerOf`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/lib/landing-page-blocks.test.js
```

Expected: FAIL — `pageCtas is not a function`.

- [ ] **Step 3: Replace `primaryCta` with `pageCtas` plus a wrapper**

In `src/lib/landing-page-blocks.js`, replace the whole `primaryCta` function (currently lines 232-256) and the comment block above it with:

```js
// Conversion targets — derived from a page's own blocks.
// Priority: a live foundation offer > explicit lead capture >
// booking > event signup.
//
// `primary` is what the sticky header, hero and footer point at.
// `secondary` exists only when a live offer has pushed the lead form
// out of the primary slot, and only the hero renders it — the header
// and footer are space-constrained and the second path is one scroll
// away on the same page.
//
// Either may be null: a page with no funnel block renders no CTA
// rather than a dead anchor.
export function pageCtas(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const leadForm = list.find((b) => b && b.type === 'lead_form')
  const offer = leadForm ? offerOf(leadForm) : null
  const waitlist = leadForm
    ? {
        href: '#waitlist',
        label: (leadForm.button_label && leadForm.button_label.trim()) || 'Join the waitlist',
      }
    : null

  // A live offer with no URL is an operator half-edit, not a reason
  // to ship <a href="">. Fall through to the form.
  if (offer && offer.cta_url) {
    return {
      primary: { href: offer.cta_url, label: offer.cta_label, external: true },
      secondary: waitlist,
    }
  }
  if (waitlist) return { primary: waitlist, secondary: null }
  if (list.some((b) => b && b.type === 'class_funnel')) {
    return { primary: { href: '#start', label: 'Claim 3 free classes' }, secondary: null }
  }
  if (list.some((b) => b && b.type === 'booking')) {
    return { primary: { href: '#book', label: 'Book a free consult' }, secondary: null }
  }
  const event = list.find((b) => b && b.type === 'event')
  if (event) {
    return {
      primary: {
        href: `#event-${event.slug || 'signup'}`,
        label: (event.title && event.title.trim()) || 'Sign up',
      },
      secondary: null,
    }
  }
  return { primary: null, secondary: null }
}

// Back-compat wrapper. Kept because two pages and a dozen tests call
// it; it is exactly pageCtas().primary and must stay that way.
export function primaryCta(blocks) {
  return pageCtas(blocks).primary
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/lib/landing-page-blocks.test.js
```

Expected: PASS. The pre-existing `primaryCta` describe block must still be green — that is the proof the wrapper is behaviour-preserving.

- [ ] **Step 5: Commit**

```bash
git add src/lib/landing-page-blocks.js src/lib/landing-page-blocks.test.js
git commit -m "HATCH-OFFER.1 — pageCtas returns primary + secondary; primaryCta wraps it"
```

---

### Task 3: The red strike and the inverted button

**Files:**
- Modify: `src/app/globals.css` — insert after line 197 (the closing `}` of `.lp-card-glow`, before the blank line and the `/* ── Success check draw` comment)

No test: this is presentational CSS with no logic. It is verified visually in Task 8.

- [ ] **Step 1: Add the two classes**

Insert after the `.lp-card-glow` rule:

```css

/* ── Was-price strike + inverted pill (offer panel) ───────────────
   The strike is a pseudo-element rather than text-decoration so it
   can be angled, and the <s> carries text-decoration:none so the
   browser default doesn't draw a second, flat line through it.
   Red is deliberate and lives here, not in the un1t-* token set:
   those are the CRM's light-theme tokens and this is the public
   marketing site. */
.lp-was-strike {
  position: relative;
  display: inline-block;
  text-decoration: none;
}
.lp-was-strike::after {
  content: '';
  position: absolute;
  left: -5%;
  right: -5%;
  top: 52%;
  height: 3px;
  border-radius: 2px;
  background: #e02424;
  transform: rotate(-9deg);
}

/* The one white pill, inverted for use ON a white panel. Declared
   after .lp-btn so it wins on source order — both are single-class
   selectors, so specificity alone would not decide it. */
.lp-btn-invert {
  background: #000;
  color: #fff;
}
.lp-btn-invert:hover {
  box-shadow: 0 16px 40px -14px rgba(0, 0, 0, 0.6);
}
```

- [ ] **Step 2: Commit**

Nothing here is unit-testable. A CSS syntax error surfaces in `npm run build`
(Task 9, Step 5) and the visual result is checked by eye in Task 9, Step 2.

```bash
git add src/app/globals.css
git commit -m "HATCH-OFFER.1 — lp-was-strike and lp-btn-invert for the offer panel"
```

---

### Task 4: Lift `E` into its own module

**Files:**
- Create: `src/components/landing-page/EditableField.jsx`
- Modify: `src/components/landing-page/BlockRenderers.jsx:37-51` (the comment block and `function E`)

Pure refactor, no behaviour change. Its 17 `<E .../>` call sites are untouched.

- [ ] **Step 1: Create the module**

Create `src/components/landing-page/EditableField.jsx`:

```jsx
// Pass-through wrapper used by every block renderer. When `onEdit`
// is provided (i.e. we're rendering inside the iframe edit
// overlay), the text becomes contentEditable and edits propagate
// via onEdit(path, newValue). When `onEdit` is absent (public page
// render), it's a plain text fragment — zero overhead.
//
// Lives in its own module rather than in BlockRenderers.jsx because
// OfferPanel needs it too, and importing it back out of
// BlockRenderers — which imports OfferPanel — would be a cycle.
// NO 'use client' here, matching BlockRenderers: EditableText brings
// its own, and this module must stay importable from a server page.

import EditableText from './EditableText'

export function E({ value, onEdit, path, multiline }) {
  if (!onEdit) return <>{value}</>
  return (
    <EditableText
      value={value || ''}
      onChange={(v) => onEdit(path, v)}
      multiline={multiline}
    />
  )
}
```

- [ ] **Step 2: Delete the local copy and import it instead**

In `src/components/landing-page/BlockRenderers.jsx`, delete the comment block and function currently at lines 37-51 (from `// Pass-through wrapper used by every block renderer.` through the closing `}` of `function E`), and add to the import list after `import EditableText from './EditableText'`:

```js
import { E } from './EditableField'
```

`EditableText` stays imported — other code in the file uses it directly.

- [ ] **Step 3: Verify nothing broke**

```bash
npm run lint && npx vitest run src/components/landing-page/
```

Expected: lint clean (in particular no `no-unused-vars` on `EditableText`; if it reports one, the direct uses are gone and the import should be dropped), tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/landing-page/EditableField.jsx src/components/landing-page/BlockRenderers.jsx
git commit -m "HATCH-OFFER.1 — lift the E inline-edit wrapper into its own module"
```

---

### Task 5: `OfferPanel`

**Files:**
- Create: `src/components/landing-page/OfferPanel.jsx`
- Test: `src/components/landing-page/OfferPanel.test.jsx`

- [ ] **Step 1: Write the failing tests**

Create `src/components/landing-page/OfferPanel.test.jsx`:

```jsx
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import OfferPanel from './OfferPanel.jsx'

// vitest runs under the `node` environment here with no jsdom and no
// @testing-library/react. We render to static markup via
// react-dom/server and assert on the HTML, the same way
// InstagramStrip.test.jsx does.

const offer = {
  enabled: true,
  eyebrow: 'Foundation membership',
  price: '€189',
  was_price: '€219',
  was_price_note: 'a month from 19 September',
  unit: 'per month\nfixed for life',
  deadline: 'Offer ends 19 September',
  ticks: ['Unlimited classes', 'Rate never rises'],
  cta_label: 'Claim your rate',
  cta_url: 'https://hatchstreet.un1t.online/#join',
}

describe('OfferPanel (HATCH-OFFER.1)', () => {
  it('strikes the was-price and states the direction for screen readers', () => {
    const html = renderToStaticMarkup(<OfferPanel offer={offer} />)
    expect(html).toContain('lp-was-strike')
    expect(html).toContain('€219')
    expect(html).toContain('€219 a month from 19 September')
  })
  it('hides the strike and its note entirely when there is no was-price', () => {
    const html = renderToStaticMarkup(<OfferPanel offer={{ ...offer, was_price: '' }} />)
    expect(html).not.toContain('lp-was-strike')
    expect(html).not.toContain('a month from 19 September')
  })
  it('links out to the checkout with rel=noopener and no target', () => {
    const html = renderToStaticMarkup(<OfferPanel offer={offer} />)
    expect(html).toContain('href="https://hatchstreet.un1t.online/#join"')
    expect(html).toContain('rel="noopener"')
    expect(html).not.toContain('target=')
  })
  it('renders no anchor at all when the url is empty', () => {
    const html = renderToStaticMarkup(<OfferPanel offer={{ ...offer, cta_url: '' }} />)
    expect(html).not.toContain('<a ')
    expect(html).toContain('€189')
  })
  it('hides the deadline chip when the deadline is empty', () => {
    const html = renderToStaticMarkup(<OfferPanel offer={{ ...offer, deadline: '' }} />)
    expect(html).not.toContain('Offer ends')
  })
  it('renders one list item per tick and survives an empty list', () => {
    expect(renderToStaticMarkup(<OfferPanel offer={offer} />).match(/<li/g)).toHaveLength(2)
    expect(renderToStaticMarkup(<OfferPanel offer={{ ...offer, ticks: [] }} />)).not.toContain('<li')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/components/landing-page/OfferPanel.test.jsx
```

Expected: FAIL — cannot resolve `./OfferPanel.jsx`.

- [ ] **Step 3: Write the component**

Create `src/components/landing-page/OfferPanel.jsx`:

```jsx
// OfferPanel — the white foundation-offer card inside the lead-form
// section (HATCH-OFFER.1). Inverted on purpose: a solid white panel
// on the black page is what makes the price the first thing the eye
// lands on.
//
// Pure presentation, no state. Every string arrives from the block's
// operator-editable `offer` group, already normalised by offerOf()
// in src/lib/landing-page-blocks.js — so this component may assume
// `ticks` is an array of non-blank strings and `cta_url` is trimmed.
//
// Its own file rather than another section inside BlockRenderers.jsx,
// which already carries every block renderer plus SiteHeader and
// SiteFooter.

import { E } from './EditableField'

export default function OfferPanel({ offer, onEdit }) {
  const ticks = Array.isArray(offer.ticks) ? offer.ticks : []
  const href = offer.cta_url || ''
  return (
    <div className="lp-reveal lp-d1 rounded-2xl bg-white text-black p-8 md:p-10 flex flex-col">
      <div className="flex items-start justify-between gap-4 mb-8">
        <div className="flex items-center gap-4">
          <span className="h-px w-10 bg-black/25" aria-hidden="true" />
          <span className="text-[11px] uppercase tracking-[0.35em] font-semibold text-black/45">
            <E value={offer.eyebrow} onEdit={onEdit} path={['offer', 'eyebrow']} />
          </span>
        </div>
        {offer.deadline ? (
          <span className="shrink-0 rounded-full bg-black text-white text-[10px] uppercase tracking-[0.16em] font-bold px-3 py-1.5">
            <E value={offer.deadline} onEdit={onEdit} path={['offer', 'deadline']} />
          </span>
        ) : null}
      </div>

      {/* The strike is decorative: it reads as "it USED to be €219",
          while the truth is that it BECOMES €219 on the 19th. Sighted
          visitors get the direction from the deadline chip and the
          page copy; the visually-hidden note gives it to everyone
          else, and stays operator-editable like the rest. */}
      <div className="flex items-end gap-4 flex-wrap mb-8">
        {offer.was_price ? (
          <>
            <s
              className="lp-was-strike font-display font-extrabold text-3xl md:text-4xl text-black/40 tracking-tight pb-1"
              aria-hidden="true"
            >
              {offer.was_price}
            </s>
            <span className="sr-only">{offer.was_price} {offer.was_price_note}</span>
          </>
        ) : null}
        <span className="font-display font-extrabold text-6xl md:text-7xl leading-[0.85] tracking-tight">
          {offer.price}
        </span>
        <span className="whitespace-pre-line text-[11px] uppercase tracking-[0.18em] font-extrabold text-black/55 leading-[1.5] pb-2">
          {offer.unit}
        </span>
      </div>

      <ul className="flex flex-col gap-3 mb-9">
        {ticks.map((t, i) => (
          <li key={i} className="flex gap-3 text-[15px] leading-relaxed text-black/70">
            <span className="opacity-55" aria-hidden="true">✓</span>
            <span><E value={t} onEdit={onEdit} path={['offer', 'ticks', i]} /></span>
          </li>
        ))}
      </ul>

      {href ? (
        <div className="mt-auto">
          <a href={href} rel="noopener" className="lp-btn lp-btn-invert">
            {offer.cta_label}
            <span className="lp-btn-arrow" aria-hidden="true">→</span>
          </a>
        </div>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/components/landing-page/OfferPanel.test.jsx
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/landing-page/OfferPanel.jsx src/components/landing-page/OfferPanel.test.jsx
git commit -m "HATCH-OFFER.1 — OfferPanel: white offer card with the red was-price strike"
```

---

### Task 6: The `LeadFormBlock` two-column branch

**Files:**
- Modify: `src/components/landing-page/BlockRenderers.jsx` — the `LeadFormBlock` function (currently starting line 320)
- Test: `src/components/landing-page/LeadFormBlock.test.jsx`

- [ ] **Step 1: Write the failing tests**

Create `src/components/landing-page/LeadFormBlock.test.jsx`:

```jsx
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LeadFormBlock } from './BlockRenderers.jsx'

// Node environment, no jsdom — render to static markup. WaitlistWidget
// is safe to render this way: it uses useState only, with no effects
// on mount.

const base = {
  id: 'l',
  type: 'lead_form',
  heading: 'Keep me posted',
  subtext: 'Not ready to join yet?',
  button_label: 'Keep me posted',
  consent_label: 'I agree',
}

const offer = {
  enabled: true,
  section_eyebrow: 'Two ways in',
  section_heading: 'Fix your rate\nbefore we open',
  eyebrow: 'Foundation membership',
  price: '€189',
  was_price: '€219',
  was_price_note: 'a month from 19 September',
  unit: 'per month\nfixed for life',
  deadline: 'Offer ends 19 September',
  ticks: ['Unlimited classes'],
  cta_label: 'Claim your rate',
  cta_url: 'https://hatchstreet.un1t.online/#join',
}

describe('LeadFormBlock offer branch (HATCH-OFFER.1)', () => {
  it('renders the offer panel and keeps the capture form when the offer is on', () => {
    const html = renderToStaticMarkup(<LeadFormBlock block={{ ...base, offer }} publicPath="hatch-street" />)
    expect(html).toContain('€189')
    expect(html).toContain('lp-was-strike')
    expect(html).toContain('https://hatchstreet.un1t.online/#join')
    expect(html).toContain('Keep me posted')
  })
  it('keeps the section anchored at #waitlist so the secondary CTA still resolves', () => {
    const html = renderToStaticMarkup(<LeadFormBlock block={{ ...base, offer }} publicPath="hatch-street" />)
    expect(html).toContain('id="waitlist"')
  })
  it('renders no offer markup at all when the offer is off', () => {
    const html = renderToStaticMarkup(<LeadFormBlock block={{ ...base, offer: { ...offer, enabled: false } }} publicPath="hatch-street" />)
    expect(html).not.toContain('€189')
    expect(html).not.toContain('lp-was-strike')
    expect(html).toContain('Keep me posted')
  })
  it('renders the pre-offer section unchanged for a block with no offer group', () => {
    const withOut = renderToStaticMarkup(<LeadFormBlock block={base} publicPath="hatch-street" />)
    const disabled = renderToStaticMarkup(<LeadFormBlock block={{ ...base, offer: { ...offer, enabled: false } }} publicPath="hatch-street" />)
    expect(withOut).toBe(disabled)
  })
  it('does not throw on a corrupted offer group', () => {
    const html = renderToStaticMarkup(<LeadFormBlock block={{ ...base, offer: 'broken' }} publicPath="hatch-street" />)
    expect(html).toContain('Keep me posted')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/components/landing-page/LeadFormBlock.test.jsx
```

Expected: FAIL — the offer assertions miss; `€189` is not in the markup.

- [ ] **Step 3: Add the branch**

In `src/components/landing-page/BlockRenderers.jsx`, add to the imports:

```js
import OfferPanel from './OfferPanel'
import { offerOf } from '@/lib/landing-page-blocks'
```

Replace the whole `LeadFormBlock` function with:

```jsx
export function LeadFormBlock({ block, onEdit, publicPath, campaign }) {
  // offerOf() is the one place that decides whether there is an offer
  // to show; a malformed group returns null and we render exactly
  // what this section rendered before the group existed.
  const offer = offerOf(block)
  const eyebrow = offer ? (offer.section_eyebrow || 'Two ways in') : 'Join us'
  return (
    <section id="waitlist" className="scroll-mt-20 relative bg-black text-white py-24 md:py-32 border-t border-white/10 overflow-hidden">
      {/* Faint outlined watermark drifting behind the form — depth
          without noise. */}
      <div className="absolute inset-y-0 -right-10 hidden lg:flex items-center pointer-events-none" aria-hidden="true">
        <span className="lp-outline font-display font-extrabold leading-none text-[13rem]">UN1T</span>
      </div>

      {offer ? (
        <div className="relative max-w-6xl mx-auto px-6">
          <Eyebrow>{eyebrow}</Eyebrow>
          {(offer.section_heading || onEdit) && (
            <h2 className="lp-reveal whitespace-pre-line font-display font-extrabold uppercase text-3xl md:text-5xl leading-[1.04] tracking-tight mb-12 md:mb-16 max-w-2xl">
              <E value={offer.section_heading} onEdit={onEdit} path={['offer', 'section_heading']} multiline />
            </h2>
          )}
          <div className="grid lg:grid-cols-[1.25fr_1fr] gap-6 lg:gap-8 items-stretch">
            <OfferPanel offer={offer} onEdit={onEdit} />
            <div className="lp-reveal lp-d2 rounded-2xl border border-white/12 p-8 md:p-10 flex flex-col">
              {(block.heading || onEdit) && (
                <h3 className="font-display font-extrabold uppercase text-xl md:text-2xl tracking-tight mb-3">
                  <E value={block.heading} onEdit={onEdit} path={['heading']} />
                </h3>
              )}
              {(block.subtext || onEdit) && (
                <p className="text-white/60 leading-relaxed text-sm md:text-base mb-7">
                  <E value={block.subtext} onEdit={onEdit} path={['subtext']} multiline />
                </p>
              )}
              <div className="mt-auto">
                <WaitlistWidget
                  publicPath={publicPath}
                  campaign={campaign}
                  buttonLabel={block.button_label}
                  successMessage={block.success_message}
                  consentLabel={block.consent_label}
                />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="relative max-w-6xl mx-auto px-6 grid lg:grid-cols-2 gap-12 lg:gap-20 items-center">
          <div>
            <Eyebrow>{eyebrow}</Eyebrow>
            {(block.heading || onEdit) && (
              <h2 className="lp-reveal font-display font-extrabold uppercase text-3xl md:text-5xl leading-[1.04] tracking-tight mb-5">
                <E value={block.heading} onEdit={onEdit} path={['heading']} />
              </h2>
            )}
            {(block.subtext || onEdit) && (
              <p className="lp-reveal lp-d1 text-white/70 leading-relaxed max-w-md text-base md:text-lg">
                <E value={block.subtext} onEdit={onEdit} path={['subtext']} multiline />
              </p>
            )}
          </div>
          <div className="lp-reveal lp-d2">
            <div className="lp-card-glow rounded-2xl p-6 md:p-8">
              <WaitlistWidget
                publicPath={publicPath}
                campaign={campaign}
                buttonLabel={block.button_label}
                successMessage={block.success_message}
                consentLabel={block.consent_label}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/components/landing-page/
```

Expected: PASS — the new file's 5 tests plus `OfferPanel.test.jsx` and `InstagramStrip.test.jsx`. The "renders the pre-offer section unchanged" test is the backward-compatibility proof.

- [ ] **Step 5: Commit**

```bash
git add src/components/landing-page/BlockRenderers.jsx src/components/landing-page/LeadFormBlock.test.jsx
git commit -m "HATCH-OFFER.1 — lead-form section renders two doors when the offer is live"
```

---

### Task 7: Two hero buttons, wired from both pages

**Files:**
- Modify: `src/components/landing-page/BlockRenderers.jsx` — `BlockRenderer` (line 67) and `HeroBlock` (line 132)
- Modify: `src/app/welcome/[location]/page.js:25` and `:128-165`
- Modify: `src/app/welcome/preview/page.js:18` and `:71-95`

- [ ] **Step 1: Add the secondary CTA to the hero**

In `BlockRenderers.jsx`, change the `BlockRenderer` signature and its hero case:

```js
export default function BlockRenderer({ block, onEdit, locationId, publicPath, campaign, reviewsData, ctaHref, ctaLabel, ctaSecondaryHref, ctaSecondaryLabel }) {
```

```js
    case 'hero':        return <HeroBlock        block={block} {...editProps} ctaHref={ctaHref} ctaLabel={ctaLabel} ctaSecondaryHref={ctaSecondaryHref} ctaSecondaryLabel={ctaSecondaryLabel} />
```

Change the `HeroBlock` signature and the three lines under it:

```js
export function HeroBlock({ block, onEdit, locationId, ctaHref, ctaLabel, ctaSecondaryHref, ctaSecondaryLabel }) {
  const href = ctaHref || (onEdit ? '#book' : null)
  const label = ctaLabel || 'Book a free consult'
  // An off-site primary (the foundation checkout) gets rel=noopener.
  // Derived from the href rather than passed as a prop — the hero
  // already receives the target and nothing else needs to know.
  const external = /^https?:\/\//i.test(href || '')
```

Replace the CTA block near the end of the hero (currently the `{href && (` block containing a single `<a>`):

```jsx
          {href && (
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <a href={href} className="lp-btn" {...(external ? { rel: 'noopener' } : {})}>
                {label}
                <span className="lp-btn-arrow" aria-hidden="true">→</span>
              </a>
              {ctaSecondaryHref && (
                <a href={ctaSecondaryHref} className="lp-btn-ghost">
                  {ctaSecondaryLabel}
                  <span className="lp-btn-arrow" aria-hidden="true">→</span>
                </a>
              )}
            </div>
          )}
```

- [ ] **Step 2: Wire the public studio page**

In `src/app/welcome/[location]/page.js`, change the import on line 25:

```js
import { blocksOrDefault, pageCtas } from '@/lib/landing-page-blocks'
```

Replace line 128:

```js
  const { primary: cta, secondary: cta2 } = pageCtas(blocks)
```

Add the two props to the `BlockRenderer` in the map (leave `SiteHeader` and `SiteFooter` exactly as they are — they stay single-button by design):

```jsx
        <BlockRenderer
          key={block.id}
          block={block}
          publicPath={params.location}
          reviewsData={reviewsData}
          ctaHref={cta?.href || null}
          ctaLabel={cta?.label}
          ctaSecondaryHref={cta2?.href || null}
          ctaSecondaryLabel={cta2?.label}
        />
```

- [ ] **Step 3: Wire the dev preview page the same way**

In `src/app/welcome/preview/page.js`, change line 18:

```js
import { pageCtas } from '@/lib/landing-page-blocks'
```

Replace line 71:

```js
  const { primary: cta, secondary: cta2 } = pageCtas(blocks)
```

And add the same two props to its `BlockRenderer`:

```jsx
        <BlockRenderer
          key={block.id}
          block={block}
          publicPath={key}
          reviewsData={null}
          ctaHref={cta?.href || null}
          ctaLabel={cta?.label}
          ctaSecondaryHref={cta2?.href || null}
          ctaSecondaryLabel={cta2?.label}
        />
```

- [ ] **Step 4: Add the hero test**

In `src/components/landing-page/LeadFormBlock.test.jsx`, add `HeroBlock` to the
existing import at the top of the file — an import appended mid-file trips
eslint's `import/first`:

```jsx
import { LeadFormBlock, HeroBlock } from './BlockRenderers.jsx'
```

Then append:

```jsx
describe('HeroBlock second CTA (HATCH-OFFER.1)', () => {
  const hero = { id: 'h', type: 'hero', headline: 'UN1T OPENS 2ND STUDIO' }

  it('renders both buttons when a secondary is supplied', () => {
    const html = renderToStaticMarkup(
      <HeroBlock block={hero} ctaHref="https://hatchstreet.un1t.online/#join" ctaLabel="Claim your rate" ctaSecondaryHref="#waitlist" ctaSecondaryLabel="Keep me posted" />
    )
    expect(html).toContain('Claim your rate')
    expect(html).toContain('Keep me posted')
    expect(html).toContain('lp-btn-ghost')
  })
  it('marks an off-site primary rel=noopener', () => {
    const html = renderToStaticMarkup(<HeroBlock block={hero} ctaHref="https://hatchstreet.un1t.online/#join" ctaLabel="Claim your rate" />)
    expect(html).toContain('rel="noopener"')
  })
  it('leaves an on-page anchor without rel', () => {
    const html = renderToStaticMarkup(<HeroBlock block={hero} ctaHref="#waitlist" ctaLabel="Join the waitlist" />)
    expect(html).not.toContain('rel="noopener"')
  })
  it('renders one button when there is no secondary', () => {
    const html = renderToStaticMarkup(<HeroBlock block={hero} ctaHref="#waitlist" ctaLabel="Join the waitlist" />)
    expect(html).not.toContain('lp-btn-ghost')
  })
})
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run src/components/landing-page/
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/landing-page/BlockRenderers.jsx src/components/landing-page/LeadFormBlock.test.jsx 'src/app/welcome/[location]/page.js' src/app/welcome/preview/page.js
git commit -m "HATCH-OFFER.1 — hero carries both CTAs; both pages read pageCtas"
```

Note the quoting on the bracketed path — zsh treats `[location]` as a glob and the `git add` silently stages nothing without it.

---

### Task 8: Operator fields in the editor

**Files:**
- Modify: `src/components/LandingPageSettingsForm.jsx:805-825` (`LeadFormEdit`)

No unit test: this is a controlled-input panel in a 1,300-line client component with no existing test harness, and the repo has no jsdom. It is verified by hand in Task 9.

- [ ] **Step 1: Replace `LeadFormEdit`**

```jsx
function LeadFormEdit({ block, onUpdate }) {
  // The offer group is nested, and updateBlock() shallow-merges the
  // patch into the block — so every offer edit must spread the whole
  // current group or it would drop the other fields.
  const offer = (block.offer && typeof block.offer === 'object' && !Array.isArray(block.offer)) ? block.offer : {}
  const setOffer = (patch) => onUpdate({ offer: { ...offer, ...patch } })
  const ticks = Array.isArray(offer.ticks) ? offer.ticks : []
  const setTick = (i, v) => {
    const next = [ticks[0] || '', ticks[1] || '', ticks[2] || '']
    next[i] = v
    setOffer({ ticks: next })
  }
  return (
    <>
      <Field label="Heading">
        <Input value={block.heading || ''} onChange={(v) => onUpdate({ heading: v })} maxLength={200} placeholder="Keep me posted" />
      </Field>
      <Field label="Sub-copy" hint="Paragraph under the heading.">
        <Textarea value={block.subtext || ''} onChange={(v) => onUpdate({ subtext: v })} maxLength={600} rows={3} />
      </Field>
      <Field label="Button label">
        <Input value={block.button_label || ''} onChange={(v) => onUpdate({ button_label: v })} maxLength={60} placeholder="Keep me posted" />
      </Field>
      <Field label="Success message" hint="Shown after a successful submit.">
        <Textarea value={block.success_message || ''} onChange={(v) => onUpdate({ success_message: v })} maxLength={300} rows={2} />
      </Field>
      <Field label="Consent checkbox text" hint="Shown beside the opt-in checkbox. Keep it explicit for GDPR — name the channels (email/SMS/WhatsApp).">
        <Textarea value={block.consent_label || ''} onChange={(v) => onUpdate({ consent_label: v })} maxLength={400} rows={3} />
      </Field>

      <div className="pt-4 mt-2 border-t border-un1t-border">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={offer.enabled === true}
            onChange={(e) => setOffer({ enabled: e.target.checked })}
            className="mt-0.5"
          />
          <span>
            <span className="block text-sm text-un1t-text">Show a membership offer beside this form</span>
            <span className="block text-[11px] text-un1t-muted mt-0.5">Adds a price panel to the left of the form and points the hero&apos;s main button at it. Untick when the offer closes and the section goes back to the form on its own.</span>
          </span>
        </label>
      </div>

      {offer.enabled === true && (
        <>
          <Field label="Section eyebrow">
            <Input value={offer.section_eyebrow || ''} onChange={(v) => setOffer({ section_eyebrow: v })} maxLength={60} placeholder="Two ways in" />
          </Field>
          <Field label="Section heading" hint="Line breaks are kept exactly as you type them.">
            <Textarea value={offer.section_heading || ''} onChange={(v) => setOffer({ section_heading: v })} maxLength={200} rows={2} placeholder={'Fix your rate\nbefore we open'} />
          </Field>
          <Field label="Offer label">
            <Input value={offer.eyebrow || ''} onChange={(v) => setOffer({ eyebrow: v })} maxLength={60} placeholder="Foundation membership" />
          </Field>
          <Field label="Price">
            <Input value={offer.price || ''} onChange={(v) => setOffer({ price: v })} maxLength={20} placeholder="€189" />
          </Field>
          <Field label="Struck-out price" hint="Shown with a red line through it, left of the price. Leave empty for no strike.">
            <Input value={offer.was_price || ''} onChange={(v) => setOffer({ was_price: v })} maxLength={20} placeholder="€219" />
          </Field>
          <Field label="Struck-out price, spoken" hint="Screen readers only. A struck price on its own is heard as “it used to be €219”, so say which way it goes.">
            <Input value={offer.was_price_note || ''} onChange={(v) => setOffer({ was_price_note: v })} maxLength={120} placeholder="a month from 19 September" />
          </Field>
          <Field label="Price caption" hint="Line breaks are kept exactly as you type them.">
            <Textarea value={offer.unit || ''} onChange={(v) => setOffer({ unit: v })} maxLength={80} rows={2} placeholder={'per month\nfixed for life'} />
          </Field>
          <Field label="Deadline chip" hint="Small pill in the corner of the panel. Leave empty to hide it.">
            <Input value={offer.deadline || ''} onChange={(v) => setOffer({ deadline: v })} maxLength={60} placeholder="Offer ends 19 September" />
          </Field>
          <Field label="What's included — line 1">
            <Input value={ticks[0] || ''} onChange={(v) => setTick(0, v)} maxLength={120} placeholder="Unlimited classes, full access from day one" />
          </Field>
          <Field label="What's included — line 2">
            <Input value={ticks[1] || ''} onChange={(v) => setTick(1, v)} maxLength={120} placeholder="Your rate never rises while your membership stays active" />
          </Field>
          <Field label="What's included — line 3">
            <Input value={ticks[2] || ''} onChange={(v) => setTick(2, v)} maxLength={120} placeholder="Pay today, next payment October" />
          </Field>
          <Field label="Offer button label">
            <Input value={offer.cta_label || ''} onChange={(v) => setOffer({ cta_label: v })} maxLength={60} placeholder="Claim your rate" />
          </Field>
          <Field label="Offer button link" hint="Where the button sends people to pay. Leave empty and the button is hidden rather than dead.">
            <Input value={offer.cta_url || ''} onChange={(v) => setOffer({ cta_url: v })} maxLength={500} placeholder="https://hatchstreet.un1t.online/#join" />
          </Field>
        </>
      )}
    </>
  )
}
```

- [ ] **Step 2: Verify lint and tests**

```bash
npm run lint && npx vitest run src/
```

Expected: lint clean, tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/LandingPageSettingsForm.jsx
git commit -m "HATCH-OFFER.1 — offer fields in the lead-form editor panel"
```

---

### Task 9: Preview fixture, visual verification, ship

**Files:**
- Modify: `src/app/welcome/preview/page.js:45` (the `fx-lead` fixture)
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Turn the offer on in the Hatch fixture**

In `src/app/welcome/preview/page.js`, replace the `fx-lead` entry inside the `'hatch-street'` fixture array with:

```js
    { id: 'fx-lead', type: 'lead_form', heading: 'Keep me posted', subtext: 'Not ready to join yet? Leave your details and we’ll keep you in the loop on the opening, classes and offers.', button_label: 'Keep me posted', success_message: "You're on the list — we'll be in touch soon.", consent_label: 'I’d like to hear from UN1T about the Hatch Street opening and offers by email, SMS and WhatsApp. I can opt out anytime.', tag: 'hatch-founding-member', lead_source: 'hatch_launch', offer: { enabled: true, section_eyebrow: 'Two ways in', section_heading: 'Fix your rate\nbefore we open', eyebrow: 'Foundation membership', price: '€189', was_price: '€219', was_price_note: 'a month from 19 September', unit: 'per month\nfixed for life', deadline: 'Offer ends 19 September', ticks: ['Unlimited classes, full access from day one', 'Your rate never rises while your membership stays active', 'Pay today, next payment October'], cta_label: 'Claim your rate', cta_url: 'https://hatchstreet.un1t.online/#join' } },
```

- [ ] **Step 2: Look at it**

```bash
npm run dev
```

Open `http://localhost:3000/welcome/preview?p=hatch-street` and check, at a desktop width and again at 375px:

1. Hero shows a solid "Claim your rate" and a ghost "Keep me posted".
2. The offer panel is white with `€219` struck in red, angled, to the left of `€189`.
3. `per month / fixed for life` breaks onto two lines and the price row does not overflow the card.
4. At 375px the two columns stack and the offer panel comes first.
5. The sticky header and the footer show one button, reading "Claim your rate".
6. Clicking "Keep me posted" in the hero scrolls to the form.

A screenshot of the section at desktop width is worth attaching to the PR.

- [ ] **Step 3: Confirm the no-offer path is untouched**

Open `http://localhost:3000/welcome/preview` (no `?p=`) — the Stillorgan fixture. It has no lead_form, so this is a regression check that nothing else moved. Then temporarily flip `enabled: false` in the fixture from Step 1, reload `?p=hatch-street`, and confirm the section is the old single-column waitlist with one hero button. Set it back to `true`.

- [ ] **Step 4: Run the full CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: all eleven pass.

- [ ] **Step 5: Run the production build**

```bash
npm run build
```

Expected: success. This is the only check that catches an unresolvable import, and this branch adds three of them (`./EditableField`, `./OfferPanel`, `offerOf` from `@/lib/landing-page-blocks`).

- [ ] **Step 6: Add the changelog row**

Add one row to `docs/CHANGELOG.md` directly under the table header at line 10, replacing `#PR` with the real number once the PR is open:

```
| #PR | HATCH-OFFER.1 — the Hatch Street page sells the foundation offer | Foundation memberships went live and the landing page still said "Join the waitlist" on every CTA. The `lead_form` block gains an optional `offer` group and the section renders two doors: a white €189 panel linking to `hatchstreet.un1t.online/#join`, beside the same capture form rebranded "Keep me posted". `pageCtas()` returns `{primary, secondary}` so the hero carries both buttons; `primaryCta()` is now a wrapper over it and every one of its existing tests still passes, which is the backward-compatibility proof. With the group absent or `enabled:false` the section is byte-identical to before, so Stillorgan is untouched and Hatch reverts by unticking one box. `WaitlistWidget` and `/api/public/leads` are NOT touched — the `hatch-founding-member` tag, the consent copy and the Pixel Lead event all keep working, which is why keeping the existing tag was free. No migration, no new route, no new public path. 🔴 **Expiry is MANUAL** (operator's call): nothing reads the date, so the page advertises €189 until someone unticks the box on 19 Sept. 🔴 The struck price is `aria-hidden` with an operator-editable spoken note beside it — a bare strike is heard as "it used to be €219" when the truth is it *becomes* €219. 🔴 For the platform builder, not us: `hatchstreet.un1t.online/#join` does NOT scroll on a fresh load (anchor fires before hydration; verified 8 Sep, `scrollY:0` against a target 5,768px down), and that page says "founding" where ours says "foundation". |
```

- [ ] **Step 7: Push and open the PR**

```bash
git add src/app/welcome/preview/page.js docs/CHANGELOG.md
git commit -m "HATCH-OFFER.1 — offer on in the Hatch preview fixture, changelog row"
git push -u origin HEAD
gh pr create --base main --title "HATCH-OFFER.1 — Hatch Street page sells the foundation offer" --body "$(cat <<'BODY'
Foundation memberships are live; the Hatch Street landing page still said "Join the waitlist" on every CTA.

The `lead_form` block gains an optional `offer` group. When it is on, the section renders two doors — a white €189 panel linking out to `hatchstreet.un1t.online/#join`, beside the same capture form rebranded "Keep me posted". When it is absent or off, the section is byte-identical to before, so Stillorgan and every other page are untouched and Hatch reverts by unticking one box.

`pageCtas()` returns `{ primary, secondary }` so the hero can carry both buttons; `primaryCta()` is now a one-line wrapper over it and all of its existing tests still pass unchanged.

No migration, no new route, no new public path. `WaitlistWidget` and `/api/public/leads` are untouched, so the `hatch-founding-member` tag, the consent copy and the Meta Pixel Lead event all keep working.

Design: `docs/superpowers/specs/2026-09-08-hatch-foundation-offer-design.md`

**Operator note — expiry is manual.** Nothing reads the 19 September date; the page advertises €189 until someone unticks the box.

**For the platform builder, not fixable here:** `hatchstreet.un1t.online/#join` does not scroll on a fresh load (the anchor fires before hydration — verified 8 Sep, `scrollY: 0` against a target 5,768px down the page), and that page brands the plan "founding" where this one says "foundation".

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

Report the PR URL. Then edit the changelog row's `#PR` to the real number, commit and push that one-line fix.

- [ ] **Step 8: Turn the offer on in production**

The fixture only affects the dev preview. The live page reads `landing_pages.blocks` from Supabase, so after the PR merges and Vercel deploys, the offer is switched on by hand at `/settings/landing-page` for the Hatch Street page: tick "Show a membership offer beside this form", check the pre-filled fields, change the heading to "Keep me posted", Save. Then confirm on `un1tdublin.com/welcome/hatch-street`.

---

## Notes for whoever executes this

- **Work in `~/code/un1t-crm-hatchoffer`, branch `hatch-foundation-offer`.** Do not `cd` to `~/code/un1t-crm`; the branch is already created off a fresh `origin/main`.
- **`main` is branch-protected.** A PR is required, **Test & lint** and **Next build** must be green, and the branch must be up to date with main before merging.
- **zsh globs bracketed paths.** Single-quote `'src/app/welcome/[location]/page.js'` in every git command or staging silently does nothing.
- **Do not touch `WaitlistWidget`, `/api/public/leads`, the tag, or the lead source.** Leaving them alone is the entire reason this change needs no migration and breaks no sequence.
- **`vitest` runs under the `node` environment with no jsdom.** Component tests render with `renderToStaticMarkup` from `react-dom/server` and assert on HTML strings. Do not reach for `@testing-library/react` — it is not installed. This also means a test cannot prove anything about layout, only about markup; the column stacking is checked by eye in Task 9.
