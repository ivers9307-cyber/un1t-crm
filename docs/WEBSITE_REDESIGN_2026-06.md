# Website redesign — un1tdublin.com (2026-06)

Design record for the full visual rebuild of the public marketing site
(`/welcome` chooser + `/welcome/[location]` studio pages). Written before
implementation; kept as the durable design reference.

## Goal

A clean, modern, visually striking marketing site that keeps visitors on
the page and guides them to one action — **leaving their details** (booking
a free consult at Stillorgan, joining the founding-member waitlist at Hatch
Street) — while staying 100% operator-editable from the CRM at
`/settings/landing-page`.

## Constraints (what made this design)

1. **The site is managed through the CRM.** The block system
   (`landing_page_settings.blocks` JSONB → `BlockRenderers.jsx`) and the
   live-preview editor (`EditModeOverlay` + postMessage) must keep working
   unchanged. Every block keeps its data shape and its `EditableText` /
   `EditableImage` field paths.
2. **Renderers stay pure** (no hooks) — they render server-side on the
   public page AND client-side in the edit iframe. Interactivity ships as
   small client islands (the established `VideoTestimonials` /
   `WaitlistWidget` pattern).
3. **No new dependencies.** Motion is CSS + two tiny IntersectionObserver
   islands. Fonts via `next/font/google` (self-hosted at build, zero
   layout shift, no external requests).
4. **The CRM app is untouched.** Fonts + marketing CSS are scoped to the
   `/welcome` segment (new `welcome/layout.js`); all new CSS lives under
   `.lp-` prefixed classes.

## Approaches considered

- **A — Restyle the rendering layer in place** *(chosen)*. Same blocks,
  same editor, new visual language. One PR, zero data migration, zero risk
  to the operator workflow.
- **B — New marketing app / block system v2.** Total freedom, but breaks
  the CRM editor until rebuilt; weeks of work; contradicts "managed
  through the CRM".
- **C — A + new block types (FAQ / pricing / timetable).** Each new type
  needs editor panels + defaults + operator content that doesn't exist
  yet. Deferred — the registry makes them easy follow-ups.

## Design language — "industrial athletic editorial"

- **Typography**: `Anton` for display (ultra-bold condensed, uppercase,
  tight leading — gym-poster energy), `Poppins` for body/UI (the repo's
  documented SIL stand-in for brand font NEXA). Loaded once in
  `welcome/layout.js`, exposed as `--font-display` / `--font-body` and
  Tailwind families `font-display` / `font-body`.
- **Colour**: stays monochrome black/white (brand-true). Energy comes from
  photography, scale and motion, not an accent colour. CTAs are solid
  white pills — highest contrast object on every screen.
- **Texture**: film-grain overlay on hero media (inline SVG noise),
  oversized outlined "UN1T" watermark text as section backdrops, hairline
  dividers, generous vertical rhythm.
- **Motion** (all disabled under `prefers-reduced-motion`):
  - Hero: staggered entrance on load (CSS keyframes), slow Ken Burns on
    the media, scroll cue.
  - Scroll reveals: `RevealManager` island arms `<html class="lp-armed">`
    via a tiny inline script **before first paint** (no flash), then an
    IntersectionObserver adds `.lp-in` per element. No JS → no arming →
    content fully visible. Edit mode never mounts it → editor unaffected.
  - Stats: count-up on first view (`CountUp` island; SSR renders the
    final value so no-JS/SEO see real numbers).
  - Brand marquee strip under the hero ("WE TRAIN AS ONE — STRENGTH &
    CONDITIONING — …") reusing the existing marquee keyframes.

## Conversion engineering

- **Sticky glass header** (public pages only; edit preview keeps the
  current absolute header): logo left, one white CTA pill right — the
  conversion action is visible at every scroll position on every device.
- **Smart CTA target** computed server-side from the page's own blocks:
  first `lead_form` → `#waitlist`, else first `booking` → `#book`, else
  first `event` → its anchor. Label follows the block (`button_label` /
  "Book a free consult").
- **Hero gets CTA buttons** (primary → funnel anchor, secondary → scroll
  to content). The current live site has *no* clickable action above the
  fold.
- **Booking block** reframed: display heading, trust bullets (free / no
  commitment / beginner-friendly), widget on a elevated card. The
  hardcoded "we're at UN1T Stillorgan" line becomes studio-neutral.
- **Lead form** rebuilt: elevated card with glow, larger touch targets,
  16px inputs (no iOS zoom), inline error, animated success check.
  Still 3 fields + consent — friction unchanged, perceived quality way up.
- **Footer** becomes a conversion surface: giant wordmark, both studios
  cross-linked, Instagram, repeat CTA.

## Per-block treatment (data shapes unchanged)

| Block | Treatment |
|---|---|
| `hero` | Full-viewport (`min-h-[92svh]`), media with Ken Burns + grain + stronger scrim, display-font headline w/ staggered reveal, CTA row, marquee strip on the bottom edge. Gradient-mesh + watermark fallback when no media (Stillorgan today). |
| `booking` | Section heading + trust bullets around the untouched `BookingWidget`. |
| `lead_form` | Two-column editorial layout (heading/subtext left, glowing form card right; stacks on mobile). |
| `pillars` | White editorial section, static "Why UN1T" eyebrow, cards with taller imagery, oversized index numerals, hover zoom. |
| `stats` | Display-font numerals with count-up, hairline separators. |
| `testimonial` | Oversized quote mark, 5-star row, quote auto-scales by length (the live Stillorgan quote is ~900 chars — it must read as editorial, not a wall). |
| `gallery` | Mosaic grid (first tile 2×2 via nth-child, pure CSS), hover zoom + caption fade. |
| `reviews` | Same marquee mechanics, richer cards (rounded-2xl, star row, Google badge), aggregate header in display font. |
| `video_testimonials` | Kept island; posters get hover ring + scale, section heading style aligned. |
| `embed` / `event` | Restyled headings/frames to match. |
| chooser (`/welcome`) | Brand bar with logo, display-font studio names, animated ENTER pill, hover scale + scrim lift (kept), grain. |

## SEO / a11y / perf

- JSON-LD (`Gym`) on studio pages — name, url, hero image, aggregate
  rating when the reviews connection has one.
- Semantic heading order preserved; all imagery keeps alt handling;
  focus-visible styles on all interactive elements.
- Zero new JS deps; islands are <2KB each; fonts subset+self-hosted;
  no layout shift (next/font); media unchanged (operator uploads).

## Dev preview harness

`/welcome/preview` renders the real production block JSON as a local
fixture (dev-only, `notFound()` in production) so the design can be
iterated and screenshot locally without Supabase credentials. This is also
the future "what does a change look like" harness for landing-page work.

## Out of scope (deliberate)

- New block types (FAQ, pricing, timetable) — registry makes these clean
  follow-ups once the operator wants the content.
- `BookingWidget` internals (shared with `/book/[slug]`) — only its frame.
- The `/book`, `/event` standalone pages.
- Mobile app, CRM app surfaces.

## Content fix shipped alongside (data, not code)

The live Hatch hero copy has typos ("HART OF DUNLIN CITY", "A STONES
THROW") — fixed via SQL on `landing_page_settings` (operator-editable
content, corrected in place; no schema change).
