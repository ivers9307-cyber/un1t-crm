# Host portal: light and dark, with a toggle — design

**Date:** 2026-11-09. **Asked by:** Richard. He found the new portal hard to read ("the black background isn't the best"), was shown the Create an event form three ways (today; dark with contrast and structure fixed; light in the staff CRM's colours), and asked: "can we have both with a toggle to switch between the 2". **Scope:** every signed-in host page plus the host login and set-password pages. One PR. No migration.

The two looks he saw are the two themes. Everything else here is **my call**, made because he asked for the outcome, not the mechanics; he can override any of it.

## 0. Ground (main at `0a3a275d9`)

- The host portal is dark by hard-coding: about 700 Tailwind classes such as `text-white/45`, `border-white/10`, `bg-white/[0.03]`, `bg-black`, plus dark-recipe status colours (`text-red-300`, `bg-amber-500/15`), across about 40 files in `src/app/host/` and `src/components/host/`.
- Measured on pure black: field labels (`text-white/45`) are 4.4 : 1, hints (`/35`) 3.0 : 1, "(optional)" (`/30`) 2.5 : 1. The usual minimum for small text is 4.5 : 1. Labels and section headings share one small, capitalised, letter-spaced style, so a form has no visible structure.
- Five shared components carry a `dark` prop that only the host portal passes: `EventSignupsCard`, `EventWaitlistPanel`, `PricingTiersEditor`, `RegistrationQuestionsEditor`, `DuplicateEventButton`.
- `src/components/host/HostPublicEvents.jsx` and `HostPublicExtras.jsx` render the PUBLIC page `/h/<slug>`. They are not part of the portal and are out of scope.
- The staff CRM is light, on the `un1t-*` tokens in `tailwind.config.js`. Tailwind is v3.4.

## 1. Intent

A host can read every screen comfortably, in whichever look they prefer, and switch with one click. Both looks come from one set of markup, so they cannot drift apart and a new screen gets both for free.

## 2. Goals

- Two themes, **Dark** and **Light**, driven by one set of semantic colour tokens.
- A toggle in the portal header that switches at once and is remembered.
- Every text colour meets 4.5 : 1 on the surface it sits on, in both themes, proven by a test.
- The legibility fixes from the mockup in both themes: sentence-case labels, readable hints, real section headings, fields with a visible edge and a clear focus outline.
- The event form (create and Set up) restructured into one panel per section, each with a heading and a one-line description, as mocked.

## 3. Non-goals

- The public pages (`/h/…`, `/event/…`), emails, and the staff CRM.
- A per-account setting stored in the database. The choice is per browser.
- Changing what any screen does. This is colour, type and grouping only.

## 4. Anti-goals

- A screen that is unreadable in one theme because a colour was left hard-coded (white text on a white panel).
- A flash of the wrong theme on load.
- A class whose name lies about its colour. No remapping of `text-white/45` by CSS override: components move to semantic names.
- Any change of behaviour, copy (other than label case and the section descriptions below), field order or API.

## 5. The design

### 5.1 Tokens

CSS variables on the element that carries `data-host-theme`, defined in `src/app/globals.css` for `dark` and `light`, and exposed to Tailwind as a `host` colour group (`bg-host-panel`, `text-host-label`, `border-host-border`…). Each is a complete colour, so opacity modifiers are not used on them.

| Token | Use | Dark | Light |
|---|---|---|---|
| `bg` | page | `#0C0D0F` | `#F7F8FA` |
| `panel` | cards, lists, section panels | `#17181B` | `#FFFFFF` |
| `well` | a box nested in a panel; table header; hover | `#121316` | `#F7F8FA` |
| `input` | field background | `#0F1012` | `#FFFFFF` |
| `border` | hairlines, card edges | `#2A2B2F` | `#E2E5E9` |
| `edge` | field borders, secondary button edges | `#4A4B50` | `#CBD5E1` |
| `text` | primary text, values | `#EDEDEE` | `#111827` |
| `label` | field labels, strong secondary text | `#C4C4C6` | `#334155` |
| `hint` | hints, meta lines, secondary text | `#A9AAAC` | `#5B6779` |
| `faint` | placeholders, disabled text | `#7B7C7F` | `#8793A6` |
| `accent` / `on-accent` | primary button, selected chip | `#FFFFFF` / `#000000` | `#1E293B` / `#FFFFFF` |
| `ok` / `ok-bg` / `ok-edge` | success text, chip, notice | `#6EE7B7` / `#10291F` / `#1F5A44` | `#047857` / `#ECFDF5` / `#A7F3D0` |
| `warn` / `warn-bg` / `warn-edge` | attention | `#FCD34D` / `#2A2110` / `#6B4E12` | `#92400E` / `#FFFBEB` / `#FCD34D` |
| `bad` / `bad-bg` / `bad-edge` | errors, destructive | `#FCA5A5` / `#2A1414` / `#6B2424` | `#B91C1C` / `#FEF2F2` / `#FECACA` |
| `info` / `info-bg` | informational chip, "moved in" notes | `#7DD3FC` / `#0F2430` | `#0369A1` / `#F0F9FF` |
| `star` | rating stars | `#FDE047` | `#CA8A04` |
| `danger` / `on-danger` | solid destructive button | `#DC2626` / `#FFFFFF` | `#DC2626` / `#FFFFFF` |

These values are starting points. The contrast test (§ 5.6) is the authority: if a pair fails, adjust the value until it passes and keep the two themes visually balanced.

### 5.2 Choosing and remembering the theme

- The theme is one of `light`, `dark` or unset. Unset follows the device (`prefers-color-scheme`); a device with no preference gets dark, as today.
- It is stored in a cookie `host_theme` (`light` | `dark`, one year, path `/`, `SameSite=Lax`), per browser. No database.
- `src/app/host/layout.js` (which wraps login, set-password and the portal) reads the cookie on the server and renders a wrapper element with `data-host-theme="light" | "dark" | "system"`, the page background and the base text colour. So the first paint is already right when the host has chosen. For `system` the CSS resolves light or dark with a media query, so there is no flash and no script.
- `color-scheme` is set to match on that wrapper, so native date and time pickers, scrollbars and autofill follow the theme.

### 5.3 The toggle

A small two-state control in the portal header, beside the host's name: a sun and a moon, the active one filled, with accessible names "Use the light theme" / "Use the dark theme" and `aria-pressed`. Clicking sets the cookie and flips `data-host-theme` on the wrapper at once (no reload). It also appears on the login and set-password pages, top right. Before the host has ever chosen, the control shows whichever theme the device resolved to.

### 5.4 A class kit

`src/components/host/host-ui.js` exports plain class strings built on the tokens, so every screen uses the same recipes and a change is made once. Usable from server and client components (it has no imports).

- Type: `HOST_H1`; `HOST_SECTION` (section heading: 17px, semibold, primary text); `HOST_SECTION_DESC`; `HOST_EYEBROW` (the small overline used above lists such as "Needs your attention": sentence case, 13px, medium weight, `label` colour; no capitals, no letter-spacing); `HOST_LABEL` (13.5px, medium, sentence case); `HOST_HINT` (13px); `HOST_META` (12.5px, `hint`).
- Surfaces: `HOST_PANEL`; `HOST_WELL`; `HOST_LIST` and `HOST_ROW` (bordered, divided lists).
- Controls: `HOST_INPUT` (44px tall, `input` background, `edge` border, 15px text, `faint` placeholder, a 2px focus outline in `accent`); `HOST_BTN` (secondary); `HOST_BTN_PRIMARY`; `HOST_BTN_DANGER`; `HOST_LINK`.
- Status: `HOST_CHIP` with `HOST_CHIP_TONE.{neutral, ok, warn, bad, info}`; `HOST_NOTICE` with `HOST_NOTICE_TONE.{neutral, ok, warn, bad}`.

`HOST_STATUS_CHIP` in `src/lib/host-portal.js` (draft, in review, published, needs changes) is rebuilt on `HOST_CHIP_TONE`.

### 5.5 Moving the screens

Every file under `src/app/host/` and `src/components/host/` (except the two public-page components) and the `dark` branch of the five shared components moves from raw colours to the kit and tokens. Rules:

- No `text-white…`, `text-black`, `bg-black`, `bg-white…`, `border-white…`, `divide-white…`, `placeholder:text-white…` or dark-recipe status colour (`text-red-300`, `bg-amber-500/15`, …) may remain in those files. A guard test enforces it, with a short allowlist for genuine exceptions (for example a dark scrim behind a modal, which is dark in both themes).
- Labels lose their capitals and letter-spacing everywhere, through `HOST_LABEL` and `HOST_EYEBROW`.
- The "selected" state of a choice (team size, active tab, active nav link) uses `accent` / `on-accent` or a clear token-based equivalent, never a faint tint.
- The visual email designer (Unlayer) keeps its own look; if it accepts a theme option, pass the current theme, otherwise leave it.
- Sizes, spacing and layout stay as they are except where the kit sets them (field height, label size).

### 5.6 The event form

`HostEventForm` (create, and the Set up tab) becomes one `HOST_PANEL` per section, each with a `HOST_SECTION` heading and a one-line `HOST_SECTION_DESC`:

| Section | Description |
|---|---|
| Basics | What it is and where. |
| Schedule & sessions | When it runs and how many places each time has. |
| Tickets & pricing | What a place costs and how big a booking can be. |
| Questions at signup | Anything you need to know from the people booking. |
| Page look | How the event page looks. |
| Emails (optional) | The confirmation, reminder and rating request, if you want to change the wording. |

Field order, names, ids, validation, the jump bar, the off-sale notice and dialog, dirty tracking and every behaviour are unchanged. The jump bar's pills use the kit; the email section stays collapsible.

### 5.7 Tests

- **Contrast.** `tests/host-theme-contrast.test.js` reads the token values out of `globals.css` and asserts, for both themes: `text`, `label` and `hint` on each of `bg`, `panel` and `well`, and `text` on `input`, are at least 4.5 : 1; `on-accent` on `accent` and `on-danger` on `danger` at least 4.5 : 1; each status text (`ok`, `warn`, `bad`, `info`) on its own `-bg` and on `panel` at least 4.5 : 1; `faint` on `input` at least 3 : 1; `edge` on `panel` and on `input` at least 3 : 1 (a field's edge must be visible).
- **No raw colours.** `tests/host-theme-raw-colours-guard.test.js` fails on any forbidden class in the in-scope files, naming file and line.
- **Tokens complete.** Every token in the Tailwind `host` group has a value in both themes, and the `system` media query sets all of them.
- **Toggle and cookie.** The layout renders the attribute from the cookie; the toggle flips the attribute, writes the cookie and reports `aria-pressed`.
- Existing tests keep passing; a test that asserted an old colour class is updated to the new one and listed.

## 6. Constraints

Unchanged from the reorganisation: every page gates on `getCurrentHost()`; a Server Component never passes a function to a Client Component; every screen holds at 375px; no behaviour change. The CRM's guardrail lint (`check:guardrails`) must stay green: the host paths are currently excused from the light-theme chip rules as a dark surface, and they stay excused, since the tokens now carry both themes.
