'use client'

// PaidTrialFunnel — PAIDTRIAL.1 / TRIALSTUDIO.10: the buyer's side of the paid
// trial (/trial), in one card (TRIALFIRST.1: `./trial-card`, the look the
// studio pages' heroes share; CLASSFIRST.1: the /50plus recipe). The buyer
// chooses a studio first (TrialStudioPicker; `?studio=` preselects a sellable
// one), then CLASSFIRST.1's class step (ClassPickStep over the studio's
// visible timetable: the class they will be booked into once the trial is on
// their account; an empty or unreadable timetable offers "continue without a
// class"), then the price panel with the form (details → POST
// /api/public/trial-purchases with the studio and the chosen `event_id`; a
// class that filled meanwhile answers class_unavailable and the card returns
// to the tiles with the details kept). Then, by studio:
//   Stillorgan: the embedded checkout (ClassFunnelCheckout against the trial
//     status route), then done.
//   Hatch Street: un1t.online's terms tick on the form, and the browser goes
//     to un1t.online's own hosted checkout (`redirect_url`). The return
//     (?purchase=<id>&studio=hatch) confirms off the status route; the cron
//     settles the row off the un1t.online mirror, so after the poll budget the
//     screen says the payment is being confirmed (the block's pending_body),
//     never "it's on your account" before it is. `?cancelled=1` is back to
//     the form with the studio chosen.
//   A refusal (trial_used at Stillorgan, active_member at Hatch) shows the
//   studio's message and one help button, which files a staff card
//   (POST /api/public/trial-purchases/help) and shows its thanks. help_filed
//   (the server already filed one) goes straight to the thanks.
// Every studio-specific word is the studio's paid_trial block or the server's
// answer.
//
// TRIALFIRST.1, for a studio page's hero: given ONE studio there is no
// "Change studio" (and an unsellable one shows the picker's disabled tile
// with the not-available line); `returnPath` goes to the POST as
// `return_path`, so a checkout comes back to the page it started on (the
// server allows /trial, /stillorgan, /hatch-street); `preview` is the
// operator's editor: the form renders disabled, posts nothing, tracks nothing.
//
// What it tells Meta (no-ops without consent / fbq): the browser Lead at the
// POST, sharing the server's event id so Meta counts one, and (TRIALCHECKOUT.1)
// an InitiateCheckout at the same moment with the price, sharing
// `trialcheckout-<lead id>` with the server's copy: the Sales campaign's ad set
// optimises on it, since Meta's Sales objective cannot optimise on Lead. A
// refused buyer was still captured, so gets the Lead alone. The browser
// Purchase fires once on paid (Stillorgan) or granted (both), sharing
// `trialpurchase-<id>` with the server's CAPI Purchase for the same reason.
// Funnel steps go out as custom `trial_*` events for drop-off diagnostics,
// never as optimisation events.
//
// TRIALLEAK.1 — a checkout survives the browser. Most buyers arrive from a Meta
// ad inside Facebook's or Instagram's in-app browser, which reloads the page
// on the way back from a banking app:
//   - entering the payment step puts `?purchase=<id>` in the URL (the other
//     params kept); a load with it for a Stillorgan row that still awaits
//     payment (`resumable` on the status route) puts the embedded checkout
//     back, after two polls in case the money is already on its way;
//   - a pending Stillorgan return never spins for ever: after the poll budget
//     the buyer is told and handed back to try again;
//   - a failed or timed-out order (the checkout's own poll, or the confirming
//     poll) returns to the form with the details kept. They are also kept in
//     sessionStorage for this tab, so a reload or a cancelled Hatch checkout
//     (`?cancelled=1`) comes back to a filled form and a plain message;
//   - inside Facebook or Instagram the payment step says a wallet button may
//     not show and offers a link to copy, which resumes in Safari or Chrome.
import { useEffect, useRef, useState } from 'react'
import { trackFunnelStep } from '@/lib/funnel-track'
import { readVisitOrigin } from '@/lib/visit-origin'
import { newLeadEventId, pixelUserData, fireBrowserLead, fireBrowserInitiateCheckout, checkoutEventIdFor } from '@/lib/meta-pixel-lead'
import { metaPixelIdsForPath, pageLocationIdFromDocument } from '@/lib/meta-pixel-paths'
import { isValidMobileNumber } from '@/lib/phone-validate'
import { formatTrialPrice, trialTicks, PAID_TRIAL_PENDING_BODY } from '@/lib/paid-trial'
import ClassFunnelCheckout from './ClassFunnelCheckout'
import TrialStudioPicker from './TrialStudioPicker'
import TrialTermsTick from './TrialTermsTick'
import ClassPickStep, { useClassList, ctaLabelFor } from './ClassPickStep'
import { TRIAL_CARD, TRIAL_INPUT, TRIAL_BTN, TRIAL_MUTED, TRIAL_FINE, TRIAL_ERROR, TRIAL_LINK, TRIAL_SUMMARY } from './trial-card'
import { customerErrorText } from '@/lib/page-request-errors'
import { classFirstStepCopy, classLine } from '@/lib/class-first-funnel'
import { inAppBrowserFromUserAgent } from '@/lib/trial-checkout-window'
import { readAttributionFromUrl, buildAttribution as buildAdAttribution } from '@/lib/campaign-funnel-attribution'

const STATUS_PATH = '/api/public/trial-purchases'
const HELP_PATH = '/api/public/trial-purchases/help'
const REFUSALS = new Set(['trial_used', 'active_member'])
// TRIALLEAK.1 — polls spent on "is the money already on its way?" before a
// still-unpaid Stillorgan return gets its checkout back.
const RESUME_AFTER_POLLS = 2
const DRAFT_KEY = 'trial_checkout_draft'
const INCOMPLETE_TEXT = "Your checkout wasn't completed. Nothing was charged. You can try again whenever you're ready."
const DECLINED_TEXT = 'That payment did not go through. Nothing was charged; please try again.'
const UNCONFIRMED_TEXT = 'We have not received a payment for that checkout. If you did pay, your confirmation email is on its way; otherwise please try again.'
const IN_APP_NAMES = { facebook: 'Facebook', instagram: 'Instagram' }

// The buyer's typed details and class, for this tab only: a reload (or a
// cancelled Hatch checkout) comes back to a filled form. Storage may throw.
function saveDraft(draft) {
  try { window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)) } catch { /* private mode */ }
}
function readDraft() {
  try {
    const d = JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) || 'null')
    return d && typeof d === 'object' && d.form && typeof d.form === 'object' ? d : null
  } catch { return null }
}
function clearDraft() {
  try { window.sessionStorage.removeItem(DRAFT_KEY) } catch { /* private mode */ }
}
const hasDetails = (f) => Boolean(f && String(f.first_name || '').trim() && String(f.email || '').trim())

// `?purchase=<id>` in the address bar (or out of it), every other param kept.
function setUrlPurchase(id) {
  try {
    const u = new URL(window.location.href)
    if (id) u.searchParams.set('purchase', id)
    else u.searchParams.delete('purchase')
    u.searchParams.delete('cancelled')
    window.history.replaceState(null, '', `${u.pathname}${u.search}${u.hash}`)
  } catch { /* never block the page */ }
}

function readFbpCookie() {
  try {
    if (typeof document === 'undefined') return null
    const m = document.cookie.match(/(?:^|;\s*)_fbp=([^;]+)/)
    return m ? decodeURIComponent(m[1]) : null
  } catch { return null }
}

function fireBrowserPurchase({ purchaseId, amountCents, currency, contentName }) {
  try {
    if (typeof window === 'undefined' || typeof window.fbq !== 'function') return
    window.fbq('track', 'Purchase', { value: (amountCents || 0) / 100, currency: currency || 'EUR', content_name: contentName }, { eventID: `trialpurchase-${purchaseId}` })
  } catch { /* pixel not loaded / blocked */ }
}

/**
 * @param {{ studios: Array<{ key: 'stillorgan'|'hatch', label: string, sellable: boolean, block: object,
 *   priceCents: number|null, currency: string, durationDays: number, productName: string }>,
 *   initialStudio?: string|null, resumePurchaseId?: string|null, cancelled?: boolean, hatchTerms?: object|null,
 *   returnPath?: string, preview?: boolean, page?: string|null }} props
 *
 * PAGES.1 — with `page` (the [slug] route passes the page's slug) the purchase
 * and the help request name `{ page, studio: <the chosen studio's public path> }`
 * and the server reads the product, price and attribution from that page's
 * studio row; without it they send the studio key as before.
 */
// CLASSFIRST.1 — `anchorId` ('trial' on the /trial page) wraps every step in
// one element the page's CTAs can scroll to; the studio pages' hero owns
// `#trial` itself (HeroTrialFirst) and passes none.
export default function PaidTrialFunnel({ anchorId = null, ...props }) {
  const card = <PaidTrialCard {...props} />
  return anchorId ? <div id={anchorId} className="w-full max-w-lg scroll-mt-24">{card}</div> : card
}

function PaidTrialCard({ studios = [], initialStudio = null, resumePurchaseId = null, cancelled = false, hatchTerms = null, returnPath = '/trial', preview = false, page = null }) {
  const list = Array.isArray(studios) ? studios : []
  const byKey = (k) => list.find((s) => s.key === k) || null
  const resuming = Boolean(resumePurchaseId) && !cancelled
  const preselected = byKey(initialStudio)?.sellable ? initialStudio : null
  // A return without ?studio= is a Stillorgan redirect-flow payment (the only kind before TRIALSTUDIO).
  const [studioKey, setStudioKey] = useState(resuming ? (initialStudio === 'hatch' ? 'hatch' : 'stillorgan') : preselected)
  // CLASSFIRST.1 — `pick` (the class) sits between the studio and the form.
  const [step, setStep] = useState(resuming ? 'confirming' : (preselected ? 'pick' : 'choose')) // choose | pick | form | payment | confirming | done | refused | help_sent
  const [chosen, setChosen] = useState(null) // the public class picked, or null (skipped)
  const [reloadKey, setReloadKey] = useState(0)
  const [doneClass, setDoneClass] = useState(null) // the class the status route reports (a resumed checkout)
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', consent: true })
  const [payment, setPayment] = useState(null) // { purchaseId, checkout, amount_cents, currency, product_name }
  const [done, setDone] = useState(null) // { state: 'paid'|'granted'|'pending' }
  const [refusal, setRefusal] = useState(null) // { message, ctaLabel }
  const [helpMessage, setHelpMessage] = useState('')
  const [termsOverride, setTermsOverride] = useState(null)
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // TRIALLEAK.1 — a cancelled checkout says so (it used to say nothing).
  const [error, setError] = useState(cancelled && !preview ? INCOMPLETE_TEXT : null)
  const [inApp, setInApp] = useState(null) // 'facebook' | 'instagram' | null
  const [copied, setCopied] = useState(null) // null | 'copied' | 'manual'
  const formRef = useRef(form)
  useEffect(() => { formRef.current = form }, [form])
  const attributionRef = useRef(null)
  const purchaseIdRef = useRef(resuming ? resumePurchaseId : null)
  const purchaseFiredRef = useRef(false)

  const studio = byKey(studioKey)
  const block = studio?.block || {}
  // Who the server is asked about: the page and the studio's public path, or (no page) the studio key.
  const target = () => (page ? { page, studio: studio?.publicPath || studioKey } : { studio: studioKey })
  const isHatch = studioKey === 'hatch'
  // un1t.online's terms tick: Hatch only; the page's copy, or the server's when it asked for it.
  const terms = isHatch ? (termsOverride || (hatchTerms?.required === true ? hatchTerms : null)) : null
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const price = formatTrialPrice(studio?.priceCents, studio?.currency)
  const ticks = trialTicks(block)
  const stepCopy = classFirstStepCopy(block, 'paid_trial')
  // The class list for the chosen studio: by the page and the studio's public
  // path, else (no page: a card that predates PAGES.1) the studio's legacy path.
  const listPath = studio?.publicPath || (studioKey === 'hatch' ? 'hatch-street' : studioKey) || null
  // Fetched only while the list can be shown (the class step, and the form
  // and payment behind it, whose Change returns to the tiles): a resumed
  // checkout never asks for it.
  const classList = useClassList({ page, publicPath: listPath, enabled: Boolean(studioKey && listPath && ['pick', 'form', 'payment'].includes(step)), reloadKey })

  useEffect(() => {
    try {
      // TRIALLEAK.1 — the shared reader: utm_source / utm_medium too, and an
      // unfilled Meta macro (`{{adset.id}}`) is no value.
      attributionRef.current = readAttributionFromUrl(window.location.search)
    } catch { /* never block the page */ }
    if (preview) return // the editor's preview tracks nothing and restores nothing
    try { setInApp(inAppBrowserFromUserAgent(window.navigator?.userAgent)) } catch { /* never block the page */ }
    // TRIALLEAK.1 — back from a checkout (a reload, a return, a cancel): the
    // details they typed in this tab, for the same studio.
    if (resuming || cancelled) {
      const draft = readDraft()
      if (draft && (!draft.studioKey || draft.studioKey === studioKey)) {
        setForm((f) => ({ ...f, ...draft.form }))
        if (draft.chosen && typeof draft.chosen === 'object') setChosen(draft.chosen)
        if (cancelled && studio?.sellable && hasDetails(draft.form)) setStep('form')
      }
    }
    trackFunnelStep('trial_view')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount: the return this page was loaded with
  }, [preview])

  // Back from un1t.online's checkout restores this page from the back-forward
  // cache with the button still on "One moment…": give it back.
  useEffect(() => {
    const onShow = (e) => { if (e.persisted) setSubmitting(false) }
    window.addEventListener('pageshow', onShow)
    return () => window.removeEventListener('pageshow', onShow)
  }, [])

  function buildAttribution() {
    return buildAdAttribution(attributionRef.current, readFbpCookie())
  }

  // TRIALLEAK.1 — back to the form (the details kept) with a reason, or the
  // class step when there are none (a fresh page), or the choice when the
  // studio is no longer for sale. The dead purchase leaves the address bar.
  function backToStart(msg) {
    setUrlPurchase(null)
    setPayment(null)
    setStep(!studio?.sellable ? 'choose' : hasDetails(formRef.current) ? 'form' : 'pick')
    setError(msg)
  }
  // What a failed or timed-out order says: a refusal is one thing, a checkout
  // nobody finished another.
  const failureText = (d) => (d?.payment_status === 'failed' ? DECLINED_TEXT : INCOMPLETE_TEXT)

  async function copyResumeLink() {
    try {
      const u = new URL(window.location.href)
      if (purchaseIdRef.current) u.searchParams.set('purchase', purchaseIdRef.current)
      await window.navigator.clipboard.writeText(u.toString())
      setCopied('copied')
    } catch { setCopied('manual') } // no clipboard here: show the link to copy by hand
    trackFunnelStep('trial_copy_link', { studio: studioKey })
  }

  function choose(key) {
    if (!byKey(key)?.sellable) return
    if (key !== studioKey) { setTermsOverride(null); setTermsAccepted(false) }
    setStudioKey(key)
    setError(null)
    if (!preview) trackFunnelStep('trial_studio_chosen', { studio: key })
    setChosen(null)
    setStep('pick')
  }

  // CLASSFIRST.1 — the class step.
  function pickClass(cls) { setChosen(cls); setError(null) }
  // MOBILEFUNNEL.1 — the class comes with the call (a tapped time continues
  // in the same event, before `chosen` re-renders); else the one chosen.
  function toForm(cls) {
    const picked = cls || chosen
    if (!picked) return
    setChosen(picked)
    if (!preview) trackFunnelStep('trial_class_chosen', { studio: studioKey })
    setError(null)
    setStep('form')
  }
  function skipClass() {
    setChosen(null)
    setError(null)
    if (!preview) trackFunnelStep('trial_class_skipped', { studio: studioKey })
    setStep('form')
  }

  function firePurchaseOnce({ purchaseId, amountCents, currency, contentName }) {
    if (purchaseFiredRef.current) return
    purchaseFiredRef.current = true
    fireBrowserPurchase({ purchaseId, amountCents, currency, contentName })
    trackFunnelStep('trial_paid', { studio: studioKey })
  }

  async function submit(e) {
    e.preventDefault()
    if (preview) return
    setError(null)
    if (!form.first_name.trim() || !form.last_name.trim() || !form.email.trim() || !form.phone.trim() || !form.consent) {
      setError('Please complete every field and tick consent.'); return
    }
    if (!isValidMobileNumber(form.phone)) { setError('Please enter a valid mobile number (e.g. 087 123 4567).'); return }
    if (terms && !termsAccepted) { setError(terms.required_message || 'Please tick to accept the terms and waiver.'); return }
    setSubmitting(true)
    let leaving = false
    const leadEventId = newLeadEventId()
    const fireLead = (contentName) => fireBrowserLead({
      pixelIds: typeof window !== 'undefined' ? metaPixelIdsForPath(window.location.pathname, { primaryLocationId: pageLocationIdFromDocument() }) : [],
      eventId: leadEventId,
      userData: pixelUserData({ email: form.email, phone: form.phone, firstName: form.first_name, lastName: form.last_name }),
      contentName,
    })
    try {
      const r = await fetch(STATUS_PATH, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...target(),
          first_name: form.first_name.trim(), last_name: form.last_name.trim(),
          email: form.email.trim(), phone: form.phone.trim(), consent: form.consent,
          ...(terms ? { terms_accepted: termsAccepted } : {}),
          ...(chosen ? { event_id: chosen.event_id } : {}),
          attribution: buildAttribution(),
          visit: readVisitOrigin() || undefined,
          lead_event_id: leadEventId,
          return_path: returnPath,
          // TRIALLEAK.1 — the purchase this browser already holds: the proof
          // that lets the server hand the same open checkout back.
          ...(purchaseIdRef.current ? { resume_purchase_id: purchaseIdRef.current } : {}),
        }),
      })
      const j = await r.json().catch(() => ({}))
      // CLASSFIRST.1 — the class filled while they typed: back to the tiles,
      // the details kept, the list reloaded so the same tile cannot be pressed
      // into the same refusal.
      if (j.code === 'class_unavailable') {
        setChosen(null)
        setStep('pick')
        setError(customerErrorText(j.error, 'That class filled up while you were typing. Pick another one, your details are saved.'))
        setReloadKey((k) => k + 1)
        return
      }
      // The studio needs un1t.online's tick and this page did not know: show it from the answer.
      if (j.code === 'terms_required' && j.terms?.required === true) {
        setTermsOverride(j.terms)
        setError(j.error || j.terms.required_message || null); return
      }
      // A refusal is a state, not an error. The server captured the lead and sent its Lead.
      if (j.success === false && (REFUSALS.has(j.code) || j.code === 'help_filed')) {
        fireLead(studio?.productName)
        trackFunnelStep('trial_refused', { studio: studioKey, code: j.code })
        if (j.code === 'help_filed') {
          trackFunnelStep('trial_help_sent', { studio: studioKey })
          setHelpMessage(j.error || block.help_sent_text)
          setStep('help_sent'); return
        }
        setRefusal({
          message: j.error || (j.code === 'trial_used' ? block.trial_used_text : block.active_member_text),
          ctaLabel: j.help?.cta_label || block.help_cta_label,
        })
        setStep('refused'); return
      }
      if (!r.ok || j.success === false || !j.data) {
        setError(customerErrorText(j.error, 'Something went wrong. Please try again.')); return
      }
      fireLead(j.data.product_name)
      fireBrowserInitiateCheckout({
        eventId: checkoutEventIdFor(leadEventId),
        value: (j.data.amount_cents ?? studio?.priceCents ?? 0) / 100,
        currency: j.data.currency || studio?.currency,
        contentName: j.data.product_name,
      })
      trackFunnelStep('trial_checkout_view', { studio: studioKey })
      purchaseIdRef.current = j.data.purchaseId
      saveDraft({ studioKey, form, chosen })
      if (j.data.redirect_url) {
        // Hatch Street: un1t.online takes the money on its own checkout.
        trackFunnelStep('trial_hatch_redirect', { studio: studioKey })
        leaving = true
        window.location.assign(j.data.redirect_url)
        return
      }
      setPayment(j.data)
      setStep('payment')
      // TRIALLEAK.1 — a reload now comes back to this checkout.
      setUrlPurchase(j.data.purchaseId)
    } catch {
      setError('Network error. Please try again.')
    } finally {
      if (!leaving) setSubmitting(false)
    }
  }

  async function askForHelp() {
    setError(null)
    setSubmitting(true)
    try {
      const r = await fetch(HELP_PATH, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...target(),
          first_name: form.first_name.trim(), last_name: form.last_name.trim(),
          email: form.email.trim(), phone: form.phone.trim(),
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) { setError(customerErrorText(j.error, 'Something went wrong. Please try again.')); return }
      trackFunnelStep('trial_help_sent', { studio: studioKey })
      setHelpMessage(j.data?.message || block.help_sent_text)
      setStep('help_sent')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  function onPaid() {
    const p = payment || {}
    firePurchaseOnce({ purchaseId: purchaseIdRef.current, amountCents: p.amount_cents ?? studio?.priceCents, currency: p.currency || studio?.currency, contentName: p.product_name || studio?.productName })
    clearDraft()
    setDone({ state: 'paid' })
    setStep('done')
  }

  // Confirming (a return from a checkout) and done: poll until the trial is
  // on the account so the screen can say so honestly. Stops on granted,
  // failed, expired or help. A Hatch row stays pending until the cron
  // settles it off the mirror: after the budget the screen says it is being
  // confirmed, and the done screen keeps listening for the grant.
  useEffect(() => {
    if (step !== 'confirming' && step !== 'done') return
    const id = purchaseIdRef.current
    // Back to the start with a reason (backToStart: the form when the details
    // are still here, else the class step, else the choice).
    const restart = backToStart
    if (!id) { restart(null); return }
    let stopped = false
    let polls = 0
    const tick = async () => {
      if (stopped) return
      polls += 1
      try {
        const r = await fetch(`${STATUS_PATH}/${id}`, { cache: 'no-store' })
        if (r.status === 404) { if (!stopped) restart('We could not find that purchase. Please start again.'); return }
        const j = await r.json().catch(() => ({}))
        const d = j?.data
        if (stopped || !d) return
        if (d.class && d.class.name) setDoneClass(d.class)
        if (d.state === 'granted') {
          firePurchaseOnce({ purchaseId: id, amountCents: d.amount_cents, currency: d.currency, contentName: d.product_name })
          clearDraft()
          setDone({ state: 'granted' }); setStep('done'); return
        }
        if (d.state === 'failed') { restart(failureText(d)); return }
        if (d.state === 'expired') { restart('That checkout expired. Nothing was charged; please start again.'); return }
        // TRIALLEAK.1 — still unpaid and still payable (a reload, or the copied
        // link in another browser): the checkout goes back in front of them.
        // Two polls first, each of which re-asks the provider, so a payment
        // already on its way lands as paid instead.
        if (step === 'confirming' && !isHatch && d.state === 'pending' && d.resumable === true && d.checkout?.token && polls >= RESUME_AFTER_POLLS) {
          setPayment({ purchaseId: id, checkout: d.checkout, amount_cents: d.amount_cents, currency: d.currency, product_name: d.product_name })
          setStep('payment')
          trackFunnelStep('trial_checkout_resumed', { studio: studioKey })
          return
        }
        if (d.state === 'help') { setHelpMessage(block.help_sent_text); setStep('help_sent'); return }
        if (d.state === 'paid' && step === 'confirming') {
          firePurchaseOnce({ purchaseId: id, amountCents: d.amount_cents, currency: d.currency, contentName: d.product_name })
          setDone({ state: 'paid' }); setStep('done'); return
        }
      } catch { /* keep polling */ }
      if (stopped) return
      // Give the grant up to ~2 minutes of polling, then leave the screen as is
      // (a Hatch purchase moves to its "being confirmed" screen).
      if (polls < 40) setTimeout(tick, 3000)
      else if (step === 'confirming' && isHatch) { setDone({ state: 'pending' }); setStep('done') }
      // TRIALLEAK.1 — Stillorgan never spins for ever: say so, and hand them back.
      else if (step === 'confirming') restart(UNCONFIRMED_TEXT)
    }
    const t = setTimeout(tick, step === 'confirming' ? 300 : 3000)
    return () => { stopped = true; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the studio and its block are fixed while polling; re-arming on them would double the polls
  }, [step])

  if (step === 'choose') {
    return (
      <div className={TRIAL_CARD}>
        <TrialStudioPicker studios={list} onChoose={choose} />
        {error && <p className={`mt-4 ${TRIAL_ERROR}`} role="alert">{error}</p>}
        {!list.some((s) => s.sellable) && (
          <p className={`mt-4 ${TRIAL_MUTED}`}>The trial is not available online right now. Message us on WhatsApp or drop into the studio and we will sort you out.</p>
        )}
      </div>
    )
  }

  if (step === 'pick' && studio) {
    const cta = chosen ? ctaLabelFor(stepCopy.pick_cta_label, chosen) : stepCopy.pick_cta_label.replace(/\{day\}|\{time\}/g, '').replace(/\s+/g, ' ').trim()
    return (
      <div className={TRIAL_CARD}>
        <div className="flex items-center justify-between gap-3 mb-2">
          <p className={`text-xs uppercase tracking-[0.25em] font-semibold ${TRIAL_MUTED}`}>{studio?.label}</p>
          {list.length > 1 && (
            <button type="button" disabled={preview} onClick={() => { setError(null); setStep('choose') }} className={`text-xs ${TRIAL_MUTED} ${TRIAL_LINK}`}>
              Change studio
            </button>
          )}
        </div>
        <ClassPickStep
          list={classList}
          copy={stepCopy}
          chosen={chosen}
          onPick={pickClass}
          onContinue={toForm}
          onSkip={skipClass}
          showClassName
          stepLabel={list.length > 1 ? 'Step 2 of 3' : 'Step 1 of 2'}
          ctaLabel={cta}
          error={error}
          title={stepCopy.pick_title}
          body={stepCopy.pick_body}
          reassurance={`${price} once, for ${studio?.durationDays || 14} days`}
        />
      </div>
    )
  }

  if (step === 'confirming') {
    return (
      <div className={`${TRIAL_CARD} text-center`}>
        <p className="font-display font-extrabold text-2xl text-black mb-2">Confirming your payment</p>
        <p className={TRIAL_MUTED}>{isHatch ? (block.pending_body || PAID_TRIAL_PENDING_BODY) : 'One moment while we check with the bank.'}</p>
      </div>
    )
  }

  if (step === 'done') {
    const state = done?.state
    const title = state === 'granted' ? (block.done_title || "You're in") : state === 'pending' ? 'Almost there' : 'Payment received'
    const body = state === 'granted'
      ? (block.done_body || 'Your trial is on your account. Check your email for how to book your first class.')
      : state === 'pending'
        ? (block.pending_body || PAID_TRIAL_PENDING_BODY)
        : 'Thanks, your payment is in. We are setting the trial up on your account now; this usually takes under a minute. Your confirmation email has the details.'
    // CLASSFIRST.1 — the class they picked (this session's, or the one the
    // status route reports after a checkout return), once the trial is theirs.
    const line = state === 'pending' ? '' : classLine(stepCopy.done_class_body, chosen || doneClass)
    return (
      <div className={`${TRIAL_CARD} text-center`}>
        <p className="font-display font-extrabold text-3xl text-black mb-3">{title}</p>
        <p className={TRIAL_MUTED}>{body}</p>
        {line ? <p className="mt-3 text-black font-semibold">{line}</p> : null}
      </div>
    )
  }

  if (step === 'help_sent') {
    return (
      <div className={`${TRIAL_CARD} text-center`}>
        <p className="text-black/80" role="status">{helpMessage}</p>
      </div>
    )
  }

  if (step === 'refused' && refusal) {
    return (
      <div className={TRIAL_CARD}>
        <p className="text-black/80 mb-5">{refusal.message}</p>
        {error && <p className={`${TRIAL_ERROR} mb-3`} role="alert">{error}</p>}
        <button type="button" onClick={askForHelp} disabled={submitting} className={TRIAL_BTN}>
          {submitting ? 'One moment…' : refusal.ctaLabel}
        </button>
      </div>
    )
  }

  if (step === 'payment' && payment) {
    return (
      <div className={TRIAL_CARD}>
        <ClassFunnelCheckout
          tone="light"
          paymentId={payment.purchaseId}
          checkout={payment.checkout}
          priceLabel={`${payment.product_name || studio?.productName} · ${formatTrialPrice(payment.amount_cents, payment.currency)}`}
          statusPath={STATUS_PATH}
          onPaid={onPaid}
          onCancel={() => { setUrlPurchase(null); setStep('form') }}
          onFailed={(d) => backToStart(failureText(d))}
        />
        {/* TRIALLEAK.1 — inside Facebook or Instagram a wallet button may not
            show. Nothing is blocked: the card form works, and the link opens
            this same checkout in their own browser. */}
        {inApp && (
          <div className={`mt-4 rounded border border-black/10 p-3 text-xs ${TRIAL_MUTED}`}>
            <p>Apple Pay and Google Pay may not show inside {IN_APP_NAMES[inApp]}. You can pay by card here, or open this page in your own browser.</p>
            <button type="button" onClick={copyResumeLink} className={`mt-2 font-semibold ${TRIAL_LINK}`}>
              {copied === 'copied' ? 'Link copied. Paste it into Safari or Chrome.' : 'Copy link to open in your browser'}
            </button>
            {copied === 'manual' && (
              <input readOnly aria-label="Link to this checkout" className={`mt-2 ${TRIAL_INPUT}`} value={typeof window !== 'undefined' ? window.location.href : ''} onFocus={(e) => e.target.select()} />
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={TRIAL_CARD}>
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className={`text-xs uppercase tracking-[0.25em] font-semibold ${TRIAL_MUTED}`}>{studio?.label}</p>
        {/* One studio (a studio page's hero) has nothing to change to. */}
        {list.length > 1 && (
          <button type="button" disabled={preview} onClick={() => { setError(null); setStep('choose') }} className={`text-xs ${TRIAL_MUTED} ${TRIAL_LINK}`}>
            Change studio
          </button>
        )}
      </div>
      {/* CLASSFIRST.1 — what they picked, with the way back to the tiles. */}
      <div className={TRIAL_SUMMARY}>
        <div className="text-[11px] uppercase tracking-wider text-black/55">{chosen ? 'Your first class' : 'First class'}</div>
        <div className="mt-1 flex items-center justify-between gap-3">
          <span className="text-base">{chosen ? <><span className="font-bold">{chosen.time}</span> · {chosen.day_label} · {chosen.name}</> : 'Pick one after you pay'}</span>
          <button type="button" disabled={preview} onClick={() => { setError(null); setStep('pick') }} className="shrink-0 text-sm underline text-black/60 hover:text-black">{chosen ? 'Change' : 'Pick a class'}</button>
        </div>
      </div>
      {/* The price region: the heading and the price first, where the eye
          lands (the Hatch foundation-offer lesson). */}
      <div className="mb-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.3em] font-semibold text-black/55 mb-2">{list.length > 1 ? 'Step 3 of 3' : 'Step 2 of 2'}</p>
            <h1 className="font-display font-extrabold uppercase text-2xl leading-tight">{block.heading}</h1>
          </div>
          <div className="text-right shrink-0">
            <div className="font-display font-extrabold text-4xl leading-none">{price}</div>
            <div className="text-xs text-black/55 mt-1">once, for {studio?.durationDays || 14} days</div>
          </div>
        </div>
        <p className="mt-3 text-sm text-black/70">{stepCopy.details_body}</p>
        {ticks.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {ticks.map((t) => (
              <li key={t} className="flex items-start gap-2 text-sm">
                <span aria-hidden="true" className="mt-0.5 inline-block h-4 w-4 rounded-full bg-black text-white text-[10px] leading-4 text-center">✓</span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={submit} className="space-y-3" aria-label="Your details">
        <div className="grid grid-cols-2 gap-4">
          <input className={TRIAL_INPUT} disabled={preview} placeholder="First name" value={form.first_name} onChange={set('first_name')} maxLength={120} autoComplete="given-name" aria-label="First name" />
          <input className={TRIAL_INPUT} disabled={preview} placeholder="Last name" value={form.last_name} onChange={set('last_name')} maxLength={120} autoComplete="family-name" aria-label="Last name" />
        </div>
        <input className={TRIAL_INPUT} disabled={preview} type="email" placeholder="Email" value={form.email} onChange={set('email')} maxLength={320} autoComplete="email" aria-label="Email" />
        <input className={TRIAL_INPUT} disabled={preview} type="tel" placeholder="Phone" value={form.phone} onChange={set('phone')} maxLength={50} autoComplete="tel" aria-label="Phone" />
        <label className={`flex items-start gap-2.5 text-xs pt-1 ${TRIAL_MUTED}`}>
          <input type="checkbox" disabled={preview} checked={form.consent} onChange={set('consent')} className="mt-0.5 w-4 h-4 accent-black" />
          <span>{block.consent_label} <a href="/privacy" target="_blank" rel="noreferrer" className={TRIAL_LINK}>Privacy</a></span>
        </label>
        {terms && <TrialTermsTick terms={terms} checked={termsAccepted} onChange={setTermsAccepted} disabled={preview} />}
        {error && <p className={TRIAL_ERROR} role="alert">{error}</p>}
        <button type="submit" disabled={preview || submitting} className={TRIAL_BTN}>
          {submitting ? 'One moment…' : `${block.cta_label || 'Start my trial'} · ${price}`}
        </button>
        <p className={TRIAL_FINE}>Secure payment. You are charged {price} once; nothing renews.</p>
      </form>
    </div>
  )
}
