# Phase 1 — Prune: Legacy Stub Deletion & Template-Editor Fold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete all 27 redirect-only legacy pages and fold the 4 still-live template editors into the canonical `/communications/templates` tree, replacing filesystem stubs with `next.config.js` redirects.

**Architecture:** Three moves in sequence: (1) repoint every live link that still targets a legacy URL, (2) delete the stubs (retiring the two tests that pin them as required, keeping the anti-vacuity guard alive via a committed fixture), (3) split `/communications` into route groups — `(hub)` carries the header/tab chrome, `(editors)` hosts the full-screen template editors at `/communications/templates/email|whatsapp/*` — so the editors share the layout's permission gate without inheriting the hub chrome. A root-level `legacy-redirects.js` (CJS, unit-tested) wired into `next.config.js` `redirects()` preserves URL back-compat without page files.

**Tech Stack:** Next.js 16 App Router (route groups), vitest, existing repo guard scripts.

**Parent spec:** `docs/superpowers/specs/2026-08-14-platform-consolidation-design.md` §3.2.1, §3.6 phase 1.

**Branch:** create a dedicated worktree `git worktree add -b prune-legacy-stubs ../un1t-crm-prune origin/main` (never work in the primary clone — parallel sessions race HEAD). All paths below are relative to the worktree root.

**Verification baseline (run before Task 1 so failures are attributable):**
```bash
npm test && npm run lint
```
Expected: all green (~2950 tests).

---

### Task 1: Repoint live links that still target legacy/stub URLs

Every edit here points a link at the URL the stub would have redirected to anyway — zero behaviour change beyond skipping a hop.

**Files:**
- Modify: `src/lib/nav-items.test.js:154`
- Modify: `src/lib/nav-items.js:246`
- Modify: `src/app/cars/[id]/page.js:23`
- Modify: `src/components/cars/CarDetail.jsx:82`
- Modify: `src/app/contacts/[id]/page.js:451`
- Modify: `src/components/StartWhatsAppButton.jsx:25`
- Modify: `src/components/WAInbox.jsx:744`
- Modify: `src/components/WATemplateEditor.jsx:347`

- [ ] **Step 1: Update the nav test expectation first (TDD)**

In `src/lib/nav-items.test.js` line 154, change:

```js
    expect(hrefsIn('other')).toEqual(['/cars', '/orders'])
```

to:

```js
    expect(hrefsIn('other')).toEqual(['/cars/active', '/orders'])
```

(Line 155 `expect(hrefsIn('gym')).not.toContain('/cars')` stays as is — still passes.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/nav-items.test.js`
Expected: FAIL — `hrefsIn('other')` returns `['/cars', '/orders']`.

- [ ] **Step 3: Update the sidebar entry**

In `src/lib/nav-items.js` line 246, change:

```js
  { href: '/cars',       label: 'Car Processing', icon: Car,           permission: 'car_processing', section: 'other' },
```

to:

```js
  { href: '/cars/active', label: 'Car Processing', icon: Car,          permission: 'car_processing', section: 'other' },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/nav-items.test.js`
Expected: PASS.

- [ ] **Step 5: Repoint the remaining six link sites**

`src/app/cars/[id]/page.js` line 23 — change `if (guard) redirect('/cars')` to:

```js
  if (guard) redirect('/cars/active')
```

`src/components/cars/CarDetail.jsx` line 82 — change `router.push('/cars')` to:

```js
    router.push('/cars/active')
```

`src/app/contacts/[id]/page.js` line 451 — change `href="/whatsapp/inbox"` to:

```jsx
                  href="/communications/inbox"
```

`src/components/StartWhatsAppButton.jsx` line 25 — change to:

```js
        router.push(`/communications/inbox?c=${data.conversation_id}`)
```

`src/components/WAInbox.jsx` line 744 — change the back-arrow link to:

```jsx
            <Link href="/communications" className="text-un1t-subtle hover:text-un1t-text transition-colors">
```

`src/components/WATemplateEditor.jsx` line 347 — change `router.push('/whatsapp/templates')` (which hops through a stub) to land on the canonical list directly:

```js
      router.push('/communications/templates?channel=whatsapp')
```

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`
Expected: PASS (the `comms-back-links.test.jsx` contract and `command-palette.test.js` K5 suites are unaffected — palette already targets `/cars/active` at `src/lib/command-palette.js:39`).

- [ ] **Step 7: Commit**

```bash
git add src/lib/nav-items.js src/lib/nav-items.test.js "src/app/cars/[id]/page.js" src/components/cars/CarDetail.jsx "src/app/contacts/[id]/page.js" src/components/StartWhatsAppButton.jsx src/components/WAInbox.jsx src/components/WATemplateEditor.jsx
git commit -m "PRUNE.1a — repoint live links off legacy stub URLs (skip the redirect hop)"
```

---

### Task 2: Retire the stub-pinning tests and delete all 27 redirect stubs

Two tests currently pin stubs as *required*: `legacy-detail-redirects.test.js` (imports 4 stub pages) and the K5 anti-vacuity check (`command-palette.test.js:247-253`, asserts `/whatsapp/broadcasts/new` and `/cars` ARE stubs). The first is deleted with the stubs it tests; the second keeps its guard-not-blind purpose via a committed fixture — the real `/cars` stub file, moved, so the fixture is the genuine retired shape.

**Files:**
- Delete: `src/app/communications/sent/legacy-detail-redirects.test.js`
- Move: `src/app/cars/page.js` → `src/lib/__fixtures__/redirect-stub-page.js`
- Modify: `src/lib/command-palette.test.js:247-253`
- Delete: 26 stub `page.js` files (list in Step 4)

- [ ] **Step 1: Move the `/cars` stub to become the K5 fixture**

```bash
mkdir -p src/lib/__fixtures__
git mv src/app/cars/page.js src/lib/__fixtures__/redirect-stub-page.js
```

Then prepend this comment to `src/lib/__fixtures__/redirect-stub-page.js` (keep the file's code untouched below it):

```js
// K5 anti-vacuity fixture — this IS the retired /cars redirect stub,
// moved here verbatim when PRUNE.1 deleted every real stub page, so
// command-palette.test.js can still prove isRedirectStub() recognises
// the shape. Never imported by app code.
```

- [ ] **Step 2: Point the K5 anti-vacuity test at the fixture**

In `src/lib/command-palette.test.js`, replace the block at lines 247-253:

```js
  it('recognises a known retired stub, so the check above is not vacuous', () => {
    // If this ever stops being a redirect the guard has gone blind.
    expect(isRedirectStub(pageFileFor('/whatsapp/broadcasts/new'))).toBe(true)
    expect(isRedirectStub(pageFileFor('/cars'))).toBe(true)
    // …and does not misread the session-resolving dashboard index as retired.
    expect(isRedirectStub(pageFileFor('/dashboard'))).toBe(false)
  })
```

with:

```js
  it('recognises a known retired stub, so the check above is not vacuous', () => {
    // Every real stub was deleted in PRUNE.1; the fixture is the old /cars
    // stub moved verbatim. If this ever stops matching, the guard has gone blind.
    const fixture = path.join(process.cwd(), 'src/lib/__fixtures__/redirect-stub-page.js')
    expect(isRedirectStub(fixture)).toBe(true)
    // …and does not misread the session-resolving dashboard index as retired.
    expect(isRedirectStub(pageFileFor('/dashboard'))).toBe(false)
  })
```

(`path` is already imported by this test — it resolves `src/app` files from disk. Verify with `grep -n "^import" src/lib/command-palette.test.js`; if `path` is somehow absent, add `import path from 'node:path'`.)

- [ ] **Step 3: Run the palette test — must pass BEFORE the mass deletion**

Run: `npx vitest run src/lib/command-palette.test.js`
Expected: PASS.

- [ ] **Step 4: Delete the stub-pinning test and the 26 remaining stubs**

```bash
git rm src/app/communications/sent/legacy-detail-redirects.test.js
git rm src/app/email/page.js src/app/email/templates/page.js \
  src/app/email/sequences/page.js src/app/email/sequences/new/page.js "src/app/email/sequences/[id]/page.js" \
  src/app/email/campaigns/new/page.js "src/app/email/campaigns/[id]/page.js" \
  src/app/whatsapp/page.js src/app/whatsapp/templates/page.js \
  src/app/whatsapp/broadcasts/page.js src/app/whatsapp/broadcasts/new/page.js "src/app/whatsapp/broadcasts/[id]/page.js" \
  src/app/whatsapp/inbox/page.js \
  src/app/segments/page.js \
  src/app/cars/new/page.js src/app/cars/pending/page.js \
  src/app/contacts/duplicates/page.js \
  src/app/communications/broadcasts/page.js src/app/communications/campaigns/page.js \
  src/app/communications/instagram/page.js \
  src/app/communications/sequences/page.js "src/app/communications/sequences/[id]/page.js" src/app/communications/sequences/templates/page.js \
  src/app/communications/sms/broadcasts/page.js src/app/communications/sms/broadcasts/new/page.js "src/app/communications/sms/broadcasts/[id]/page.js"
```

(That is all 27 from the audit: 26 here + `/cars` moved in Step 1. The four `/email/templates/*` and `/whatsapp/templates/*` **editor** pages and their tests are NOT in this list — they move in Task 4.)

- [ ] **Step 5: Verify nothing references the deleted routes**

Run: `grep -rn "whatsapp/inbox\|whatsapp/broadcasts\|email/campaigns\|email/sequences\|communications/sequences\|sms/broadcasts/new" src/ --include="*.js" --include="*.jsx" | grep -v "api/" | grep -v "\.test\." | grep -v "^Binary"`
Expected: only code comments (e.g. `src/app/automations/[id]/page.js:12`, `src/lib/command-palette.js:57`) — no `href=`, `router.push`, or `redirect(` hits.

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src/app src/lib
git commit -m "PRUNE.1b — delete all 27 redirect stub pages; K5 guard keeps a fixture"
```

---

### Task 3: Split `/communications` into a gate-only root layout + `(hub)` chrome group

The current `src/app/communications/layout.js` does two jobs: the access gate AND the hub chrome (`CommsShell` + `<h1>` + `CommunicationsTabs`). The template editors moving in under `/communications/templates/...` (Task 4) are full-screen `h-screen` surfaces that must not inherit the chrome. Route groups split the jobs; URLs do not change.

**Files:**
- Modify: `src/app/communications/layout.js` (becomes gate-only)
- Create: `src/app/communications/(hub)/layout.js` (the chrome)
- Move: `inbox/ list-health/ page.js email-hub-stats.js email-hub-stats.test.js segments/ send/ sent/ templates/ tickets/` → `src/app/communications/(hub)/`

- [ ] **Step 1: Move every hub surface into the group**

```bash
mkdir "src/app/communications/(hub)"
git mv src/app/communications/inbox src/app/communications/list-health \
  src/app/communications/page.js src/app/communications/email-hub-stats.js src/app/communications/email-hub-stats.test.js \
  src/app/communications/segments src/app/communications/send src/app/communications/sent \
  src/app/communications/templates src/app/communications/tickets \
  "src/app/communications/(hub)/"
```

(`page.js` imports `./email-hub-stats.js` relatively — they move together so the import survives. All other imports in the moved files are `@/` alias imports, unaffected.)

- [ ] **Step 2: Rewrite the root layout as gate-only**

Replace the full contents of `src/app/communications/layout.js` with:

```js
// /communications layout — access gate only.
//
// The hub chrome (header + tab strip) lives in (hub)/layout.js so that
// full-screen surfaces — the template editors under (editors)/templates/
// email|whatsapp — share this gate without inheriting the chrome.
//
// hasPermission() honours the location feature gate (mig 032), so
// disabling a channel at a location's settings closes the whole tree.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function CommunicationsLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const canEmail = hasPermission(user, 'email')
  const canWhatsapp = hasPermission(user, 'whatsapp')
  const canSms = hasPermission(user, 'sms')
  // EMAIL-TICKET.4 — the ticket inbox lives at /communications/tickets and is
  // gated on `email_inbox`, a DIFFERENT key from the marketing `email` one.
  // Without it in this OR, someone granted only the ticket surface gets
  // bounced off their own page by this layout before it ever renders.
  const canEmailInbox = hasPermission(user, 'email_inbox')
  if (!canEmail && !canWhatsapp && !canSms && !canEmailInbox) redirect('/')

  return children
}
```

- [ ] **Step 3: Create the chrome layout**

Create `src/app/communications/(hub)/layout.js`:

```js
// /communications (hub) layout — header + sub-nav (up to 6 tabs,
// permission-dependent). Access is already gated by the parent
// communications/layout.js; the permission booleans are recomputed
// here because the chrome needs them for tab visibility — deliberate
// duplication, the gate and the chrome are separate jobs.

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import CommunicationsTabs from '@/components/communications/CommunicationsTabs'
import CommsShell from '@/components/communications/CommsShell'

export const dynamic = 'force-dynamic'

export default async function CommunicationsHubLayout({ children }) {
  const user = await getCurrentUser()

  const canEmail = hasPermission(user, 'email')
  const canWhatsapp = hasPermission(user, 'whatsapp')
  const canSms = hasPermission(user, 'sms')
  const canEmailInbox = hasPermission(user, 'email_inbox')

  // COMMSLAYOUT.3 — the Segments tab's gate, computed here so it is the SAME
  // expression /communications/segments applies to itself. The page is
  // manager-only and both of its data sources agree (GET /api/segments is
  // "Manager+ required"), so the page gate is the correct one and the tab was
  // the side that was wrong: it rendered on `canEmail || canWhatsapp`, which a
  // `staff` user can hold, and clicking it redirected them to `/` — losing the
  // Communications context. Channel permission AND manager role, or no tab.
  const canSegments = (canEmail || canWhatsapp) && MANAGER_ROLES.includes(user.role)

  return (
    <CommsShell>
      <h1 className="text-2xl font-bold text-un1t-text mb-1">Communications</h1>
      <p className="text-sm text-un1t-subtle mb-5">
        {[
          (canEmail || canEmailInbox) && 'email',
          canWhatsapp && 'WhatsApp',
          canSms && 'SMS',
        ].filter(Boolean).join(' + ')} for {user.activeLocation?.name || 'your studio'}
      </p>
      <CommunicationsTabs
        canSms={canSms}
        canEmail={canEmail}
        canWhatsapp={canWhatsapp}
        canEmailInbox={canEmailInbox}
        canSegments={canSegments}
      />
      {children}
    </CommsShell>
  )
}
```

- [ ] **Step 4: Run the unit suite and the build**

Run: `npm test`
Expected: PASS (moved `email-hub-stats.test.js` and `sent/page.test.jsx` run from their new paths).

Run: `npm run build`
Expected: compiles; the route list still shows `/communications`, `/communications/inbox`, `/communications/templates`, etc. at unchanged URLs. A route-collision error here means a file was left outside `(hub)` that duplicates a grouped URL — fix before proceeding.

- [ ] **Step 5: Commit**

```bash
git add -A src/app/communications
git commit -m "PRUNE.1c — split /communications: gate-only root layout + (hub) chrome group"
```

---

### Task 4: Move the four template editors under `/communications/(editors)/templates/`

The editors are thin server wrappers (auth + fetch + IDOR guard) around `TemplateEditor` / `WATemplateEditor` client components. They move verbatim — same guards, same components — into an `(editors)` route group, gaining the tree's permission gate and keeping their full-screen chrome. Their co-located tests move with them (they import `./page.js` relatively — no edits needed).

New URLs: `/communications/templates/email/new`, `/communications/templates/email/[id]`, `/communications/templates/whatsapp/new`, `/communications/templates/whatsapp/[id]`.

**Files:**
- Move: `src/app/email/templates/new/page.js` → `src/app/communications/(editors)/templates/email/new/page.js`
- Move: `src/app/email/templates/[id]/page.js` + `page.test.js` → `src/app/communications/(editors)/templates/email/[id]/`
- Move: `src/app/whatsapp/templates/new/page.js` → `src/app/communications/(editors)/templates/whatsapp/new/page.js`
- Move: `src/app/whatsapp/templates/[id]/page.js` + `page.test.js` → `src/app/communications/(editors)/templates/whatsapp/[id]/`
- Modify: `src/app/communications/(hub)/templates/page.js` (3 hrefs + header comment)
- Modify: `src/components/WhatsappTemplatesList.jsx:116,140`
- Modify: `src/components/WABroadcastEditor.jsx:629`
- Modify: `src/components/TemplateEditor.jsx:128`

- [ ] **Step 1: Move the pages and their tests**

```bash
mkdir -p "src/app/communications/(editors)/templates/email" "src/app/communications/(editors)/templates/whatsapp"
git mv src/app/email/templates/new "src/app/communications/(editors)/templates/email/new"
git mv "src/app/email/templates/[id]" "src/app/communications/(editors)/templates/email/[id]"
git mv src/app/whatsapp/templates/new "src/app/communications/(editors)/templates/whatsapp/new"
git mv "src/app/whatsapp/templates/[id]" "src/app/communications/(editors)/templates/whatsapp/[id]"
```

After this, `src/app/email/` and `src/app/whatsapp/` are empty and vanish from git. Verify: `find src/app/email src/app/whatsapp -type f 2>/dev/null` → no output.

- [ ] **Step 2: Repoint the templates list page**

In `src/app/communications/(hub)/templates/page.js`:

Replace the header comment (lines 1-6) with:

```js
// /communications/templates — combined email + WhatsApp templates.
//
// Single page with a channel filter at the top. Email and WhatsApp
// templates have very different shapes (HTML/JSON vs Meta-approved
// template+variables) so each channel keeps its own editor, at
// /communications/templates/email/* and /communications/templates/
// whatsapp/* — full-screen surfaces in the (editors) route group,
// outside this (hub) chrome.
```

Line 58 — change `href="/email/templates/new"` to:

```jsx
              href="/communications/templates/email/new"
```

Line 66 — change `href="/whatsapp/templates/new"` to:

```jsx
              href="/communications/templates/whatsapp/new"
```

Line 104 — change `` href={`/email/templates/${t.id}`} `` to:

```jsx
                href={`/communications/templates/email/${t.id}`}
```

- [ ] **Step 3: Repoint the three component links and the history rewrite**

`src/components/WhatsappTemplatesList.jsx` line 116 — change to:

```jsx
                    <Link href={`/communications/templates/whatsapp/${t.id}`} className="text-sm font-medium text-un1t-text hover:underline truncate">{t.name}</Link>
```

`src/components/WhatsappTemplatesList.jsx` line 140 — change to:

```jsx
                      <Link href={`/communications/templates/whatsapp/${t.id}`} className="text-xs text-blue-600 hover:underline">Edit &amp; resubmit</Link>
```

`src/components/WABroadcastEditor.jsx` line 629 — change to:

```jsx
                  <Link href="/communications/templates/whatsapp/new" className="text-sm text-blue-700 hover:underline">
```

`src/components/TemplateEditor.jsx` line 128 — the post-first-save URL rewrite must write the new canonical path:

```js
        window.history.replaceState(null, '', `/communications/templates/email/${result.template.id}`)
```

- [ ] **Step 4: Verify no legacy template URLs remain in live code**

Run: `grep -rn "email/templates\|whatsapp/templates" src/components src/app --include="*.jsx" 2>/dev/null | grep -v "api/" | grep -v communications | grep -v "\.test\."`
Expected: no output. (Comments in `scripts/check-location-scoping.mjs` and the synthetic fixture strings in `tests/location-scoping-check.test.js` mention old paths as historical precedent — leave them.)

- [ ] **Step 5: Run the unit suite and the build**

Run: `npm test`
Expected: PASS — including the two moved IDOR page tests from their new locations, and `comms-back-links.test.jsx` unchanged (both editors' back links already point at `/communications/templates?channel=…`, which is exactly why the fold needs no editor edits).

Run: `npm run build`
Expected: compiles; route list shows the four new `/communications/templates/email|whatsapp/*` routes and no `/email/*` or `/whatsapp/*` page routes.

- [ ] **Step 6: Commit**

```bash
git add -A src/app src/components
git commit -m "PRUNE.1d — fold template editors into /communications/(editors)/templates"
```

---

### Task 5: `legacy-redirects.js` module wired into `next.config.js`

Old URLs live in browser history (the editors' own `replaceState` wrote `/email/templates/<id>` into operators' histories until Task 4) and bookmarks. Config-level redirects replace the deleted stubs without page files. `next.config.js` is CJS (`module.exports`), so the module is root-level CJS; vitest imports CJS fine.

**Files:**
- Create: `src/lib/legacy-redirects.test.js`
- Create: `legacy-redirects.js` (repo root, beside `next.config.js`)
- Modify: `next.config.js` (the `redirects()` block at lines 114-127)

- [ ] **Step 1: Write the failing test**

Create `src/lib/legacy-redirects.test.js`:

```js
// PRUNE.1 — the config-level redirects that replaced the deleted legacy
// stub pages. Invariants: every destination is canonical (a redirect must
// never land on another retired tree, or the chain the stubs were deleted
// to kill comes back), and specific rules precede their prefix wildcard
// (next.config redirects are first-match-wins).
import { describe, it, expect } from 'vitest'
import legacyRedirects from '../../legacy-redirects.js'

const RETIRED_PREFIXES = ['/email', '/whatsapp', '/segments']

describe('legacy-redirects', () => {
  it('has entries and every entry is well-formed', () => {
    expect(legacyRedirects.length).toBeGreaterThan(0)
    for (const r of legacyRedirects) {
      expect(r.source).toMatch(/^\//)
      expect(r.destination).toMatch(/^\//)
      expect(r.permanent).toBe(false)
    }
  })

  it('never redirects into a retired tree (no chains)', () => {
    for (const r of legacyRedirects) {
      const destPath = r.destination.split('?')[0]
      for (const prefix of RETIRED_PREFIXES) {
        expect(destPath === prefix || destPath.startsWith(`${prefix}/`),
          `${r.source} → ${r.destination} lands in retired tree ${prefix}`).toBe(false)
      }
      expect(destPath, `${r.source} → /cars is itself retired`).not.toBe('/cars')
    }
  })

  it('lists specific rules before their prefix wildcard', () => {
    for (const [i, r] of legacyRedirects.entries()) {
      if (!r.source.includes(':path*')) continue
      const prefix = r.source.replace('/:path*', '')
      for (let j = i + 1; j < legacyRedirects.length; j++) {
        expect(legacyRedirects[j].source.startsWith(`${prefix}/`),
          `${legacyRedirects[j].source} is shadowed by earlier wildcard ${r.source}`).toBe(false)
      }
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/legacy-redirects.test.js`
Expected: FAIL — cannot resolve `../../legacy-redirects.js`.

- [ ] **Step 3: Create the redirects module**

Create `legacy-redirects.js` at the repo root:

```js
// PRUNE.1 — config-level redirects replacing the deleted legacy stub
// pages (the /email, /whatsapp, /segments trees and the /cars index).
// 307s on purpose, matching the SIDEBAR-IA.1 convention: the browser URL
// updates to the canonical path so active states light up, and the alias
// stays cheap to re-point as the IA evolves.
//
// Keep this list SHRINKING, never growing sideways: a future route move
// adds entries here ONLY in the same change that deletes the old route
// directory. Order matters — specific rules before the prefix wildcards
// (next.config redirects are first-match-wins).
//
// Coarse mappings are deliberate: /email/campaigns/<id> and friends had
// zero live inbound links at deletion time (2026-08-14 audit), so
// anything still arriving there is stale history — the hub is the right
// landing. The template-editor ids are the exception: TemplateEditor
// wrote /email/templates/<id> into browser histories via replaceState,
// so those map 1:1. (`:id` also matches the literal `new`, which maps to
// the right page anyway.)
module.exports = [
  { source: '/email/templates/:id', destination: '/communications/templates/email/:id', permanent: false },
  { source: '/whatsapp/templates/:id', destination: '/communications/templates/whatsapp/:id', permanent: false },
  { source: '/email/templates', destination: '/communications/templates?channel=email', permanent: false },
  { source: '/whatsapp/templates', destination: '/communications/templates?channel=whatsapp', permanent: false },
  { source: '/whatsapp/inbox', destination: '/communications/inbox', permanent: false },
  { source: '/segments', destination: '/communications/segments', permanent: false },
  { source: '/cars', destination: '/cars/active', permanent: false },
  { source: '/email/:path*', destination: '/communications', permanent: false },
  { source: '/whatsapp/:path*', destination: '/communications', permanent: false },
]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/legacy-redirects.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into `next.config.js`**

At the top of `next.config.js` (before `const nextConfig = {`), add:

```js
const legacyRedirects = require('./legacy-redirects')
```

In the `redirects()` block, append the spread after the last existing entry (the pride-training-club alias):

```js
      { source: '/event/pride-training-club-aug2', destination: '/event/pride-training-club-sep20', permanent: false },
      // PRUNE.1 — aliases for the deleted legacy stub pages.
      ...legacyRedirects,
    ]
  },
```

- [ ] **Step 6: Build to prove the config parses and routes compile**

Run: `npm run build`
Expected: compiles with no config errors.

- [ ] **Step 7: Commit**

```bash
git add legacy-redirects.js src/lib/legacy-redirects.test.js next.config.js
git commit -m "PRUNE.1e — config-level legacy redirects replace the deleted stubs"
```

---

### Task 6: Full verification, CHANGELOG, hand-off

**Files:**
- Modify: `docs/CHANGELOG.md` (prepend entry)

- [ ] **Step 1: Run the full local CI mirror**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails
```
Expected: all green. Notes if not:
- `check:mobile-parity` compares sidebar permission keys against mobile tabs — no permission keys changed here, only one href, so a failure means an unintended nav edit.
- `check:route-guards` / `check:location-scoping` re-scan the moved editor pages at their new paths — they moved verbatim with their `assertLocationAccess(...) → notFound()` guards, so a failure means a move dropped content.

- [ ] **Step 2: Run the production build (required by CLAUDE.md for any route change)**

Run: `npm run build`
Expected: exit 0. Route list contains no `/email/*`, `/whatsapp/*`, or `/segments` pages, no `/cars` index, and the four new editor routes under `/communications/templates/`.

- [ ] **Step 3: Prepend the CHANGELOG entry**

Prepend to `docs/CHANGELOG.md` (following the house style — coded id, dense rationale):

```markdown
- PRUNE.1 — phase 1 of the platform consolidation (spec: docs/superpowers/specs/2026-08-14-platform-consolidation-design.md): all 27 redirect-only legacy pages deleted (/email, /whatsapp, /segments trees; /cars, /cars/new, /cars/pending indexes; /contacts/duplicates; the /communications stub set — broadcasts, campaigns, instagram, sequences×3, sms/broadcasts×3), and the 4 still-live template editors folded into the canonical tree at /communications/templates/email|whatsapp/{new,[id]}. /communications split into route groups so the editors share the layout's permission gate without inheriting the hub chrome: root layout.js is now gate-only, (hub)/layout.js carries CommsShell + tabs (COMMSLAYOUT.3 segments gate preserved verbatim), (editors)/ hosts the full-screen editors. Every live inbound link repointed to skip the deleted hop (sidebar /cars → /cars/active; contact drawer + StartWhatsAppButton → /communications/inbox; WAInbox back arrow → /communications; WATemplateEditor post-save → /communications/templates?channel=whatsapp; TemplateEditor's replaceState now writes the canonical editor URL). URL back-compat moved from filesystem stubs to next.config redirects via a new root legacy-redirects.js (unit-tested: no chains into retired trees, specific-before-wildcard; 307s matching the SIDEBAR-IA.1 convention). Tests: legacy-detail-redirects.test.js retired with the stubs it pinned; the K5 anti-vacuity guard now proves isRedirectStub() against src/lib/__fixtures__/redirect-stub-page.js — the old /cars stub moved verbatim, so the guard can never go blind for lack of a real stub. The two moved IDOR page tests (TPL-IDOR.1) travel with their pages unchanged.
```

- [ ] **Step 4: Commit and push**

```bash
git add docs/CHANGELOG.md
git commit -m "PRUNE.1 — changelog"
git push -u origin prune-legacy-stubs
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create --title "PRUNE.1 — delete 27 legacy redirect stubs, fold template editors into /communications" --body "Phase 1 of the platform consolidation ([spec](docs/superpowers/specs/2026-08-14-platform-consolidation-design.md) §3.2.1). Deletes every redirect-only page, folds the 4 live template editors into /communications/(editors)/templates, splits the communications layout into gate + (hub) chrome route groups, and replaces stub-based URL back-compat with config-level redirects (new root legacy-redirects.js, unit-tested).

- 27 stubs deleted; K5 anti-vacuity guard keeps a committed fixture (the old /cars stub, moved verbatim)
- 8 live link sites repointed to canonical URLs (no behaviour change — each skipped a redirect hop)
- Editors moved verbatim with their TPL-IDOR.1 tests; back-link contract test passes unchanged
- Full CI mirror + next build green

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Manual QA after Vercel preview deploys (GET-only against the preview, per local-dev rules): visit `/communications/templates`, open an email template and a WhatsApp template (full-screen editors, no hub chrome, back arrow returns to the filtered list), create-new for both channels, and confirm `/whatsapp/inbox`, `/email/templates`, `/segments`, `/cars` all 307 to their canonical homes.
