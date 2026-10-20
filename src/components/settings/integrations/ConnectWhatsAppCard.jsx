'use client'

// INTEG hub inline #4 (Phase 3) — the "Connect with WhatsApp" Embedded
// Signup card, extracted from WhatsAppIntegrationTab. WAORGNUMBER.1: numbers
// belong to the ORGANISATION, so the card now lives on the organisation's
// number page (OrgWhatsAppNumbers) and talks to the organisation's route:
//   GET  /api/organizations/[id]/whatsapp/embedded-signup → launch config
//   POST /api/organizations/[id]/whatsapp/embedded-signup → code→token exchange,
//        WABA webhook subscription, conditional number registration, upsert.
// A NEW number needs a home studio (where new-enquiry threads land), so the
// card asks for one; a number the organisation already holds keeps its own.

import { useEffect, useRef, useState } from 'react'
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react'

// WA-TECHPROV.5 — Embedded Signup v4 launcher. The FB JS SDK is loaded on
// demand (never globally, so it doesn't clash with other pages); the
// session-info postMessage listener captures waba_id/phone_number_id,
// FB.login's callback supplies the response code, and the exchange route
// (embedded-signup) does the rest: code→token, WABA webhook subscription,
// conditional number registration, then upsert into whatsapp_numbers.
//
// `extras`/version checked against Meta's current ES v4 implementation
// guide (2026-07): the documented sample is `extras: { setup: {} }` — no
// `sessionInfoVersion` field (some third-party partner docs still carry
// one; omitting it doesn't change the WA_EMBEDDED_SIGNUP payload shape,
// which nests waba_id/phone_number_id under `data.data` in the current
// docs' own example). FB.init's `version` is bumped to the
// currently-documented 'v25.0'.
function loadFacebookSdk(appId) {
  return new Promise((resolve, reject) => {
    if (window.FB) return resolve(window.FB)
    window.fbAsyncInit = () => {
      window.FB.init({ appId, autoLogAppEvents: false, xfbml: false, version: 'v25.0' })
      resolve(window.FB)
    }
    const s = document.createElement('script')
    s.src = 'https://connect.facebook.net/en_US/sdk.js'
    s.async = true
    s.defer = true
    s.onerror = () => reject(new Error('Facebook SDK failed to load'))
    document.body.appendChild(s)
  })
}

export function ConnectWhatsAppCard({ organizationId, locations = [], canEdit, onConnected }) {
  const [launch, setLaunch] = useState(null)      // { configured, app_id, config_id }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [connectedLabel, setConnectedLabel] = useState(null)
  // The home studio of a NEW number: the only studio when there is one.
  const [homeLocationId, setHomeLocationId] = useState(locations.length === 1 ? locations[0].id : '')
  const sessionInfo = useRef({})                  // { waba_id, phone_number_id }

  useEffect(() => {
    let cancelled = false
    fetch(`/api/organizations/${organizationId}/whatsapp/embedded-signup`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setLaunch(j.success ? j.data : { configured: false }) })
      .catch(() => { if (!cancelled) setLaunch({ configured: false }) }) // fetch failed → amber not-configured chip
    return () => { cancelled = true }
  }, [organizationId])

  // Preload the FB SDK once we know we're launchable, so connect()'s await
  // resolves instantly (loadFacebookSdk is idempotent via the window.FB
  // check) and FB.login's popup opens inside the click's user-activation
  // window — otherwise popup blockers can eat the dialog.
  useEffect(() => {
    if (launch?.configured) loadFacebookSdk(launch.app_id).catch(() => { /* surfaced on click */ })
  }, [launch])

  useEffect(() => {
    function onMessage(event) {
      // Hostname check, not a substring one — endsWith('facebook.com') on the
      // raw origin would also pass https://evilfacebook.com.
      let host
      try { host = new URL(event.origin).hostname } catch { return }
      if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return
      try {
        const data = JSON.parse(event.data)
        if (data?.type === 'WA_EMBEDDED_SIGNUP') {
          sessionInfo.current = {
            waba_id: data.data?.waba_id ?? sessionInfo.current.waba_id,
            phone_number_id: data.data?.phone_number_id ?? sessionInfo.current.phone_number_id,
          }
        }
      } catch { /* FB widgets also postMessage non-JSON — ignore */ }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  async function connect(mode = 'cloud_api') {
    setError(null)
    setBusy(true)
    try {
      const FB = await loadFacebookSdk(launch.app_id)
      const authCode = await new Promise((resolve) => {
        FB.login(
          (response) => resolve(response?.authResponse?.code || null),
          {
            config_id: launch.config_id,
            response_type: 'code',
            override_default_response_type: true,
            extras: mode === 'coexistence'
              ? { setup: {}, featureType: 'whatsapp_business_app_onboarding' }
              : { setup: {} },
          },
        )
      })
      if (!authCode) { setBusy(false); return }   // dialog abandoned = no-op

      const { waba_id, phone_number_id } = sessionInfo.current
      if (!waba_id) {
        throw new Error('Signup finished but no WhatsApp Business account details arrived — close the dialog and retry.')
      }
      if (mode === 'cloud_api' && !phone_number_id) {
        throw new Error('Signup finished but no number details arrived — close the dialog and retry.')
      }

      const res = await fetch(`/api/organizations/${organizationId}/whatsapp/embedded-signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, code: authCode, waba_id, phone_number_id, home_location_id: homeLocationId || undefined }),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error || 'Connection failed')
      setConnectedLabel(json.data.label)
      sessionInfo.current = {}
      onConnected?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 space-y-2">
      <div>
        <h4 className="text-sm font-semibold text-un1t-text mb-1">Connect with WhatsApp</h4>
        <p className="text-xs text-un1t-subtle">
          Onboard a WhatsApp Business account and number through Meta&apos;s guided signup —
          the connected number appears in the list above, ready to send.
        </p>
      </div>

      {connectedLabel && (
        <div className="text-xs text-green-700 bg-green-500/10 border border-green-200 rounded p-2 inline-flex items-center gap-1.5">
          <CheckCircle2 size={12} /> Connected: {connectedLabel}
        </div>
      )}
      {error && (
        <div className="text-xs text-red-700 bg-red-500/10 border border-red-200 rounded p-2 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> {error}
        </div>
      )}
      {launch && !launch.configured && (
        <div className="text-xs text-amber-700 bg-amber-500/10 border border-amber-200 rounded p-2 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> Embedded Signup isn&apos;t configured yet — set{' '}
          <code className="text-amber-700">WHATSAPP_ES_CONFIG_ID</code> (plus the app id/secret) to enable it.
        </div>
      )}

      <label className="block">
        <div className="text-[10px] uppercase tracking-wider text-un1t-subtle mb-0.5">Home studio</div>
        <select
          value={homeLocationId}
          onChange={(e) => setHomeLocationId(e.target.value)}
          className="bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
        >
          <option value="">Choose a studio…</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <div className="text-[10px] text-un1t-muted mt-0.5">
          Where a new number is switched on first and new-enquiry threads land. A number the organisation already holds keeps its own.
        </div>
      </label>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => connect('cloud_api')}
          disabled={!canEdit || busy || !launch?.configured || !homeLocationId}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <button
          type="button"
          onClick={() => connect('coexistence')}
          disabled={!canEdit || busy || !launch?.configured || !homeLocationId}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-un1t-bg border border-un1t-border text-un1t-text hover:bg-un1t-surface disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
          {busy ? 'Connecting…' : 'Connect existing number'}
        </button>
      </div>
      <p className="text-xs text-un1t-subtle">
        Already using the WhatsApp Business app on this number? Use “Connect existing number” to link it without moving off your phone.
      </p>
      {/* ECHOAUTOREPLIES.1 — the app's own greeting/away auto-replies reach
          the CRM as phone-app echoes, indistinguishable from a reply someone
          typed, and every echo takes the thread over from Mia
          (whatsapp-coexistence-ingest.js). Until a real echo is captured and
          can be filtered, they must be off before linking. */}
      <p className="text-xs text-amber-700 bg-amber-500/10 border border-amber-200 rounded p-2">
        Before you connect an existing number, turn off the app&apos;s Greeting message and Away message (WhatsApp Business app → Business tools). The CRM can&apos;t tell them apart from a reply you typed, so each one would stop Mia answering in that chat.
      </p>
    </div>
  )
}
