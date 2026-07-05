'use client'

// RCOV.P1 — Hunt inboxes card on /accounting, rendered above
// CoverageBoard. Lists the Gmail app-password inboxes the hunt engine
// searches for invoices matching unreconciled bank lines, and lets an
// operator add/remove them. Mailboxes are a GLOBAL resource (no
// per-location scoping) so this card has no locationName prop and no
// location filter — same list regardless of active location.
//
// Styled like XeroLocationCard (bg-un1t-surface card, red-outline
// Remove button mirroring its Disconnect). Save flow mirrors
// AdsIntegrationTab's save() shape: POST JSON, clear the password
// field on success, re-fetch, inline error in the standard red chip
// recipe.

import { useCallback, useEffect, useState } from 'react'
import { Loading } from '@/components/ui'

export default function HuntInboxesCard() {
  const [inboxes, setInboxes] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [busyId, setBusyId] = useState(null)

  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch('/api/accounting/mailboxes')
      const json = await res.json()
      if (!json.success) { setLoadError(json.error); return }
      setInboxes(json.data)
    } catch (e) {
      setLoadError(e.message || 'Network error')
    }
  }, [])

  useEffect(() => { load() }, [load])

  function resetAddForm() {
    setLabel('')
    setEmail('')
    setPassword('')
    setSaveError(null)
    setAdding(false)
  }

  async function save() {
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch('/api/accounting/mailboxes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, email, password }),
      })
      const json = await res.json()
      if (!json.success) {
        setSaveError(json.error || 'Failed to add inbox')
        return
      }
      setPassword('')
      setLabel('')
      setEmail('')
      setAdding(false)
      await load()
    } catch (e) {
      setSaveError(e.message || 'Network error')
    } finally {
      setSaving(false)
    }
  }

  async function remove(id) {
    if (!window.confirm('Remove this inbox? Hunting will stop searching it.')) return
    setBusyId(id)
    try {
      const res = await fetch(`/api/accounting/mailboxes/${id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!json.success) { setLoadError(json.error); return }
      await load()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-semibold text-un1t-text">Hunt inboxes</div>
          <p className="text-xs text-un1t-subtle mt-1">
            The email accounts searched for invoices matching unreconciled bank lines. Gmail app
            password required (2-Step Verification must be on).
          </p>
        </div>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="shrink-0 text-xs px-3 py-1.5 bg-un1t-text text-un1t-bg rounded-md font-semibold hover:bg-un1t-accent"
          >
            Add inbox
          </button>
        )}
      </div>

      {loadError && (
        <div className="text-xs px-3 py-2 rounded bg-red-500/10 text-red-700 mb-3">{loadError}</div>
      )}

      {inboxes === null && !loadError ? (
        <Loading />
      ) : (
        <div className="space-y-2">
          {(inboxes || []).length === 0 && !adding ? (
            <div className="text-xs text-un1t-subtle">No hunt inboxes added yet.</div>
          ) : (
            (inboxes || []).map((mb) => {
              const failed = !!mb.last_error
              return (
                <div
                  key={mb.id}
                  className="flex items-center justify-between gap-3 border border-un1t-border/50 rounded-md px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-un1t-text font-medium truncate">{mb.label}</div>
                    <div className="text-xs text-un1t-subtle truncate">{mb.email}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`text-[11px] px-2 py-1 rounded ${failed ? 'bg-red-500/10 text-red-700' : 'bg-green-500/10 text-green-700'}`}
                      title={failed ? mb.last_error : undefined}
                    >
                      {failed ? 'Auth failed' : 'Connected'}
                    </span>
                    <button
                      type="button"
                      onClick={() => remove(mb.id)}
                      disabled={busyId === mb.id}
                      className="text-xs px-3 py-1.5 border border-red-500/40 hover:bg-red-500/10 text-red-700 rounded-md disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )
            })
          )}

          {adding && (
            <div className="border border-un1t-border/50 rounded-md p-3 space-y-2 mt-2">
              <div>
                <label className="block text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-1">
                  Label
                </label>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  disabled={saving}
                  placeholder="Stillorgan invoices"
                  className="w-full bg-un1t-bg/30 border border-un1t-border rounded-md px-3 py-1.5 text-xs text-un1t-text disabled:opacity-50"
                />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={saving}
                  placeholder="invoices@example.com"
                  className="w-full bg-un1t-bg/30 border border-un1t-border rounded-md px-3 py-1.5 text-xs text-un1t-text disabled:opacity-50"
                />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-1">
                  App password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={saving}
                  autoComplete="off"
                  placeholder="16-character Gmail app password"
                  className="w-full bg-un1t-bg/30 border border-un1t-border rounded-md px-3 py-1.5 text-xs text-un1t-text disabled:opacity-50"
                />
              </div>

              {saveError && (
                <div className="text-xs px-3 py-2 rounded bg-red-500/10 text-red-700">{saveError}</div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={resetAddForm}
                  disabled={saving}
                  className="text-xs px-3 py-1.5 bg-un1t-border/40 hover:bg-un1t-border text-un1t-text rounded-md disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || !label || !email || !password}
                  className="text-xs px-3 py-1.5 bg-un1t-text text-un1t-bg rounded-md font-semibold hover:bg-un1t-accent disabled:opacity-50"
                >
                  {saving ? 'Verifying…' : 'Save'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
