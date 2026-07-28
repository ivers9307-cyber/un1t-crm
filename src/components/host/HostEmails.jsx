'use client'

// HOST-EMAIL.3/.4 — the host portal's "Email your contacts" surface.
//
// .4 upgrades the composer to parity with the CRM communications editor:
//   - the same Unlayer visual designer (design + plain-text modes; the
//     design document round-trips via host_campaigns.design_json so drafts
//     reopen editable), and
//   - an audience picker: everyone, or confirmed attendees of ONE of the
//     host's events (resolved from registrations server-side at send time).
//
// The server still owns every send gate (verified sender, daily cap,
// consent/suppression, double-send CAS) and its 409 messages are
// user-facing, so they render inline verbatim. The unsubscribe footer is
// injected server-side after sanitization — nothing here can omit it.
//
// Dark UN1T host-portal styling (bg-black page) — dark-surface chip recipe
// `bg-<c>-500/15 text-<c>-300`; host paths are exempt from the light-theme
// -700 chip rule.

import { useCallback, useEffect, useRef, useState } from 'react'

const STATUS_CHIP = {
  draft: 'bg-white/10 text-white/70',
  sending: 'bg-amber-500/15 text-amber-300',
  sent: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
}

const STATUS_LABEL = {
  draft: 'Draft',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
}

const UNLAYER_SRC = 'https://editor.unlayer.com/embed.js'
const EDITOR_DIV_ID = 'host-email-designer'

export default function HostEmails() {
  const [campaigns, setCampaigns] = useState(null) // null = loading
  const [audiences, setAudiences] = useState({ all_count: null, events: [] })
  const [subject, setSubject] = useState('')
  const [audienceEventId, setAudienceEventId] = useState('')
  const [mode, setMode] = useState('design') // 'design' | 'text'
  const [textBody, setTextBody] = useState('')
  const [editingId, setEditingId] = useState(null) // draft being edited (null = new)
  const [unlayerReady, setUnlayerReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sendingId, setSendingId] = useState(null)
  const [loadingDraftId, setLoadingDraftId] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const editorInited = useRef(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/host/emails', { cache: 'no-store' })
      const json = await res.json().catch(() => ({}))
      if (res.ok && json.success) setCampaigns(json.data || [])
      else setCampaigns([])
    } catch {
      setCampaigns([])
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    fetch('/api/host/emails/audiences', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (j?.success) setAudiences(j.data) })
      .catch(() => {})
  }, [])

  // Load the Unlayer embed script once; fall back to plain text if it never
  // arrives (blocked network, script error) so the host can always write.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.unlayer) { setUnlayerReady(true); return }
    const existing = document.querySelector(`script[src="${UNLAYER_SRC}"]`)
    const script = existing || document.createElement('script')
    const onLoad = () => setUnlayerReady(true)
    const onError = () => setMode('text')
    script.addEventListener('load', onLoad)
    script.addEventListener('error', onError)
    if (!existing) {
      script.src = UNLAYER_SRC
      script.async = true
      document.body.appendChild(script)
    }
    return () => {
      script.removeEventListener('load', onLoad)
      script.removeEventListener('error', onError)
    }
  }, [])

  // Init the designer when the script is up and design mode is showing.
  useEffect(() => {
    if (!unlayerReady || mode !== 'design') return
    if (editorInited.current) return
    const el = document.getElementById(EDITOR_DIV_ID)
    if (!el || !window.unlayer) return
    window.unlayer.init({
      id: EDITOR_DIV_ID,
      displayMode: 'email',
      appearance: { theme: 'dark' },
    })
    editorInited.current = true
  }, [unlayerReady, mode])

  function exportDesign() {
    return new Promise((resolve, reject) => {
      if (!window.unlayer) return reject(new Error('Designer not loaded'))
      try {
        window.unlayer.exportHtml((data) => resolve(data || {}))
      } catch (e) {
        reject(e)
      }
    })
  }

  function resetComposer() {
    setSubject('')
    setTextBody('')
    setAudienceEventId('')
    setEditingId(null)
    if (editorInited.current && window.unlayer) {
      try {
        if (typeof window.unlayer.loadBlankTemplate === 'function') window.unlayer.loadBlankTemplate()
        else window.unlayer.loadDesign({ body: { rows: [] } })
      } catch { /* leave whatever design is showing */ }
    }
  }

  async function editDraft(id) {
    setError('')
    setNotice('')
    setLoadingDraftId(id)
    try {
      const res = await fetch(`/api/host/emails/${id}`, { cache: 'no-store' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.error || 'Could not open the draft.')
        return
      }
      const c = json.data
      setEditingId(c.id)
      setSubject(c.subject || '')
      setAudienceEventId(c.audience_event_id || '')
      if (c.design_json && unlayerReady && window.unlayer) {
        setMode('design')
        try { window.unlayer.loadDesign(c.design_json) } catch { /* stale design doc — editor keeps its current state */ }
      } else {
        setMode('text')
        setTextBody(c.body_html || '')
      }
      document.getElementById('host-email-subject')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } catch {
      setError('Could not open the draft.')
    } finally {
      setLoadingDraftId(null)
    }
  }

  async function saveDraft(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      let body = textBody
      let designJson = null
      if (mode === 'design') {
        const exported = await exportDesign()
        body = exported.html || ''
        designJson = exported.design || null
        if (!body.trim()) {
          setError('The design is empty — add some content first.')
          return
        }
      }
      const payload = {
        subject,
        body,
        design_json: designJson,
        audience_event_id: audienceEventId || null,
      }
      const res = await fetch(editingId ? `/api/host/emails/${editingId}` : '/api/host/emails', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.error || 'Could not save the email.')
        return
      }
      resetComposer()
      setNotice('Draft saved — press Send when you’re ready.')
      await load()
    } catch {
      setError('Could not save the email.')
    } finally {
      setBusy(false)
    }
  }

  function audienceLabel(id) {
    if (!id) {
      return audiences.all_count == null
        ? 'all your emailable contacts'
        : `all ${audiences.all_count} contacts (where emailable)`
    }
    const ev = audiences.events.find((x) => x.id === id)
    return ev ? `attendees of ${ev.name} (${ev.race_date})` : 'the selected event’s attendees'
  }

  async function send(id, campaignAudienceId) {
    if (!window.confirm(`Send this email to ${audienceLabel(campaignAudienceId)}?`)) return
    setError('')
    setNotice('')
    setSendingId(id)
    try {
      const res = await fetch(`/api/host/emails/${id}/send`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        // The 409 messages ("Daily send limit reached.", "No emailable
        // contacts.", "Sending is not enabled — …") are user-facing.
        setError(json.error || 'Could not send the email.')
        return
      }
      const n = json.data?.recipient_count || 0
      setNotice(`Sending to ${n} contact${n === 1 ? '' : 's'} — this takes a few minutes.`)
      await load()
    } catch {
      setError('Could not send the email.')
    } finally {
      setSendingId(null)
    }
  }

  const input =
    'w-full rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-sm text-white ' +
    'placeholder:text-white/30 focus:outline-none focus:border-white/40'

  return (
    <div>
      {(error || notice) && (
        <div
          className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
            error
              ? 'border-red-500/25 bg-red-500/10 text-red-300'
              : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
          }`}
        >
          {error || notice}
        </div>
      )}

      <section className="mt-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs uppercase tracking-[0.15em] text-white/45">
            {editingId ? 'Edit draft' : 'New email'}
          </h2>
          {editingId && (
            <button
              type="button"
              onClick={resetComposer}
              className="text-xs text-white/45 hover:text-white"
            >
              Discard changes · start a new email
            </button>
          )}
        </div>
        <form onSubmit={saveDraft} className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="host-email-subject" className="block text-xs text-white/50 mb-1">Subject</label>
              <input
                id="host-email-subject"
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={200}
                required
                placeholder="e.g. Early-bird tickets are live"
                className={input}
              />
            </div>
            <div>
              <label htmlFor="host-email-audience" className="block text-xs text-white/50 mb-1">Send to</label>
              <select
                id="host-email-audience"
                value={audienceEventId}
                onChange={(e) => setAudienceEventId(e.target.value)}
                className={input}
              >
                <option value="">
                  Everyone{audiences.all_count != null ? ` (${audiences.all_count})` : ''}
                </option>
                {audiences.events.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    Attended · {ev.name} — {ev.race_date} ({ev.count})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="block text-xs text-white/50">Message</span>
              <div className="flex gap-1 text-[11px]">
                <button
                  type="button"
                  onClick={() => setMode('design')}
                  disabled={!unlayerReady}
                  className={`rounded px-2 py-0.5 ${mode === 'design' ? 'bg-white/15 text-white' : 'text-white/45 hover:text-white'} disabled:opacity-40`}
                >
                  Design
                </button>
                <button
                  type="button"
                  onClick={() => setMode('text')}
                  className={`rounded px-2 py-0.5 ${mode === 'text' ? 'bg-white/15 text-white' : 'text-white/45 hover:text-white'}`}
                >
                  Plain text
                </button>
              </div>
            </div>

            {mode === 'design' ? (
              <div className="rounded-lg overflow-hidden border border-white/15 bg-white/[0.02]">
                <div id={EDITOR_DIV_ID} style={{ minHeight: 480 }}>
                  {!unlayerReady && (
                    <p className="text-white/40 text-sm p-4">Loading the designer…</p>
                  )}
                </div>
              </div>
            ) : (
              <textarea
                id="host-email-body"
                value={textBody}
                onChange={(e) => setTextBody(e.target.value)}
                maxLength={20000}
                required
                rows={8}
                placeholder="Write your email…"
                className={input}
              />
            )}
            <p className="text-[11px] text-white/35 mt-1">
              Sent with your sender name and an unsubscribe link added automatically.
            </p>
          </div>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-white text-black text-sm font-semibold px-4 py-2 hover:bg-white/90 disabled:opacity-50"
          >
            {busy ? 'Saving…' : editingId ? 'Save changes' : 'Save draft'}
          </button>
        </form>
      </section>

      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-3">Your emails</h2>
        {campaigns === null ? (
          <p className="text-white/40 text-sm">Loading…</p>
        ) : campaigns.length === 0 ? (
          <p className="text-white/50 text-sm">No emails yet — write your first one above.</p>
        ) : (
          <ul className="divide-y divide-white/10 rounded-xl border border-white/10 overflow-hidden">
            {campaigns.map((c) => {
              const chip = STATUS_CHIP[c.status] || 'bg-white/10 text-white/70'
              return (
                <li key={c.id} className="px-4 py-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      <span className="truncate">{c.subject}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${chip}`}>
                        {STATUS_LABEL[c.status] || c.status}
                      </span>
                    </p>
                    <p className="text-xs text-white/45 mt-0.5">
                      {c.status === 'draft'
                        ? 'Not sent yet'
                        : `${c.sent_count || 0}/${c.recipient_count ?? '—'} sent`}
                      {' · '}
                      {(c.sent_at || c.created_at || '').slice(0, 10) || '—'}
                    </p>
                  </div>
                  {c.status === 'draft' && (
                    <div className="shrink-0 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => editDraft(c.id)}
                        disabled={loadingDraftId === c.id}
                        className="rounded-lg border border-white/20 text-white/80 text-xs font-semibold px-3 py-1.5 hover:text-white hover:border-white/40 disabled:opacity-50"
                      >
                        {loadingDraftId === c.id ? 'Opening…' : 'Edit'}
                      </button>
                      <button
                        type="button"
                        onClick={() => send(c.id, c.audience_event_id || '')}
                        disabled={sendingId === c.id}
                        className="rounded-lg bg-white text-black text-xs font-semibold px-3 py-1.5 hover:bg-white/90 disabled:opacity-50"
                      >
                        {sendingId === c.id ? 'Sending…' : 'Send'}
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
