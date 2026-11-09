# Host Portal Light/Dark Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the host portal a light and a dark theme from one set of semantic colour tokens, with a remembered toggle, and fix the portal's legibility in both.

**Architecture:** CSS variables on a `data-host-theme` wrapper rendered by `src/app/host/layout.js` from a cookie; a Tailwind `host` colour group over those variables; a class kit (`src/components/host/host-ui.js`) every screen uses; then a file-by-file move of the portal from raw `white/NN` colours to the kit. Colour, type and grouping only: no behaviour change, no API change, no migration.

**Tech Stack:** Next.js 16 App Router (JS), Tailwind 3.4, React Server and Client Components, Vitest + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-09-host-portal-theme-design.md`. Read it first: § 5.1 is the token table, § 5.4 the kit, § 5.6 the form's section descriptions.

## Global Constraints

- **In scope:** every file under `src/app/host/` and `src/components/host/`, and the `dark` branch of `src/components/{EventSignupsCard,EventWaitlistPanel,PricingTiersEditor,RegistrationQuestionsEditor,DuplicateEventButton}.jsx`. **Out of scope, do not touch:** `src/components/host/HostPublicEvents.jsx`, `src/components/host/HostPublicExtras.jsx` (they render the public page), anything under `src/app/h/` or `src/app/event/`, and the light (`dark === false`) branch of the five shared components.
- **No behaviour change.** A migration task's diff is class strings, wrapper elements and label case only. No prop, state, handler, fetch, route, copy (beyond the spec's section descriptions and sentence-case labels), id, `aria-*`, field order or test id changes. If a file cannot be moved without changing behaviour, stop and report.
- **No raw colours left** in a file you migrate: none of `text-white`, `text-black`, `bg-black`, `bg-white`, `border-white`, `divide-white`, `ring-white`, `placeholder:text-white` (with or without `/NN`, with or without a `hover:`/`focus:`/`disabled:` prefix), no `text-`/`bg-`/`border-` class on the `red`, `amber`, `emerald`, `green`, `sky`, `blue` or `yellow` palettes, and no `[color-scheme:dark]`. The one allowed exception is a modal scrim, which stays `bg-black/60` in both themes.
- **Mapping from raw classes** (judge by what the element IS, not only by its opacity):

| Was | Becomes |
|---|---|
| primary text: `text-white`, `text-white/80`–`/90` | `text-host-text` |
| a field label | `HOST_LABEL` |
| a section heading (the small capitals style `text-xs uppercase tracking-[0.15em] text-white/45`) | `HOST_SECTION` for a form or page section; `HOST_EYEBROW` for an overline above a list or card |
| supporting copy a host must read: `text-white/45`–`/75`, and `text-white/30`–`/40` when it is a hint, a meta line or a link | `text-host-hint` (use `text-host-label` when it leads a row) |
| placeholder or disabled text only | `text-host-faint` / `placeholder:text-host-faint` |
| card, list, section surface: `bg-white/[0.02]`–`[0.05]` with a border | `HOST_PANEL` / `HOST_LIST` |
| a box nested inside a card; a table header; a hover fill (`hover:bg-white/5`) | `bg-host-well` / `hover:bg-host-well` |
| hairline: `border-white/5`–`/15`, `divide-white/10` | `border-host-border` / `divide-host-border` |
| a control's edge: `border-white/12`–`/40` on an input, select or secondary button | `HOST_INPUT` / `HOST_BTN` (edge token) |
| `bg-white text-black` button | `HOST_BTN_PRIMARY` |
| a selected choice or active tab or nav link (`bg-white/10 text-white`) | `bg-host-accent text-host-on-accent` for a choice chip; for a tab or nav link `bg-host-well text-host-text font-semibold` |
| red text or box | `text-host-bad` / `HOST_NOTICE_TONE.bad`; a solid red button → `HOST_BTN_DANGER` |
| amber text or box | `text-host-warn` / `HOST_NOTICE_TONE.warn` |
| emerald or green | `text-host-ok` / `HOST_NOTICE_TONE.ok` / `HOST_CHIP_TONE.ok` |
| sky or blue | `text-host-info` / `HOST_CHIP_TONE.info` |
| `text-yellow-300` stars | `text-host-star` |
| `hover:text-white` | `hover:text-host-text` |

- Tokens are complete colours: never put an opacity modifier on a `host-*` colour (`bg-host-panel/50` renders nothing useful). Use `opacity-*` on the element when something must look disabled.
- A Server Component never passes a function to a Client Component. The kit is plain strings with no imports, safe on both sides.
- Every `<button>` inside a `<form>` keeps its `type`.
- A test that asserted an old colour class is updated to the new class and listed in the report; no other assertion changes.
- Every RTL test file calls `afterEach(cleanup)`.
- One PR off `origin/main`. Commit subjects start `HOSTTHEME.1 —`. Changelog file `docs/changelog/entries/<PR>.md` after `gh pr create`.

## Review Focus

1. **White on white, or black on black.** A leftover raw colour is invisible in one theme. → the raw-colour guard (Task 6) plus each migration task's own grep.
2. **A text colour that fails contrast on the surface it actually sits on** (hint text inside a well; a status colour on a panel). → the contrast test (Task 1) covers every text token on every surface.
3. **The wrong theme flashing on load, or the toggle not surviving a reload.** → Task 1 tests the server-rendered attribute from the cookie.
4. **Native controls ignoring the theme** (date and time pickers, select menus, autofill, scrollbars). → Task 1 sets `color-scheme` on the wrapper and tests it per theme.
5. **A behaviour change hidden in a styling diff.** → every migration review checks the diff is classes and wrappers only.

---

### Task 1: tokens, the wrapper, the toggle and the kit

**Files:**
- Create: `src/lib/host-theme.js` + test, `src/components/host/host-ui.js` + test, `src/components/host/HostThemeToggle.jsx` + test, `src/app/host/layout.test.js`, `tests/host-theme-contrast.test.js`
- Modify: `src/app/globals.css`, `tailwind.config.js`, `src/app/host/layout.js`, `src/app/host/(portal)/layout.js`, `src/lib/host-portal.js` (+ its test), `eslint.guardrails.config.mjs` only if a guardrail rule objects to the new files

**Interfaces — Produces:**
- `src/lib/host-theme.js` (no imports): `HOST_THEME_COOKIE = 'host_theme'`; `HOST_THEMES = ['light', 'dark']`; `hostThemeFromCookie(value) → 'light' | 'dark' | 'system'` (anything else, including undefined, is `'system'`); `hostThemeCookieString(theme) → string` (`host_theme=<theme>; Path=/; Max-Age=31536000; SameSite=Lax`).
- CSS in `globals.css`: `[data-host-theme='dark']`, `[data-host-theme='light']` each set every `--host-*` variable and `color-scheme`; `[data-host-theme='system']` sets the dark values and, inside `@media (prefers-color-scheme: light)`, the light values. Keep the two value blocks single-sourced if the syntax allows (for example a shared selector list for dark and for light), so `system` cannot drift from the explicit themes.
- `tailwind.config.js`: `colors.host = { bg, panel, well, input, border, edge, text, label, hint, faint, accent, 'on-accent', ok, 'ok-bg', 'ok-edge', warn, 'warn-bg', 'warn-edge', bad, 'bad-bg', 'bad-edge', info, 'info-bg', star, danger, 'on-danger' }`, each `'var(--host-<name>)'`.
- `src/app/host/layout.js`: reads the cookie with `cookies()` from `next/headers` and wraps `children` in `<div data-host-theme={theme} className="min-h-screen bg-host-bg text-host-text">`. `(portal)/layout.js` drops its own `min-h-screen bg-black text-white` wrapper classes and renders `<HostThemeToggle initial={theme} />` in the header beside the host's name (it reads the cookie the same way; pass a string, never a function).
- `HostThemeToggle({ initial })` (client): two buttons, "Use the light theme" and "Use the dark theme", `aria-pressed` on the active one. On mount, when `initial` is `'system'`, it resolves the active one from `matchMedia('(prefers-color-scheme: light)')` (guard for it being undefined: then dark). A click writes `document.cookie = hostThemeCookieString(theme)` and sets `data-host-theme` on the closest `[data-host-theme]` ancestor.
- `host-ui.js`: the constants named in spec § 5.4, as plain strings built only from `host-*` colours and layout utilities.
- `HOST_STATUS_CHIP` in `host-portal.js`: draft → neutral, pending_review → warn, published → ok, rejected → bad, built from `HOST_CHIP` + `HOST_CHIP_TONE`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-theme-contrast.test.js — parse globals.css; fail with the pair and the ratio
const TEXT_ON = { text: ['bg','panel','well','input'], label: ['bg','panel','well'], hint: ['bg','panel','well'] }
it.each(['dark','light'])('%s: every text token meets 4.5:1 on every surface it sits on', (theme) => {})
it.each(['dark','light'])('%s: on-accent on accent and on-danger on danger meet 4.5:1', (theme) => {})
it.each(['dark','light'])('%s: each status text meets 4.5:1 on its own -bg and on panel', (theme) => {})
it.each(['dark','light'])('%s: faint on input, and edge on panel and on input, meet 3:1', (theme) => {})
it('every token in the Tailwind host group has a value in both themes', () => {})
it('the system theme sets the dark values and switches every token to light under prefers-color-scheme: light', () => {})
it('each theme sets color-scheme to its own name', () => {})
// src/lib/host-theme.test.js
it('reads light and dark and treats anything else as system', () => {
  expect(hostThemeFromCookie('light')).toBe('light'); expect(hostThemeFromCookie('dark')).toBe('dark')
  for (const v of [undefined, null, '', 'blue', 'system']) expect(hostThemeFromCookie(v)).toBe('system')
})
it('writes a one-year, site-wide, lax cookie', () => { expect(hostThemeCookieString('light')).toBe('host_theme=light; Path=/; Max-Age=31536000; SameSite=Lax') })
// src/app/host/layout.test.js
it.each([['light','light'],['dark','dark'],[undefined,'system'],['nonsense','system']])('cookie %s renders data-host-theme=%s', async (cookie, attr) => {})
// HostThemeToggle.test.jsx
it('marks the initial theme as pressed', () => {})
it('resolves system from the device and marks that one', () => {})
it('a click sets the attribute on the wrapper, writes the cookie and moves aria-pressed', () => {})
// host-ui.test.js
it('uses no raw white, black or palette colour in any constant', () => {})
it('never puts an opacity modifier on a host colour', () => {})
```

- [ ] **Step 2:** run them → FAIL. **Step 3:** implement, adjusting token values until the contrast test passes (record every value you changed from the spec's table in your report). **Step 4:** PASS; also `npx vitest run src/lib/host-portal.test.js 'src/app/host' src/components/host tests/server-to-client-function-props.test.js tests/rtl-cleanup-after-each.test.js` and `npm run check:guardrails`. **Step 5:** Commit `HOSTTHEME.1 — theme tokens, the wrapper, the toggle and the host class kit`.

### Task 2: the shell and the top-level pages

**Files (modify, with their tests where a class is asserted):** `src/app/host/(portal)/layout.js`, `src/components/host/{HostNav,HostSignOut,HostImpersonationBanner,HostEventRow,HostPastEvents,HostSeriesList,HostSubmitButton,HostPayouts,HostStatements,HostYourPage,HostListPageEditor,CopyLinkButton}.jsx`, `src/app/host/login/{page.js,HostLoginForm.jsx}`, `src/app/host/set-password/{page.js,HostSetPasswordForm.jsx}`, `src/app/host/(portal)/{page.js,events/page.js,events/new/page.js,earnings/page.js,page/page.js,contacts/page.js}`.

Move each to the kit per the mapping. The login and set-password pages also render `<HostThemeToggle initial={theme} />` top right. The header keeps its layout; the brand, nav strip, Create event button (`HOST_BTN_PRIMARY`), host name, toggle and sign out all use tokens.

- [ ] **Step 1:** For each file, `grep` the forbidden patterns and note the count. **Step 2:** migrate. **Step 3:** grep again: zero in every listed file. **Step 4:** `npx vitest run 'src/app/host' src/components/host tests/server-to-client-function-props.test.js tests/rtl-cleanup-after-each.test.js`, `npx eslint` on changed files, `npm run check:guardrails`. **Step 5:** Commit `HOSTTHEME.1 — the shell and the top-level pages use the theme tokens`.

### Task 3: the event pages

**Files:** `src/app/host/(portal)/events/[id]/{layout.js,page.js,attendees/page.js,setup/page.js,promote/page.js,insights/page.js}`, `src/components/host/{HostEventTabs,HostEventMenu,HostEventActions,SessionFillBars,HostAttendeeTable,EventShareLinks,AnnounceEventButton,HostPromoCodes,HostSeriesActions,HostEventRatings}.jsx`, and the `dark` branch of `src/components/{EventWaitlistPanel,EventSignupsCard,DuplicateEventButton}.jsx` (plus any dialog `HostAttendeeTable` opens that takes a `dark` flag: follow it).

Same steps as Task 2. In the shared components only the `dark ? … : …` dark arm changes; the light arm (staff) must be byte-identical. Session bars: track `bg-host-well`, fill `bg-host-accent`. Commit `HOSTTHEME.1 — the event pages use the theme tokens`.

### Task 4: the event form in panels

**Files:** `src/components/host/HostEventForm.jsx` (+ test), `src/components/host/OffSaleConfirmDialog.jsx` (+ test), the `dark` branch of `src/components/{PricingTiersEditor,RegistrationQuestionsEditor}.jsx`.

Restructure per spec § 5.6: each section in a `HOST_PANEL` with `HOST_SECTION` and the spec's one-line `HOST_SECTION_DESC`; labels `HOST_LABEL` (sentence case: the label TEXT keeps its words, only the capitals styling goes); hints `HOST_HINT`; fields `HOST_INPUT`; team-size chips selected = accent; the nested session row a `HOST_WELL`; the off-sale notice `HOST_NOTICE_TONE.warn`; the jump bar pills `HOST_BTN`-style with the kit. Section ids, field ids, `htmlFor`, names, order, validation, dirty tracking, the session-id merge, the off-sale check and every handler are untouched. The dialog keeps its scrim (`bg-black/60`) and moves its panel and buttons to the kit.

- [ ] **Step 1:** add tests: each of the six sections renders its heading and its description from the spec; no forbidden class in the rendered form (render and scan `className`s); every existing test still passes unchanged apart from class assertions. **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `npx vitest run src/components/host tests/host-event-edit-roundtrip-guard.test.js 'src/app/host'` PASS. **Step 5:** Commit `HOSTTHEME.1 — the event form in panels, on the theme tokens`.

### Task 5: emails

**Files:** `src/app/host/(portal)/emails/{page.js,[id]/page.js}`, `src/components/host/{HostEmails,HostEmailReport,HostEmailPreviewModal}.jsx`.

Same steps as Task 2. The preview modal keeps its scrim. The email preview frame itself (the rendered email) is not themed. If Unlayer's `init` accepts an appearance or theme option, pass the current theme read from the wrapper's `data-host-theme`; if not, leave it and say so. Commit `HOSTTHEME.1 — the email screens use the theme tokens`.

### Task 6: the raw-colour guard

**Files:** Create `tests/host-theme-raw-colours-guard.test.js`.

Scan every `.js`/`.jsx` non-test file under `src/app/host/` and `src/components/host/` except the two public-page components, plus the dark arm of the five shared components (for those, fail on a forbidden class inside the `dark ?` arm only; if that cannot be isolated reliably, scan the strings assigned in the dark arm by locating the `dark\s*\?` ternaries and say so in the header). Forbidden patterns as in Global Constraints. Allowlist: `bg-black/60` on a scrim, each entry with a reason. Fail with `file:line` and the class. Prove itself with a synthetic string. It must pass on the tree; if it finds a leftover, fix the leftover (styling only) in this task and list it.

Commit `HOSTTHEME.1 — guard: no raw colours in the host portal`.

### Task 7: ship

- [ ] Render the main screens to static HTML in both themes and look at them in a browser at 1280px and 375px (the controller does this; it is the only visual check available without a host session).
- [ ] CI mirror, then `npm run build` on its own.
- [ ] Push, `gh pr create --base main` titled `HOSTTHEME.1 — the host portal in light and dark, with a toggle`, changelog entry, push.
