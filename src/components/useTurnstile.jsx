'use client'
// TURNSTILE.1 — the browser half of the public-form bot check (server half:
// src/lib/turnstile.js). Usage in a form component:
//
//   const turnstile = useTurnstile()
//   ...
//   const res = await fetch(url, { method: 'POST',
//     headers: { 'Content-Type': 'application/json', ...(await turnstile.headers()) }, ... })
//
// headers() hands over the current token and starts a fresh one, because a
// token works once: a retry after an error gets a new token automatically.
//
// The widget lives in its own small box fixed to the corner of the page, not
// inside the form, so multi-step funnels (where the form mounts late or the
// submit happens on a later step) need no placement. appearance
// 'interaction-only' keeps it invisible unless Cloudflare wants the person to
// tick a box, which is rare; when it does, the box shows in that corner.
//
// With no NEXT_PUBLIC_TURNSTILE_SITE_KEY nothing loads and headers() resolves
// to {} at once: the forms behave exactly as before.

import { useCallback, useEffect, useRef } from 'react'

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || ''
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const TOKEN_WAIT_MS = 5000

let scriptPromise = null
function loadScript() {
  if (window.turnstile) return Promise.resolve()
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = SCRIPT_SRC
      s.async = true
      s.onload = () => resolve()
      s.onerror = () => { scriptPromise = null; reject(new Error('turnstile script failed')) }
      document.head.appendChild(s)
    })
  }
  return scriptPromise
}

export function useTurnstile({ siteKey = SITE_KEY } = {}) {
  const widgetId = useRef(null)
  const token = useRef(null)
  const waiters = useRef([])

  useEffect(() => {
    if (!siteKey) return undefined
    let cancelled = false
    const box = document.createElement('div')
    box.setAttribute('data-turnstile-box', '')
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483000;'
    document.body.appendChild(box)

    const settle = (value) => {
      token.current = value
      if (!value) return
      const w = waiters.current
      waiters.current = []
      w.forEach((resolve) => resolve(value))
    }

    loadScript().then(() => {
      if (cancelled || !window.turnstile) return
      widgetId.current = window.turnstile.render(box, {
        sitekey: siteKey,
        appearance: 'interaction-only',
        callback: (t) => settle(t),
        'expired-callback': () => settle(null),
        'error-callback': () => settle(null),
      })
    }).catch(() => {
      // Script blocked or offline: the form submits without a token. The
      // server logs it, and refuses only in enforce mode.
    })

    return () => {
      cancelled = true
      if (widgetId.current != null) window.turnstile?.remove(widgetId.current)
      widgetId.current = null
      box.remove()
    }
  }, [siteKey])

  const headers = useCallback(async () => {
    if (!siteKey) return {}
    let t = token.current
    if (!t) {
      t = await new Promise((resolve) => {
        waiters.current.push(resolve)
        setTimeout(() => resolve(null), TOKEN_WAIT_MS)
      })
    }
    // Single use: clear it and ask the widget for the next one now, so a
    // second submit (after a server error, say) has a fresh token.
    token.current = null
    if (widgetId.current != null) window.turnstile?.reset(widgetId.current)
    return t ? { 'cf-turnstile-response': t } : {}
  }, [siteKey])

  return { headers }
}
