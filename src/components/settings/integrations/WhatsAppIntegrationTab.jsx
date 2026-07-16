'use client'

// WA-MULTI.1 — WhatsApp Cloud API numbers tab.
//
// One location can have multiple registered numbers (e.g. one
// Cloud API number + one Coexistence-mode mobile number). Each
// row is a `whatsapp_numbers` record. Operators add/edit/remove
// numbers and pick which is default for outbound.
//
// Tokens are NEVER returned in plain by the API — the list shows
// the last 6 chars masked behind dots. Editing the token requires
// pasting the new full value; the field starts empty and is only
// sent on the wire when non-empty.

import { useEffect, useRef, useState } from 'react'
import {
  Plus, Trash2, Star, Loader2, CheckCircle2, AlertCircle, ChevronDown, ChevronRight,
  ExternalLink, Pencil, Upload,
} from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { validateTemplateMedia } from '@/lib/template-media'
import { normalizeUrlish } from '@/lib/urlish'

export default function WhatsAppIntegrationTab({ location, canEdit }) {
  const [numbers, setNumbers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  const [expandedId, setExpandedId] = useState(null)

  async function load() {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/locations/${location.id}/whatsapp/numbers`)
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Failed to load numbers')
      setNumbers(j.numbers || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-un1t-text mb-1">WhatsApp numbers</h4>
        <p className="text-xs text-un1t-subtle">
          Register the WhatsApp Cloud API numbers active at this location. One number is the
          <span className="font-medium"> default</span> — outbound sends from broadcasts,
          sequences, and the inbox route through it. Inbound webhooks land at whichever
          number Meta posted to.
        </p>
        <p className="text-[11px] text-un1t-muted mt-1">
          Coexistence (linking an existing WhatsApp Business mobile number) requires Meta-side
          approval on our Tech Provider account.{' '}
          <a
            href="https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-blue-400 hover:underline"
          >
            Meta docs <ExternalLink size={9} />
          </a>{' '}
          — set <code>source = coexistence</code> on the row once the mobile number is registered.
        </p>
      </div>

      {error && (
        <div className="text-xs text-red-700 bg-red-500/10 border border-red-200 rounded p-2 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      {loading ? (
        <div className="text-xs text-un1t-subtle inline-flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {numbers.length === 0 && (
              <div className="text-xs text-un1t-subtle bg-un1t-bg border border-un1t-border rounded p-3">
                No numbers configured. This location falls back to the global
                <code className="text-un1t-muted"> WHATSAPP_*</code> env vars (legacy single-number setup).
                Add a number below to migrate.
              </div>
            )}
            {numbers.map((n) => (
              <NumberRow
                key={n.id}
                location={location}
                number={n}
                canEdit={canEdit}
                expanded={expandedId === n.id}
                onExpand={() => setExpandedId(expandedId === n.id ? null : n.id)}
                onReload={load}
                onError={setError}
              />
            ))}
          </div>

          {canEdit && (
            adding ? (
              <AddNumberForm
                locationId={location.id}
                onCancel={() => setAdding(false)}
                onSaved={() => { setAdding(false); load() }}
                onError={setError}
              />
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent"
              >
                <Plus size={12} /> Add WhatsApp number
              </button>
            )
          )}

          <ConnectWhatsAppCard location={location} canEdit={canEdit} onConnected={load} />

          <ChatOpenersCard location={location} canEdit={canEdit} />

          <CardSetsCard location={location} canEdit={canEdit} />
        </>
      )}
    </div>
  )
}

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

function ConnectWhatsAppCard({ location, canEdit, onConnected }) {
  const [launch, setLaunch] = useState(null)      // { configured, app_id, config_id }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [connectedLabel, setConnectedLabel] = useState(null)
  const sessionInfo = useRef({})                  // { waba_id, phone_number_id }

  useEffect(() => {
    let cancelled = false
    fetch(`/api/locations/${location.id}/whatsapp/embedded-signup`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j.success) setLaunch(j.data) })
      .catch(() => { /* card renders the not-configured state */ })
    return () => { cancelled = true }
  }, [location.id])

  useEffect(() => {
    function onMessage(event) {
      if (typeof event.origin !== 'string' || !event.origin.endsWith('facebook.com')) return
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

  async function connect() {
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
            extras: { setup: {} },
          },
        )
      })
      if (!authCode) { setBusy(false); return }   // dialog abandoned = no-op

      const { waba_id, phone_number_id } = sessionInfo.current
      if (!waba_id || !phone_number_id) {
        throw new Error('Signup finished but no WABA/number details arrived — close the dialog and retry.')
      }

      const res = await fetch(`/api/locations/${location.id}/whatsapp/embedded-signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: authCode, waba_id, phone_number_id }),
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

      <button
        type="button"
        onClick={connect}
        disabled={!canEdit || busy || !launch?.configured}
        className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent disabled:opacity-50"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </div>
  )
}

// C2 — Meta conversational components ("chat openers"): the welcome-message
// event (fires the request_welcome webhook → instant greeting) plus up to 4
// ice-breaker prompts shown to users opening a fresh chat with this number.
function ChatOpenersCard({ location, canEdit }) {
  const saved = location.settings?.conversational_automation || null
  const [enableWelcome, setEnableWelcome] = useState(saved ? saved.enable_welcome !== false : true)
  const [prompts, setPrompts] = useState(() => {
    const p = Array.isArray(saved?.prompts) ? saved.prompts : []
    return [p[0] || '', p[1] || '', p[2] || '', p[3] || '']
  })
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState(null)

  async function save() {
    setSaving(true); setError(null); setSavedAt(null)
    try {
      const res = await fetch('/api/whatsapp/conversational-automation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: location.id,
          enable_welcome: enableWelcome,
          prompts: prompts.map((p) => p.trim()).filter(Boolean),
        }),
      })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Failed to save chat openers')
      setSavedAt(Date.now())
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 space-y-2">
      <div>
        <h4 className="text-sm font-semibold text-un1t-text mb-1">Chat openers</h4>
        <p className="text-xs text-un1t-subtle">
          What a customer sees when they open a brand-new chat with this number (e.g. from a
          click-to-WhatsApp ad). The greeting toggle makes Meta notify us the moment they open
          the chat so the agent&apos;s welcome message sends instantly; ice breakers are tappable
          prompts they can start with.
        </p>
      </div>
      <label className="flex items-center gap-2 text-[11px] text-un1t-subtle">
        <input
          type="checkbox"
          disabled={!canEdit}
          checked={enableWelcome}
          onChange={(e) => setEnableWelcome(e.target.checked)}
        />
        Greet users when they open the chat
      </label>
      {prompts.map((p, i) => (
        <Row key={i} label={`Ice breaker ${i + 1} (optional, 80 chars)`}>
          <input
            disabled={!canEdit}
            maxLength={80}
            className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
            value={p}
            onChange={(e) => setPrompts((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
            placeholder={i === 0 ? 'e.g. What classes do you run?' : ''}
          />
        </Row>
      ))}
      {error && (
        <div className="text-xs text-red-400 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> {error}
        </div>
      )}
      {canEdit && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-un1t-text text-un1t-bg text-[11px] font-semibold hover:bg-un1t-accent disabled:opacity-50"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
            {saving ? 'Saving…' : 'Save chat openers'}
          </button>
          {savedAt && <span className="text-[11px] text-emerald-500">Saved ✓</span>}
        </div>
      )}
    </div>
  )
}

// C4 — operator-curated card sets for the in-session WhatsApp media
// carousel (2-10 swipeable image cards; each card = image + title +
// optional body + optional link button). Staff send a set from the inbox
// composer while the 24h window is open — no template approval needed.
// Stored on locations.settings.wa_card_sets via /api/whatsapp/card-sets
// (PUT replaces the whole array). Meta requires consistent button config
// across cards, so each set is all-links-or-none — validated here before
// save and again server-side.
const emptyCard = () => ({ image_url: '', title: '', body: '', link_url: '', link_text: '' })

function validateCardSetDraft(draft) {
  if (!draft.name.trim()) return 'Give the card set a name'
  if (draft.cards.length < 2 || draft.cards.length > 10) return 'A card set needs 2-10 cards'
  for (let i = 0; i < draft.cards.length; i++) {
    const c = draft.cards[i]
    if (!c.image_url.trim()) return `Card ${i + 1} needs an image`
    if (!c.title.trim()) return `Card ${i + 1} needs a title`
    if (c.link_text.trim() && !c.link_url.trim()) return `Card ${i + 1} has button text but no link URL`
  }
  const withLinks = draft.cards.filter((c) => c.link_url.trim()).length
  if (withLinks !== 0 && withLinks !== draft.cards.length) {
    return 'WhatsApp requires consistent buttons: give every card a link, or none'
  }
  return null
}

// Trim + drop empty optional fields so the payload matches the API schema.
// URLs get https:// prefixed when the operator typed a bare domain — the
// server normalises identically, but doing it here keeps what's stored equal
// to what was validated.
function normalizeCardSet(draft) {
  return {
    id: draft.id,
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    ...(draft.body_text.trim() ? { body_text: draft.body_text.trim() } : {}),
    cards: draft.cards.map((c) => ({
      image_url: normalizeUrlish(c.image_url),
      title: c.title.trim(),
      ...(c.body.trim() ? { body: c.body.trim() } : {}),
      ...(c.link_url.trim() ? { link_url: normalizeUrlish(c.link_url) } : {}),
      ...(c.link_url.trim() && c.link_text.trim() ? { link_text: c.link_text.trim() } : {}),
    })),
  }
}

function CardSetsCard({ location, canEdit }) {
  const [sets, setSets] = useState(() => (
    Array.isArray(location.settings?.wa_card_sets) ? location.settings.wa_card_sets : []
  ))
  const [editing, setEditing] = useState(null) // draft copy of the set being created/edited
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState(null)

  function startNew() {
    setEditing({ id: crypto.randomUUID(), name: '', description: '', body_text: '', cards: [emptyCard(), emptyCard()] })
    setError(null); setSavedAt(null)
  }

  function startEdit(s) {
    setEditing({
      id: s.id,
      name: s.name || '',
      description: s.description || '',
      body_text: s.body_text || '',
      cards: (s.cards || []).map((c) => ({
        image_url: c.image_url || '', title: c.title || '', body: c.body || '',
        link_url: c.link_url || '', link_text: c.link_text || '',
      })),
    })
    setError(null); setSavedAt(null)
  }

  async function persist(nextSets) {
    setSaving(true); setError(null); setSavedAt(null)
    try {
      const res = await fetch('/api/whatsapp/card-sets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: location.id, sets: nextSets }),
      })
      const j = await res.json()
      if (!j.success) {
        // Surface the first zod issue instead of the generic message — a bare
        // "Invalid request body" cost real debugging time on first use.
        const issue = Array.isArray(j.issues) && j.issues[0]
        const detail = issue ? ` — ${[issue.path?.join?.('.'), issue.message].filter(Boolean).join(': ')}` : ''
        throw new Error((j.error || 'Failed to save card sets') + detail)
      }
      setSets(j.sets || nextSets)
      setEditing(null)
      setSavedAt(Date.now())
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  function saveDraft() {
    const problem = validateCardSetDraft(editing)
    if (problem) { setError(problem); return }
    const normalized = normalizeCardSet(editing)
    const next = sets.some((s) => s.id === normalized.id)
      ? sets.map((s) => (s.id === normalized.id ? normalized : s))
      : [...sets, normalized]
    persist(next)
  }

  function removeSet(s) {
    if (!confirm(`Delete card set "${s.name}"? The inbox "Send cards" picker will no longer offer it.`)) return
    persist(sets.filter((x) => x.id !== s.id))
  }

  function updateDraftCard(i, patch) {
    setEditing((prev) => ({ ...prev, cards: prev.cards.map((c, j) => (j === i ? { ...c, ...patch } : c)) }))
  }

  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 space-y-2">
      <div>
        <h4 className="text-sm font-semibold text-un1t-text mb-1">Card sets</h4>
        <p className="text-xs text-un1t-subtle">
          Curated sets of 2-10 swipeable image cards staff can send from the inbox while a
          conversation&apos;s 24h window is open — no template approval needed. Each card has an
          image, a title, and optionally a short body and a link button. WhatsApp requires
          buttons to be consistent: give every card in a set a link, or none.
        </p>
      </div>

      {sets.length === 0 && !editing && (
        <p className="text-[11px] text-un1t-muted">No card sets yet.</p>
      )}

      {sets.map((s) => (
        <div key={s.id} className="flex items-center justify-between gap-2 bg-un1t-surface/30 border border-un1t-border rounded px-2 py-1.5">
          <div className="min-w-0">
            <span className="text-xs font-medium text-un1t-text truncate">{s.name}</span>
            <span className="text-[11px] text-un1t-muted ml-2">{s.cards?.length || 0} cards</span>
            {(s.cards || []).some((c) => c.link_url) && (
              <span className="text-[10px] uppercase text-un1t-muted ml-2">Linked</span>
            )}
          </div>
          {canEdit && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => startEdit(s)}
                disabled={saving}
                className="text-un1t-subtle hover:text-un1t-text p-1 disabled:opacity-50"
                title="Edit this card set"
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                onClick={() => removeSet(s)}
                disabled={saving}
                className="text-un1t-subtle hover:text-red-500 p-1 disabled:opacity-50"
                title="Delete this card set"
              >
                <Trash2 size={12} />
              </button>
            </div>
          )}
        </div>
      ))}

      {error && (
        <div className="text-xs text-red-400 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> {error}
        </div>
      )}
      {savedAt && !editing && <div className="text-[11px] text-emerald-500">Saved ✓</div>}

      {canEdit && !editing && (
        <button
          type="button"
          onClick={startNew}
          disabled={saving || sets.length >= 20}
          className="inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent disabled:opacity-50"
        >
          <Plus size={11} /> Add card set
        </button>
      )}

      {editing && (
        <div className="border border-un1t-border rounded-md p-2.5 space-y-2 bg-un1t-surface/30">
          <Row label="Set name (shown to staff, 60 chars)">
            <input
              maxLength={60}
              className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
              value={editing.name}
              onChange={(e) => setEditing((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="e.g. Membership options"
            />
          </Row>
          <Row label="When should Mia send this? (shown to the AI, 200 chars)">
            <input
              maxLength={200}
              className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
              value={editing.description}
              onChange={(e) => setEditing((prev) => ({ ...prev, description: e.target.value }))}
              placeholder="When someone asks about membership options or pricing"
            />
          </Row>
          <Row label="Message text (optional — sent above the cards; defaults to the set name)">
            <textarea
              rows={2}
              maxLength={1024}
              className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
              value={editing.body_text}
              onChange={(e) => setEditing((prev) => ({ ...prev, body_text: e.target.value }))}
            />
          </Row>

          {editing.cards.map((c, i) => (
            <div key={i} className="border border-un1t-border rounded p-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-un1t-subtle">Card {i + 1}</span>
                {editing.cards.length > 2 && (
                  <button
                    type="button"
                    onClick={() => setEditing((prev) => ({ ...prev, cards: prev.cards.filter((_, j) => j !== i) }))}
                    className="text-un1t-subtle hover:text-red-500 p-0.5"
                    title="Remove this card"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
              <CardImageField
                locationId={location.id}
                value={c.image_url}
                onChange={(url) => updateDraftCard(i, { image_url: url })}
                onError={setError}
              />
              <div className="grid grid-cols-2 gap-1.5">
                <Row label="Title (80 chars)">
                  <input
                    maxLength={80}
                    className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
                    value={c.title}
                    onChange={(e) => updateDraftCard(i, { title: e.target.value })}
                  />
                </Row>
                <Row label="Body (optional, 160 chars)">
                  <input
                    maxLength={160}
                    className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
                    value={c.body}
                    onChange={(e) => updateDraftCard(i, { body: e.target.value })}
                  />
                </Row>
                <Row label="Link URL (all cards or none)">
                  <input
                    className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono"
                    value={c.link_url}
                    onChange={(e) => updateDraftCard(i, { link_url: e.target.value })}
                    placeholder="https://…"
                  />
                </Row>
                <Row label="Button text (20 chars, default 'Open')">
                  <input
                    maxLength={20}
                    className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
                    value={c.link_text}
                    onChange={(e) => updateDraftCard(i, { link_text: e.target.value })}
                  />
                </Row>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={() => setEditing((prev) => ({ ...prev, cards: [...prev.cards, emptyCard()] }))}
            disabled={editing.cards.length >= 10}
            className="inline-flex items-center gap-1 text-[11px] text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
          >
            <Plus size={11} /> Add card ({editing.cards.length}/10)
          </button>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={saveDraft}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-un1t-text text-un1t-bg text-[11px] font-semibold hover:bg-un1t-accent disabled:opacity-50"
            >
              {saving ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
              {saving ? 'Saving…' : 'Save card set'}
            </button>
            <button
              type="button"
              onClick={() => { setEditing(null); setError(null) }}
              className="text-[11px] text-un1t-subtle hover:text-un1t-text"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Card image — reuses the template-media 3-step signed-upload flow
// (sign → browser-direct storage upload → finalise; see WATemplateEditor's
// handleMediaUpload for the original): we only keep the returned public
// `url`, which is exactly what the carousel send feeds Meta. A plain URL
// input sits alongside for operators pasting an already-hosted image.
function CardImageField({ locationId, value, onChange, onError }) {
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef(null)

  async function handleUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    onError(null)
    try {
      // Instant pre-check against Meta's caps (IMAGE: jpeg/png, 5 MB).
      const pre = validateTemplateMedia({ format: 'IMAGE', mime: file.type, size: file.size, fileName: file.name })
      if (!pre.ok) { onError(pre.error); return }

      // 1. Mint a signed direct-to-storage upload slot.
      const signRes = await fetch('/api/whatsapp/templates/upload-media/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'IMAGE', mime: file.type, size: file.size, file_name: file.name, location_id: locationId }),
      })
      const sign = await signRes.json().catch(() => ({}))
      if (!sign.success) { onError(sign.error || 'Could not start the upload'); return }

      // 2. Browser → Supabase Storage directly (bypasses Vercel).
      const supabase = createBrowserClient()
      const { error: upErr } = await supabase.storage
        .from('whatsapp-templates')
        .uploadToSignedUrl(sign.path, sign.token, file, { contentType: file.type })
      if (upErr) { onError(`Storage upload failed: ${upErr.message}`); return }

      // 3. Finalise → public URL. (Also mints a Meta template handle we
      //    don't need here — carousels send images by link.)
      const res = await fetch('/api/whatsapp/templates/upload-media', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: sign.path, format: 'IMAGE', mime: file.type, file_name: file.name, location_id: locationId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!j.success || !j.url) { onError(j.error || 'Upload failed'); return }
      onChange(j.url)
    } catch (err) {
      onError(err.message || 'Network error')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <Row label="Image (JPEG/PNG — upload or paste a public URL)">
      <div className="flex items-center gap-1.5">
        {value && (
          <img src={value} alt="" className="w-8 h-8 rounded object-cover border border-un1t-border shrink-0" />
        )}
        <input
          className="flex-1 bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://…"
        />
        <input ref={fileRef} type="file" accept="image/jpeg,image/png" className="hidden" onChange={handleUpload} />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-50 shrink-0"
        >
          {uploading ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </Row>
  )
}

function NumberRow({ location, number, canEdit, expanded, onExpand, onReload, onError }) {
  const [busy, setBusy] = useState(false)

  async function setDefault() {
    if (!canEdit || number.is_default) return
    setBusy(true)
    try {
      const res = await fetch(`/api/locations/${location.id}/whatsapp/numbers/${number.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_default: true }),
      })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Failed to set default')
      onReload()
    } catch (e) { onError(e.message) } finally { setBusy(false) }
  }

  async function remove() {
    if (!canEdit) return
    if (!confirm(`Remove "${number.label}"? Any sends to / from this number will fall back to the location's other configured number, or the env-var default.`)) return
    setBusy(true)
    try {
      const res = await fetch(`/api/locations/${location.id}/whatsapp/numbers/${number.id}`, { method: 'DELETE' })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Failed to remove')
      onReload()
    } catch (e) { onError(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-md">
      <div className="flex items-center justify-between p-3 gap-3">
        <button type="button" onClick={onExpand} className="flex items-center gap-2 flex-1 min-w-0 text-left">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-un1t-text truncate">{number.label}</span>
              {number.is_default && (
                <span className="inline-flex items-center gap-0.5 text-[10px] uppercase text-amber-400">
                  <Star size={10} className="fill-amber-400" /> Default
                </span>
              )}
              {!number.is_active && (
                <span className="text-[10px] uppercase text-un1t-muted">Inactive</span>
              )}
              <span className="text-[10px] uppercase text-un1t-muted">
                {number.source === 'coexistence' ? 'Coexistence' : 'Cloud API'}
              </span>
            </div>
            <div className="text-[11px] text-un1t-subtle truncate">
              {number.display_phone || number.phone_number_id}
              <span className="mx-1.5 text-un1t-muted">·</span>
              <span className="text-un1t-muted">PhoneNumberID:</span> {number.phone_number_id}
            </div>
          </div>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          {canEdit && !number.is_default && (
            <button
              type="button"
              onClick={setDefault}
              disabled={busy}
              className="inline-flex items-center gap-1 text-[10px] text-un1t-subtle hover:text-amber-400 disabled:opacity-50"
              title="Make this the default outbound number"
            >
              <Star size={11} /> Set default
            </button>
          )}
          {canEdit && (
            <button type="button" onClick={remove} disabled={busy} className="text-un1t-subtle hover:text-red-500 p-1 disabled:opacity-50">
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <EditNumberForm
          locationId={location.id}
          number={number}
          canEdit={canEdit}
          onSaved={onReload}
          onError={onError}
        />
      )}
    </div>
  )
}

const FIELD_HELP = {
  phone_number_id: 'Meta\'s PHONE_NUMBER_ID for this number. Find it under Meta Business → WhatsApp → API Setup.',
  business_account_id: 'WhatsApp Business Account ID (WABA). Required for template management.',
  app_id: 'Meta App ID. Required for the template media-upload flow.',
  access_token: 'Permanent system-user access token. Generated via Meta Business Manager → Users → System Users.',
}

function AddNumberForm({ locationId, onCancel, onSaved, onError }) {
  const [form, setForm] = useState({
    label: '', phone_number_id: '', access_token: '',
    business_account_id: '', app_id: '', display_phone: '',
    source: 'cloud_api', is_default: false,
  })
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      const body = { ...form }
      // Strip empty optional strings — schema rejects empty for some.
      for (const k of ['business_account_id', 'app_id', 'display_phone']) {
        if (!body[k]) delete body[k]
      }
      const res = await fetch(`/api/locations/${locationId}/whatsapp/numbers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Failed to add number')
      onSaved()
    } catch (e) {
      onError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 space-y-2">
      <h5 className="text-xs font-semibold text-un1t-text">Add WhatsApp number</h5>
      <Row label="Label" hint="A short name for the operator UI (e.g. 'Stillorgan mobile')">
        <input className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
      </Row>
      <Row label="Phone Number ID" hint={FIELD_HELP.phone_number_id}>
        <input className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono" value={form.phone_number_id} onChange={(e) => setForm({ ...form, phone_number_id: e.target.value.trim() })} />
      </Row>
      <Row label="Display phone" hint="Friendly format for the UI, e.g. +353 1 234 5678">
        <input className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text" value={form.display_phone} onChange={(e) => setForm({ ...form, display_phone: e.target.value })} />
      </Row>
      <Row label="Access token" hint={FIELD_HELP.access_token}>
        <textarea rows={2} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono" value={form.access_token} onChange={(e) => setForm({ ...form, access_token: e.target.value })} />
      </Row>
      <Row label="WABA ID" hint={FIELD_HELP.business_account_id}>
        <input className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono" value={form.business_account_id} onChange={(e) => setForm({ ...form, business_account_id: e.target.value.trim() })} />
      </Row>
      <Row label="App ID" hint={FIELD_HELP.app_id}>
        <input className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono" value={form.app_id} onChange={(e) => setForm({ ...form, app_id: e.target.value.trim() })} />
      </Row>
      <Row label="Source">
        <select className="bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
          <option value="cloud_api">Cloud API</option>
          <option value="coexistence">Coexistence (mobile + API)</option>
        </select>
      </Row>
      <label className="flex items-center gap-2 text-[11px] text-un1t-subtle">
        <input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} />
        Make this the default outbound number for this location
      </label>
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={save}
          disabled={saving || !form.label.trim() || !form.phone_number_id.trim() || !form.access_token.trim()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-un1t-text text-un1t-bg text-[11px] font-semibold hover:bg-un1t-accent disabled:opacity-50"
        >
          {saving ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} className="text-[11px] text-un1t-subtle hover:text-un1t-text">
          Cancel
        </button>
      </div>
    </div>
  )
}

function EditNumberForm({ locationId, number, canEdit, onSaved, onError }) {
  const [form, setForm] = useState({
    label: number.label || '',
    display_phone: number.display_phone || '',
    business_account_id: number.business_account_id || '',
    app_id: number.app_id || '',
    is_active: number.is_active,
    new_access_token: '', // empty by default — only sent on save if non-empty
  })
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      const updates = {
        label: form.label.trim() || undefined,
        display_phone: form.display_phone || null,
        business_account_id: form.business_account_id || null,
        app_id: form.app_id || null,
        is_active: form.is_active,
      }
      if (form.new_access_token.trim()) {
        updates.access_token = form.new_access_token.trim()
      }
      const res = await fetch(`/api/locations/${locationId}/whatsapp/numbers/${number.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Failed to save')
      onSaved()
    } catch (e) {
      onError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-t border-un1t-border p-3 space-y-2 bg-un1t-surface/30">
      <Row label="Label">
        <input disabled={!canEdit} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
      </Row>
      <Row label="Display phone">
        <input disabled={!canEdit} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text" value={form.display_phone} onChange={(e) => setForm({ ...form, display_phone: e.target.value })} />
      </Row>
      <Row label="WABA ID">
        <input disabled={!canEdit} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono" value={form.business_account_id} onChange={(e) => setForm({ ...form, business_account_id: e.target.value.trim() })} />
      </Row>
      <Row label="App ID">
        <input disabled={!canEdit} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono" value={form.app_id} onChange={(e) => setForm({ ...form, app_id: e.target.value.trim() })} />
      </Row>
      <Row label="Current token" hint="Stored value (last 6 chars shown). To change, paste a new token below.">
        <code className="block w-full bg-un1t-surface/50 border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-muted">
          {number.access_token_redacted || '••••'}
        </code>
      </Row>
      <Row label="New access token (leave blank to keep current)">
        <textarea disabled={!canEdit} rows={2} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono" value={form.new_access_token} onChange={(e) => setForm({ ...form, new_access_token: e.target.value })} />
      </Row>
      <label className="flex items-center gap-2 text-[11px] text-un1t-subtle">
        <input type="checkbox" disabled={!canEdit} checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
        Active (uncheck to disable without deleting — useful for temporary maintenance)
      </label>
      {canEdit && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-un1t-text text-un1t-bg text-[11px] font-semibold hover:bg-un1t-accent disabled:opacity-50"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}

function Row({ label, hint, children }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-wider text-un1t-subtle mb-0.5">{label}</div>
      {children}
      {hint && <div className="text-[10px] text-un1t-muted mt-0.5">{hint}</div>}
    </label>
  )
}
