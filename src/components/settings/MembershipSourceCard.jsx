'use client'

// W1.M2 — the per-location "Membership source" card.
//
// Settings → Locations → <name> → Integrations, ABOVE the tab strip: which
// system is the source of truth for memberships at this studio
// (locations.membership_source, mig 717). The choices are every value the
// CHECK admits; one with no registered provider yet (un1t) is listed but
// DISABLED, and the route refuses it too (the registry decides, see
// src/lib/membership/source.js).
//
// The current STATE arrives as a prop, resolved server-side by the page
// (membershipSourceState): a client component cannot ask the seam itself
// without dragging @/lib/glofox into the browser bundle. Saving goes
// through PUT /api/locations/[id]/membership-source (owner here or master;
// the same guard the page's `canEdit` mirrors), then router.refresh() so
// the Glofox tab's dot and every gated page re-read the row.
//
// Switching to "none" never deletes a credential: the route says
// `warning: 'glofox_credentials_kept'` and the card repeats it.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Database, Loader2, Check, AlertTriangle } from 'lucide-react'
import { MEMBERSHIP_SOURCE_CHOICES, NOT_AVAILABLE_YET_LABEL } from '@/lib/membership/choices'

const STATE_COPY = {
  none: { tone: 'bg-un1t-border/40 text-un1t-subtle', label: 'No membership source' },
  configured: { tone: 'bg-green-500/10 text-green-700', label: 'Connected' },
  unconfigured: { tone: 'bg-amber-500/10 text-amber-700', label: 'Credentials incomplete' },
  unknown: { tone: 'bg-amber-500/10 text-amber-700', label: 'Could not load' },
}

function StateChip({ membershipSource }) {
  const state = membershipSource?.state || 'none'
  const copy = STATE_COPY[state] || STATE_COPY.none
  const choice = MEMBERSHIP_SOURCE_CHOICES.find((c) => c.key === membershipSource?.source)
  const label = state === 'none' || !choice ? copy.label : `${choice.label}: ${copy.label}`
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${copy.tone}`}>
      {label}
    </span>
  )
}

export default function MembershipSourceCard({ locationId, membershipSource, canEdit }) {
  const router = useRouter()
  // The row's value is the source of truth for the select; a failed read
  // (state 'unknown', source null) starts the select on 'none' but says so
  // in copy, never pretending the studio has no source.
  const current = membershipSource?.source || 'none'
  const [value, setValue] = useState(current)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [savedFlash, setSavedFlash] = useState(false)

  const dirty = value !== current
  const readFailed = membershipSource?.state === 'unknown'

  async function save() {
    if (!dirty || saving) return
    setSaving(true); setError(null); setNotice(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/membership-source`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ membership_source: value }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) {
        setError(j.error || `HTTP ${res.status}`)
      } else {
        if (j.warning === 'glofox_credentials_kept') {
          setNotice('The Glofox credentials were kept. To remove them, use Disconnect on the Glofox tab or in the Integrations hub.')
        }
        setSavedFlash(true)
        setTimeout(() => setSavedFlash(false), 2000)
        router.refresh()
      }
    } catch (e) {
      setError(e?.message || 'Network error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="mb-4 bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-2">
            <Database size={14} className="text-un1t-subtle" />
            <h4 className="text-sm font-semibold text-un1t-text">Membership source</h4>
          </div>
          <p className="text-xs text-un1t-subtle mt-1 max-w-md">
            Where memberships, bookings and credits come from at this studio.
            Radars, the membership trend, class automations and Mia&apos;s booking
            tools follow it. A studio with no source is a lead CRM only.
          </p>
        </div>
        <StateChip membershipSource={membershipSource} />
      </div>

      {readFailed && (
        <p className="mt-2 text-xs text-amber-700">
          Could not load the membership source for this studio. Try again, and
          save only if you mean to change it.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-un1t-text">
        <label htmlFor="membership-source">Membership source</label>
        <select
          id="membership-source"
          value={value}
          disabled={!canEdit}
          onChange={(e) => setValue(e.target.value)}
          className="rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-xs text-un1t-text disabled:opacity-60"
        >
          {MEMBERSHIP_SOURCE_CHOICES.map((c) => (
            <option key={c.key} value={c.key} disabled={!c.registered}>
              {c.registered ? c.label : `${c.label} (${NOT_AVAILABLE_YET_LABEL})`}
            </option>
          ))}
        </select>
        <span className="text-un1t-muted">
          {MEMBERSHIP_SOURCE_CHOICES.find((c) => c.key === value)?.hint}
        </span>
      </div>

      {membershipSource?.state === 'unconfigured' && Array.isArray(membershipSource.missing) && membershipSource.missing.length > 0 && (
        <p className="mt-1 text-xs text-amber-700">
          Missing: {membershipSource.missing.join(', ')}.
        </p>
      )}

      {error && (
        <div className="mt-2 text-xs text-red-700 bg-red-500/10 border border-red-200 rounded p-2 inline-flex items-center gap-1.5">
          <AlertTriangle size={12} /> {error}
        </div>
      )}
      {notice && (
        <div className="mt-2 text-xs text-amber-700 bg-amber-500/10 border border-amber-200 rounded p-2 inline-flex items-center gap-1.5">
          <AlertTriangle size={12} /> {notice}
        </div>
      )}

      {canEdit && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            aria-label="Save membership source"
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent disabled:opacity-50"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : null}
            Save
          </button>
          {savedFlash && (
            <span className="inline-flex items-center gap-1 text-xs text-green-700">
              <Check size={12} /> Saved
            </span>
          )}
        </div>
      )}
    </section>
  )
}
