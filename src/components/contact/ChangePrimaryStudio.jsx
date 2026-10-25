'use client'
// ORGCONTACTS.4 (decision 4) — "Change primary studio": move the contact's
// primary studio to another studio the person has a relationship with. The
// server decides (POST /api/contacts/[id]/primary-studio: the primary
// studio's admins, an organisation admin, or a master); this control is only
// rendered for a caller the page's gate admits, and only when there is another
// studio to move to. A full reload follows success: the page's every card is
// keyed on the primary.
import { useState } from 'react'

export default function ChangePrimaryStudio({ contactId, currentLocationId, studios }) {
  // Review Focus 1: a deactivated studio or a host anchor is never a primary
  // studio, whatever relationship the person holds there (the card still lists it).
  const others = (studios || []).filter((s) => s?.location_id && s.location_id !== currentLocationId
    && s.location?.active !== false && s.location?.is_host_anchor !== true)
  const [target, setTarget] = useState(others[0]?.location_id || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  if (others.length === 0) return null

  async function onSubmit(e) {
    e.preventDefault()
    if (!target || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/contacts/${contactId}/primary-studio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: target }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.success) {
        setError(json?.error === 'no_relationship' ? 'This person has no relationship at that studio yet.'
          : json?.error === 'other_organisation' ? 'That studio is in another organisation.'
          : json?.error === 'studio_inactive' ? 'That studio is closed or is not a studio.'
          : json?.error || 'Could not change the primary studio.')
        return
      }
      window.location.reload()
    } catch {
      setError('Could not change the primary studio.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="pt-2 border-t border-un1t-border space-y-1.5">
      <label htmlFor="primary_location_id" className="block text-[11px] font-medium text-un1t-subtle">Change primary studio</label>
      <div className="flex items-center gap-2">
        <select
          id="primary_location_id"
          name="primary_location_id"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="flex-1 text-sm border border-un1t-border rounded-md px-2 py-1 bg-un1t-bg text-un1t-text"
        >
          {others.map((s) => <option key={s.location_id} value={s.location_id}>{s.location?.name || 'Studio'}</option>)}
        </select>
        <button type="submit" disabled={busy || !target} className="text-sm px-3 py-1 rounded-md bg-un1t-accent text-white disabled:opacity-50">
          {busy ? 'Moving…' : 'Move'}
        </button>
      </div>
      {error ? <p className="text-[11px] text-red-700">{error}</p> : null}
    </form>
  )
}
