'use client'

// CookieConsent — site-wide GDPR cookie consent banner.
//
// Mounted in the ROOT layout, so it renders across the whole Next.js
// app. The root layout is SHARED with the ccfautos.com car-dealership
// brand (pay.ccfautos.com etc.), so this component HOST-SCOPES itself:
// it only renders on UN1T hosts and never on ccfautos hosts. The
// advertising pixels loaded here are UN1T's, so this also prevents
// UN1T tracking from firing on the dealership's pages.
//
// Consent gating: Google Analytics, Meta Pixel, TikTok Pixel and
// Google Ads tags are injected ONLY after the visitor consents to the
// relevant category. Do not hard-code those tags elsewhere. Replace
// the placeholder IDs in the loaders below with the real tag IDs.
//
// NOTE (operator): the internal /privacy (CRM + iOS) policy states the
// system uses no advertising identifiers / cross-app tracking. Because
// this banner is site-wide, marketing pixels can load on the
// authenticated CRM too once a staff user consents. If that is not
// intended, either narrow the host check below to the public marketing
// hosts only, or update that statement. Flagged 2026-06-19.

import { useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'un1t_cookie_consent_v1'
const EXPIRY_DAYS = 180

// ---- Replace these with your real tag IDs ----
const GA_MEASUREMENT_ID = 'G-XXXXXXXXXX'
const META_PIXEL_ID = '1866914428028977' // UN1T Web dataset (Meta Pixel)
const TIKTOK_PIXEL_ID = 'XXXXXXXXXXXXXXXXXXXX'
const GOOGLE_ADS_ID = 'AW-XXXXXXXXX'

function readConsent() {
  if (typeof document === 'undefined') return null
  const m = document.cookie.match(new RegExp('(?:^|; )' + STORAGE_KEY + '=([^;]*)'))
  if (!m) return null
  try {
    return JSON.parse(decodeURIComponent(m[1]))
  } catch {
    return null
  }
}

function saveConsent(consent) {
  const payload = { ...consent, ts: Date.now() }
  document.cookie =
    STORAGE_KEY +
    '=' +
    encodeURIComponent(JSON.stringify(payload)) +
    ';path=/;max-age=' +
    EXPIRY_DAYS * 24 * 60 * 60 +
    ';SameSite=Lax'
}

const loaded = { analytics: false, marketing: false }

function loadAnalytics() {
  if (loaded.analytics || typeof window === 'undefined') return
  if (GA_MEASUREMENT_ID.includes('XXXX')) return // not configured yet
  loaded.analytics = true
  const s = document.createElement('script')
  s.async = true
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_MEASUREMENT_ID
  document.head.appendChild(s)
  window.dataLayer = window.dataLayer || []
  window.gtag = function () {
    window.dataLayer.push(arguments)
  }
  window.gtag('js', new Date())
  window.gtag('config', GA_MEASUREMENT_ID, { anonymize_ip: true })
}

function loadMarketing() {
  if (loaded.marketing || typeof window === 'undefined') return
  loaded.marketing = true

  // Meta (Facebook/Instagram) Pixel
  if (!META_PIXEL_ID.includes('XXXX')) {
    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return
      n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments)
      }
      if (!f._fbq) f._fbq = n
      n.push = n
      n.loaded = !0
      n.version = '2.0'
      n.queue = []
      t = b.createElement(e)
      t.async = !0
      t.src = v
      s = b.getElementsByTagName(e)[0]
      s.parentNode.insertBefore(t, s)
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js')
    window.fbq('init', META_PIXEL_ID)
    window.fbq('track', 'PageView')
  }

  // TikTok Pixel
  if (!TIKTOK_PIXEL_ID.includes('XXXX')) {
    !(function (w, d, t) {
      w.TiktokAnalyticsObject = t
      var ttq = (w[t] = w[t] || [])
      ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie']
      ttq.setAndDefer = function (t, e) {
        t[e] = function () {
          t.push([e].concat(Array.prototype.slice.call(arguments, 0)))
        }
      }
      for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i])
      ttq.instance = function (t) {
        for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n])
        return e
      }
      ttq.load = function (e, n) {
        var i = 'https://analytics.tiktok.com/i18n/pixel/events.js'
        ttq._i = ttq._i || {}
        ttq._i[e] = []
        ttq._i[e]._u = i
        ttq._t = ttq._t || {}
        ttq._t[e] = +new Date()
        ttq._o = ttq._o || {}
        ttq._o[e] = n || {}
        var o = d.createElement('script')
        o.type = 'text/javascript'
        o.async = !0
        o.src = i + '?sdkid=' + e + '&lib=' + t
        var a = d.getElementsByTagName('script')[0]
        a.parentNode.insertBefore(o, a)
      }
      ttq.load(TIKTOK_PIXEL_ID)
      ttq.page()
    })(window, document, 'ttq')
  }

  // Google Ads (uses gtag, loaded by analytics or standalone)
  if (!GOOGLE_ADS_ID.includes('XXXX') && typeof window.gtag === 'function') {
    window.gtag('config', GOOGLE_ADS_ID)
  }
}

function applyConsent(c) {
  if (c.analytics) loadAnalytics()
  if (c.marketing) loadMarketing()
}

export default function CookieConsent() {
  const [visible, setVisible] = useState(false)
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [analytics, setAnalytics] = useState(false)
  const [marketing, setMarketing] = useState(false)
  const barRef = useRef(null)

  // STARTCONV.1 — reserve the space the bar occupies.
  //
  // The bar is `fixed inset-x-0 bottom-0`, so it is out of flow and nothing
  // ever accounted for its height. It therefore sits ON TOP of whatever
  // happens to be at the bottom of the viewport, and because it is fixed you
  // cannot scroll clear of it — the covered content is unreachable, not just
  // hidden. On /start that was the booking form's consent tick and its submit
  // button: on a 375px screen the bar took roughly a third of the viewport and
  // buried the one control the page exists to offer. Measured 2026-08-20,
  // alongside 112 of 138 visitors dropping at that step.
  //
  // Measured rather than hard-coded because the height changes with viewport
  // width (the copy rewraps) and with the font the browser actually loads.
  // Skipped while the preferences modal is open — that renders as a
  // full-screen overlay, where padding underneath means nothing.
  useEffect(() => {
    const el = barRef.current
    if (!visible || prefsOpen || !el) {
      document.body.style.paddingBottom = ''
      return undefined
    }
    const apply = () => { document.body.style.paddingBottom = `${el.offsetHeight}px` }
    apply()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null
    if (ro) ro.observe(el)
    window.addEventListener('resize', apply)
    return () => {
      if (ro) ro.disconnect()
      window.removeEventListener('resize', apply)
      // Always hand the page back exactly as we found it — a stale
      // padding-bottom after dismissal would leave a dead strip forever.
      document.body.style.paddingBottom = ''
    }
  }, [visible, prefsOpen])

  useEffect(() => {
    // Host-scope: the cookie banner + advertising pixels are a PUBLIC
    // MARKETING SITE concern only. Activate solely on the apex marketing
    // host (un1tdublin.com / www) — never on the authenticated CRM
    // (crm.un1tdublin.com, the default host), the ccfautos dealership
    // brand (pay.ccfautos.com), or Vercel preview hosts. This keeps the
    // Meta/Google/TikTok pixels off the staff CRM, matching the /privacy
    // statement that the CRM uses no advertising identifiers.
    const host = window.location.hostname || ''
    const isMarketingSite = host === 'un1tdublin.com' || host === 'www.un1tdublin.com'
    if (!isMarketingSite) return

    const existing = readConsent()
    if (existing && Date.now() - (existing.ts || 0) < EXPIRY_DAYS * 24 * 60 * 60 * 1000) {
      applyConsent(existing)
      setAnalytics(!!existing.analytics)
      setMarketing(!!existing.marketing)
    } else {
      setVisible(true)
    }

    // Allow reopening preferences from anywhere (e.g. a footer link
    // with onClick={() => window.UN1TCookies?.open()}).
    window.UN1TCookies = {
      open: () => {
        const c = readConsent() || {}
        setAnalytics(!!c.analytics)
        setMarketing(!!c.marketing)
        setPrefsOpen(true)
        setVisible(true)
      },
    }
  }, [])

  function acceptAll() {
    const c = { essential: true, analytics: true, marketing: true }
    saveConsent(c)
    applyConsent(c)
    setVisible(false)
    setPrefsOpen(false)
  }

  function rejectAll() {
    const c = { essential: true, analytics: false, marketing: false }
    saveConsent(c)
    setVisible(false)
    setPrefsOpen(false)
  }

  function saveSelected() {
    const c = { essential: true, analytics, marketing }
    saveConsent(c)
    applyConsent(c)
    setVisible(false)
    setPrefsOpen(false)
  }

  if (!visible) return null

  return (
    <div ref={barRef} className="fixed inset-x-0 bottom-0 z-[9999]">
      {!prefsOpen ? (
        <div className="border-t-2 border-white bg-black text-white">
          {/* STARTCONV.1 — tighter on a phone. Wording is unchanged (it is
              consent copy); only the spacing and control size move, which is
              what made the bar tall enough to bury the page's own CTA. */}
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-4 py-4 sm:flex-row sm:justify-between sm:gap-4 sm:px-6 sm:py-5">
            <p className="max-w-2xl text-[13px] leading-relaxed text-white/75 sm:text-sm">
              We use cookies to run our site, understand how it is used, and show
              you relevant ads. You can accept all, reject non-essential, or
              choose your preferences. See our{' '}
              <a href="/privacy/members" className="underline hover:text-white">privacy policy</a>.
            </p>
            <div className="flex w-full shrink-0 gap-2 sm:w-auto sm:flex-wrap">
              <button
                onClick={rejectAll}
                className="flex-1 border-2 border-white/40 px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors hover:border-white sm:flex-none sm:px-5 sm:py-3 sm:text-xs"
              >
                Reject
              </button>
              <button
                onClick={() => setPrefsOpen(true)}
                className="flex-1 border-2 border-white/40 px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors hover:border-white sm:flex-none sm:px-5 sm:py-3 sm:text-xs"
              >
                Preferences
              </button>
              <button
                onClick={acceptAll}
                className="flex-1 border-2 border-white bg-white px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-black transition-colors hover:bg-white/80 sm:flex-none sm:px-5 sm:py-3 sm:text-xs"
              >
                Accept all
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-end justify-center bg-black/60 p-4 sm:items-center">
          <div className="w-full max-w-lg border-2 border-black bg-white text-gray-900">
            <div className="bg-black px-6 py-5 text-white">
              <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.3em] text-white/70">UN1T Dublin</div>
              <h2 className="text-xl font-bold uppercase tracking-wide">Cookie preferences</h2>
            </div>
            <div className="px-6 py-4">
              <div className="flex items-start justify-between gap-4 border-b border-gray-200 py-4">
                <div>
                  <h3 className="text-sm font-bold">Essential</h3>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500">Required for the site to work. These cannot be switched off.</p>
                </div>
                <span className="shrink-0 text-[11px] font-bold uppercase tracking-wider text-gray-400">Always on</span>
              </div>
              <label className="flex cursor-pointer items-start justify-between gap-4 border-b border-gray-200 py-4">
                <div>
                  <h3 className="text-sm font-bold">Analytics</h3>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500">Help us understand how visitors use the site so we can improve it.</p>
                </div>
                <input
                  type="checkbox"
                  checked={analytics}
                  onChange={(e) => setAnalytics(e.target.checked)}
                  className="mt-1 h-5 w-5 shrink-0 accent-black"
                />
              </label>
              <label className="flex cursor-pointer items-start justify-between gap-4 py-4">
                <div>
                  <h3 className="text-sm font-bold">Marketing</h3>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500">Used to measure and personalise advertising (Meta, Google Ads, TikTok).</p>
                </div>
                <input
                  type="checkbox"
                  checked={marketing}
                  onChange={(e) => setMarketing(e.target.checked)}
                  className="mt-1 h-5 w-5 shrink-0 accent-black"
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-2 px-6 pb-6">
              <button
                onClick={saveSelected}
                className="flex-1 border-2 border-black bg-black px-5 py-3 text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-gray-800"
              >
                Save choices
              </button>
              <button
                onClick={acceptAll}
                className="flex-1 border-2 border-black bg-white px-5 py-3 text-xs font-bold uppercase tracking-wider text-black transition-colors hover:bg-gray-100"
              >
                Accept all
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
