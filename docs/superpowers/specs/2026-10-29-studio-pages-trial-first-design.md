# Studio pages, trial-first (TRIALFIRST) — design

Date: 2026-10-29. Agreed with Richard in a brainstorm (mockups in
`.superpowers/brainstorm/8361-1793301584/content/`: `layout.html` option A,
`visual-style.html` option 2 "Editorial").

## Intent

The two public studio pages on un1tdublin.com, `/stillorgan` and
`/hatch-street`, become pages whose one job is to sell the paid trial (The 14
Day Reset, €39 once). The buy card that today lives only on `/trial` sits in
the hero of each studio page with that studio already chosen. At the same time
the marketing site gets one modernised look, "Editorial", applied to all four
public funnel pages: the two studio pages, `/trial` and `/corp`.

**Why now.** Today `/stillorgan` has no way to sign up at all: the hero promises
a free consultation "below", there is no form, and the footer button points at
a `#book` anchor that does not exist. `/hatch-street` leads with the Foundation
membership rate and a "keep me posted" form; the trial is mentioned once in
passing and cannot be bought there. Both pages are black top to bottom and
front-load atmosphere over action. The trial is the product the ads sell and
the one Richard wants every visitor pushed to.

## Goals

- A visitor on either studio page can buy the trial without leaving the page,
  above the fold on desktop, first thing under the headline on a phone.
- One look across `/stillorgan`, `/hatch-street`, `/trial` and `/corp`, so
  there is one card style and one set of section styles to maintain.
- Every customer-facing word stays operator-editable in
  `/settings/landing-page`, as today.
- No change to how a purchase is taken, verified, granted or refused.

## Non-goals

- No change to `/start`, `/free-class`, `/offers`, the events pages or the
  `/welcome` chooser.
- No new fonts, no colour. Brand stays black / white / grey, Poppins.
- No change to the trial's price, products, Glofox or un1t.online handling,
  the Meta events, or the staff review cards.
- No database migration. Everything lives in the `landing_page_settings`
  blocks JSONB and the code.

## Anti-goals (would make this a failure even if it works)

- A second offer competing with the trial on a studio page. Hatch's
  Foundation rate panel goes; nothing on either page sells anything but the
  trial.
- Two looks on one site: `/trial` or `/corp` left on the old dark style.
- A studio page that renders a card for a studio that is not sellable
  (`loadTrialStudios` says `sellable: false`): the page must degrade to the
  classic hero, never a dead card.
- Copy hard-coded in the renderer.

## Current state (what exists, read 2026-10-29)

- Studio pages: `src/app/welcome/[location]/page.js` renders `SiteHeader` →
  the row's ordered blocks via `BlockRenderer`
  (`src/components/landing-page/BlockRenderers.jsx`) → `SiteFooter`. The
  primary/secondary CTA comes from `pageCtas(blocks)` in
  `src/lib/landing-page-blocks.js` (offer → lead form → class funnel →
  booking → event; nothing for `paid_trial`).
- Live rows: Stillorgan is `hero > class_funnel (hidden) > video_testimonials
  > stats > reviews > paid_trial`; Hatch is `hero > lead_form (offer on,
  second_path form) > video_testimonials > pillars > stats > testimonial >
  reviews > class_funnel (hidden) > paid_trial`. Both `paid_trial` blocks
  exist and are sellable (Stillorgan via Glofox, Hatch via un1t.online).
- `BlockRenderer` renders `paid_trial` only in edit mode (an editor stub); on
  the public page it returns null.
- `/trial` (`src/app/trial/page.js`) renders its own hero: Ken Burns photo and
  `PaidTrialFunnel` (studio picker → form → checkout) as a frosted card, then
  Stillorgan's content blocks (minus hero, lead_form, class_funnel,
  paid_trial), then the footer. `loadTrialStudios` (`src/lib/trial-studios.js`)
  is the one reader of both studios' trial config.
- `/corp` (merged in #2248, not on this worktree's branch; implement from
  `origin/main`) renders the same shape: a frosted card in the hero, Hatch's
  content blocks, the footer.
- A Hatch purchase leaves the site for un1t.online's hosted checkout and
  returns to `/trial?purchase=<id>&studio=hatch` (`&cancelled=1` when backed
  out), built in `src/lib/trial-purchase-un1t-checkout.js`.
- Meta pixels: `/hatch-street` already loads the Hatch dataset as well as the
  site pixel (`src/lib/meta-pixel-paths.js`); `PaidTrialFunnel` reads the
  pixel ids from `window.location.pathname`, so it needs nothing new on a
  studio page.

## The design

### 1. Layout A: the card in the hero

On a studio page whose row holds a sellable `paid_trial` block, the hero
renders in a **trial-first** layout:

- Backdrop: the hero block's image or video as today, with a black sweep from
  the left (strong at the headline, light over the card) instead of the
  bottom-weighted scrim. Grain stays. Ken Burns stays. The hero marquee strip
  ("We train as one ✦ …") is not rendered on a trial-first hero; the card
  takes that space. It stays on the classic hero.
- Two columns from `md` up inside `max-w-6xl`: left the copy, right the card.
  Below `md` they stack: eyebrow, headline, card. The subtext is hidden below
  `md` so the card is the first thing under the headline. The scroll cue is
  not rendered.
- Copy is the hero block's own fields, unchanged in meaning: `eyebrow`,
  `headline`, `subhead` (rendered as the grey second line), `subtext`. The
  headline is **mixed case** in the Editorial look (no `uppercase`), heavy
  weight, tight tracking.
- The card is `PaidTrialFunnel` given exactly this studio
  (`studios=[thisStudio]`, `initialStudio=key`), so it opens on the form with
  no studio picker and no "Change studio" link. The section carries
  `id="trial"` so every CTA on the page can scroll to it.
- A row of two or three small proof lines under the subtext on desktop (for
  example "★★★★★ 4.9 on Google · 200+ members") is **not** a new field: it is
  the page's `stats` block items rendered small, when the page has one.
  Builder's call whether to include it at all; it is in the mockup but not
  load-bearing.

If the row has no sellable trial block (or `loadTrialStudios` could not read),
the page renders exactly as today: classic hero, `pageCtas` as today. No card,
no empty column.

### 2. One shared card style

The buy card on all four pages is one component style:

- White card, 4px radius, hairline border, soft shadow. Inputs are white with
  an underline only (no box), 16px text so phones do not zoom. The button is
  black on white, full width, pill. One line of fine print in grey under it
  ("Secure payment · €39 once").
- Price top right in heavy type; eyebrow, title, one-line subhead, up to three
  ticks above the inputs (all from the block, as today).
- The same style wraps the studio picker on `/trial` and the claim form on
  `/corp`. `/trial` and `/corp` keep a **centred** card with no headline
  column: on those pages the card is the message.

This replaces the frosted dark panel (`bg-black/45`, `border-white/12`,
`backdrop-blur`) in `PaidTrialFunnel`, `TrialStudioPicker`, and the `/corp`
claim form.

### 3. The Editorial body

The page alternates black and pale after the hero. Pale is one token (a warm
off-white near `#f5f5f3`, defined once as a Tailwind colour or CSS variable,
not repeated as a literal). Section by section, in `BlockRenderers.jsx`:

| Block | Today | Editorial |
|---|---|---|
| `stats` | black, white numerals | pale; numerals black and larger (`clamp` up to ~4.5rem), labels grey, hairline dividers |
| `pillars` | white, numbered tiles | pale background, each pillar a white tile with hairline border, number large in light grey above the title |
| `testimonial` | black, huge faint quote mark | black band kept, tightened: quote in white, author in grey, stars white |
| `reviews` | black marquee, dark cards | pale; white review cards with hairline border, Google mark as today |
| `video_testimonials` | black | black, unchanged |
| `lead_form` | black, offer panel + form | see 4 |
| `gallery`, `embed`, `booking`, `event`, `class_funnel` | black | unchanged (not on these pages) |
| `SiteFooter` | black, "Ready when you are." + button | unchanged |
| `SiteHeader` | sticky glass, white pill | unchanged |

Section eyebrows stay uppercase and tracked; on pale sections they are grey.
Chip and text contrast on pale sections follows the house rule (`-700` ramp on
light surfaces; `check:guardrails` enforces chips).

Because `/trial` and `/corp` render the studio rows' body blocks through the
same renderers, they pick the body up with no page-specific work. Their
heroes keep the Ken Burns photo and the bottom scrim.

### 4. The soft path

A visitor who reads to the bottom without buying gets one quiet second path:
the existing `lead_form` block, rendered **compact** when it is the soft path
(no offer panel): one pale strip before the footer with the block's heading,
subtext, the three fields, consent and button in a single row on desktop.

- It is still the `lead_form` block, so its heading, subtext, button, consent
  and lead tag are the operator's.
- The offer panel is not rendered when a trial-first hero is on the page, even
  if `offer.enabled` is true. Belt and braces: the Hatch operator also switches
  the offer off (go-live checklist).
- Stillorgan has no `lead_form` block today; the operator adds one (go-live
  checklist). Without one the page simply has no soft path.
- **Where it sits is the operator's block order, as for every block.** The
  renderer never reorders blocks. Hatch's lead form is second today, directly
  under the hero; the go-live checklist moves it to the end. Rendered in place
  under the hero it would be the competing second offer the anti-goals forbid,
  so that checklist step is not optional. (Reviewer question 1; my call.)

### 5. CTAs

`pageCtas(blocks)` gains a first rule: a sellable `paid_trial` block that is
shown on the page owns the primary CTA, `{ href: '#trial', label:
block.cta_label, labelShort: block.cta_label_short || '' }`. The secondary is
the lead form's waitlist (`#waitlist`) when one is present, else null. The
offer rule no longer applies on such a page.

`cta_label_short` is a new optional string on the `paid_trial` block (default
`''`), editable in `PaidTrialEdit`, for the sticky header on phones (the header
already falls back to the full label when blank). No other new fields.

The hero's own button is not rendered in the trial-first layout (the card is
the action). The footer's button and the header's go to `#trial`.

### 6. The return from un1t.online

A Hatch purchase started on `/hatch-street` must come back to `/hatch-street`,
not `/trial`. The POST to `/api/public/trial-purchases` takes an optional
`return_path`, validated against an allowlist of exactly `/trial`,
`/stillorgan` and `/hatch-street` (anything else → `/trial`), and
`trial-purchase-un1t-checkout.js` builds `successUrl`/`cancelUrl` from it.
Nothing is stored. The studio page then reads `?purchase=`, `?studio=` and
`?cancelled=` the way `/trial` does (extract that parsing into one helper both
pages call) and hands `resumePurchaseId` / `cancelled` to the card, which
already knows how to confirm or go back to the form.

**Stillorgan too.** The Revolut order built in
`src/lib/trial-purchase-payments.js` already carries a `returnPath`
(default `/trial`) as the redirect target for 3DS and redirect-based methods,
and the POST route does not pass it. The same validated `return_path` is
threaded into `createTrialPurchasePayment`, so a Stillorgan buyer the bank
redirects comes back to `/stillorgan?purchase=<id>`. This is the one place
the "no change to how a purchase is taken" boundary is touched: only the
order's redirect URL changes, nothing about amount, verification or grant.
(Reviewer question 3; my call. The earlier draft said Stillorgan needed no
return; that was wrong.)

**A return overrides the degrade rule.** When `?purchase=` is present the
studio page renders the card in resume mode even if the studio is not
sellable at that moment (the switch turned off, the product read failed):
money has been taken and `PaidTrialFunnel` already confirms a resume
regardless of `sellable`. If the page itself cannot render (row missing or
unpublished, which is a 404 today), it redirects to `/trial` with the query
preserved instead of 404ing a buyer. (Reviewer question 2; my call.)

### 7. Editor and preview

- The editor's preview (`?edit=1`, `EditModeOverlay`) renders the trial-first
  hero with the card **static**: the real `PaidTrialFunnel` markup with its
  form disabled (a `preview` prop), so the operator sees what ships without a
  purchase being possible from the editor. Inline editing of eyebrow,
  headline, subhead and subtext keeps working.
- The standalone `paid_trial` editor stub (`PaidTrialBlock`) stays as the
  place the operator edits the card's words, and its note now says the card
  is shown in this page's hero and at `/trial`.
- The public page never renders the standalone `paid_trial` block (as today).

### 8. Go-live checklist (content)

Both live rows already hold sellable `paid_trial` blocks, so both pages flip
to trial-first the moment the deploy lands, with whatever hero copy is in the
row at that moment. So the copy is rewritten **before the merge** (a hero
rewrite is harmless on today's layout) and only the offer switch genuinely
waits. Done by hand in `/settings/landing-page`, per studio, by Richard or
the builder with him:

Before the merge:
1. Hatch: rewrite the hero to the trial message (mixed case); retitle the
   lead form as the soft path ("Not ready yet?" or Richard's words) and
   **move it to the end of the block list**, before nothing but the footer.
2. Stillorgan: rewrite the hero (the "book a free 30-minute consultation"
   copy goes); add a `lead_form` block at the end as the soft path, with a
   Stillorgan tag and lead source.
3. Both: set `cta_label_short` on the paid trial block once the field ships
   (it can be the same PR's first deploy).

After the merge:
4. Hatch: switch the Foundation offer off on the lead form (the renderer
   already hides it on a trial-first page; this makes the row say so too).
5. Both: check the pages on a phone, and buy nothing: the embedded and hosted
   checkouts are live.

## Constraints

- All four pages are public and already allowlisted (proxy, AppShell, brands,
  tenant-domains edge). No new paths.
- No colour accents; low-ramp text on the new pale sections must pass
  `check:guardrails`. Do not add new `un1t-*` tokens by old names.
- A column named in a `.select()` is a schema claim: no new columns are
  selected anywhere.
- `mobile/**` is untouched.
- Branch off fresh `origin/main` (this worktree's branch predates `/corp`).

## Verification the builder owes

- `PaidTrialFunnel` tests: single-studio mode opens on the form with no
  picker and no "Change studio"; `preview` renders with no submit.
- `pageCtas` tests: shown `paid_trial` wins; lead form becomes secondary;
  offer ignored on such a page; page without a sellable trial unchanged.
  (`pageCtas` is pure on blocks and has one other caller,
  `src/app/welcome/preview/page.js`; whether sellability comes in as a second
  argument or as a flag the page stamps on the block is the builder's.)
- Studio page tests: sellable trial → trial-first hero with `id="trial"`;
  not sellable / unreadable → classic hero.
- `trial-purchases` route and checkout tests: `return_path` allowlist, the
  un1t.online success/cancel URLs AND the Revolut order's `returnUrl`.
- Studio page tests: `?purchase=` with an unsellable studio still renders the
  card in resume mode; a missing/unpublished row with `?purchase=` redirects
  to `/trial` with the query intact.
- `/trial` and `/corp` still render (their own tests), with the shared card.
- The full CI mirror, `npm run build`, and a phone-width pass on all four
  pages in the browser.

## Left to the builder

- Exact type scale, spacing and the pale token value; how the two-column
  hero collapses between 768 and 1024px.
- Whether the small proof row under the hero subtext is worth it.
- How `preview` is wired through `PaidTrialFunnel` without duplicating its
  markup.
- Where the shared card classes live (a small `TrialCard` wrapper, or
  shared class strings in `src/lib/landing-page-ui.js`).
- The `/corp` hero's left column: none (centred card), as decided above.
