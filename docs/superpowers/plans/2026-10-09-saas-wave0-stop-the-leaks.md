# SaaS Wave 0 — Stop the leaks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every verified cross-tenant leak in un1t-crm so a second gym can be given staff and customers on the shared host without seeing, or being seen by, another tenant.

**Architecture:** Fourteen small, independent PRs against `origin/main`, each a scoping change plus a test, two forward-only migrations applied via the Supabase MCP, and one coordinated kiosk cut-over in un1t-pi. Every change follows the existing invariant: service-role routes scope in app code, the org boundary is `locations.organization_id`, detail routes answer 404 not 403. Decisions were taken by Richard on 2026-10-09 (see `docs/SAAS_READINESS_REVIEW_2026-10-09.md` §3 and the memory note `saas-readiness-review-2026-10-09`).

**Tech Stack:** Next.js 16 App Router (JS), Supabase (service-role client, RLS browser-only), Zod, Vitest (4 CI shards), PostgREST query builders, Vercel env, un1t-pi (Node on Pi over Tailscale).

**Decisions already made (do not reopen):**
- Legacy `CRM_API_KEY` → scoped to UN1T Group (`f117b7b8-5f56-4f80-8299-2c698242e4d2`) via env `CRM_API_KEY_ORG_ID`; Richard mints a per-org `unitk_` key for n8n later and we unset the env.
- Contact email uniqueness → one contact per person per ORGANISATION (`contacts.organization_id`, trigger-maintained).
- Events `shared` → visible within the owning organisation only; any manager may still set it.
- `/offers` → pinned to Stillorgan (`locations.slug = 'un1t-stillorgan'`) until Wave 2.
- Policies → `organization_id`, the three existing rows go to UN1T Group, master still edits.
- Live board location-keyed routes → remove, after the four kiosks are moved to the token URL.
- Delivery → the executor opens, self-reviews, gates on CI and merges each PR, and applies migrations via the Supabase MCP (project `iyvtbjjxdggiadzwwvdj`). A decision card only for a visible behaviour change not covered above.

## Status — Wave 0 delivered 9–10 Oct 2026

All fourteen tasks shipped as planned (PR titles verified against GitHub on 10 Oct). The plan text below is kept as written; migration numbers in the task bodies were provisional and landed as noted here. Two items stay with Richard: the n8n `unitk_` key swap (then unset `CRM_API_KEY*`) and the Strava push-subscription recreate.

| Task | PR | State | Note |
|---|---|---|---|
| W0.1 legacy key | #1957 | Merged | `CRM_API_KEY_ORG_ID` set; Richard to mint the n8n `unitk_` key then unset both envs |
| W0.2 WA + mail inbound org match | #1956 | Merged | also the coexistence ingest |
| W0.3 shared events | #1962 | Merged | |
| W0.4 offers pinned | #1958 | Merged | until Wave 2 |
| W0.5 policies per org | #1960 | Merged | landed as **mig 713** (plan said 710); 3 rows → UN1T Group |
| W0.6 contacts per-org uniqueness | #1961 | Merged | landed as **mig 712** (plan said 711); `nulls not distinct` |
| W0.7 coverage report per org | #1964 | Merged | env `RECEIPT_COVERAGE_REPORT_TO` retired |
| W0.8 notifications page | #1963 | Merged | |
| W0.9a token challenges + heartbeat | #1969 | Merged | |
| W0.9b kiosks on token URL | un1t-pi #2 | Merged | per-kiosk `tv-token-<device>` secret, `pi kiosk-refresh`; stillorgan-tv1 cut over (heartbeat advancing 10 Oct 02:11 UTC), stillorgan-tv2 offline (SD card, `pi prepare`), hatch-tv1/tv2 not provisioned |
| W0.9c remove location-keyed routes | #1973 | Merged | removal shipped ahead of the hatch kiosks (decision: they are not yet provisioned, so nothing to break); staff `/live/[locationId]` lost its "TV display" button, restore later |
| W0.10 Strava | #1970 | Merged | Richard to recreate the push subscription on `/api/webhooks/strava/<token>` |
| W0.11 templates NULL guard | #1965 | Merged | |
| W0.12 automation device ids | #1966 | Merged | |
| W0.13 WA alert fan-out | #1967 | Merged | |
| W0.14 Instagram lookup error | #1968 | Merged | |

---

## PR ritual (every task ends with this)

Repo conventions: fresh worktree per task (never share one), one changelog file per PR, CI = `Test & lint` + `Next build` required checks, 4 vitest shards (~5 min). Never `git stash` in a worktree. `[id]`/`[slug]` paths need single quotes in zsh.

```bash
# 1. Fresh worktree from main
cd /Users/richardivers/code/un1t-crm && git fetch origin main -q
git worktree add -q /Users/richardivers/code/un1t-crm-w0-<slug> -b w0-<slug> origin/main
cd /Users/richardivers/code/un1t-crm-w0-<slug> && npm ci --silent
# 2. ... task steps ...
# 3. Gates that run locally in seconds
npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns && npm run check:guardrails
npx vitest run <changed test files> tests/changelog-entries.test.js
# 4. PR
git push -u origin w0-<slug>
gh pr create --title "W0.<n> <TITLE>" --body-file .pr-body.md   # body ends with "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
# 5. Changelog entry AFTER the PR number exists
printf '| #%s | W0.<n> — <title> | %s. <what and why> |\n' "$PR" "$(date +%F)" > docs/changelog/entries/$PR.md
git add docs/changelog/entries/$PR.md && git commit -m "W0.<n> — changelog entry" && git push
# 6. Wait for CI, self-review the diff once more, merge
gh pr checks $PR --watch && gh pr merge $PR --squash --delete-branch
# 7. Remove the worktree
cd /Users/richardivers/code/un1t-crm && git worktree remove /Users/richardivers/code/un1t-crm-w0-<slug>
```

Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File structure (what changes where)

| Task | Files |
|---|---|
| W0.1 legacy key | `src/lib/api-auth.js`, `src/lib/api-auth.test.js`, `tests/cross-tenant/api-key-routes.test.js`, Vercel env `CRM_API_KEY_ORG_ID` |
| W0.2 WA + mail inbound org match | new `src/lib/inbound-contact-match.js` (+test), `src/app/api/webhooks/whatsapp/route.js`, `src/app/api/webhooks/postmark-inbound/[token]/route.js` |
| W0.3 shared events | new `src/lib/event-visibility.js` (+test), `src/app/api/events/route.js`, `src/app/(members)/events/page.js`, `src/app/welcome/[location]/events/page.js` |
| W0.4 offers pinned | new `src/lib/offers-home.js` (+test), `src/app/offers/page.js`, `src/app/offers/[slug]/page.js`, `src/app/api/public/offers/[slug]/checkout/route.js` |
| W0.5 policies per org | mig `710_policies_organization.sql`, `src/lib/policies.js` (+test), `src/app/(team)/policies/manage/page.js`, `src/app/(team)/policies/manage/[slug]/page.js`, `src/app/(team)/policies/manage/[slug]/versions/[versionNumber]/page.js`, `src/app/api/admin/policies/[slug]/versions/route.js`, `src/app/api/policies/[slug]/views/route.js` |
| W0.6 contacts per-org uniqueness | mig `711_contacts_organization_email_unique.sql`, `src/lib/race-contact-linking.js` (+test), `src/app/api/contacts/route.js`, `tests/audience-view-columns-guard.test.js` (passes untouched once the view carries the column) |
| W0.7 coverage report per org | `src/lib/recon/finalize.js`, `src/lib/recon/report-email.js` (+tests), one-time `org_settings.ops_alert_emails` data step |
| W0.8 notifications page | `src/app/settings/notifications/page.js` |
| W0.9 live board token cut-over | `src/app/api/public/tv-live/[token]/route.js`, new `src/app/api/public/tv-challenges/[token]/route.js`, new `src/app/tv/live/[token]/challenges/page.jsx`, un1t-pi `src/roles/kiosk.js`, then removal of `src/app/tv/[locationId]/**`, `src/app/api/public/live/[locationId]`, `src/app/api/public/challenges/[locationId]`, `src/proxy.js` allowlist |
| W0.10 Strava | move `src/app/api/webhooks/strava/route.js` → `src/app/api/webhooks/strava/[token]/route.js`, Vercel env `STRAVA_WEBHOOK_URL_TOKEN`, Richard recreates the Strava push subscription |
| W0.11 templates NULL guard | `src/app/api/templates/[id]/route.js` (+test) |
| W0.12 automation device ids | `src/app/api/automations/[key]/route.js` (+test) |
| W0.13 WA alert fan-out | `src/lib/whatsapp-flow-events.js`, `src/lib/whatsapp-number-events.js` (+tests) |
| W0.14 Instagram lookup error | `src/lib/agent/channels.js`, `src/app/api/webhooks/instagram/route.js` (+test) |

---

### Task W0.1: Scope the legacy shared API key to one organisation

**Status:** done — #1957 (merged).

**Files:**
- Modify: `src/lib/api-auth.js:170-178` (requireApiKeyOrManager) and `:232-236` (authenticateApiKey)
- Modify: `src/lib/api-auth.test.js:41-44,80-84,153,181,207`
- Modify: `tests/cross-tenant/api-key-routes.test.js` (the "legacy shared key sees everything" pins)
- Vercel: env `CRM_API_KEY_ORG_ID` = `f117b7b8-5f56-4f80-8299-2c698242e4d2` (production + preview) BEFORE merge

- [ ] **Step 1: Write the failing tests** — replace the three legacy expectations in `src/lib/api-auth.test.js`:

```js
// in beforeEach, after vi.stubEnv('CRM_API_KEY', GLOBAL_KEY):
vi.stubEnv('CRM_API_KEY_ORG_ID', 'org-1')

it('legacy shared CRM_API_KEY → ok, scoped to CRM_API_KEY_ORG_ID (W0.1)', async () => {
  const auth = await authenticateApiKey(req(GLOBAL_KEY))
  expect(auth).toEqual({ ok: true, orgId: 'org-1', legacy: true })
})

it('legacy shared key with CRM_API_KEY_ORG_ID unset → 401 (fail closed)', async () => {
  vi.stubEnv('CRM_API_KEY_ORG_ID', '')
  const auth = await authenticateApiKey(req(GLOBAL_KEY))
  expect(auth.ok).toBe(false)
  expect(auth.response.status).toBe(401)
})

// requireApiKeyOrManager block:
it('legacy shared key → ok, scoped to CRM_API_KEY_ORG_ID', async () => {
  const auth = await requireApiKeyOrManager(req(GLOBAL_KEY))
  expect(auth).toEqual({ ok: true, user: null, orgId: 'org-1' })
  expect(getCurrentUser).not.toHaveBeenCalled()
})
```

Keep the three "no-op when orgId is falsy" helper tests as they are: cookie callers still pass `null`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/api-auth.test.js`
Expected: the two new legacy specs FAIL (`orgId: null` received).

- [ ] **Step 3: Implement** in `src/lib/api-auth.js`:

```js
// W0.1 — the legacy shared key is no longer unscoped. It acts as a per-org
// key for ONE organisation named by CRM_API_KEY_ORG_ID (UN1T Group in prod).
// No org id configured → the legacy key is refused outright (fail closed):
// an unscoped integration key is the SaaS leak this closes. Retire both env
// vars once n8n holds a unitk_ key.
function legacyKeyOrgId() {
  const id = (process.env.CRM_API_KEY_ORG_ID || '').trim()
  return id || null
}

// authenticateApiKey — replace the legacy block:
  const expected = process.env.CRM_API_KEY
  if (expected && safeEqual(token, expected)) {
    const orgId = legacyKeyOrgId()
    if (!orgId) return unauthorized()
    return { ok: true, orgId, legacy: true }
  }

// requireApiKeyOrManager — replace the legacy block:
  if (expected && token && safeEqual(token, expected)) {
    const orgId = legacyKeyOrgId()
    if (!orgId) {
      return { ok: false, response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
    }
    return { ok: true, user: null, orgId }
  }
```

Update the file header comment (lines 210-214) to describe the new semantics.

- [ ] **Step 4: Run** `npx vitest run src/lib/api-auth.test.js` → PASS.

- [ ] **Step 5: Flip the cross-tenant harness pins.** In `tests/cross-tenant/api-key-routes.test.js` find every assertion that the legacy key "sees everything" / "unscoped BY DESIGN" (grep `legacy`). Stub `CRM_API_KEY_ORG_ID` to the fixture's org A id in its `beforeEach` and change those expectations to: legacy key behaves exactly like org A's key (sees org A's rows only; cross-tenant detail → 404; create into org B → 403). Update the file header comment. Run: `npx vitest run tests/cross-tenant` → PASS.

- [ ] **Step 6: Set the Vercel env BEFORE merging.** Using the Vercel MCP `create_project_env` on project `prj_s4VsBp3O6MWs4kR5uYzdRTkc5bsr` (team `team_FgMwIJ8BU0fvTV5UsGStVJlq`): key `CRM_API_KEY_ORG_ID`, value `f117b7b8-5f56-4f80-8299-2c698242e4d2`, targets `production` and `preview`, type plain. Verify with `filter_project_envs`.

- [ ] **Step 7: Docs** — add one line to `CLAUDE.md` Invariants (Data access): "The legacy `CRM_API_KEY` is scoped to `CRM_API_KEY_ORG_ID`; unset org id = key refused." Then the PR ritual. Changelog: `W0.1 — legacy CRM_API_KEY scoped to one organisation`.

- [ ] **Step 8: Tell Richard** (in the PR body and the session summary): mint a per-org key for UN1T Group at `/settings/api-keys` (master, active studio in UN1T Group), paste it into n8n's three workflows, then we remove `CRM_API_KEY` and `CRM_API_KEY_ORG_ID` in a follow-up.

---

### Task W0.2: Inbound WhatsApp and mail match contacts inside the receiving organisation only

**Status:** done — #1956 (merged).

**Files:**
- Create: `src/lib/inbound-contact-match.js`, `src/lib/inbound-contact-match.test.js`
- Modify: `src/app/api/webhooks/whatsapp/route.js:233-241`
- Modify: `src/app/api/webhooks/postmark-inbound/[token]/route.js:891-900`

- [ ] **Step 1: Write the failing test** `src/lib/inbound-contact-match.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'
import { orgLocationIdsFor } from './inbound-contact-match'

vi.mock('./sibling-locations', () => ({
  siblingLocationIds: vi.fn(async (_db, locationId) =>
    locationId === 'loc-a1' ? { ids: ['loc-a2'], error: null } : { ids: [], error: { message: 'boom' } }),
}))

describe('orgLocationIdsFor (W0.2)', () => {
  it('returns the receiving location plus its organisation siblings', async () => {
    expect(await orgLocationIdsFor({}, 'loc-a1')).toEqual(['loc-a1', 'loc-a2'])
  })
  it('narrows to the receiving location alone when the sibling lookup fails', async () => {
    expect(await orgLocationIdsFor({}, 'loc-b1')).toEqual(['loc-b1'])
  })
  it('an empty location id yields no scope at all (callers must then match nothing)', async () => {
    expect(await orgLocationIdsFor({}, null)).toEqual([])
  })
})
```

- [ ] **Step 2: Run** `npx vitest run src/lib/inbound-contact-match.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement** `src/lib/inbound-contact-match.js`:

```js
// W0.2 — the ORGANISATION scope for matching an inbound sender (WhatsApp
// phone, mail From) to an existing contact. Before this, both webhooks
// matched across the whole estate with a location *preference*, so a person
// who was already a contact at tenant A and wrote to tenant B's number or
// mailbox was linked to A's row — and the WhatsApp thread was then FILED at
// A. Never wider than the receiving location's organisation; on a sibling
// lookup error, narrow to the receiving location (fail safe, never open).
import { siblingLocationIds } from './sibling-locations'

/**
 * @param {object} db service-role client
 * @param {string|null} receivingLocationId the location owning the number / mailbox
 * @returns {Promise<string[]>} location ids a contact match may come from
 */
export async function orgLocationIdsFor(db, receivingLocationId) {
  if (!receivingLocationId) return []
  const { ids } = await siblingLocationIds(db, receivingLocationId)
  return [receivingLocationId, ...ids]
}
```

- [ ] **Step 4: Run** the test → PASS.

- [ ] **Step 5: Apply in the WhatsApp webhook.** In `src/app/api/webhooks/whatsapp/route.js` add `import { orgLocationIdsFor } from '@/lib/inbound-contact-match'` and change the contact query (lines ~233-241):

```js
  // W0.2 — ORG-scoped: a match may come from the receiving number's
  // organisation only (its own location first, siblings second — the
  // pickInboundContact preference is unchanged). Never another tenant's row.
  const orgLocIds = await orgLocationIdsFor(db, defaultLocationId)
  let contact = null
  const { data: existingContacts } = await db.from('contacts')
    .select('id, location_id')
    .in('location_id', orgLocIds.length ? orgLocIds : ['00000000-0000-0000-0000-000000000000'])
    .or(`wa_phone.eq.${phoneWithout},wa_phone.eq.${phoneWithPlus},phone.eq.${phoneWithout},phone.eq.${phoneWithPlus}`)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(20)
```

Update the comment block above it (COMMS-AUDIT 2026-07-10 paragraph) to say "within the receiving number's organisation". The thread-filing block (lines ~284-293) needs no change: the contact's location is now always in-org.

- [ ] **Step 6: Apply in the mail webhook.** In `src/app/api/webhooks/postmark-inbound/[token]/route.js`, same import, and change the From-address lookup:

```js
  const orgLocIds = await orgLocationIdsFor(db, locationId)
  const { data: contacts, error: cErr } = await db.from('contacts')
    .select('id, location_id, created_at')
    .in('location_id', orgLocIds.length ? orgLocIds : ['00000000-0000-0000-0000-000000000000'])
    .ilike('email', escapeLikePattern(fromEmail))
    .limit(50)
```

Amend the comment "(b) From address → contacts" to say the match is organisation-scoped.

- [ ] **Step 7: Run the webhook suites** `npx vitest run src/app/api/webhooks/whatsapp src/app/api/webhooks/postmark-inbound src/lib/email-inbox.test.js` → PASS (the reply-number test mocks `pickInboundContact`; if its fake db lacks `.in`, add `in: () => builder` to that test's builder stub).

- [ ] **Step 8:** `npm run check:location-scoping` → both routes still classified scoped. PR ritual. Changelog: `W0.2 — inbound WhatsApp and mail match contacts inside the receiving organisation only`.

---

### Task W0.3: "Shared" events are shared within the owning organisation only

**Status:** done — #1962 (merged).

**Files:**
- Create: `src/lib/event-visibility.js`, `src/lib/event-visibility.test.js`
- Modify: `src/app/api/events/route.js:156`, `src/app/(members)/events/page.js:68`, `src/app/welcome/[location]/events/page.js:94`

- [ ] **Step 1: Failing test** `src/lib/event-visibility.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { sharedEventsOrFilter } from './event-visibility'

describe('sharedEventsOrFilter (W0.3)', () => {
  it('own location OR shared events owned by a sibling of the same organisation', () => {
    expect(sharedEventsOrFilter('loc-a1', ['loc-a1', 'loc-a2']))
      .toBe('location_id.eq.loc-a1,and(shared.eq.true,location_id.in.(loc-a1,loc-a2))')
  })
  it('a location with no known organisation sees its own events only', () => {
    expect(sharedEventsOrFilter('loc-x', [])).toBe('location_id.eq.loc-x')
  })
})
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `src/lib/event-visibility.js`:

```js
// W0.3 — `race_events.shared` used to mean "visible on EVERY tenant's staff
// list and public events page". It now means "visible across the owning
// organisation": a Hatch event flagged shared still shows at Stillorgan;
// another gym never sees it. The PostgREST .or() string is built here so the
// three listings cannot drift.
import { orgLocationIdsFor } from './inbound-contact-match'

/** Pure. @param {string} locationId @param {string[]} orgLocationIds (includes locationId) */
export function sharedEventsOrFilter(locationId, orgLocationIds) {
  const own = `location_id.eq.${locationId}`
  if (!Array.isArray(orgLocationIds) || orgLocationIds.length === 0) return own
  return `${own},and(shared.eq.true,location_id.in.(${orgLocationIds.join(',')}))`
}

/** Async: resolve the org scope then build the filter. Narrows to own location on error. */
export async function sharedEventsOrFilterFor(db, locationId) {
  const ids = await orgLocationIdsFor(db, locationId)
  return sharedEventsOrFilter(locationId, ids)
}
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Apply at the three listings.** Each currently has `.or(\`location_id.eq.${X},shared.eq.true\`)`. Replace with:

```js
// src/app/api/events/route.js (after `const db = createServerClient()`)
const orFilter = await sharedEventsOrFilterFor(db, activeLocationId)
// ... .or(orFilter)

// src/app/(members)/events/page.js — same, using activeLocationId
// src/app/welcome/[location]/events/page.js — same, using locationId
```

with `import { sharedEventsOrFilterFor } from '@/lib/event-visibility'` in each. Update each site's comment ("surfaced everywhere" → "across the owning organisation").

- [ ] **Step 6: Run** `npx vitest run src/app/api/events src/lib/event-visibility.test.js` and `npm run check:location-scoping` → PASS. PR ritual. Changelog: `W0.3 — shared events are shared within the owning organisation only`.

---

### Task W0.4: Pin the public /offers surface to Stillorgan

**Status:** done — #1958 (merged).

**Files:**
- Create: `src/lib/offers-home.js`, `src/lib/offers-home.test.js`
- Modify: `src/app/offers/page.js:115-121`, `src/app/offers/[slug]/page.js:51-52`, `src/app/api/public/offers/[slug]/checkout/route.js:36-37`

- [ ] **Step 1: Failing test** `src/lib/offers-home.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { OFFERS_HOME_LOCATION_SLUG, offerBelongsToHome } from './offers-home'

describe('offers home (W0.4)', () => {
  it('the public offers surface is pinned to the Stillorgan studio', () => {
    expect(OFFERS_HOME_LOCATION_SLUG).toBe('un1t-stillorgan')
  })
  it('an offer from any other location is treated as not found', () => {
    expect(offerBelongsToHome({ location_id: 'home' }, 'home')).toBe(true)
    expect(offerBelongsToHome({ location_id: 'other' }, 'home')).toBe(false)
    expect(offerBelongsToHome({ location_id: 'home' }, null)).toBe(false)
  })
})
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `src/lib/offers-home.js`:

```js
// W0.4 — /offers, /offers/[slug] and the offer checkout are ONE public
// surface that used to list every active sale_offers row across all
// tenants under a "UN1T STILLORGAN" header, and always charged the
// platform Revolut merchant. Until Wave 2 gives each tenant its own offers
// route and payment rail, the surface is pinned to Stillorgan: other
// locations' offers are not listed and their slugs answer 404.
export const OFFERS_HOME_LOCATION_SLUG = 'un1t-stillorgan'

/** Pure. */
export function offerBelongsToHome(offer, homeLocationId) {
  return Boolean(homeLocationId && offer?.location_id === homeLocationId)
}

/** The pinned location's id, or null when the row is missing (page then renders empty / 404). */
export async function resolveOffersHomeLocationId(db) {
  const { data } = await db.from('locations').select('id').eq('slug', OFFERS_HOME_LOCATION_SLUG).maybeSingle()
  return data?.id || null
}
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Apply.** `src/app/offers/page.js`: before the query, `const homeId = await resolveOffersHomeLocationId(db)`; add `.eq('location_id', homeId || '00000000-0000-0000-0000-000000000000')` to the `sale_offers` select. `src/app/offers/[slug]/page.js:51-52`: after the lookup, `const homeId = await resolveOffersHomeLocationId(db); if (!offer || !offerBelongsToHome(offer, homeId)) notFound()`. Checkout route `:36-37`: same check returning the existing 404 JSON. Imports from `@/lib/offers-home` in all three.

- [ ] **Step 6:** `npx vitest run src/lib/offers-home.test.js src/app/api/public/offers` and `npm run check:location-scoping` (the page now carries a location filter; if the tripwire previously exempted `src/app/offers/page.js` for `sale_offers`, delete that EXEMPT entry). PR ritual. Changelog: `W0.4 — public offers surface pinned to Stillorgan until tenant offers ship`.

---

### Task W0.5: Policies belong to an organisation

**Status:** done — #1960 (merged, mig 713).

**Files:**
- Create: `supabase/migrations/710_policies_organization.sql`
- Modify: `src/lib/policies.js:34-60,103-118`, `src/lib/policies.test.js`
- Modify: `src/app/(team)/policies/manage/page.js:37`, `src/app/(team)/policies/manage/[slug]/page.js:38`, `src/app/(team)/policies/manage/[slug]/versions/[versionNumber]/page.js:55`, `src/app/api/admin/policies/[slug]/versions/route.js:48`, `src/app/api/policies/[slug]/views/route.js:39`

- [ ] **Step 1: Migration** `supabase/migrations/710_policies_organization.sql`:

```sql
-- 710 — W0.5: policies belong to an ORGANISATION.
--
-- WHY. policies / policy_versions had no tenant column: every signed-in
-- user on the platform was shown UN1T's employee handbook, acceptable-use
-- policy and staff privacy notice (mig 178 seed), and could not replace
-- them. The SaaS review of 2026-10-09 listed this as a blocker.
--
-- WHAT. organization_id on policies, backfilled to UN1T Group (the only
-- org that ever authored policies), then NOT NULL. slug uniqueness becomes
-- per organisation so each tenant can own an 'employee-handbook'. The
-- authenticated SELECT policy is narrowed to the caller's organisations
-- (private.auth_is_in_organization, mig 079) or master. Service-role code
-- (src/lib/policies.js) filters the same way. Safe before the code deploys:
-- old code reads all rows exactly as before.

alter table public.policies
  add column if not exists organization_id uuid references public.organizations(id);

update public.policies
   set organization_id = 'f117b7b8-5f56-4f80-8299-2c698242e4d2'
 where organization_id is null;

alter table public.policies alter column organization_id set not null;

alter table public.policies drop constraint if exists policies_slug_key;
create unique index if not exists policies_org_slug_key
  on public.policies (organization_id, slug);
create index if not exists policies_org_active_idx
  on public.policies (organization_id, active, display_order, title) where active = true;

comment on column public.policies.organization_id is
  'W0.5 (mig 710) — owning organisation. Staff see only their organisations'' policies.';

-- RLS (live names verified 2026-10-09: policies_read_all / policy_versions_read_all
-- are `for select to authenticated using (true)`; helpers
-- private.auth_is_in_organization(org_id uuid) and private.auth_is_master() exist).
-- Browser reads are rare — the lib uses the service role — but the deny must
-- exist at the DB too.
drop policy if exists policies_read_all on public.policies;
create policy policies_read_in_org on public.policies
  for select to authenticated
  using (private.auth_is_master() or private.auth_is_in_organization(organization_id));

drop policy if exists policy_versions_read_all on public.policy_versions;
create policy policy_versions_read_in_org on public.policy_versions
  for select to authenticated
  using (exists (
    select 1 from public.policies p
     where p.id = policy_versions.policy_id
       and (private.auth_is_master() or private.auth_is_in_organization(p.organization_id))));
```

Policy and helper names above were verified against the live database on 2026-10-09.

- [ ] **Step 2: Failing test** — add to `src/lib/policies.test.js` (follow its existing fake-db style):

```js
it('W0.5 — lists only the active organisation\'s policies, none without an organisation', async () => {
  const user = { id: 'u1', activeOrganization: { id: 'org-a' } }
  await listPoliciesWithStatus(user)
  expect(fromCalls('policies')[0].filters).toContainEqual(['eq', 'organization_id', 'org-a'])
  expect(await listPoliciesWithStatus({ id: 'u1' })).toEqual([])
})
```

(Adapt `fromCalls` to however that test file inspects the fake builder; the assertion is that `.eq('organization_id', 'org-a')` is applied and that a user with no org gets `[]`.)

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** in `src/lib/policies.js`:

```js
/** W0.5 — the organisation whose policies this user reads. null = none. */
export function policyOrgIdFor(user) {
  return user?.activeOrganization?.id || user?.activeLocation?.organization_id || null
}

// listPoliciesWithStatus: after `if (!user?.id) return []`
  const orgId = policyOrgIdFor(user)
  if (!orgId) return []
  // ... .from('policies') ... .eq('active', true).eq('organization_id', orgId)

// getPolicyBySlug(slug, user): same guard + .eq('organization_id', orgId)
```

- [ ] **Step 5: Apply the org filter to the five remaining `from('policies')` readers** (manage pages and the two routes): each already has `user`; add `.eq('organization_id', policyOrgIdFor(user))` to the policies lookup and 404/empty when `policyOrgIdFor(user)` is null. Masters keep their active org's view (they switch studio to switch org).

- [ ] **Step 6: Run** `npx vitest run src/lib/policies src/app/\(team\)/policies src/app/api/policies src/app/api/admin/policies` and `npm run check:location-scoping` → PASS.

- [ ] **Step 7: Apply the migration** via Supabase MCP `apply_migration` (name `710_policies_organization`) BEFORE merging the PR (old code tolerates the new column). Verify: `select slug, organization_id from policies` shows three rows under UN1T Group. PR ritual. Changelog: `W0.5 — policies are per organisation; UN1T's handbook no longer shown to other tenants`.

---

### Task W0.6: One contact per person per organisation

**Status:** done — #1961 (merged, mig 712).

**Files:**
- Create: `supabase/migrations/711_contacts_organization_email_unique.sql`
- Modify: `src/lib/race-contact-linking.js:121-133,163-171`, `src/lib/race-contact-linking.test.js`
- Modify: `src/app/api/contacts/route.js:101-102`
- Verify: `tests/audience-view-columns-guard.test.js` passes with the appended view column

- [ ] **Step 1: Migration** `supabase/migrations/711_contacts_organization_email_unique.sql`:

```sql
-- 711 — W0.6: contact email is unique per ORGANISATION, not platform-wide.
--
-- WHY. mig 008's contacts_email_unique (email) WHERE email IS NOT NULL was
-- global: a second gym could not hold a contact whose email existed at
-- another tenant, public forms silently dropped that person (restrictToOrg
-- refuses cross-org links), and POST /api/contacts echoed the raw unique
-- violation — an existence oracle across tenants.
--
-- WHAT. (1) contacts.organization_id, trigger-maintained from the row's
-- location (locations.organization_id, NOT NULL since mig 079), backfilled.
-- (2) the unique index becomes (organization_id, email). (3) the audience
-- send-path view gains the column (mig 689 rule: a new contacts column
-- must reach contact_location_audience, appended at the END). (4) the
-- public booking trigger (mig 336) matches an existing contact across the
-- booking's ORGANISATION, so a sibling-studio contact never collides on
-- insert. Safe before the code deploys.

alter table public.contacts
  add column if not exists organization_id uuid references public.organizations(id);

create or replace function private.contacts_set_organization_id()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.location_id is null then
    new.organization_id := null;
  else
    select organization_id into new.organization_id from public.locations where id = new.location_id;
  end if;
  return new;
end $$;

drop trigger if exists contacts_set_organization_id on public.contacts;
create trigger contacts_set_organization_id
  before insert or update of location_id on public.contacts
  for each row execute function private.contacts_set_organization_id();

update public.contacts c
   set organization_id = l.organization_id
  from public.locations l
 where l.id = c.location_id and c.organization_id is distinct from l.organization_id;

create index if not exists contacts_organization_id_idx on public.contacts (organization_id);

drop index if exists public.contacts_email_unique;
create unique index if not exists contacts_email_org_unique
  on public.contacts (organization_id, email) where email is not null;

comment on column public.contacts.organization_id is
  'W0.6 (mig 711) — denormalised from locations.organization_id by trigger; never written by app code.';
```

Then append the view and the booking trigger in the same file:

- Copy the `CREATE OR REPLACE VIEW public.contact_location_audience ...` statement from `supabase/migrations/705_contacts_visit_origin.sql` lines 32–66 verbatim, change the last column line `c.visit_referrer, c.visit_landing_path, c.visit_captured_at` to `c.visit_referrer, c.visit_landing_path, c.visit_captured_at, c.organization_id`, then restate `REVOKE ALL ON public.contact_location_audience FROM anon, authenticated, PUBLIC;` and copy the `DO $$ ... security_invoker self-check ... $$;` block from mig 705 lines 72–85, replacing "mig 705" with "mig 711" in its message.
- Copy the booking trigger function from `supabase/migrations/336_*.sql` (the whole `CREATE OR REPLACE FUNCTION ... handle_new_booking` body) and change the match to:

```sql
  SELECT c.id INTO v_contact_id
  FROM contacts c
  LEFT JOIN locations l ON l.id = c.location_id
  WHERE lower(c.email) = lower(NEW.customer_email)
    AND (c.location_id = v_location_id
         OR c.location_id IS NULL
         OR l.organization_id = (SELECT organization_id FROM locations WHERE id = v_location_id))
  ORDER BY (c.location_id = v_location_id) DESC, c.created_at ASC
  LIMIT 1;
```

- [ ] **Step 2: Failing tests** in `src/lib/race-contact-linking.test.js`: the spec around line 99 that pins the global fallback (no `restrictToOrg` → `.ilike` anywhere) must now expect an ORG-scoped lookup; add:

```js
it('W0.6 — without restrictToOrg the lookup still never leaves the organisation', async () => {
  await findOrCreateRaceContact({ db, locationId: 'loc-a1', email: 'x@example.com' })
  expect(db.contactsQueries.some((q) => q.scope === 'anywhere')).toBe(false)
})
```

(adapt to the file's fake-db recorder) and update the 23505 message in the existing fixture to `"contacts_email_org_unique"`.

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** in `src/lib/race-contact-linking.js`: delete the `else if (!restrictToLocation)` global branch (lines ~127-133) and make the org lookup the default:

```js
    if (!restrictToLocation) {
      // W0.6 — org-wide is the WIDEST any caller may resolve, public or
      // staff: contacts_email_org_unique (mig 711) is per organisation, so
      // a match outside it is another tenant's person, never this one.
      const sibling = await findContactInOrg(db, locationId, normalised)
      if (sibling) return sibling
    }
```

and extend the 23505 handler so it applies to every caller (drop the `&& restrictToOrg` condition at line ~167). Update the JSDoc: `restrictToOrg` is now the default and kept only for call-site readability.

- [ ] **Step 5:** `src/app/api/contacts/route.js:101-102`:

```js
  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ success: false, error: 'A contact with this email already exists in your organisation' }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: 'Could not create contact' }, { status: 400 })
  }
```

- [ ] **Step 6: Run** `npx vitest run src/lib/race-contact-linking src/app/api/contacts tests/audience-view-columns-guard.test.js tests/cross-tenant` and `npm run check:select-columns` → PASS. Update the stale comments that cite `contacts_email_unique` as global (`src/app/api/public/leads/route.js:70`, `src/app/api/public/class-booking/route.js:146`, `src/app/api/email/mail/[id]/link-contact/route.js:24,70`, `src/lib/sale-offers.js:81`, `src/lib/person-accounts.js:261`).

- [ ] **Step 7: Apply mig 711 via MCP** before merge. Pre-check in SQL: `select count(*) from contacts c join locations l on l.id=c.location_id group by l.organization_id, lower(c.email) having count(*)>1` must be 0 (it is, because the old index was global). Post-check: `select indexname from pg_indexes where tablename='contacts' and indexname like 'contacts_email%'` shows only `contacts_email_org_unique`. PR ritual. Changelog: `W0.6 — contact email unique per organisation (mig 711); generic 409 on duplicates`.

---

### Task W0.7: Receipt-coverage report per organisation

**Status:** done — #1964 (merged).

**Files:**
- Modify: `src/lib/recon/finalize.js:55-62,190-270`, `src/lib/recon/report-email.js:137-150`, their tests under `src/lib/recon/`
- One-time data: `org_settings.ops_alert_emails` for UN1T Group and CCF Autos

- [ ] **Step 1: Failing test** in `src/lib/recon/finalize.test.js` (or a new `finalize.org.test.js` using the module's existing fake-db style): two `xero_connections` whose locations belong to different organisations → `sendCoverageReportForOrg` is called once per org with only that org's sections, and nothing reads `RECEIPT_COVERAGE_REPORT_TO`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** `loadConnections` selects `location:location_id(id, name, organization_id)`. After the sections loop, group:

```js
    const byOrg = new Map()
    for (const s of sections) {
      const key = s.organizationId || 'unknown'
      if (!byOrg.has(key)) byOrg.set(key, { organizationId: s.organizationId, locationId: s.locationId, sections: [], errors: [] })
      byOrg.get(key).sections.push(s)
    }
    for (const e of errors) {
      // An error carries the organisation of the connection that produced it;
      // one without (a platform-level failure) is shown to every organisation.
      const targets = e.organizationId && byOrg.has(e.organizationId) ? [byOrg.get(e.organizationId)] : [...byOrg.values()]
      for (const bucket of targets) bucket.errors.push({ locationName: e.locationName, error: e.error })
    }
    for (const bucket of byOrg.values()) {
      const html = renderCoverageReportHtml({ appUrl: getAppUrl(), dateStr: dublinTodayStr(), sections: bucket.sections, errors: bucket.errors })
      try {
        await sendCoverageReportForOrg({ db, organizationId: bucket.organizationId, locationId: bucket.locationId, html, dateStr: dublinTodayStr() })
      } catch (e) {
        return { finalized: false, reason: 'email_failed', error: String(e?.message || e) }
      }
    }
```

(push `organizationId: conn.location?.organization_id, locationId` onto each section and error.) In `report-email.js` replace `reportRecipients`/`sendCoverageReport` with:

```js
import { sendOpsAlert } from '@/lib/ops-alerts'

/** W0.7 — one report per organisation, to its own ops_alert_emails (push fallback inside sendOpsAlert). */
export async function sendCoverageReportForOrg({ db, organizationId, locationId, html, dateStr }) {
  if (!organizationId) throw new Error('coverage report: section without an organisation')
  return sendOpsAlert(
    { organizationId, locationId, subject: `Receipt coverage — ${dateStr}`, htmlBody: html, pushBody: 'Weekly receipt coverage report is ready in Accounting.' },
    { db },
  )
}
```

Delete `RECEIPT_COVERAGE_REPORT_TO` reads; update `docs/architecture/INTEGRATIONS.md` env table.

- [ ] **Step 4: Run** `npx vitest run src/lib/recon src/app/api/cron/receipt-coverage-weekly src/app/api/cron/process-receipt-hunts` → PASS.

- [ ] **Step 5: Data step (via Supabase MCP `execute_sql`)** so Richard keeps receiving the UN1T and CCF reports: read the current `RECEIPT_COVERAGE_REPORT_TO` value from Vercel (`filter_project_envs`, decrypt only this one) and `update org_settings set ops_alert_emails = '<that list>' where organization_id in ('f117b7b8-5f56-4f80-8299-2c698242e4d2','6a4e9970-c8b7-4b22-916b-40c63e818883') and (ops_alert_emails is null or ops_alert_emails = '')` (insert the CCF row if absent — check `select * from org_settings` first; the column type is text, see `parseOpsAlertEmails`). PR ritual. Changelog: `W0.7 — receipt-coverage report sent per organisation to its ops alert emails`.

---

### Task W0.8: The notifications settings page shows the caller's organisation only

**Status:** done — #1963 (merged).

**Files:**
- Modify: `src/app/settings/notifications/page.js:48-62`

- [ ] **Step 1: Failing test** `src/app/settings/notifications/page.test.js` (mock `@/lib/auth` getCurrentUser and `@/lib/supabase` as the sibling page tests do): a non-master user with locations `['loc-a1']` → the `locations` query carries `.in('id', ['loc-a1'])` and the `profiles` query carries `.in('id', <ids from profile_locations at loc-a1>)`; a master → no `.in` filter.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement:**

```js
  const isMaster = user.isMaster || user.role === 'master' || user.profileRole === 'master'
  const scopeIds = isMaster ? null : getUserLocationIds(user)
  let profileIds = null
  if (scopeIds) {
    const { data: links } = await db.from('profile_locations').select('profile_id').in('location_id', scopeIds.length ? scopeIds : ['00000000-0000-0000-0000-000000000000'])
    profileIds = [...new Set((links || []).map((l) => l.profile_id))]
  }
  let profilesQ = db.from('profiles').select('id, role, active, permissions').eq('active', true)
  if (profileIds) profilesQ = profilesQ.in('id', profileIds.length ? profileIds : ['00000000-0000-0000-0000-000000000000'])
  let locationsQ = db.from('locations').select('id, name, slug, active, notification_config').eq('active', true).eq('is_host_anchor', false).order('name')
  if (scopeIds) locationsQ = locationsQ.in('id', scopeIds.length ? scopeIds : ['00000000-0000-0000-0000-000000000000'])
  const [{ data: profiles }, { data: locations }] = await Promise.all([profilesQ, locationsQ])
```

(`import { getUserLocationIds } from '@/lib/auth'`.)

- [ ] **Step 4: Run** the test and `npm run check:location-scoping` → PASS. PR ritual. Changelog: `W0.8 — notifications settings page scoped to the caller's locations`.

---

### Task W0.9: Live board — kiosk cut-over to token URLs, then remove the location-keyed routes

**Status:** done — #1969 W0.9a (merged) · un1t-pi #2 W0.9b (merged) · #1973 W0.9c (merged 10 Oct).

This is the only task with a hardware step. Order matters: 9a and 9b ship first; 9c (removal) only after every kiosk is verified on the token URL.

**Files:**
- 9a Modify: `src/app/api/public/tv-live/[token]/route.js` (accept `?device=` and stamp the render heartbeat exactly as `src/app/api/public/live/[locationId]/route.js` does — copy its `stampRender(deviceFromRequest(request), ...)` fire-and-forget block)
- 9a Create: `src/app/api/public/tv-challenges/[token]/route.js` (copy of `src/app/api/public/challenges/[locationId]/route.js` whose location is resolved from `tv_displays.token` exactly as `tv-live/[token]/route.js` resolves it, 404 on unknown/inactive token, same rate limit), `src/app/tv/live/[token]/challenges/page.jsx` (renders `ChallengeTvClient` with an `endpoint` prop `/api/public/tv-challenges/${token}`; add that optional prop to `ChallengeTvClient.jsx:104` mirroring LiveTvClient's `endpoint`)
- 9a Test: `src/app/api/public/tv-challenges/[token]/route.test.js` (copy `tv-live/[token]/route.test.js` and point it at the new route: unknown token → 404; valid token → payload for that location)
- 9b Data: one `tv_displays` row per kiosk ("Kiosk — stillorgan-tv1" etc., `location_id` of the studio) created through the existing admin TV route as master, token shown once
- 9b un1t-pi: `src/roles/kiosk.js:74` and `/etc/un1t-pi/agent.env` on each Pi
- 9c Delete: `src/app/tv/[locationId]/` (page, LiveTvClient stays — move it to `src/app/tv/live/LiveTvClient.jsx` and fix the two imports), `src/app/api/public/live/[locationId]/`, `src/app/api/public/challenges/[locationId]/`; `src/proxy.js:217` keeps `/tv/` (token pages live there); `docs/kiosk-pi-setup.md` updated to the token URL

- [ ] **9a Step 1:** write the `tv-challenges` route test (copy, adjust) → run → FAIL (route missing). **Step 2:** create the route and page, add the `endpoint` prop, add `?device=` heartbeat passthrough to `tv-live`. **Step 3:** `npx vitest run src/app/api/public/tv-live src/app/api/public/tv-challenges` → PASS. PR ritual (`W0.9a — token-gated challenge board + kiosk render heartbeat on the token live route`).

- [ ] **9b Step 1 (data):** as master, `POST /api/admin/tv-displays` (see `src/lib/tv-admin.js` for the body shape) for each of `stillorgan-tv1`, `stillorgan-tv2`, `hatch-tv1`, `hatch-tv2`, label `Kiosk — <device>`, location = the studio. Record each token privately (never in chat or the PR).

- [ ] **9b Step 2 (un1t-pi):** in `/Users/richardivers/code/un1t-pi`, branch `w0-kiosk-token`; change `src/roles/kiosk.js:74` to:

```js
  // W0.9 — the kiosk loads the TOKEN-gated board. TV_TOKEN is per device
  // (a tv_displays.token minted for this kiosk), written to agent.env by
  // provisioning. Without it we refuse to start rather than fall back to the
  // location-keyed URL, which W0.9c removes.
  if (!process.env.TV_TOKEN) throw new Error('kiosk: TV_TOKEN missing from /etc/un1t-pi/agent.env')
  const url = `${crmBaseUrl}/tv/live/${process.env.TV_TOKEN}?kiosk=1&device=${device.name}`
```

Add `TV_TOKEN` to the provisioning template that writes `agent.env` (grep `agent.env` in `un1t-pi/src` and `scripts`), update `un1t-pi/README.md`, add a unit test for the missing-token refusal if `src/roles/kiosk.test.js` exists. PR, merge.

- [ ] **9b Step 3 (fleet):** for each kiosk, with the `un1t-pi` CLI over Tailscale: `pi rw <name>` (tv1 root is frozen — memory: `pi rw` before ANY change, `pi ro` after), append `TV_TOKEN=<token>` to `/etc/un1t-pi/agent.env`, update the agent to the new release, restart the kiosk role, `pi ro <name>`. Verify on the CRM side: `select device_name, last_render_at from fleet_devices` advances for all four AND Vercel runtime logs show `GET /api/public/tv-live/<token>` hits from each device (`get_runtime_logs` filtered by path). Also eyeball the two studio TVs (Richard, or a photo). Do NOT proceed to 9c until all four show token hits.

- [ ] **9c Step 1:** delete the three location-keyed directories, move `LiveTvClient.jsx`, fix imports, remove the `public-live:` rate-limit prefix if nothing else uses it, update `docs/kiosk-pi-setup.md` (lines 12, 18, 67) to the token URL. **Step 2:** `npx vitest run src/app/tv src/app/api/public` and `npm run check:route-guards` (the public route list shrinks by two — update the script's expected public count if it pins one). **Step 3:** `next build` locally (`npm run build`) to catch a dangling import. PR ritual. Changelog: `W0.9c — location-keyed live/challenge board routes removed; kiosks on token URLs`.

---

### Task W0.10: Strava webhook behind a URL token

**Status:** done — #1970 (merged).

**Files:**
- Move: `src/app/api/webhooks/strava/route.js` → `src/app/api/webhooks/strava/[token]/route.js`
- Vercel env: `STRAVA_WEBHOOK_URL_TOKEN` (32 hex, generated with `openssl rand -hex 16`), production + preview
- Richard: recreate the Strava push subscription with the new callback URL

- [ ] **Step 1: Failing test** `src/app/api/webhooks/strava/[token]/route.test.js`: POST with a wrong `params.token` → 404 and no DB read; correct token + `object_type:'activity'` + unknown athlete → `{ skipped: 'unknown_athlete' }`; GET handshake with wrong token → 403.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — at the top of both handlers:

```js
import { safeEqual } from '@/lib/webhook-auth'

function tokenOk(params) {
  const expected = process.env.STRAVA_WEBHOOK_URL_TOKEN || ''
  return expected.length > 0 && safeEqual(String(params?.token || ''), expected)
}
// GET: if (!tokenOk(await props.params)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
// POST: if (!tokenOk(await props.params)) return NextResponse.json({ success: false }, { status: 404 })
```

Add an IP rate limit on POST (`checkRateLimit(db, \`strava-webhook:${getClientIp(request)}\`, { max: 120, windowMs: 60_000 })`). Update the header comment: "Strava does not sign; the URL token is the shared secret (same model as postmark-inbound/[token])."

- [ ] **Step 4: Run** → PASS; `npm run check:route-guards` (the script's webhook exemption at `scripts/check-route-guards.mjs:133` names the old path — move it to the new path). Set the Vercel env. PR ritual. Changelog: `W0.10 — Strava webhook moved behind a URL token`.

- [ ] **Step 5: Richard's step (in the PR body):** following `docs/domain-migration-stage3.md:270-290`, DELETE the existing push subscription and POST a new one with `callback_url=https://crm.repset.ie/api/webhooks/strava/<STRAVA_WEBHOOK_URL_TOKEN>`; confirm `GET push_subscriptions` shows it and a test activity ingests.

---

### Task W0.11: Location-less email templates are master-only

**Status:** done — #1965 (merged).

**Files:**
- Modify: `src/app/api/templates/[id]/route.js` GET (`:42-46`), PUT (`:61`), DELETE (`:89`)

- [ ] **Step 1: Failing test** in `src/app/api/templates/[id]/route.test.js` (create if absent, mocking `@/lib/auth` and `@/lib/supabase` like the sibling route tests): a template row with `location_id: null` → non-master GET/PUT/DELETE → 404; master → 200.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — a helper at the top of the file:

```js
// W0.11 — a template with no location belongs to the platform, not to any
// tenant: assertLocationAccessOr404 passes a null location through and the
// permission check was skipped for it, so any staff member anywhere could
// read, edit or delete it by id. Platform rows are master-only.
function platformTemplateGuard(user, locationId) {
  if (locationId) return null
  const isMaster = user.isMaster || user.role === 'master' || user.profileRole === 'master'
  return isMaster ? null : NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })
}
```

Call it right after each `assertLocationAccessOr404` (`const pg = platformTemplateGuard(user, data.location_id); if (pg) return pg`).

- [ ] **Step 4: Run** → PASS. PR ritual. Changelog: `W0.11 — location-less email templates readable and editable by master only`.

---

### Task W0.12: Automation device ids must belong to the location

**Status:** done — #1966 (merged).

**Files:**
- Modify: `src/app/api/automations/[key]/route.js:12-16,35-50`

- [ ] **Step 1: Failing test** `src/app/api/automations/[key]/route.test.js`: body `{ location_id: 'loc-a', enabled: true, config: { device_ids: ['dev-b'] } }` where `ac_devices` has `dev-b` at `loc-b` → 400 `unknown_device`, no upsert; same with `dev-a` at `loc-a` → 200.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — schema and check:

```js
const Schema = z.object({
  location_id: uuidLike,
  enabled: z.boolean(),
  config: z.object({ device_ids: z.array(uuidLike).max(50).optional() }).passthrough().optional(),
})

// after the role check at body.location_id, before the upsert:
  const wanted = body.config?.device_ids || []
  if (wanted.length) {
    const { data: owned, error: devErr } = await db.from('ac_devices').select('id').eq('location_id', body.location_id).in('id', wanted)
    if (devErr) return NextResponse.json({ success: false, error: devErr.message }, { status: 500 })
    const ownedIds = new Set((owned || []).map((d) => d.id))
    const foreign = wanted.filter((id) => !ownedIds.has(id))
    if (foreign.length) {
      // W0.12 — a pasted id from another studio would make the climate
      // runners switch THAT studio's AC. Refuse; never say whose it is.
      return NextResponse.json({ success: false, error: 'unknown_device' }, { status: 400 })
    }
  }
```

- [ ] **Step 4: Run** → PASS. PR ritual. Changelog: `W0.12 — automation configs may only name the location's own AC devices`.

---

### Task W0.13: Unmatched WhatsApp number and flow events no longer page every tenant

**Status:** done — #1967 (merged).

**Files:**
- Modify: `src/lib/whatsapp-flow-events.js:53-56`, `src/lib/whatsapp-flow-events.test.js:48`
- Modify: `src/lib/whatsapp-number-events.js:209-211`, `src/lib/whatsapp-number-events.test.js:131,138`

- [ ] **Step 1: Flip the tests.** `flow-events.test.js:48` "falls back to all number locations when no settings match" → rename to "an unmatched flow notifies no location (logged for platform ops)" and expect `{ locations: [], notify: <still built>, unmatched: true }`. `number-events.test.js:131` ("account-level events fan out to every number location") and `:138` ("unmatched number ... notifies (all locations)") → expect `locations: []` and `unmatched: true`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement:**

```js
// whatsapp-flow-events.js — replace the fallback:
  if (!locations.length) {
    // W0.13 — never fan an unidentified event out to every tenant's managers.
    console.error(`[wa-flow-events] unmatched flow_id ${flowId || '(none)'}: ${notify.title}`)
    return { locations: [], notify, unmatched: true }
  }

// whatsapp-number-events.js — replace the `locations` computation:
  const locations = matched ? [matched.location_id] : []
  if (!matched && notify) console.error(`[wa-number-events] unmatched ${field} event: ${notify.title}`)
  return { locations, notify, matched, pausedBroadcasts, unmatched: !matched }
```

Check the webhook caller (`src/app/api/webhooks/whatsapp/route.js` around `applyNumberEvent`/`applyFlowEvent`) tolerates an empty `locations` array (it loops over it; nothing else to change).

- [ ] **Step 4: Run** `npx vitest run src/lib/whatsapp-flow-events src/lib/whatsapp-number-events src/app/api/webhooks/whatsapp` → PASS. PR ritual. Changelog: `W0.13 — unmatched WhatsApp number/flow events are logged, not pushed to every studio`.

---

### Task W0.14: Instagram lookup errors are retried, not swallowed

**Status:** done — #1968 (merged).

**Files:**
- Modify: `src/lib/agent/channels.js:165-177`, `src/lib/agent/channels.test.js`
- Modify: `src/app/api/webhooks/instagram/route.js:63-81`

- [ ] **Step 1: Failing tests.** `channels.test.js`: `resolveLocationByExternalAccount` with a fake db returning `{ data: null, error: { message: 'boom' } }` → throws (`/lookup failed/`), not `null`. Instagram route test (create `src/app/api/webhooks/instagram/route.test.js` if absent, mocking `@/lib/agent/instagram` `handleInstagramInbound` to throw a `LookupError`): the response is 500 and the dedup row for that message id is released (`webhook_events` delete called), so Meta's retry is processed.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement:**

```js
// channels.js
export async function resolveLocationByExternalAccount(platform, externalAccountId, db = null) {
  if (!platform || !externalAccountId) return null
  const client = db || createServerClient()
  const { data, error } = await client.from('channel_connections')
    .select('*').eq('platform', platform).eq('external_account_id', externalAccountId)
    .eq('is_active', true).limit(1).maybeSingle()
  // W0.14 — a failed read is NOT "unmatched": the caller has already claimed
  // the dedup row, so swallowing this made Meta's retry a no-op and lost the
  // message for good. Throw so the webhook answers non-2xx and Meta retries.
  if (error) throw new Error(`channel_connections lookup failed: ${error.message}`)
  if (!data) return null
  return { locationId: data.location_id, connection: data }
}

// instagram/route.js — inside the loop:
      try {
        await handleInstagramInbound(db, ev)
      } catch (err) {
        if (ev.messageId) await releaseWebhookEvent({ db, provider: WEBHOOK_PROVIDERS.INSTAGRAM, eventId: `msg:${ev.messageId}` })
        console.error('Instagram webhook: handler failed, releasing dedup for retry:', err?.message)
        return NextResponse.json({ success: false, error: 'retry' }, { status: 500 })
      }
```

Add `releaseWebhookEvent` next to `recordWebhookEvent` in the webhook-events lib (`grep -rn "export async function recordWebhookEvent" src/lib` names the file; mirror its table and column names — the dedup row is keyed `(provider, event_id)`):

```js
/** W0.14 — undo a dedup claim so the provider's retry is processed. Never throws. */
export async function releaseWebhookEvent({ db, provider, eventId }) {
  try {
    await db.from('webhook_events').delete().eq('provider', provider).eq('event_id', eventId)
  } catch (e) {
    console.error(`[webhook-events] release failed for ${provider}:${eventId}: ${e?.message || e}`)
  }
}
```

Keep the outer catch's 200 for parse-level errors.

- [ ] **Step 4: Run** `npx vitest run src/lib/agent/channels src/app/api/webhooks/instagram src/lib/webhook-events*` → PASS. PR ritual. Changelog: `W0.14 — Instagram lookup failures are retried instead of dropped`.

---

## Verification at the end of Wave 0

- [ ] `npm run test:cross-tenant` green with the legacy key pinned to org A.
- [ ] Live DB: `select indexname from pg_indexes where tablename in ('contacts','policies') and indexname like '%org%'` lists `contacts_email_org_unique`, `policies_org_slug_key`.
- [ ] Vercel runtime logs: no `GET /api/public/live/` or `/api/public/challenges/` hits after 9c; token hits from all four kiosks.
- [ ] `/offers` on un1tdublin.com renders Stillorgan's offers only; a non-Stillorgan slug answers 404.
- [ ] Richard's two manual items recorded in memory as waiting on him: n8n per-org key swap (then unset `CRM_API_KEY*`), Strava subscription recreate.
- [x] Update `docs/SAAS_READINESS_REVIEW_2026-10-09.md` §3 blockers 1–6, 9–11 with the PR numbers (this docs PR); update the memory note.
