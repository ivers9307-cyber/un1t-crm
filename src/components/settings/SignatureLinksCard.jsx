'use client'

// MAIL-SIG.2 — the STUDIO half of the email signature, portal-editable
// (Richard, 2 Sep: the Book-a-class / Membership links must be changeable
// here, and they differ per studio — a send from a Hatch account carries
// Hatch's links, from Stillorgan Stillorgan's, whoever the sender is).
//
// What lives here: the studio phone + up to five labelled links. What does
// NOT: names and photos (the person's own, on /account). Saved through the
// existing branding PUT (owner/master + location access — the same gate as
// the rest of this page), merged key-wise so it can't clobber the logo.

import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, Field } from '@/components/ui'

const MAX_LINKS = 5

const emptyRow = () => ({ label: '', url: '' })

function rowError(row) {
  const label = row.label.trim()
  const url = row.url.trim()
  if (!label && !url) return null // empty rows are dropped silently at save
  if (!url) return 'Add the link address'
  if (!/^https?:\/\/\S+$/i.test(url)) return 'Links must start with http:// or https://'
  return null
}

export default function SignatureLinksCard({ locationId }) {
  const [phone, setPhone] = useState('')
  const [rows, setRows] = useState([emptyRow()])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState(null) // {tone:'ok'|'err', text}

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await fetch(`/api/settings/branding?location_id=${encodeURIComponent(locationId)}`)
        const j = await res.json().catch(() => null)
        if (!alive) return
        const sig = j?.data?.email_signature || null
        setPhone(sig?.phone || '')
        setRows(Array.isArray(sig?.links) && sig.links.length ? sig.links.map(l => ({ label: l.label || '', url: l.url || '' })) : [emptyRow()])
      } catch { /* stays editable from blank; save writes fresh */ }
      if (alive) setLoaded(true)
    })()
    return () => { alive = false }
  }, [locationId])

  const errors = rows.map(rowError)
  const hasError = errors.some(Boolean)

  async function save() {
    if (hasError || saving) return
    setSaving(true)
    setNotice(null)
    const links = rows
      .map(r => ({ label: r.label.trim(), url: r.url.trim() }))
      .filter(r => r.url)
      .slice(0, MAX_LINKS)
    const payload = (phone.trim() || links.length)
      ? { phone: phone.trim(), links }
      : null // nothing set = clear back to personal fallbacks
    try {
      const res = await fetch('/api/settings/branding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, email_signature: payload }),
      })
      const j = await res.json().catch(() => null)
      if (!res.ok || !j?.success) {
        setNotice({ tone: 'err', text: j?.error || 'Save failed — try again' })
      } else {
        setNotice({ tone: 'ok', text: 'Saved — every email sent from this studio carries these from now on' })
      }
    } catch {
      setNotice({ tone: 'err', text: 'Save failed — try again' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-xl border border-un1t-border bg-un1t-bg p-5">
      <h3 className="text-sm font-semibold text-un1t-text">Email signature — studio details</h3>
      <p className="mt-1 text-xs text-un1t-subtle">
        Every email sent from this studio&rsquo;s accounts carries these in the sender&rsquo;s
        signature — whoever sends it. Names and photos come from each person&rsquo;s own
        account page.
      </p>

      <div className="mt-4 max-w-sm">
        <Field label="Studio phone">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={60}
            placeholder="+353 1 578 9401"
            className="w-full rounded border border-un1t-border bg-un1t-bg px-2 py-1.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
          />
        </Field>
      </div>

      <div className="mt-4 space-y-2">
        <span className="text-xs font-medium text-un1t-subtle">Links (up to {MAX_LINKS})</span>
        {rows.map((row, i) => (
          <div key={i} className="flex items-start gap-2">
            <input
              value={row.label}
              onChange={(e) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))}
              maxLength={40}
              placeholder="Book a class"
              aria-label={`Link ${i + 1} label`}
              className="w-44 rounded border border-un1t-border bg-un1t-bg px-2 py-1.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
            />
            <div className="min-w-0 flex-1">
              <input
                value={row.url}
                onChange={(e) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, url: e.target.value } : r)))}
                maxLength={300}
                placeholder="https://…"
                aria-label={`Link ${i + 1} address`}
                className="w-full rounded border border-un1t-border bg-un1t-bg px-2 py-1.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
              />
              {errors[i] && <p role="alert" className="mt-1 text-[11px] text-red-700">{errors[i]}</p>}
            </div>
            <button
              type="button"
              onClick={() => setRows(rs => (rs.length === 1 ? [emptyRow()] : rs.filter((_, j) => j !== i)))}
              aria-label={`Remove link ${i + 1}`}
              className="mt-1.5 text-un1t-muted hover:text-un1t-text"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {rows.length < MAX_LINKS && (
          <button
            type="button"
            onClick={() => setRows(rs => [...rs, emptyRow()])}
            className="inline-flex items-center gap-1 text-xs font-medium text-un1t-subtle hover:text-un1t-text"
          >
            <Plus size={12} /> Add link
          </button>
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button type="button" size="sm" onClick={save} loading={saving} disabled={!loaded || hasError}>
          Save signature details
        </Button>
        {notice && (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            notice.tone === 'ok' ? 'bg-emerald-500/10 text-emerald-700' : 'bg-red-500/10 text-red-700'
          }`}>
            {notice.text}
          </span>
        )}
      </div>
    </div>
  )
}
