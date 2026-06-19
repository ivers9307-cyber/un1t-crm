# champ-app design refresh — dark performance identity — design spec

- **Date:** 2026-06-19
- **Status:** Draft for review
- **Ticket:** CHAMP-UI.1
- **Repo:** **champ-app** only (the customer portal at `app.champfitness.ie`). No un1t-crm code change; the spec/plan live in un1t-crm `docs/superpowers/` like the other HR slices.

## Goal

Give the customer app a distinctive, premium visual identity now that it carries real features (dashboard, session list, the post-class Session Report, the shareable card, device onboarding, account). Today it's the textbook "generic" starting point — bare `<html><body>` on the **system font**, a **red placeholder** `champ` palette, neutral-gray utility classes, **no app shell or navigation**, dark mode only via `prefers-color-scheme`. The refresh expresses the **UN1T** brand (members know UN1T; it matches `un1tdublin.com` and the share card already shipped) as a **dark-only, monochrome "performance instrument"**: near-black canvas, white Poppins type, and the **HR zone colours as the only colour anywhere** — the data is the colour. Bold, restrained, premium, and explicitly **not** a generic-AI template (the standing [[champ-app-design-bar]] rule).

Direction chosen from mockups (brand = UN1T; direction = "B · Performance, dark"; accent = monochrome white; mode = dark-only).

## Why this shape (grounded in current state)

- **No design system exists.** Every page is a lone `<main>` with inline Tailwind (`text-neutral-*`, `rounded-2xl border`, `bg-neutral-900` buttons). There is one extracted component (`ShareSessionButton.jsx`). So this is greenfield styling, not a rip-out — we add tokens + primitives + a shell and apply them.
- **No navigation at all.** `layout.jsx` is `<html><body>{children}</body></html>`; you can only move between surfaces via in-page links. A persistent bottom tab bar is the single biggest usability win and the "easy to navigate" requirement.
- **The data already wants to be the hero.** Sessions carry `effort_points`, `zones_seconds` (→ `zoneBreakdown` 5-colour bar), `peak_hr_bpm`. On a dark canvas these read as a performance dashboard. The zone colours (`#9CA3AF / #3B82F6 / #10B981 / #F59E0B / #EF4444`, defined once in `src/lib/heart-rate.js ZONE_DEFS`) become the app's only colour.
- **Brand assets are minimal** — no logo file, no brand font installed (`public/` is empty; `package.json` has no font lib). So the identity is built from type + colour + layout, not a logo drop-in. The `UN1T` wordmark is set type (Poppins 800, letter-spaced), matching the share card.

## The design system (foundation)

One source of truth: CSS custom properties in `src/app/globals.css` + a real token set in `tailwind.config.js` replacing the red `champ` placeholder. **Dark-only** — the `@media (prefers-color-scheme: dark)` branch is removed and the single dark palette is the base.

### Tokens

| Role | Token | Value |
|---|---|---|
| Canvas (page) | `--bg` | `#0B0B0C` |
| Raised surface (card) | `--surface` | `#161618` |
| Surface hover / border | `--surface-2` / `--border` | `#1F1F23` |
| Text primary | `--text` | `#FFFFFF` |
| Text secondary | `--text-2` | `#8A8A93` |
| Text tertiary / hints | `--text-3` | `#5A5A61` |
| Accent (primary action, active) | `--accent` | `#FFFFFF` (white; button = white bg / `#0B0B0C` text) |
| Zone 1–5 (the only colour) | from `ZONE_DEFS` | `#9CA3AF #3B82F6 #10B981 #F59E0B #EF4444` |

- **No coloured accent.** Primary buttons are white-on-black; secondary are bordered ghost buttons. Active nav/state = white. Colour appears only on zone bars, the HR trace, and zone breakdowns.
- **Radii:** cards `20px` (`--radius-card`), inputs/buttons `12px`, pills `999px`.
- **Spacing:** 4-pt rhythm; page padding `16–24px`; card padding `16–20px`.
- Tailwind: expose these as `un1t.*` colours (e.g. `bg-un1t-surface`, `text-un1t-2`) **driven by the CSS variables** so there's one source of truth, and delete the `champ` red scale.

### Typography

- **Poppins via `next/font/google`** (self-hosted by Next, no layout shift, no runtime external request) wired in `layout.jsx`, exposed as `--font-poppins` and set as the body font.
- Scale: display/hero numbers **800** (`tabular-nums`, tight tracking), section headings **600**, body **400/500**. The `UN1T` wordmark is **800** with `letter-spacing` ~`0.18em`.

### Motion

Restrained, tasteful — a subtle fade/translate-in on cards (CSS, respecting `prefers-reduced-motion`), and an optional count-up on the hero effort number. No flashy effects; matches the monochrome-premium feel. Motion is the lowest-priority layer and can be trimmed without affecting structure.

## App shell + navigation

The biggest structural change: introduce a **route group `src/app/(app)/`** that holds the authenticated surfaces (dashboard, sessions, account) with a shared `(app)/layout.jsx` that renders the chrome. Route groups don't change URLs, so `/`, `/sessions`, `/account/*` are unchanged.

- **`<TopBar>`** — slim: `UN1T` wordmark (left) + avatar/initials → account (right).
- **`<TabBar>`** — persistent bottom tab bar: **Home · Sessions · Account** (Tabler/lucide icons, active = white, inactive = `--text-3`). Mobile-first, thumb-reachable; the app is used primarily on phones.
- **`login` and `share/[token]` stay OUTSIDE `(app)/`** (no tab bar): both get a shell-less, dark-branded treatment (centred `UN1T` wordmark + the form / the card).
- Moving the dashboard (`page.jsx` + its in-file `SignOutButton` usage), `sessions/`, and `account/` under `(app)/` is the one structural refactor; `@/`-aliased imports are unaffected, relative imports (`./SignOutButton`) move with their files.

## Component primitives

New `src/components/ui/` (today everything is inline). Surfaces compose these so the look stays consistent and future features inherit it:

- `Card` — dark raised surface (`--surface`, radius-card, optional header row with title + "see all →").
- `Button` — `primary` (white/black), `ghost` (bordered), `size` variants; the existing inline button styles collapse into this.
- `StatNumber` / `EffortNumber` — big tabular Poppins-800 number + unit label (the `312 UN1T pts` hero treatment).
- `ZoneBar` — the 5-segment zone bar from `zoneBreakdown` (already inline in 3 places; extract once).
- `Chip` — small pill (e.g. "Personal best", source label).
- `TopBar`, `TabBar` — the shell pieces above.
- `EmptyState` — icon + message + optional CTA (recent-sessions / achievements / goals empty states).

Pure formatting helpers that surface in multiple places (duration, date label, source label) move to a small `src/lib/format.js` and get unit tests.

## Per-surface application

Restyle every surface to the system:

1. **Dashboard (`/`)** — `Hi, {firstName}` hero, recent-sessions card (date · duration, source · peak, the effort number + zone bar), achievements (X/Y + recent badges), goals (weekly progress), connect-device CTA. Becomes the dark performance home.
2. **Sessions list (`/sessions`)** — dark list of session cards (each: date, class, effort, zone bar), tappable into the report.
3. **Session report (`/sessions/[id]`)** — the showcase. Hero effort number, zone breakdown, the Slice 1–3 layers (highlight, "how this compares" / `vs_category`, the editable `next_action` CTA), the Share button. Restyle to dark; keep all Slice 1–4 logic intact.
4. **Account sub-pages** — `achievements`, `devices`, `goals`, `integrations`: dark cards, consistent headers. **Audit CTA targets** while here — the dashboard "Connect a device" links to `/account/connections`, which doesn't exist (real routes are `/account/devices` + `/account/integrations`); fix to a real route.
5. **Login (`/login`)** — dark-branded magic-link form, centred `UN1T` wordmark.
6. **Public share page (`/share/[token]`)** — restyle the page chrome to dark. **The share-card OG image (`opengraph-image.jsx`) stays as-is** — its light card reads well in social feeds and looks intentional on a dark page (do not touch the shipped Slice 4 image).

## In scope

- The token system + Poppins + dark-only `globals.css` + `tailwind.config.js` (`un1t.*`, drop `champ`).
- The `(app)/` route-group shell: `TopBar` + bottom `TabBar`.
- `src/components/ui/` primitives + `src/lib/format.js` (+ tests for the pure helpers).
- Restyling all surfaces listed above + the CTA-target link fix.
- Subtle, reduced-motion-safe entrance motion.

## Out of scope (deliberate)

- **un1t-crm / the staff CRM** — untouched.
- **The share-card OG image** — already on-brand; not re-themed.
- **A light theme** — dark-only by decision; a light theme could be a later effort.
- **New features / data** — purely presentational + the one shell refactor; no new tables, routes, or HR logic.
- **A real logo file / custom NEXA font** — identity is type+colour+layout; the `UN1T` wordmark is set in Poppins. A licensed brand font is a later upgrade.
- **Native app** — champ-app stays web.

## Phasing / rollout

Three shippable PRs (each builds + deploys green on its own; champ-app auto-deploys to `app.champfitness.ie`):

- **P1 — Foundation:** tokens + Poppins + dark-only `globals.css`/`tailwind.config.js` + `src/components/ui/` primitives + `src/lib/format.js` + the `(app)/` route-group shell (TopBar + TabBar). After P1 the app is dark + navigable; surfaces still use some inline styles but inherit the dark body + shell.
- **P2 — Core surfaces:** dashboard, sessions list, session-report view rebuilt on the primitives.
- **P3 — Remaining surfaces:** account sub-pages, login, public share-page chrome + the CTA link-target fix.

## Testing

- **Pure helpers** (`src/lib/format.js`, any extracted logic) — unit-tested (Vitest), mirroring the existing suite.
- **Per PR:** `npm test` + `npm run lint` + `npm run build` all green. champ-app has **no GitHub Actions** — the Vercel PR build is the remote gate (same as Slice 4), so a real `next build` before merge is mandatory.
- **Visual:** the redesign is presentational; verify the build route list + spot-check the rendered surfaces. No new logic-heavy paths.
- **No regressions** to Slice 1–4 behaviour (the report builder, share mint/route, opengraph-image image) — those modules aren't touched, only the surrounding chrome/styling.

## Open questions

1. **Tab bar entries** — Home / Sessions / Account assumed (the three authenticated trees). Add a 4th later if a surface warrants it. *Default: three.*
2. **Wordmark vs logo** — `UN1T` set in Poppins 800 for v1; swap in a real logo/NEXA later if provided. *Default: set type.*
3. **Motion depth** — subtle entrance + optional number count-up; trim if it feels much. *Default: subtle, reduced-motion-safe.*
