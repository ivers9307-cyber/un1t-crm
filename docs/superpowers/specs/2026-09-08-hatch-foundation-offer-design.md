# Hatch Street foundation offer — design

**Date:** 2026-09-08
**Status:** Approved, ready for an implementation plan
**Surface:** `un1tdublin.com/welcome/hatch-street` (public marketing site, rendered by `src/app/welcome/[location]/page.js`)

---

## Why

Foundation memberships for UN1T Hatch Street went live. The Hatch Street landing
page has not caught up: every call to action on it — sticky header, hero, the
lead-capture section, the closing band and the footer — still says **"Join the
waitlist"** and points at `#waitlist`. The page cannot sell the thing that is now
for sale, and its body copy still reads "before we open" and "founding-member
offers".

Two jobs, on one page:

1. **Claim the foundation rate.** €189 a month fixed for life, €219 from opening
   day, offer closes 19 September. Checkout lives on the booking platform at
   `https://hatchstreet.un1t.online/#join`, not in this repo.
2. **Keep the waitlist, rebranded.** Visitors who are not buying today still
   need somewhere to leave their details. It stops being the headline act and
   stops being called a waitlist.

---

## Decisions taken

Settled with Richard over three rounds of mockups (`.superpowers/brainstorm/`,
session `6297-1788905289`).

| Decision | Choice |
|---|---|
| Page structure | **One "two doors" chooser section** — paid offer left, details capture right, side by side. Replaces the standalone waitlist section rather than sitting beside it. |
| Visual treatment | **Inverted panel** — the offer card is solid white with black text against the black section; the capture card stays dark and understated. |
| Struck price | **Inline, angled red strike** — `€219` immediately left of `€189`, red rule at −9°. |
| Naming | **"Foundation"**, never "founding" — including in the defaults shipped with the block. |
| Second door | **"Keep me posted"**. |
| Hero CTAs | **Two buttons** — solid "Claim your rate" straight to checkout, ghost "Keep me posted" scrolling to `#waitlist`. |
| Offer expiry | **Manual.** The operator edits the block on 19 September. No auto-hide. |
| Lead tagging | **Unchanged** — `hatch-founding-member` / `hatch_launch`, so existing sequences and audiences keep firing. |
| Link target | `https://hatchstreet.un1t.online/#join`, same tab. |

### Accepted risks

- **Manual expiry means the page keeps advertising €189 until it is edited.**
  Richard's call, made with the auto-hide alternative on the table. Nothing in
  this design mitigates it; the date is not read at render time.
- **The lead tag no longer distinguishes two populations.** Everyone in
  `hatch-founding-member` used to be a pre-launch waitlist signup; from now on
  the tag also holds people who saw a live offer and chose not to buy. Accepted
  to keep current sequences working.

### Not ours to fix — raise with the platform builder

- **`#join` does not scroll.** Verified 2026-09-08: the anchor exists
  (`<section id="join">`, 5,768px down the page) but a fresh load of
  `https://hatchstreet.un1t.online/#join` leaves the browser at `scrollY: 0`.
  The hash is in the URL and nothing acts on it — the anchor jump fires before
  the section hydrates. The link works; it just lands the visitor at the top of
  a long page. We ship `#join` regardless, so it starts working the moment they
  fix it.
- **The destination says "FOUNDING MEMBERSHIP"** where this page will say
  foundation. Visible to anyone who clicks through.

---

## Approach

**Extend the existing `lead_form` block with an optional `offer` group** rather
than adding a new block type.

The blocks system renders each block as a full-width stacked section, so a
separate `offer` block could not sit beside the capture form without new layout
machinery, and it would need its own copies of the heading, consent, tag and
success-message fields. Extending `lead_form` keeps one conversion section, one
editor panel, and one place where the funnel's copy lives.

**Backward compatibility is the load-bearing property**: with no `offer` group,
or with `offer.enabled` false, `LeadFormBlock` renders byte-for-byte what it
renders today. Stillorgan and every future page are untouched by this change,
and the Hatch page can be reverted by clearing one checkbox.

`BlockBaseSchema` is `.passthrough()`, so the new nested group needs no schema
change to be accepted by the `PUT` route.

---

## Components

### 1. Block definition — `src/lib/landing-page-blocks.js`

`LEAD_FORM_DEFAULT` gains an `offer` group. Every visitor-facing string is a
field, per the operator-editable-copy invariant — including the price and the
deadline, so the 19 September edit needs no deploy.

```js
offer: {
  enabled:      false,          // false ⇒ renders exactly as today
  eyebrow:      'Foundation membership',
  price:        '€189',
  was_price:    '€219',         // rendered with the red strike; '' ⇒ no strike
  unit:         'per month\nfixed for life',   // newlines preserved on render
  deadline:     'Offer ends 19 September',   // '' ⇒ chip hidden
  ticks: [
    'Unlimited classes, full access from day one',
    'Your rate never rises while your membership stays active',
    'Pay today, next payment October',
  ],
  cta_label:    'Claim your rate',
  cta_url:      'https://hatchstreet.un1t.online/#join',
  section_heading: 'Fix your rate before we open',
  section_eyebrow: 'Two ways in',
}
```

Prices are **strings, not cents**. Nothing computes with them — they are display
copy pointing at a checkout this repo does not own, and a string lets the
operator write "€189" or "From €189" without a parser in the way. This is
deliberately unlike `class_funnel.price_cents`, which really does charge.

`blocksOrDefault()` must tolerate a malformed `offer` (non-object, `ticks` not an
array) by falling back to the no-offer render rather than throwing — the existing
"never 500 the public funnel" posture.

### 2. `pageCtas(blocks)` — same file

`primaryCta()` returns a single `{ href, label }` and cannot express the hero's
two buttons. Add:

```js
export function pageCtas(blocks) → { primary, secondary }
```

- Offer enabled with a `cta_url` → `primary` is `{ href: cta_url, label: cta_label, external: true }`, `secondary` is `{ href: '#waitlist', label: button_label }`.
- Otherwise → `primary` is today's `primaryCta()` result, `secondary` is `null`.

`primaryCta()` stays exported as `pageCtas(blocks).primary` so both existing call
sites and its current tests keep passing unchanged.

**Where each CTA surfaces:**

| Surface | Renders |
|---|---|
| Hero (`HeroBlock`) | primary + secondary |
| Sticky header (`SiteHeader`) | primary only |
| Footer (`SiteFooter`) | primary only |

Header and footer stay single-button — both are space-constrained, and the
secondary path is one scroll away on the same page.

### 3. `src/components/landing-page/OfferPanel.jsx` — new file

The white panel: eyebrow, deadline chip, struck price + live price + unit
caption, tick list, CTA button. Pure server-rendered markup, no state.

Its own file because `BlockRenderers.jsx` is already past 900 lines and holds
every block renderer plus `SiteHeader` and `SiteFooter`; another full section
belongs outside it. Takes the `offer` group and an `onEdit` handler, nothing
else.

**Multi-line copy:** `unit` and `section_heading` are rendered with
`whitespace-pre-line`, so the operator controls the line break ("per month /
fixed for life") from the editor without HTML in a text field.

**External link:** plain `<a href>`, same tab (checkout links should not spawn
tabs), with `rel="noopener"`.

**The struck price is `<s>` plus visually-hidden text.** A struck price with no
words beside it reads as *"it used to be €219"*; here it *becomes* €219 on
19 September. Sighted visitors get that from the deadline chip and the page
copy, so the visual stays exactly as approved — but a screen reader gets the
direction explicitly:

```jsx
<s className="lp-was-strike" aria-hidden="true">{offer.was_price}</s>
<span className="sr-only">{offer.was_price} a month from 19 September.</span>
```

### 4. `LeadFormBlock` — `src/components/landing-page/BlockRenderers.jsx`

Branches on `block.offer?.enabled`:

- **Off:** today's render, unchanged.
- **On:** the section heading/eyebrow come from the offer group; the two-column
  grid becomes `<OfferPanel>` on the left and the existing `WaitlistWidget` card
  on the right.

`WaitlistWidget` itself is **not touched** — same component, same props, same
`POST /api/public/leads`, so the tag, source, consent and Meta Pixel Lead event
all keep working exactly as they do now. That is what makes the tagging decision
free.

The section keeps `id="waitlist"` so the secondary CTA, the footer link and any
existing external link into the page all still resolve.

### 5. `.lp-was-strike` — `src/app/globals.css`

The red rule, as an `::after` on a relatively-positioned `<s>` (a border-based
strike cannot be angled). Marketing CSS is `.lp-`-prefixed and segment-scoped;
red is not in the `un1t-*` token set and must not be added to it, since those
tokens are the CRM's light-theme palette and this is the public site.

`text-decoration: none` on the `<s>` — the pseudo-element is the strike, and the
browser default would double it.

### 6. Editor — `src/components/LandingPageSettingsForm.jsx`

`LeadFormEdit` gains an "Offer" section: an enable checkbox that reveals the
fields above. Ticks are three plain inputs, not a repeater — the panel is fixed
at three lines by design and a repeater is machinery nobody asked for.

The `E`/`contentEditable` inline path in `OfferPanel` covers `section_heading`,
`eyebrow` and the tick text, matching how every other block handles inline edit.

### 7. Preview fixture — `src/app/welcome/preview/page.js`

The `?p=hatch-street` fixture gets the offer group populated, so the section can
be worked on without Supabase creds. Dev-only, 404s in prod.

---

## Data flow

Nothing changes server-side. No migration, no new route, no new public path — so
none of the four public-path allowlists are in play.

```
landing_pages.blocks (JSONB)
  └─ lead_form block
       ├─ offer.*          → OfferPanel  → <a href="https://hatchstreet.un1t.online/#join">
       │                                     (leaves the estate; no callback, no attribution)
       └─ heading/consent/ → WaitlistWidget → POST /api/public/leads
          button_label/…                      → contacts + hatch-founding-member tag
```

**Attribution ends at the click.** Once a visitor crosses to the booking
platform this repo learns nothing about whether they paid — there are no
outbound webhooks on that API and the sync described in
`2026-09-01-un1t-online-hatch-integration-design.md` is not built. Conversion
rate on this section is therefore not measurable today beyond the Meta Pixel
click. Out of scope here; worth knowing before anyone asks how the section is
performing.

---

## Error handling

- **Malformed `offer` group** → falls back to the no-offer render. A corrupted
  block must never 500 the public funnel.
- **`offer.enabled` true but `cta_url` empty** → the panel renders without a
  button and `pageCtas` falls through to today's `#waitlist` primary, rather
  than shipping a dead `<a href="">`.
- **`was_price` empty** → no strike, no visually-hidden text; the price line
  renders alone.
- **`deadline` empty** → chip hidden.
- **The destination being down or slow** is invisible to this page — it is a
  plain link, not a fetch.

---

## Testing

Unit (`vitest`, no DB):

- `pageCtas` — offer on, offer off, offer on with empty `cta_url`, and no
  lead_form at all.
- `primaryCta` — every existing case, unchanged, proving the wrapper.
- `blocksOrDefault` — a lead_form carrying a malformed `offer` survives.
- `OfferPanel` render — strike present with `was_price`, absent without it;
  visually-hidden text present; no `<a>` when `cta_url` is empty.

Manual, before merge:

- `/welcome/preview?p=hatch-street` at desktop and at 375px — the two columns
  must stack, and the price must not overflow its card.
- Light and dark rendering is not a factor: the marketing site is black-only.
- `npm run build`, since this adds an import.

The full eleven-command CI mirror runs before push.

---

## Out of scope

- Auto-expiring the offer on 19 September (explicitly declined).
- Any change to the Stillorgan page or to `defaultBlocks()`.
- Any change to `WaitlistWidget`, `/api/public/leads`, tags, or sequences.
- Conversion tracking across to the booking platform.
- Fixing the destination's `#join` scroll or its "founding" wording — different
  repo, different owner.
