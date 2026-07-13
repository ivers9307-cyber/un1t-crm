# Contact Drawer + Command-Centre Contact Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open contacts from /pipeline in a slide-over drawer (board never unmounts), then re-lay-out /contacts/[id] as a tabless command centre — per the approved spec `docs/superpowers/specs/2026-07-13-contact-drawer-and-command-centre-design.md`.

**Architecture:** Two PRs. PR 1 extracts shared contact sections (`src/components/contact/`), adds a Note-first (+Email) channel set to ContactComposer, extends the existing `GET /api/contacts/[id]/command-centre` bundle with `?scope=drawer` fields (notes, sequences, WA window, composer templates), and ships `ContactDrawer` on /pipeline driven by a `?contact=<id>` search param. PR 2 recomposes the contact page around the same sections in a three-column grid, removing the five tabs.

**Tech stack:** Next.js 16 App Router (JS, no TS), Tailwind `un1t-*` tokens, supabase-js service-role server client, vitest (mocked, no DB).

**Spec deviations (discovered during planning, both reductions):**
- The spec's new `GET /api/contacts/[id]/summary` is **replaced by extending the existing `GET /api/contacts/[id]/command-centre`** route (already session-authed, IDOR-gated 404-not-403, already returns contact + 20 activities). Additive fields only; its one consumer (`CommandCentre.jsx`) is unaffected.
- Composer gets an **Email tab too** (spec listed it; feasible because `POST /api/contacts/[id]/email` already exists, gated on the `email` permission).
- The mockup's "Book class" quick action is **dropped** (no existing per-contact class-booking flow on this page; YAGNI).

---

## PR 1 — shared sections + pipeline drawer (branch `contact-drawer-pr1`)

### Task 1: Pure lib — timeline merge/filter + needs-attention derivation

**Files:**
- Create: `src/lib/contact-view.js`
- Test: `src/lib/contact-view.test.js`

- [ ] **Step 1: Write failing tests**

```js
// src/lib/contact-view.test.js
import { describe, it, expect } from 'vitest'
import { mergeTimeline, timelineFilterGroup, deriveNeedsAttention } from './contact-view'

describe('mergeTimeline', () => {
  it('merges notes and activities newest-first with type tags', () => {
    const notes = [{ id: 'n1', created_at: '2026-07-10T10:00:00Z', content: 'hello' }]
    const activities = [
      { id: 'a1', created_at: '2026-07-11T10:00:00Z', type: 'booking' },
      { id: 'a2', created_at: '2026-07-09T10:00:00Z', type: null },
    ]
    const tl = mergeTimeline(notes, activities)
    expect(tl.map((t) => t.id)).toEqual(['a1', 'n1', 'a2'])
    expect(tl[0]).toMatchObject({ type: 'activity', activityType: 'booking' })
    expect(tl[1]).toMatchObject({ type: 'note', activityType: 'note' })
    expect(tl[2].activityType).toBe('task') // null type falls back to task
  })
  it('handles empty inputs', () => {
    expect(mergeTimeline([], [])).toEqual([])
  })
})

describe('timelineFilterGroup', () => {
  it('maps activity types to filter pills', () => {
    expect(timelineFilterGroup({ activityType: 'booking' })).toBe('classes')
    expect(timelineFilterGroup({ activityType: 'whatsapp_sent' })).toBe('messages')
    expect(timelineFilterGroup({ activityType: 'whatsapp_received' })).toBe('messages')
    expect(timelineFilterGroup({ activityType: 'sms_sent' })).toBe('messages')
    expect(timelineFilterGroup({ activityType: 'email' })).toBe('messages')
    expect(timelineFilterGroup({ activityType: 'note' })).toBe('notes')
    expect(timelineFilterGroup({ activityType: 'pipeline' })).toBe('system')
    expect(timelineFilterGroup({ activityType: 'task' })).toBe('system')
    expect(timelineFilterGroup({ activityType: 'call' })).toBe('system')
  })
})

describe('deriveNeedsAttention', () => {
  const base = { pipeline_stage_slug: 'first_class', trial_credits_remaining: 2, next_class_at: null }
  it('flags funnel contact with credits but no next class', () => {
    const items = deriveNeedsAttention({ contact: base, arrearsCents: 0, openTasks: [] })
    expect(items).toEqual([expect.objectContaining({ key: 'no_next_class', tone: 'danger' })])
  })
  it('does not flag when a next class is booked', () => {
    const items = deriveNeedsAttention({
      contact: { ...base, next_class_at: '2026-07-15T07:00:00Z' }, arrearsCents: 0, openTasks: [],
    })
    expect(items).toEqual([])
  })
  it('does not flag no_next_class off the funnel', () => {
    const items = deriveNeedsAttention({
      contact: { ...base, pipeline_stage_slug: 'member' }, arrearsCents: 0, openTasks: [],
    })
    expect(items).toEqual([])
  })
  it('flags arrears', () => {
    const items = deriveNeedsAttention({ contact: { ...base, next_class_at: 'x' }, arrearsCents: 4900, openTasks: [] })
    expect(items).toEqual([expect.objectContaining({ key: 'arrears', tone: 'danger' })])
  })
  it('flags overdue tasks (due_date <= todayStr)', () => {
    const items = deriveNeedsAttention({
      contact: { ...base, next_class_at: 'x' }, arrearsCents: 0,
      openTasks: [{ id: 't1', subject: 'Call', due_date: '2026-07-10' }], todayStr: '2026-07-13',
    })
    expect(items).toEqual([expect.objectContaining({ key: 'task_overdue', tone: 'warn' })])
  })
})
```

- [ ] **Step 2: Run and verify FAIL** — `npx vitest run src/lib/contact-view.test.js` → module not found.

- [ ] **Step 3: Implement `src/lib/contact-view.js`**

```js
// Contact view helpers shared by /contacts/[id] and the pipeline
// contact drawer. Pure functions — no DB, no Date.now() (callers pass
// todayStr from dublinTodayStr()).

const FUNNEL_SLUGS = new Set(['new_lead', 'first_class', 'second_class', 'trial_done'])
const MESSAGE_TYPES = new Set(['whatsapp_sent', 'whatsapp_received', 'sms_sent', 'email'])

// Unified timeline: notes + activities, newest first. Extracted
// verbatim from the contact page (types drive activityIcons there).
export function mergeTimeline(notes, activities) {
  return [
    ...(notes || []).map((n) => ({ type: 'note', activityType: 'note', date: n.created_at, ...n })),
    ...(activities || []).map((a) => ({ type: 'activity', activityType: a.type || 'task', date: a.created_at, ...a })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date))
}

// Filter-pill grouping for the timeline: all / classes / messages /
// notes / system. Anything unrecognised is "system" so new activity
// types never vanish behind the filters.
export function timelineFilterGroup(item) {
  const t = item.activityType
  if (t === 'booking') return 'classes'
  if (MESSAGE_TYPES.has(t)) return 'messages'
  if (t === 'note') return 'notes'
  return 'system'
}

// Needs-attention derivation for the drawer + the page's right rail.
// Returns [{ key, label, detail, tone }] — tone maps to the light-theme
// chip ramp (danger=red, warn=amber).
export function deriveNeedsAttention({ contact, arrearsCents = 0, openTasks = [], todayStr = null }) {
  const items = []
  if (
    FUNNEL_SLUGS.has(contact?.pipeline_stage_slug) &&
    !contact?.next_class_at &&
    (contact?.trial_credits_remaining ?? 0) > 0
  ) {
    items.push({
      key: 'no_next_class',
      label: 'No next class booked',
      detail: `${contact.trial_credits_remaining} trial credit${contact.trial_credits_remaining === 1 ? '' : 's'} unused`,
      tone: 'danger',
    })
  }
  if (arrearsCents > 0) {
    items.push({ key: 'arrears', label: 'Payment overdue', detail: 'On the Overdue chase-list', tone: 'danger' })
  }
  if (todayStr) {
    const overdue = (openTasks || []).filter((t) => t.due_date && t.due_date <= todayStr)
    if (overdue.length > 0) {
      items.push({
        key: 'task_overdue',
        label: `${overdue.length} task${overdue.length === 1 ? '' : 's'} overdue`,
        detail: overdue[0].subject || '',
        tone: 'warn',
      })
    }
  }
  return items
}
```

- [ ] **Step 4: Run and verify PASS** — `npx vitest run src/lib/contact-view.test.js`.
- [ ] **Step 5: Commit** — `git add src/lib/contact-view.* && git commit -m "DRAWER.1 — contact-view lib: timeline merge/filter + needs-attention"`

### Task 2: Extend `GET /api/contacts/[id]/command-centre` with `?scope=drawer`

**Files:**
- Modify: `src/app/api/contacts/[id]/command-centre/route.js`
- Create: `src/app/api/contacts/[id]/command-centre/route.test.js` (follow `../email/route.test.js` mocking pattern)
- Modify: `src/lib/openapi.js` (add the scope param + response fields to the route's registration; register the route if absent)

- [ ] **Step 1: Write failing tests** — mock `@/lib/auth` (getCurrentUser, assertLocationAccess), `@/lib/supabase`; assert: 401 unauthenticated; 404 when contact missing; 404 when assertLocationAccess returns a guard; base scope returns `{ success, contact, activities, event_types }` unchanged; `?scope=drawer` additionally returns `{ notes, sequences, wa, composer_templates }`; `wa.window_open` computed from `window_expires_at` vs now; templates only fetched when the user holds the `whatsapp` permission.

- [ ] **Step 2: Run and verify FAIL.**

- [ ] **Step 3: Implement.** Add to the existing route (keep every existing line; additive only):

```js
// after: const url = new URL(request.url) — note: change handler signature
// from (_request, props) to (request, props)
const scope = url.searchParams.get('scope')

// existing actRes/etRes Promise.all stays; when scope === 'drawer'
// run a second parallel pass:
let drawerExtras = null
if (scope === 'drawer') {
  const [notesRes, seqRes, waRes] = await Promise.all([
    db.from('notes').select('*').eq('contact_id', params.id)
      .order('created_at', { ascending: false }).limit(MAX_ACTIVITIES),
    db.from('sequence_enrollments')
      .select('id, next_step_at, email_sequences(name)')
      .eq('contact_id', params.id).eq('status', 'active')
      .order('next_step_at', { ascending: true }),
    db.from('whatsapp_conversations')
      .select('id, window_expires_at, last_message_at')
      .eq('contact_id', params.id)
      .order('last_message_at', { ascending: false }).limit(1),
  ])
  const latestWa = (waRes.data || [])[0] || null
  // Composer template list — same filter chain the contact page uses
  // (UTILITY + APPROVED + isSendableUtilityTemplate), only when the
  // caller can send WhatsApp at all.
  let composerTemplates = []
  if (hasPermission(user, 'whatsapp')) {
    const { data: rawTemplates } = await db.from('whatsapp_templates')
      .select('name, language, components, status, category')
      .eq('location_id', contact.location_id)
      .eq('category', 'UTILITY').eq('status', 'APPROVED')
      .order('name', { ascending: true })
    composerTemplates = (rawTemplates || []).filter(isSendableUtilityTemplate)
      .map((t) => ({ name: t.name, language: t.language || 'en',
        bodyText: extractTemplateBody(t.components).bodyText, sendable: true }))
  }
  drawerExtras = {
    notes: notesRes.data || [],
    sequences: seqRes.data || [],
    wa: latestWa ? {
      window_open: latestWa.window_expires_at ? new Date(latestWa.window_expires_at) > new Date() : false,
      window_expires_at: latestWa.window_expires_at,
    } : { window_open: false, window_expires_at: null },
    composer_templates: composerTemplates,
    permissions: {
      whatsapp: hasPermission(user, 'whatsapp'),
      sms: hasPermission(user, 'sms'),
      email: hasPermission(user, 'email'),
    },
  }
}
// response: { success: true, contact, activities, event_types, ...(drawerExtras || {}) }
```
New imports: `hasPermission` from `@/lib/permissions`; `extractTemplateBody, isSendableUtilityTemplate` from `@/lib/radar-outreach`.

- [ ] **Step 4: Run and verify PASS**, then run the pre-existing suite for neighbours: `npx vitest run src/app/api/contacts --pool=threads`.
- [ ] **Step 5: Register in `src/lib/openapi.js`** (search for a sibling `/api/contacts/{id}/...` GET entry and mirror it; document `scope=drawer`).
- [ ] **Step 6: Commit** — `"DRAWER.2 — command-centre route: ?scope=drawer bundle (notes, sequences, WA window, templates)"`

### Task 3: Extract `ContactTimeline` component (used by page + drawer)

**Files:**
- Create: `src/components/contact/ContactTimeline.jsx` (client component)
- Modify: `src/app/contacts/[id]/page.js` (activity tab renders the new component; delete the inlined timeline JSX at lines ~496–613 and the `activityIcons` map at lines 52–66; keep `ContactActions` header placement)

- [ ] **Step 1:** Create the component. Move both timeline branches (grouped-person and single-contact, page.js lines 510–612) verbatim into it. Signature:

```jsx
'use client'
import { useState } from 'react'
import { Mail, Calendar, MessageSquare, CheckSquare, Clock, BookOpen, ArrowRight, MessageCircle } from 'lucide-react'
import { timelineFilterGroup } from '@/lib/contact-view'

// props:
//   timeline        — mergeTimeline() output (single-contact variant)
//   person          — person aggregate or null (grouped variant, uses person.timeline)
//   showFilters     — render the All/Classes/Messages/Notes/System pills (default false)
//   emptyText       — default 'No activity yet'
export default function ContactTimeline({ timeline = [], person = null, showFilters = false, emptyText = 'No activity yet' }) {
  const [filter, setFilter] = useState('all')
  // grouped variant ignores filters (item shape differs); single variant filters via timelineFilterGroup
  const items = person && person.accounts.length > 1 ? person.timeline
    : (filter === 'all' ? timeline : timeline.filter((i) => timelineFilterGroup(i) === filter))
  // …moved JSX from page.js, with the activityIcons map moved here too…
}
```
Filter pills (only when `showFilters`): buttons `all|classes|messages|notes|system`, each `type="button"`, active = `bg-un1t-text text-un1t-bg`, inactive = `border border-un1t-border text-un1t-subtle` (matches ChannelPill idiom).

- [ ] **Step 2:** Rewire page.js: `activityTab`'s timeline card body becomes `<ContactTimeline timeline={timeline} person={person} />`; page keeps building `timeline` via `mergeTimeline(notes, activities)` from Task 1 (replacing the inline merge at lines 320–323).
- [ ] **Step 3:** `npm test` (verifies nothing imported the deleted map) and `npm run build`.
- [ ] **Step 4: Commit** — `"DRAWER.3 — extract ContactTimeline (shared by contact page + drawer)"`

### Task 4: Note-first composer (+ Email channel)

**Files:**
- Modify: `src/components/ContactComposer.jsx`
- Modify: `src/app/contacts/[id]/page.js` (pass `canEmail`, `hasEmail`, `emailBlocked`)

Design (per spec): channel pills ordered **Note, WhatsApp, SMS, Email**; default channel `'note'`. Note tab: textarea + "Save note" → `POST /api/contacts/[id]/notes` `{ content }` → flash "Note saved" + `router.refresh()`; caption "Visible to staff only · syncs to Glofox". Email tab (only when `canEmail && hasEmail && !emailBlocked`): subject input + body textarea → `POST /api/contacts/[id]/email` `{ subject, body }`. WhatsApp/SMS behaviour unchanged. The early `return null` (line 71) is removed — Note is always available. All new buttons `type="button"`.

- [ ] **Step 1:** Implement: add `canEmail = false, hasEmail = false, emailBlocked = false, defaultChannel = 'note'` props; `channel` state initialised to `defaultChannel`; pills render for every available channel (Note always; WhatsApp/SMS/Email per availability). Add `sendNote()` and `sendEmail()` using the existing `post()` helper; separate `subject` state for email.
- [ ] **Step 2:** Page passes: `canEmail={hasPermission(user, 'email')}`, `hasEmail={!!contact.email}`, `emailBlocked={['bounced','complained','unsubscribed'].includes(contact.email_status)}`.
- [ ] **Step 3:** `npm test && npm run build`; manual dev-server check of all four tabs on a contact.
- [ ] **Step 4: Commit** — `"DRAWER.4 — Note-first composer + ad-hoc Email channel"`

### Task 5: `ContactDrawer` + pipeline wiring

**Files:**
- Create: `src/components/contact/ContactDrawer.jsx` (client)
- Modify: `src/components/DealCard.jsx` (navigate → set `?contact=` param)
- Modify: `src/components/KanbanBoard.jsx` (render drawer; provide per-column ordered contact-id list)
- Modify: `src/app/pipeline/page.js` (no change expected beyond what KanbanBoard needs — verify)

- [ ] **Step 1: DealCard** — replace `router.push('/contacts/'+id)` with a `useSearchParams`/`useRouter` param write:

```js
function openDrawer() {
  if (!contact.id) return
  const params = new URLSearchParams(window.location.search)
  params.set('contact', contact.id)
  router.replace(`?${params.toString()}`, { scroll: false })
}
```

- [ ] **Step 2: KanbanBoard** — read the open contact id via `useSearchParams()`; find its column and build `columnContactIds` (the same sorted order used to render that column's cards); render `<ContactDrawer contactId={openId} columnContactIds={columnContactIds} locationId={locationId} onNavigate={(id)=>setParam(id)} onClose={()=>clearParam()} />`. Because `useSearchParams` requires it, wrap the board's export in `<Suspense>` (check whether /pipeline already renders inside one; add if not).
- [ ] **Step 3: ContactDrawer** — fixed-position right panel (`fixed inset-y-0 right-0 w-[440px] max-w-[90vw] z-40 bg-un1t-bg border-l border-un1t-border shadow-2xl flex flex-col`) + scrim (`fixed inset-0 bg-black/20 z-30`); mounts when `contactId` set; fetches `/api/contacts/${id}/command-centre?scope=drawer`; loading skeleton; renders:
  - header: `PersonHeader` (name, stageSlug, linkedCount=1) + close ✕ (`type="button"`, aria-label) + `PersonActionBar` actions `['task','sequence','cold']` (message action omitted — the composer is right below),
  - `ContactComposer` (Note default; wa/sms/email availability from `permissions` + contact fields + `wa.window_open` + `composer_templates`),
  - needs-attention chips via `deriveNeedsAttention` (openTasks = activities where `kind==='task' && !done`; todayStr from a `new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Dublin' })` client equivalent — or simpler, omit todayStr client-side and skip overdue detection in the drawer v1),
  - `ContactTimeline` (merged from bundle notes+activities via `mergeTimeline`, `showFilters`),
  - condensed sequences list,
  - footer: `Open full profile →` (`<Link href={'/contacts/'+id}>`) + ‹ › buttons cycling `columnContactIds`.
  Esc listener (`keydown`, cleanup on unmount) calls `onClose`. Scrim click closes. `router.refresh()` NOT needed — drawer refetches on contactId change.
- [ ] **Step 4:** Manual dev-server pass: open/close/Esc/back-button, ‹ › across a column, both funnel and `?view=dormant`, note save from the drawer, chips readable.
- [ ] **Step 5:** `npm test && npm run lint && npm run build` + full CI mirror.
- [ ] **Step 6: Commit** — `"DRAWER.5 — pipeline contact slide-over (?contact= param, column nav)"`

### Task 6: PR 1

- [ ] Run full CI mirror (`npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`) + `npm run build`; push; `gh pr create` describing drawer + extractions; report URL.

---

## PR 2 — contact page command centre (branch `contact-command-centre-pr2`, after PR 1 merges)

### Task 7: Extract remaining sections

**Files:**
- Create: `src/components/contact/ContactHeaderBand.jsx` — server-compatible; composes the member photo + `PersonHeader` + risk chip + `PersonActionBar` (moved from page.js lines 895–929) and a stats strip replacing the Overview `MetricCard` grid: LTV, Arrears (danger tone when >0), Attended 30d, Deals, First-90 (`Day X/Y · a/t` when `journey?.inWindow`), Last attended. Props: `{ contact, person, risk, journey, metrics: { ltvCents, arrearsCents, attended, deals }, currency }`. Status chips row: stage pill lives in PersonHeader already; add `No class booked` (danger) / `Next: <date>` chip + `N trial credits` chip for funnel slugs (same BADGE_SLUGS logic as DealCard).
- Create: `src/components/contact/ContactWhoRail.jsx` — Identity card (emails/phones, moved from lines 372–396), Details card (InfoRow block, lines 459–464), `LinkedAccountsCard`, `GlofoxProfileCard`, `ContactMarketingPreferencesCard`. `GlofoxProfileCard`, `MetricCard`, `InfoRow`, `BookingsSubsection`, `buildMessageHistory` move out of page.js into `src/components/contact/GlofoxProfileCard.jsx` / `contact-page-helpers.jsx` as needed (they are currently file-local functions).
- Create: `src/components/contact/ContactNextRail.jsx` — Needs-attention (from `deriveNeedsAttention`, with `todayStr={dublinTodayStr()}` passed from the server page), Open tasks (moved lines 695–715), Active sequences (moved 478–492), Upcoming event registrations (moved 634–658), Races card (moved 664–667), Devices card, Admin actions card (moved 810–851).
- Test: components are moved JSX; coverage stays at the lib level (Task 1) — run `npm test` + `npm run build` after each move.

- [ ] Each extraction is its own commit (`"CC.1 — extract ContactHeaderBand"`, `"CC.2 — extract ContactWhoRail"`, `"CC.3 — extract ContactNextRail"`), page still rendering the old tab layout via the new components between commits.

### Task 8: Re-layout the page

**Files:**
- Modify: `src/app/contacts/[id]/page.js`

- [ ] **Step 1:** Replace the `ContactDetailTabs` render (lines 931–942) with:

```jsx
<ContactHeaderBand … />
<div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)_300px] items-start mt-6">
  <div className="space-y-5 xl:order-1 order-3"><ContactWhoRail … /></div>
  <div className="space-y-5 xl:order-2 order-2">
    <div id="message" className="scroll-mt-4"><ContactComposer … /></div>
    <ContactTimeline timeline={timeline} person={person} showFilters />
    {messages.length > 0 && <MessagesCard messages={messages} />}
    {(waConversations.length > 0 || contact.wa_phone) && <WhatsAppConversationsCard … />}
    {pastBookings.length > 0 && <PastEventsCard … />}
  </div>
  <div className="space-y-5 xl:order-3 order-1"><ContactNextRail … /></div>
</div>
{canConsultations && <section className="mt-8">…consultations content, unchanged…</section>}
<div className="mt-8"><ContactConsentHistoryCard contactId={contact.id} /></div>
```
(`MessagesCard` / `WhatsAppConversationsCard` / `PastEventsCard` = the existing comms/activity JSX blocks moved into `src/components/contact/` files with the props they already close over.)

- [ ] **Step 2:** Delete the now-dead `overviewTab/activityTab/commsTab/adminTab` constructions and the `ContactDetailTabs` import. Grep `ContactDetailTabs` — if this page was its only consumer, leave the component in place (other pages may adopt it; do NOT delete shared components in this PR).
- [ ] **Step 3:** Mobile/stacked order check at `sm` width; `#message` anchor still lands on the composer.
- [ ] **Step 4:** `npm test && npm run lint && npm run build`; manual pass on a trial contact, a grouped person, a member with arrears, and a staff-role user (consultations hidden).
- [ ] **Step 5: Commit** — `"CC.4 — /contacts/[id] command-centre layout (tabs removed)"`

### Task 9: PR 2

- [ ] Full CI mirror + build; push; `gh pr create`; report URL.

---

## Self-review notes
- Spec coverage: drawer (T5), param-driven URL (T5), summary endpoint (T2, as command-centre extension), extraction (T3/T4/T7), Note-first composer (T4), command-centre layout (T8), consultations placement (T8), testing (T1/T2 + manual lists). Gap accepted: drawer overdue-task chip deferred to PR 2 (needs server todayStr) — needs-attention in the drawer covers no-next-class + arrears only if arrears data present (it is not in the drawer bundle; chip omitted there — documented in T5).
- No mobile-permission changes; no migrations; no new env vars.
