# Hatch Street Waitlist Lead Form — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reusable `lead_form` landing-page block + `POST /api/public/leads` endpoint that captures a founding-member waitlist lead (name/email/phone + consent) as a Hatch `new_lead` with marketing consent and a `hatch-founding-member` tag.

**Architecture:** A new operator-editable `lead_form` block renders an inline-editable heading/sub-copy plus a client `<WaitlistWidget>` form. The widget POSTs to `/api/public/leads`, which resolves the studio + tag/lead_source from `public_path` (server-side, so the client can't target another location or inject tags), then reuses the existing public-form helpers — `findOrCreateRaceContact`, `applyFormMarketingConsent`, `writeContactTag` — and opens a `new_lead` deal. No migration (reuses `contacts`/`deals`/`contact_preferences`/`consent_log`/`contact_tags`; the block lives in the `landing_page_settings.blocks` JSONB).

**Tech Stack:** Next.js 16 (App Router; server + client components), React 19, Supabase (service-role server client), Zod, Vitest, Tailwind (`un1t-*` + the public-page white-on-black palette).

**Spec:** `docs/superpowers/specs/2026-06-08-hatch-waitlist-lead-form-design.md`
**Branch:** `hatch-waitlist-lead-form` (already created; the spec commit is the first commit).

---

## Testing approach (read first)

This repo's Vitest suite covers **pure lib helpers only** (per `CLAUDE.md` + the existing landing-page + event-register code, neither of which has component/route tests). So:

- **Task 1** (`src/lib/leads.js`) and **Task 2** (block factory) get real TDD — failing test first, then code.
- **Tasks 3–6** (the client widget, the block renderer, the editor panel, the endpoint) are verified by `npm run build` + targeted manual checks, matching how the rest of this codebase verifies pages/components/public routes. Do **not** invent an RTL/route-test harness.

Full CI mirror before push (Task 7):
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run build
```

---

## File Structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `src/lib/leads.js` | Pure: Zod `LeadSchema`, `normaliseLead`, `leadConfigFromBlocks`, default tag/source | Create |
| `src/lib/leads.test.js` | Unit tests for the above | Create |
| `src/lib/landing-page-blocks.js` | Register the `lead_form` block type + factory | Modify |
| `src/lib/landing-page-blocks.test.js` | Factory/registry test for `lead_form` | Create (or append) |
| `src/components/WaitlistWidget.jsx` | Client form (name/email/phone/consent + honeypot) → POST | Create |
| `src/components/landing-page/BlockRenderers.jsx` | `LeadFormBlock` case + thread `publicPath` | Modify |
| `src/app/welcome/[location]/page.js` | Pass `publicPath={params.location}` into `BlockRenderer` | Modify |
| `src/components/LandingPageSettingsForm.jsx` | `summaryFor` + `BlockEditPanel` cases + `LeadFormEdit` panel | Modify |
| `src/app/api/public/leads/route.js` | Public capture endpoint | Create |

No migration.

---

## Task 1: Pure lead helpers (TDD)

**Files:**
- Create: `src/lib/leads.js`
- Test: `src/lib/leads.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/leads.test.js`:
```js
import { describe, it, expect } from 'vitest'
import {
  LeadSchema, normaliseLead, leadConfigFromBlocks,
  DEFAULT_LEAD_TAG, DEFAULT_LEAD_SOURCE,
} from './leads'

const valid = {
  first_name: '  Sarah ', email: 'Sarah@Example.com ', phone: '087 123 4567',
  consent: true, public_path: 'hatch-street', company: '',
}

describe('LeadSchema', () => {
  it('accepts a valid submission', () => {
    expect(LeadSchema.safeParse(valid).success).toBe(true)
  })
  it('rejects a blank name', () => {
    expect(LeadSchema.safeParse({ ...valid, first_name: '   ' }).success).toBe(false)
  })
  it('rejects a bad email', () => {
    expect(LeadSchema.safeParse({ ...valid, email: 'nope' }).success).toBe(false)
  })
  it('rejects a too-short phone', () => {
    expect(LeadSchema.safeParse({ ...valid, phone: '123' }).success).toBe(false)
  })
  it('rejects consent !== true', () => {
    expect(LeadSchema.safeParse({ ...valid, consent: false }).success).toBe(false)
    expect(LeadSchema.safeParse({ ...valid, consent: undefined }).success).toBe(false)
  })
  it('allows the honeypot to be present (handler decides)', () => {
    expect(LeadSchema.safeParse({ ...valid, company: 'bot' }).success).toBe(true)
  })
})

describe('normaliseLead', () => {
  it('trims name/phone and lowercases email', () => {
    expect(normaliseLead(valid)).toEqual({
      firstName: 'Sarah', email: 'sarah@example.com', phone: '087 123 4567', publicPath: 'hatch-street',
    })
  })
})

describe('leadConfigFromBlocks', () => {
  it('falls back to defaults when no lead_form block exists', () => {
    expect(leadConfigFromBlocks([{ type: 'hero' }])).toEqual({ tag: DEFAULT_LEAD_TAG, leadSource: DEFAULT_LEAD_SOURCE })
    expect(leadConfigFromBlocks(null)).toEqual({ tag: DEFAULT_LEAD_TAG, leadSource: DEFAULT_LEAD_SOURCE })
  })
  it('uses the block tag/lead_source when present', () => {
    const blocks = [{ type: 'lead_form', tag: 'vip-list', lead_source: 'spring_promo' }]
    expect(leadConfigFromBlocks(blocks)).toEqual({ tag: 'vip-list', leadSource: 'spring_promo' })
  })
  it('falls back when the block fields are blank', () => {
    const blocks = [{ type: 'lead_form', tag: '  ', lead_source: '' }]
    expect(leadConfigFromBlocks(blocks)).toEqual({ tag: DEFAULT_LEAD_TAG, leadSource: DEFAULT_LEAD_SOURCE })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/leads.test.js`
Expected: FAIL — cannot resolve `./leads`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/leads.js`:
```js
// Pure helpers for the public waitlist / lead-capture form.
// Consumed by POST /api/public/leads. No DB, no side effects — unit-tested.

import { z } from 'zod'

// Defaults when a lead_form block hasn't overridden them. Hatch's
// founding-member launch is the first use; both are operator-overridable
// per-block via landing-page-blocks.js.
export const DEFAULT_LEAD_TAG = 'hatch-founding-member'
export const DEFAULT_LEAD_SOURCE = 'hatch_launch'

// Public submission shape. NOT strict — extra fields (e.g. a stale
// client sending more) are ignored rather than 400'd. `company` is a
// honeypot the handler inspects; humans never fill it.
export const LeadSchema = z.object({
  first_name: z.string().trim().min(1, 'Your name is required').max(120),
  email: z.string().trim().email('Enter a valid email').max(320),
  phone: z.string().trim().min(1, 'Phone number is required').max(50)
    .refine((v) => v.replace(/\D/g, '').length >= 7, 'Enter a valid phone number'),
  consent: z.boolean().refine((v) => v === true, { message: 'Please tick the consent box to continue' }),
  public_path: z.string().trim().min(1).max(120),
  company: z.string().max(200).optional(),
})

// Normalise a validated body into the fields the handler stores.
export function normaliseLead(data) {
  return {
    firstName: data.first_name.trim(),
    email: data.email.toLowerCase().trim(),
    phone: data.phone.trim(),
    publicPath: data.public_path.trim(),
  }
}

// Resolve the tag + lead_source from the page's first lead_form block,
// falling back to the defaults. Pure — the handler passes the page's
// blocks JSONB. Keeps tag/source server-derived so the client can't
// inject arbitrary tags.
export function leadConfigFromBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const lf = list.find((b) => b && typeof b === 'object' && b.type === 'lead_form')
  const tag = (lf && typeof lf.tag === 'string' && lf.tag.trim()) || DEFAULT_LEAD_TAG
  const leadSource = (lf && typeof lf.lead_source === 'string' && lf.lead_source.trim()) || DEFAULT_LEAD_SOURCE
  return { tag, leadSource }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/leads.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/leads.js src/lib/leads.test.js
git commit -m "feat(leads): pure waitlist helpers — LeadSchema, normaliseLead, leadConfigFromBlocks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Register the `lead_form` block type (TDD)

**Files:**
- Modify: `src/lib/landing-page-blocks.js`
- Test: `src/lib/landing-page-blocks.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/landing-page-blocks.test.js` (if it exists already, append the `describe` block):
```js
import { describe, it, expect } from 'vitest'
import { BLOCK_TYPES, newBlockOfType, BlocksArraySchema } from './landing-page-blocks'

describe('lead_form block type', () => {
  it('is registered in BLOCK_TYPES', () => {
    expect(BLOCK_TYPES.some((t) => t.type === 'lead_form')).toBe(true)
  })
  it('factory produces the expected default shape', () => {
    const b = newBlockOfType('lead_form')
    expect(b.type).toBe('lead_form')
    expect(typeof b.id).toBe('string')
    for (const k of ['heading', 'subtext', 'button_label', 'success_message', 'consent_label', 'tag', 'lead_source']) {
      expect(typeof b[k]).toBe('string')
      expect(b[k].length).toBeGreaterThan(0)
    }
    expect(b.tag).toBe('hatch-founding-member')
    expect(b.lead_source).toBe('hatch_launch')
  })
  it('validates through BlocksArraySchema', () => {
    expect(BlocksArraySchema.safeParse([newBlockOfType('lead_form')]).success).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/landing-page-blocks.test.js`
Expected: FAIL — `newBlockOfType('lead_form')` throws `Unknown block type: lead_form`.

- [ ] **Step 3: Add the factory + registry entry**

In `src/lib/landing-page-blocks.js`, add the factory immediately after `EVENT_DEFAULT` (before `STATS_DEFAULT`):
```js
const LEAD_FORM_DEFAULT = () => ({
  id:              newBlockId(),
  type:            'lead_form',
  heading:         'Join the founding members',
  subtext:         'Be first through the doors at UN1T Hatch Street. Leave your details and we’ll be in touch with founding-member offers before we open.',
  button_label:    'Join the waitlist',
  success_message: "You're on the list — we'll be in touch soon.",
  consent_label:   'I’d like to hear from UN1T about the Hatch Street launch and offers by email, SMS and WhatsApp. I can opt out anytime.',
  tag:             'hatch-founding-member',
  lead_source:     'hatch_launch',
})
```

Then add to the `BLOCK_TYPES` array, immediately after the `event` entry:
```js
  { type: 'lead_form',   label: 'Lead form',    description: 'Waitlist / interest capture — name, email, phone + consent.',  factory: LEAD_FORM_DEFAULT },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/landing-page-blocks.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/landing-page-blocks.js src/lib/landing-page-blocks.test.js
git commit -m "feat(landing-blocks): register lead_form block type + factory

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `WaitlistWidget` client form

**Files:**
- Create: `src/components/WaitlistWidget.jsx`

(No unit test — client component; verified by build + manual in Task 7.)

- [ ] **Step 1: Create the component**

Create `src/components/WaitlistWidget.jsx`:
```jsx
'use client'

// Public waitlist form. Posts to /api/public/leads with the page's
// public_path; the endpoint resolves the studio + tag/source. Mirrors
// the booking/event widgets' role: an interactive client island the
// (server-rendered) LeadFormBlock embeds.

import { useState } from 'react'

export default function WaitlistWidget({ publicPath, buttonLabel, successMessage, consentLabel }) {
  const [form, setForm] = useState({ first_name: '', email: '', phone: '', consent: false, company: '' })
  const [status, setStatus] = useState('idle') // idle | submitting | done | error
  const [error, setError] = useState(null)

  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  async function onSubmit(e) {
    e.preventDefault()
    setStatus('submitting'); setError(null)
    try {
      const r = await fetch('/api/public/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, public_path: publicPath }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        setError(j.error || 'Something went wrong. Please try again.')
        setStatus('error')
        return
      }
      setStatus('done')
    } catch {
      setError('Something went wrong. Please try again.')
      setStatus('error')
    }
  }

  if (status === 'done') {
    return (
      <div className="rounded-lg border border-white/15 bg-white/5 px-6 py-8 text-center">
        <p className="text-lg font-semibold text-white">
          {successMessage || "You're on the list — we'll be in touch soon."}
        </p>
      </div>
    )
  }

  const inputCls =
    'w-full bg-white/5 border border-white/15 rounded-md px-3 py-2.5 text-sm text-white placeholder-white/40 focus:outline-none focus:border-white/40'

  return (
    <form onSubmit={onSubmit} className="space-y-3 text-left">
      {/* Honeypot — off-screen, not tab-focusable. Bots fill it; humans don't. */}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: '1px', height: '1px', overflow: 'hidden' }}>
        <label>Company
          <input type="text" tabIndex={-1} autoComplete="off" value={form.company} onChange={set('company')} />
        </label>
      </div>

      <input className={inputCls} type="text"  required placeholder="Your name" value={form.first_name} onChange={set('first_name')} maxLength={120} autoComplete="name" />
      <input className={inputCls} type="email" required placeholder="Email"     value={form.email}      onChange={set('email')}      maxLength={320} autoComplete="email" />
      <input className={inputCls} type="tel"   required placeholder="Phone"     value={form.phone}      onChange={set('phone')}      maxLength={50}  autoComplete="tel" />

      <label className="flex items-start gap-2 text-xs text-white/70 leading-relaxed">
        <input type="checkbox" required checked={form.consent} onChange={set('consent')} className="mt-0.5 shrink-0" />
        <span>
          {consentLabel || 'I’d like to hear from UN1T about the Hatch Street launch and offers by email, SMS and WhatsApp. I can opt out anytime.'}{' '}
          <a href="/privacy" target="_blank" rel="noreferrer" className="underline hover:text-white">Privacy</a>
        </span>
      </label>

      {error && <p className="text-sm text-red-300">{error}</p>}

      <button
        type="submit"
        disabled={status === 'submitting'}
        className="w-full bg-white text-black font-semibold text-sm py-3 rounded-full hover:bg-white/90 disabled:opacity-60 transition-colors"
      >
        {status === 'submitting' ? 'Submitting…' : (buttonLabel || 'Join the waitlist')}
      </button>
    </form>
  )
}
```

- [ ] **Step 2: Lint**

Run: `npx eslint src/components/WaitlistWidget.jsx`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/WaitlistWidget.jsx
git commit -m "feat(waitlist): client WaitlistWidget form (name/email/phone/consent + honeypot)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Render the block + thread `publicPath`

**Files:**
- Modify: `src/components/landing-page/BlockRenderers.jsx`
- Modify: `src/app/welcome/[location]/page.js`

(No unit test — server render; verified by build + manual in Task 7.)

- [ ] **Step 1: Import the widget**

In `src/components/landing-page/BlockRenderers.jsx`, add to the imports (after `import BookingWidget...`):
```js
import WaitlistWidget from '@/components/WaitlistWidget'
```

- [ ] **Step 2: Thread `publicPath` + add the case**

Change the `BlockRenderer` signature and add the `lead_form` case. Replace:
```js
export default function BlockRenderer({ block, onEdit, locationId }) {
```
with:
```js
export default function BlockRenderer({ block, onEdit, locationId, publicPath }) {
```
and in the `switch (block.type)`, add this case (after the `event` case):
```js
    case 'lead_form':   return <LeadFormBlock    block={block} onEdit={localOnEdit} publicPath={publicPath} />
```

- [ ] **Step 3: Add the `LeadFormBlock` component**

Add this component to the file (e.g. immediately after `EventBlock`):
```jsx
export function LeadFormBlock({ block, onEdit, publicPath }) {
  return (
    <section id="waitlist" className="bg-black text-white py-20 md:py-28 border-t border-white/10">
      <div className="max-w-xl mx-auto px-6 text-center">
        {(block.heading || onEdit) && (
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-3">
            <E value={block.heading} onEdit={onEdit} path={['heading']} />
          </h2>
        )}
        {(block.subtext || onEdit) && (
          <p className="text-white/70 leading-relaxed mb-8 max-w-md mx-auto">
            <E value={block.subtext} onEdit={onEdit} path={['subtext']} multiline />
          </p>
        )}
        <WaitlistWidget
          publicPath={publicPath}
          buttonLabel={block.button_label}
          successMessage={block.success_message}
          consentLabel={block.consent_label}
        />
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Pass `publicPath` from the studio page**

In `src/app/welcome/[location]/page.js`, the blocks map renders `<BlockRenderer key={block.id} block={block} />`. Change it to:
```jsx
      {blocks.map((block) => (
        <BlockRenderer key={block.id} block={block} publicPath={params.location} />
      ))}
```
(`params.location` is the page's `public_path` — already in scope from `const params = await props.params`.)

- [ ] **Step 5: Lint**

Run: `npx eslint src/components/landing-page/BlockRenderers.jsx 'src/app/welcome/[location]/page.js'`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/landing-page/BlockRenderers.jsx 'src/app/welcome/[location]/page.js'
git commit -m "feat(landing): render lead_form block; thread publicPath to BlockRenderer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Editor panel for the `lead_form` block

**Files:**
- Modify: `src/components/LandingPageSettingsForm.jsx`

(No unit test — React editor; verified by build + manual in Task 7.)

- [ ] **Step 1: Add a `summaryFor` case**

In `summaryFor(block)`'s `switch`, add (before `default:`):
```js
    case 'lead_form':   return block.heading || 'Waitlist'
```

- [ ] **Step 2: Add a `BlockEditPanel` case**

In `BlockEditPanel`'s `switch (props.block.type)`, add (after the `event` case):
```js
    case 'lead_form':   return <LeadFormEdit    {...props} />
```

- [ ] **Step 3: Add the `LeadFormEdit` component**

Add this component near the other `*Edit` components (e.g. after `EventEdit`):
```jsx
function LeadFormEdit({ block, onUpdate }) {
  return (
    <>
      <Field label="Heading">
        <Input value={block.heading || ''} onChange={(v) => onUpdate({ heading: v })} maxLength={200} placeholder="Join the founding members" />
      </Field>
      <Field label="Sub-copy" hint="Paragraph under the heading.">
        <Textarea value={block.subtext || ''} onChange={(v) => onUpdate({ subtext: v })} maxLength={600} rows={3} />
      </Field>
      <Field label="Button label">
        <Input value={block.button_label || ''} onChange={(v) => onUpdate({ button_label: v })} maxLength={60} placeholder="Join the waitlist" />
      </Field>
      <Field label="Success message" hint="Shown after a successful submit.">
        <Textarea value={block.success_message || ''} onChange={(v) => onUpdate({ success_message: v })} maxLength={300} rows={2} />
      </Field>
      <Field label="Consent checkbox text" hint="Shown beside the opt-in checkbox. Keep it explicit for GDPR — name the channels (email/SMS/WhatsApp).">
        <Textarea value={block.consent_label || ''} onChange={(v) => onUpdate({ consent_label: v })} maxLength={400} rows={3} />
      </Field>
    </>
  )
}
```
(`tag`/`lead_source` are intentionally NOT exposed in v1 — they default to `hatch-founding-member`/`hatch_launch` and are resolved server-side. Add an "advanced" sub-section later if a second campaign needs different values.)

- [ ] **Step 4: Lint**

Run: `npx eslint src/components/LandingPageSettingsForm.jsx`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/LandingPageSettingsForm.jsx
git commit -m "feat(landing editor): LeadFormEdit panel for the lead_form block

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `POST /api/public/leads` endpoint

**Files:**
- Create: `src/app/api/public/leads/route.js`

(No unit test — public route reusing already-tested helpers; the pure bits are covered in Task 1. Verified by build + manual in Task 7.)

- [ ] **Step 1: Create the route**

Create `src/app/api/public/leads/route.js`:
```js
// POST /api/public/leads — public waitlist / lead capture.
//
// Mirrors the /api/public/events lead_gen branch but with no event:
// capture name+email+phone+consent, create the contact at the studio
// (resolved server-side from public_path), record marketing consent,
// stamp the nurture tag, and open a new_lead deal so it shows in the
// pipeline. No auth; rate-limited + honeypot like the other public forms.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { LeadSchema, normaliseLead, leadConfigFromBlocks } from '@/lib/leads'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { writeContactTag } from '@/lib/contact-tags'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

export async function POST(request) {
  const db = createServerClient()
  const ip = getClientIp(request)

  const limit = await checkRateLimit(db, `lead:${ip}`, { max: 8, windowMs: 15 * 60_000 })
  if (!limit.allowed) {
    return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes and try again.')
  }

  const validation = await validateBody(request, LeadSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Honeypot — bots fill `company`; humans never see it. Pretend success
  // so the bot gets no signal, but write nothing.
  if (body.company && body.company.trim().length > 0) {
    return NextResponse.json({ success: true, data: { already_on_list: false } })
  }

  const { firstName, email, phone, publicPath } = normaliseLead(body)

  // Resolve the studio + its lead-form config from public_path. The
  // client never sends a location_id or the tag/source, so a caller
  // can't target an arbitrary location or inject arbitrary tags.
  const { data: page } = await db
    .from('landing_page_settings')
    .select('location_id, blocks')
    .eq('public_path', publicPath)
    .maybeSingle()
  if (!page || !page.location_id) {
    return NextResponse.json({ success: false, error: 'This studio is not accepting sign-ups right now.' }, { status: 400 })
  }
  const locationId = page.location_id
  const { tag, leadSource } = leadConfigFromBlocks(page.blocks)

  // Find-or-create the contact at this studio (shared public-form helper).
  const contactId = await findOrCreateRaceContact({ db, locationId, email, name: firstName, phone })
  if (!contactId) {
    return NextResponse.json({ success: false, error: 'Could not capture your details. Please try again.' }, { status: 500 })
  }

  // Stamp lead_source only when the contact has none yet (don't clobber
  // a richer existing attribution). Best-effort.
  try {
    await db.from('contacts').update({ lead_source: leadSource }).eq('id', contactId).is('lead_source', null)
  } catch (e) { logWarn('leads', 'lead_source set failed', { err: e }) }

  // Marketing consent (best-effort; helper short-circuits ClassPass).
  try {
    const { applyFormMarketingConsent } = await import('@/lib/marketing-consent')
    await applyFormMarketingConsent(db, { contactId, consent: true, source: 'waitlist_form', ipAddress: ip })
  } catch (e) { logWarn('leads', 'consent write failed', { err: e }) }

  // Nurture-seam tag (idempotent; fires tag_added sequences exactly once).
  let alreadyOnList = false
  try {
    const r = await writeContactTag(db, { contactId, locationId, tag })
    alreadyOnList = !!r.alreadyPresent
  } catch (e) { logWarn('leads', 'tag write failed', { err: e }) }

  // Open a new_lead deal so the lead shows in the pipeline. Direct +
  // deterministic (a brand-new web lead is unambiguously new_lead);
  // skip when the contact already has an open deal. Best-effort.
  try {
    const { data: openDeal } = await db.from('deals').select('id').eq('contact_id', contactId).eq('status', 'open').maybeSingle()
    if (!openDeal) {
      const { data: stage } = await db.from('pipeline_stages').select('id').eq('location_id', locationId).eq('slug', 'new_lead').maybeSingle()
      if (stage) {
        await db.from('deals').insert({ title: firstName || 'Website lead', contact_id: contactId, stage_id: stage.id, location_id: locationId, status: 'open' })
      }
    }
  } catch (e) { logWarn('leads', 'deal create failed', { err: e }) }

  return NextResponse.json({ success: true, data: { already_on_list: alreadyOnList } })
}
```

- [ ] **Step 2: Lint**

Run: `npx eslint src/app/api/public/leads/route.js`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/public/leads/route.js
git commit -m "feat(api): POST /api/public/leads — waitlist capture (contact + consent + tag + new_lead deal)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Verify, build, ship

**Files:** none (verification + PR).

- [ ] **Step 1: Full CI mirror + production build**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run build
```
Expected: tests PASS (incl. the new `leads` + `landing-page-blocks` tests), lint clean (a pre-existing `ChooserEditorForm` line-207 `no-img-element` warning may remain — unrelated), parity + imports clean, `next build` succeeds. The build is the gate for the new cross-module imports (`@/lib/leads`, `@/components/WaitlistWidget`, the route's helper imports).

- [ ] **Step 2: Manual end-to-end (local `npm run dev` or a Vercel preview)**

1. As master/owner, go to **Settings → Landing Page → a studio page** (Hatch Street). Click **+ Add section → Lead form**. Confirm the `LeadFormEdit` panel shows (heading / sub-copy / button / success / consent) and edits persist on **Save**.
2. View the studio page (`/welcome/hatch-street`, or `/hatch-street` on the marketing host) and confirm the form renders with your copy.
3. Submit a real test lead. Confirm in the CRM:
   - a **contact** exists at Hatch with that email/phone, `lead_source=hatch_launch`,
   - it has a **`new_lead` deal** (shows in the pipeline),
   - it carries the **`hatch-founding-member`** tag,
   - `contact_preferences` has the three `_marketing` flags TRUE and a `consent_log` row (source `waitlist_form`).
4. **Re-submit the same email** → no duplicate contact/deal; still success.
5. **Blank-consent / blank-name** submit → rejected (client `required` + server 400).
6. **Honeypot:** via devtools, set the hidden `company` field to any text and submit → returns success but **no contact is written**.

> Local host note: to exercise `/hatch-street` (pretty path) locally set `MARKETING_HOSTNAMES=localhost` in `.env.local`; `/welcome/hatch-street` works without it. Revert any local env change after.

- [ ] **Step 3: Push**

```bash
git push -u origin hatch-waitlist-lead-form
```

- [ ] **Step 4: Open the PR** (per `CLAUDE.md` ship loop)

```bash
TOKEN=$(git config --get remote.origin.url | sed -E 's|.*x-access-token:([^@]+)@.*|\1|')
curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/ivers9307-cyber/un1t-crm/pulls \
  -d @- <<'JSON' | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('html_url') or r.get('message') or r)"
{
  "title": "LEADFORM.1 — Hatch Street waitlist lead-capture block + /api/public/leads",
  "head": "hatch-waitlist-lead-form",
  "base": "main",
  "body": "Adds a reusable **lead_form** landing-page block + **POST /api/public/leads** that captures a founding-member waitlist lead (name/email/phone + consent) as a Hatch **new_lead** with marketing consent + a **hatch-founding-member** tag (the nurture seam — a sequence can be attached later with zero code). Reuses the existing public-form helpers (findOrCreateRaceContact / applyFormMarketingConsent / writeContactTag); resolves the studio + tag/source server-side from public_path. Honeypot + rate-limit. **No migration.** Spec + plan under docs/superpowers/.\n\nVerified: unit tests (leads + block factory) · lint · parity · imports · build · manual end-to-end (submit → Hatch new_lead with tag + consent; dedupe; honeypot).\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"
}
JSON
```
Report the PR URL.

---

## Self-Review (completed by plan author)

**1. Spec coverage** — every spec section maps to a task:
- `lead_form` block + factory → Task 2; renderer + `publicPath` → Task 4; editor panel → Task 5.
- `POST /api/public/leads` (rate-limit, honeypot, resolve-from-public_path, find-or-create contact, consent, tag, new_lead deal, dedupe) → Task 6, with the pure schema/config in Task 1.
- Consent (single all-channel, `consent_log`) → `applyFormMarketingConsent(source:'waitlist_form')` in Task 6; checkbox in Task 3.
- Nurture seam (tag + lead_source + new_lead) → Task 6 (`writeContactTag` + deal).
- No migration → confirmed (no Task creates one).
- Spam (honeypot + rate-limit, no captcha) → Tasks 3 + 6.
- Tests → Tasks 1 + 2; build/manual → Task 7.

**2. Placeholder scan** — no TBD/TODO; every code step has complete code or an exact command.

**3. Type/name consistency** — `LeadSchema` / `normaliseLead` / `leadConfigFromBlocks` / `DEFAULT_LEAD_TAG` / `DEFAULT_LEAD_SOURCE` defined in Task 1 and imported identically in Task 6. Block field names (`heading`, `subtext`, `button_label`, `success_message`, `consent_label`, `tag`, `lead_source`) match across the factory (Task 2), the renderer + widget props (Tasks 3–4), and the editor panel (Task 5). `WaitlistWidget` props (`publicPath`, `buttonLabel`, `successMessage`, `consentLabel`) match between `LeadFormBlock` (Task 4) and the component (Task 3). The POST body keys (`first_name`, `email`, `phone`, `consent`, `public_path`, `company`) match between the widget (Task 3) and `LeadSchema` (Task 1).
