'use client'

// ContactForm — shared create / edit form for /contacts.
//
// Manager+ only. Used by /contacts/new (no `contact` prop) and from
// the Edit drawer on the contact profile (`contact` prop populated).
// The same component drives both flows so adding a new field only
// touches one place.
//
// Backed by /api/contacts (POST + PUT) which now accepts cookie auth
// for manager+ in addition to the existing n8n API key path.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, AlertCircle, Loader2 } from 'lucide-react'

// CLASSIFY.2 — the lead_status picker is gone. Pipeline stage is now
// auto-derived from the contact's open deal (trigger from mig 155),
// so operators move stage by moving the deal on the kanban, not by
// flipping a select on the contact form.

const LEAD_SOURCES = [
  { value: '',          label: '(none)' },
  { value: 'booking',   label: 'Booking' },
  { value: 'meta',      label: 'Meta (Facebook/Instagram)' },
  { value: 'tiktok',    label: 'TikTok' },
  { value: 'walkin',    label: 'Walk-in' },
  { value: 'referral',  label: 'Referral' },
  { value: 'website',   label: 'Website' },
  { value: 'whatsapp',  label: 'WhatsApp' },
  { value: 'other',     label: 'Other' },
]

export default function ContactForm({ contact = null, onCancelHref = '/contacts' }) {
  const router = useRouter()
  const isEditing = !!contact

  const [firstName, setFirstName] = useState(contact?.first_name || '')
  const [lastName, setLastName] = useState(contact?.last_name || '')
  const [email, setEmail] = useState(contact?.email || '')
  const [phone, setPhone] = useState(contact?.phone || '')
  const [leadSource, setLeadSource] = useState(contact?.lead_source || '')
  const [label, setLabel] = useState(contact?.label || '')
  const [glofoxId, setGlofoxId] = useState(contact?.glofox_member_id || '')
  // Tags rendered as a single comma-separated input — small enough
  // to not warrant the audience-builder-style pill chip UI for v1.
  const [tagsCsv, setTagsCsv] = useState(
    Array.isArray(contact?.tags) ? contact.tags.join(', ') : ''
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    if (!firstName.trim() && !lastName.trim()) {
      setError('First name or last name is required.')
      return
    }
    if (!email.trim()) {
      setError('Email is required.')
      return
    }

    setSaving(true)
    const trimmedFirst = firstName.trim()
    const trimmedLast = lastName.trim()
    const fullName = [trimmedFirst, trimmedLast].filter(Boolean).join(' ')

    const payload = {
      name: fullName || email.trim(),
      first_name: trimmedFirst || null,
      last_name: trimmedLast || null,
      email: email.trim(),
      phone: phone.trim() || null,
      lead_source: leadSource || undefined,
      label: label.trim() || null,
      glofox_member_id: glofoxId.trim() || null,
    }
    // Tags only sent when provided so a blank input on edit doesn't
    // wipe existing tags. Edit-only — POST doesn't take tags today.
    if (isEditing && tagsCsv.trim()) {
      payload.tags = tagsCsv
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
    } else if (isEditing && !tagsCsv.trim() && Array.isArray(contact?.tags) && contact.tags.length > 0) {
      // Operator cleared the field — explicitly send empty array.
      payload.tags = []
    }

    try {
      const url = isEditing ? `/api/contacts/${contact.id}` : '/api/contacts'
      const method = isEditing ? 'PUT' : 'POST'
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.error || `Save failed (${r.status})`)
        setSaving(false)
        return
      }
      router.push(isEditing ? `/contacts/${contact.id}` : `/contacts/${j.data.id}`)
      router.refresh()
    } catch (err) {
      setError(err.message || 'Network error')
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Link href={onCancelHref} className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text">
        <ArrowLeft size={16} /> {isEditing ? 'Back to contact' : 'Back to contacts'}
      </Link>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3 inline-flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Identity</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-un1t-subtle mb-1">First name</label>
            <input
              type="text"
              value={firstName}
              onChange={e => setFirstName(e.target.value)}
              maxLength={100}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
          </div>
          <div>
            <label className="block text-sm text-un1t-subtle mb-1">Last name</label>
            <input
              type="text"
              value={lastName}
              onChange={e => setLastName(e.target.value)}
              maxLength={100}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm text-un1t-subtle mb-1">Email *</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
          />
        </div>
        <div>
          <label className="block text-sm text-un1t-subtle mb-1">Phone</label>
          <input
            type="tel"
            value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="+353 87 123 4567"
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
          />
        </div>
      </div>

      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Pipeline</h3>
        <div>
          <label className="block text-sm text-un1t-subtle mb-1">Lead source</label>
          <select
            value={leadSource}
            onChange={e => setLeadSource(e.target.value)}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
          >
            {LEAD_SOURCES.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <p className="text-[11px] text-un1t-muted mt-2">
            Pipeline stage is set automatically when you move the contact&apos;s deal on the kanban board.
          </p>
        </div>
      </div>

      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Misc</h3>
        <div>
          <label className="block text-sm text-un1t-subtle mb-1">Label</label>
          <input
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            maxLength={100}
            placeholder="Free-form bucket — e.g. VIP, deposit-paid"
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
          />
        </div>
        <div>
          <label className="block text-sm text-un1t-subtle mb-1">Glofox member ID</label>
          <input
            type="text"
            value={glofoxId}
            onChange={e => setGlofoxId(e.target.value)}
            maxLength={100}
            placeholder="GFX-…"
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
          />
        </div>
        {isEditing && (
          <div>
            <label className="block text-sm text-un1t-subtle mb-1">Tags <span className="text-[11px] text-un1t-muted">(comma-separated)</span></label>
            <input
              type="text"
              value={tagsCsv}
              onChange={e => setTagsCsv(e.target.value)}
              placeholder="vip, race_completed"
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
            <p className="text-[11px] text-un1t-muted mt-1">
              Adding a tag here also fires any sequence with trigger=&quot;Tag Added&quot;.
            </p>
          </div>
        )}
      </div>

      <button
        type="submit"
        disabled={saving}
        className="w-full inline-flex items-center justify-center gap-2 bg-un1t-text text-un1t-bg font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent disabled:opacity-50"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
        {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Create contact'}
      </button>
    </form>
  )
}
