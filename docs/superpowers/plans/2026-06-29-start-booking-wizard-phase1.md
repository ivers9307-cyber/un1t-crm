# `/start` Booking Wizard — Phase 1 (Consultation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public `/start` page where a Meta-ad lead books a **free consultation** (choose → details → pick a slot → confirm) and receives a **WhatsApp confirmation**, attributed as a `meta_book` lead.

**Architecture:** A new client wizard (`StartFunnel.jsx`) drives the brief's step order (choose → details → calendar) by calling the **existing** public booking APIs (`/api/public/bookings/[slug]`, `/slots`, `POST /api/public/book`). The consultation booking is created by the existing endpoint; a new best-effort automation sends a WhatsApp confirmation (template `booking_consult_confirmed`) when the booking carries `source='meta_book'`. The class option is shown but disabled ("coming soon") until Phase 2.

**Tech Stack:** Next.js 16 App Router (server page + client island), React 19, Tailwind, Vitest, Supabase (service-role API routes), WhatsApp Cloud API (reusing the PR #707 send pattern).

**Spec:** `docs/superpowers/specs/2026-06-29-start-booking-wizard-design.md`

**Branch:** work on `start-booking-wizard` (this branch). It stacks conceptually on PR #706/#707 but Phase 1 touches none of their files except `src/lib/whatsapp.js` (read-only reuse), so it can target `main` directly.

---

## File Structure

- **Create** `src/lib/automations/booking-whatsapp-confirm.js` — `maybeSendBookingWhatsappConfirm()`: resolve an APPROVED UTILITY template at the location, send a body-only confirmation to the lead's E.164 phone, log to the inbox. Reused by Phase 2 for class confirmations.
- **Create** `src/lib/automations/booking-whatsapp-confirm.test.js` — unit tests (guards + happy path, WhatsApp layer mocked).
- **Modify** `src/app/api/public/book/route.js` — after a successful booking, fire `maybeSendBookingWhatsappConfirm` as a best-effort side effect when `body.source === 'meta_book'`.
- **Create** `src/components/StartFunnel.jsx` — the client wizard (choose → details → calendar → confirmed).
- **Create** `src/app/start/page.js` — public server page; renders `StartFunnel` inside the shared landing chrome; `noindex`.
- **Modify** `src/lib/brands.js` — allowlist `/start` (un1t-marketing brand).
- **Modify** `src/proxy.js` — allowlist `/start` (default publicPaths).
- **Modify** `src/components/AppShell.jsx` — allowlist `/start` (PUBLIC_PATHS).

---

## Task 1: WhatsApp booking-confirmation automation

**Files:**
- Create: `src/lib/automations/booking-whatsapp-confirm.js`
- Test: `src/lib/automations/booking-whatsapp-confirm.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/automations/booking-whatsapp-confirm.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp', () => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.OK', status: 'sent' })),
  getOrCreateConversation: vi.fn(async () => 'conv-1'),
}))

import { maybeSendBookingWhatsappConfirm } from './booking-whatsapp-confirm'
import { sendTemplateMessage } from '@/lib/whatsapp'

function makeDb(template) {
  return {
    from(tbl) {
      if (tbl === 'whatsapp_templates') {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: template }) }) }) }) }
      }
      if (tbl === 'contacts') return { update: () => ({ eq: () => ({ is: async () => ({}) }) }) }
      if (tbl === 'whatsapp_messages') return { insert: async () => ({}) }
      return {}
    },
  }
}
const APPROVED = { name: 'booking_consult_confirmed', status: 'APPROVED', language: 'en' }

beforeEach(() => vi.clearAllMocks())

describe('maybeSendBookingWhatsappConfirm', () => {
  it('no template name → noop', async () => {
    const r = await maybeSendBookingWhatsappConfirm({ db: makeDb(null), locationId: 'L', contact: { phone: '0871234567' }, templateName: null, bodyParams: ['Sarah'] })
    expect(r).toEqual({ sent: false, reason: 'no_template_configured' })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })
  it('no phone → noop', async () => {
    const r = await maybeSendBookingWhatsappConfirm({ db: makeDb(APPROVED), locationId: 'L', contact: {}, templateName: 'booking_consult_confirmed', bodyParams: ['Sarah'] })
    expect(r).toEqual({ sent: false, reason: 'no_phone' })
  })
  it('template not APPROVED → noop', async () => {
    const r = await maybeSendBookingWhatsappConfirm({ db: makeDb({ ...APPROVED, status: 'PENDING' }), locationId: 'L', contact: { phone: '0871234567' }, templateName: 'booking_consult_confirmed', bodyParams: ['Sarah'] })
    expect(r).toEqual({ sent: false, reason: 'template_PENDING' })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })
  it('happy path → sends to E.164 with body params', async () => {
    const r = await maybeSendBookingWhatsappConfirm({
      db: makeDb(APPROVED), locationId: 'a0000000-0000-0000-0000-000000000001',
      contact: { id: 'c1', first_name: 'Sarah', phone: '0871234567', wa_phone: null },
      templateName: 'booking_consult_confirmed', bodyParams: ['Sarah', 'Tue 8 Jul, 6:30pm'],
    })
    expect(r).toEqual({ sent: true, messageId: 'wamid.OK' })
    expect(sendTemplateMessage).toHaveBeenCalledWith(
      '+353871234567', 'booking_consult_confirmed', 'en',
      [{ type: 'body', parameters: [{ type: 'text', text: 'Sarah' }, { type: 'text', text: 'Tue 8 Jul, 6:30pm' }] }],
      { locationId: 'a0000000-0000-0000-0000-000000000001' },
    )
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/lib/automations/booking-whatsapp-confirm.test.js`
Expected: FAIL — `Failed to resolve import './booking-whatsapp-confirm'`.

- [ ] **Step 3: Write the implementation**

```javascript
// src/lib/automations/booking-whatsapp-confirm.js
// Best-effort WhatsApp booking confirmation for campaign booking pages
// (/start). Sent as a UTILITY template (no 24h window after a web booking),
// straight to the lead's normalised phone, then wa_phone is backfilled so
// the message logs to a conversation and any reply routes to Mia. Mirrors
// the send pattern in meta-ad-whatsapp-welcome.js. Never throws.

import { toE164Ireland } from '@/lib/twilio'
import { sendTemplateMessage, getOrCreateConversation } from '@/lib/whatsapp'
import { logWarn } from '@/lib/log'

export async function maybeSendBookingWhatsappConfirm({ db, locationId, contact, templateName, bodyParams = [] }) {
  try {
    if (!templateName) return { sent: false, reason: 'no_template_configured' }
    if (!contact?.phone) return { sent: false, reason: 'no_phone' }

    const waPhone = toE164Ireland(contact.phone)
    if (!waPhone || !/^\+\d{10,15}$/.test(waPhone)) return { sent: false, reason: 'unnormalisable_phone' }

    const { data: template } = await db
      .from('whatsapp_templates').select('*')
      .eq('name', templateName).eq('location_id', locationId).maybeSingle()
    if (!template) return { sent: false, reason: 'template_not_found' }
    if (template.status !== 'APPROVED') return { sent: false, reason: `template_${template.status}` }

    const components = [{
      type: 'body',
      parameters: bodyParams.map((v) => ({ type: 'text', text: (v == null || v === '') ? ' ' : String(v) })),
    }]

    const result = await sendTemplateMessage(waPhone, template.name, template.language || 'en', components, { locationId })

    if (!contact.wa_phone) {
      try { await db.from('contacts').update({ wa_phone: waPhone }).eq('id', contact.id).is('wa_phone', null) }
      catch (e) { logWarn('booking-wa-confirm', 'wa_phone backfill failed', { err: e }) }
      contact = { ...contact, wa_phone: waPhone }
    }
    try {
      const conversationId = await getOrCreateConversation(db, contact, locationId)
      if (conversationId && result?.messageId) {
        await db.from('whatsapp_messages').insert({
          conversation_id: conversationId, contact_id: contact.id, location_id: locationId,
          wa_message_id: result.messageId, direction: 'outbound', message_type: 'template',
          template_name: template.name, body: bodyParams.join(' · '),
          status: 'sent', sent_at: new Date().toISOString(),
        })
      }
    } catch (e) { logWarn('booking-wa-confirm', 'inbox log failed', { err: e }) }

    return { sent: true, messageId: result?.messageId || null }
  } catch (e) {
    logWarn('booking-wa-confirm', 'send failed', { err: e })
    return { sent: false, reason: 'send_failed' }
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/lib/automations/booking-whatsapp-confirm.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/automations/booking-whatsapp-confirm.js src/lib/automations/booking-whatsapp-confirm.test.js
git commit -m "feat(start): WhatsApp booking-confirmation automation"
```

---

## Task 2: Fire the WhatsApp confirm from the public booking endpoint

**Files:**
- Modify: `src/app/api/public/book/route.js`

- [ ] **Step 1: Read the route** to find where the booking row + contact are available after insert and where existing confirmation side-effects (`sendBookingConfirmation`) are triggered. Insert the new side-effect immediately after them, before the JSON response.

- [ ] **Step 2: Add the fire-and-forget WhatsApp confirm**

After the existing confirmation/sequence side-effects and before `return NextResponse.json(...)`, add (adapt variable names to the route's actual locals for the inserted booking row and resolved `location_id`):

```javascript
  // Campaign WhatsApp confirmation (the /start funnel sends source='meta_book').
  // Best-effort; never blocks the booking response. UTILITY template; Dublin
  // day/time formatted the same way as the email/SMS confirmation.
  try {
    if (body.source === 'meta_book' && booking?.contact_id) {
      const { fmtBookingTime } = await import('@/lib/booking-confirmations')
      const { maybeSendBookingWhatsappConfirm } = await import('@/lib/automations/booking-whatsapp-confirm')
      const { data: c } = await db.from('contacts')
        .select('id, first_name, name, phone, wa_phone').eq('id', booking.contact_id).maybeSingle()
      if (c) {
        const firstName = c.first_name || (c.name ? c.name.split(' ')[0] : '') || 'there'
        const whenLabel = fmtBookingTime(booking.booking_date, booking.start_time)
        await maybeSendBookingWhatsappConfirm({
          db, locationId: booking.location_id, contact: c,
          templateName: 'booking_consult_confirmed', bodyParams: [firstName, whenLabel],
        })
      }
    }
  } catch (e) { logWarn('book', 'whatsapp confirm failed', { err: e }) }
```

(If `fmtBookingTime` is not exported from `booking-confirmations.js`, export it in that file as part of this task. If `logWarn` isn't already imported in the route, add `import { logWarn } from '@/lib/log'`.)

- [ ] **Step 3: Verify the build resolves**

Run: `npx next build` (or rely on the Vercel PR check if a local build isn't available — note which in the commit).
Expected: build succeeds; no unresolved imports.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/public/book/route.js src/lib/booking-confirmations.js
git commit -m "feat(start): WhatsApp confirm on meta_book consultations"
```

---

## Task 3: Allowlist `/start` on all three public gates

**Files:**
- Modify: `src/lib/brands.js`, `src/proxy.js`, `src/components/AppShell.jsx`

- [ ] **Step 1: brands.js** — in the `un1t-marketing` brand's `allowedPaths`, add after `/hatch-street`:

```javascript
      '/start',         // Meta-ad booking wizard (src/app/start)
```

- [ ] **Step 2: proxy.js** — add `'/start'` to the default `publicPaths` array (next to `/welcome`).

- [ ] **Step 3: AppShell.jsx** — add `'/start'` to `PUBLIC_PATHS` (next to `/hatch-street`).

- [ ] **Step 4: Commit**

```bash
git add src/lib/brands.js src/proxy.js src/components/AppShell.jsx
git commit -m "feat(start): allowlist /start on brand, proxy, and AppShell gates"
```

---

## Task 4: The `StartFunnel` wizard component

**Files:**
- Create: `src/components/StartFunnel.jsx`

The wizard: **choose** (consultation enabled; class disabled "coming soon") → **details** (first/last/email/phone + consent) → **Next** → **calendar** (day picker + slot list from the public booking APIs) → **confirmed**. Posts to `POST /api/public/book` with `source: 'meta_book'`.

- [ ] **Step 1: Create the component** (complete code)

```jsx
'use client'

// /start booking funnel. Brief's step order: choose path → details → pick a
// slot → confirmed. Reuses the existing public booking APIs (no new booking
// endpoint). Class option is "coming soon" until Phase 2. On success the
// booking endpoint also fires a WhatsApp confirmation (source='meta_book').

import { useState, useEffect } from 'react'

const CONSULT_SLUG = 'free-un1t-consultation'

function dayList(maxAdvanceDays = 30) {
  // Next ~14 selectable days as YYYY-MM-DD (Dublin wall-clock, no UTC math).
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit' })
  const label = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short' })
  const out = []
  const base = Date.now()
  for (let i = 0; i < Math.min(14, maxAdvanceDays); i++) {
    const d = new Date(base + i * 86400000)
    out.push({ date: fmt.format(d), label: label.format(d) })
  }
  return out
}

const inputCls = 'w-full bg-white/[0.06] border border-white/15 rounded-xl px-4 py-3.5 text-base text-white placeholder-white/40 focus:outline-none focus:border-white/50'

export default function StartFunnel() {
  const [step, setStep] = useState('choose') // choose | details | calendar | done
  const [path, setPath] = useState(null)     // 'consultation'
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', consent: false })
  const [event, setEvent] = useState(null)
  const [days] = useState(() => dayList())
  const [selectedDate, setSelectedDate] = useState(null)
  const [slots, setSlots] = useState([])
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  // Load the consultation event once the user has chosen the consult path.
  useEffect(() => {
    if (path !== 'consultation') return
    fetch(`/api/public/bookings/${CONSULT_SLUG}`).then((r) => r.json()).then((j) => { if (j.success) setEvent(j.data) }).catch(() => {})
  }, [path])

  async function loadSlots(date) {
    setSelectedDate(date); setSlots([]); setSlotsLoading(true)
    try {
      const r = await fetch(`/api/public/bookings/${CONSULT_SLUG}/slots?date=${date}`)
      const j = await r.json()
      setSlots(j.success ? (j.data.slots || []) : [])
    } catch { setSlots([]) } finally { setSlotsLoading(false) }
  }

  function chooseConsult() { setPath('consultation'); setStep('details') }

  function detailsNext(e) {
    e.preventDefault()
    setError(null)
    if (!form.first_name.trim() || !form.last_name.trim() || !form.email.trim() || form.phone.replace(/\D/g, '').length < 7 || !form.consent) {
      setError('Please complete every field and tick consent.'); return
    }
    setStep('calendar')
  }

  async function book(slot) {
    if (submitting || !event) return
    setSubmitting(true); setError(null)
    try {
      const r = await fetch('/api/public/book', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type_id: event.id, booking_date: selectedDate, start_time: slot.start,
          customer_name: `${form.first_name.trim()} ${form.last_name.trim()}`.trim(),
          customer_email: form.email.trim(), customer_phone: form.phone.trim(),
          marketing_consent: form.consent, source: 'meta_book',
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) { setError(j.error || 'That slot was just taken — pick another.'); return }
      setStep('done')
    } catch { setError('Something went wrong. Please try again.') } finally { setSubmitting(false) }
  }

  if (step === 'done') {
    return (
      <div className="max-w-md mx-auto px-6 py-16 text-center">
        <p className="font-display font-extrabold uppercase text-3xl text-white mb-3">You&apos;re booked 🎉</p>
        <p className="text-white/70">We&apos;ve sent a WhatsApp confirming your consultation. See you at UN1T Stillorgan!</p>
      </div>
    )
  }

  return (
    <div className="max-w-xl mx-auto px-6 py-12 text-white">
      {step === 'choose' && (
        <div className="space-y-4">
          <h1 className="font-display font-extrabold uppercase text-3xl mb-6">How do you want to start?</h1>
          <button onClick={chooseConsult} className="w-full text-left rounded-2xl border-2 border-white/20 hover:border-white p-6 transition-colors">
            <div className="font-bold text-lg">Book a free consultation</div>
            <div className="text-white/60 text-sm mt-1">Meet a coach, talk goals, get a plan.</div>
          </button>
          <div className="w-full text-left rounded-2xl border-2 border-white/10 p-6 opacity-50 cursor-not-allowed">
            <div className="font-bold text-lg">Book a free class <span className="text-xs uppercase tracking-wider ml-2 text-white/50">Coming soon</span></div>
            <div className="text-white/50 text-sm mt-1">Jump straight into a session.</div>
          </div>
        </div>
      )}

      {step === 'details' && (
        <form onSubmit={detailsNext} className="space-y-3.5">
          <h1 className="font-display font-extrabold uppercase text-2xl mb-4">Your details</h1>
          <input className={inputCls} placeholder="First name" value={form.first_name} onChange={set('first_name')} maxLength={120} autoComplete="given-name" />
          <input className={inputCls} placeholder="Last name" value={form.last_name} onChange={set('last_name')} maxLength={120} autoComplete="family-name" />
          <input className={inputCls} type="email" placeholder="Email" value={form.email} onChange={set('email')} maxLength={320} autoComplete="email" />
          <input className={inputCls} type="tel" placeholder="Phone" value={form.phone} onChange={set('phone')} maxLength={50} autoComplete="tel" />
          <label className="flex items-start gap-2.5 text-xs text-white/65 pt-1">
            <input type="checkbox" checked={form.consent} onChange={set('consent')} className="mt-0.5 w-4 h-4 accent-white" />
            <span>I&apos;d like to hear from UN1T Stillorgan by email, SMS and WhatsApp. <a href="/privacy" target="_blank" rel="noreferrer" className="underline">Privacy</a></span>
          </label>
          {error && <p className="text-sm text-red-300">{error}</p>}
          <button type="submit" className="lp-btn w-full">Next →</button>
        </form>
      )}

      {step === 'calendar' && (
        <div>
          <h1 className="font-display font-extrabold uppercase text-2xl mb-4">Pick a time</h1>
          <div className="flex gap-2 overflow-x-auto pb-3 mb-4">
            {days.map((d) => (
              <button key={d.date} onClick={() => loadSlots(d.date)}
                className={`shrink-0 px-4 py-3 rounded-xl border-2 text-sm ${selectedDate === d.date ? 'border-white bg-white text-black' : 'border-white/20 text-white'}`}>
                {d.label}
              </button>
            ))}
          </div>
          {!selectedDate && <p className="text-white/50 text-sm">Choose a day to see available times.</p>}
          {slotsLoading && <p className="text-white/50 text-sm">Loading times…</p>}
          {selectedDate && !slotsLoading && slots.length === 0 && <p className="text-white/50 text-sm">No times left that day — try another.</p>}
          <div className="grid grid-cols-3 gap-2">
            {slots.map((s) => (
              <button key={s.start} disabled={submitting} onClick={() => book(s)}
                className="px-3 py-3 rounded-xl border-2 border-white/20 hover:border-white text-sm disabled:opacity-50">
                {s.start}
              </button>
            ))}
          </div>
          {error && <p className="text-sm text-red-300 mt-3">{error}</p>}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/StartFunnel.jsx
git commit -m "feat(start): StartFunnel booking wizard (consultation path)"
```

---

## Task 5: The `/start` public page

**Files:**
- Create: `src/app/start/page.js`

- [ ] **Step 1: Create the page** (complete code)

```jsx
// /start — public Meta-ad booking wizard (Stillorgan). Renders the
// StartFunnel client island inside the shared dark landing chrome.
// Allowlisted in brands.js (un1t-marketing) + proxy.js + AppShell.
// noindex: a paid funnel shouldn't compete in organic search.

import StartFunnel from '@/components/StartFunnel'

const STILLORGAN_LOGO =
  'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/landing-page/a0000000-0000-0000-0000-000000000001/de12ffbe-22db-4c34-b307-8983488ffd96.png'

export const metadata = {
  title: 'Book your free start — UN1T Stillorgan',
  description: 'Book a free consultation at UN1T Stillorgan — coach-led strength & conditioning.',
  robots: { index: false, follow: false },
}

export default function StartPage() {
  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <header className="border-b border-white/10">
        <div className="max-w-6xl mx-auto px-6 py-4">
          <img src={STILLORGAN_LOGO} alt="UN1T Stillorgan" width={150} className="h-8 w-auto" />
        </div>
      </header>
      <StartFunnel />
    </div>
  )
}
```

- [ ] **Step 2: Verify the build resolves**

Run: `npx next build` (or rely on the Vercel PR check).
Expected: `/start` route compiles; imports resolve.

- [ ] **Step 3: Commit**

```bash
git add src/app/start/page.js
git commit -m "feat(start): /start public page"
```

---

## Task 6: End-to-end verification (manual, after deploy/preview)

- [ ] **Step 1:** Open the Vercel preview at `/start`. Confirm: choose-step shows (class is disabled "coming soon"); choosing consult → details → Next → day picker loads; selecting a day loads real slots from the live consultation event.
- [ ] **Step 2:** Complete a booking with a **real phone number you control**. Confirm: the "You're booked" screen shows, a `bookings` row is created (check `/bookings` in the CRM), and a **WhatsApp confirmation** arrives (requires the `booking_consult_confirmed` template APPROVED — see preconditions).
- [ ] **Step 3:** Confirm the contact shows `lead_source` / source attribution for the booking and a `new_lead` deal opened.
- [ ] **Step 4:** Note any issues; fix-forward in a follow-up task.

**Preconditions for Step 2:** operator has created + Meta has APPROVED the UTILITY template `booking_consult_confirmed` (content in the spec). Until then, the booking still works; only the WhatsApp send no-ops (`template_not_found`/`template_PENDING`).

---

## Self-Review

- **Spec coverage:** wizard + choose-step (Task 4) ✓; consultation path via existing APIs (Task 4) ✓; WhatsApp confirm (Tasks 1–2) ✓; attribution `source='meta_book'` (Task 4 → booking trigger sets contact/deal) ✓; public allowlists + noindex (Tasks 3, 5) ✓; class option deferred/"coming soon" per phasing (Task 4) ✓. Class path, queue/cron, decision tree = **Phase 2 (separate plan)**, intentionally out of scope here.
- **Placeholder scan:** none — every code step is complete.
- **Type/name consistency:** `maybeSendBookingWhatsappConfirm({ db, locationId, contact, templateName, bodyParams })` is defined identically in Task 1 and called in Task 2; template name `booking_consult_confirmed` consistent; `source: 'meta_book'` consistent across the funnel POST (Task 4) and the booking-route guard (Task 2).

---

## Phase 2 (separate plan, later)

Class path: `GET /api/public/classes` (live Glofox list), the `class_booking_requests` queue table + `process-class-bookings` drain cron, the account/credit/"attended-before" decision tree, `booking_class_confirmed` WhatsApp template, and `/approvals` integration for review/failures. Enable the class option in `StartFunnel`.
