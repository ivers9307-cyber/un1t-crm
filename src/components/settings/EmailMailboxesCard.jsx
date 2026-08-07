'use client'

// EMAIL-MAILBOX-ADMIN.1 — the operator surface for a studio's email accounts
// and who may read each one.
//
// WHERE THIS LIVES AND WHY
// Settings → Locations → <studio> → Email. It replaces the single "Email
// Inbox / Reply-To" field that used to sit in LocationForm: that field wrote
// locations.email_inbox_reply_to, which mig 485 superseded with
// email_mailboxes (many accounts per studio, each separately permissioned).
// Leaving a one-address field on the Details tab implied a studio still has
// exactly one address and that editing it changed where mail goes — neither
// of which is true any more.
//
// TWO THINGS ON ONE SCREEN, deliberately: the accounts, and who reads each.
// They are one decision ("we're adding sales@ — the front desk handles it"),
// and splitting them across two pages guarantees the second half is forgotten.
//
// ELEVATION IS SHOWN, NOT HIDDEN. Owners and masters read every account here
// with no grant row, and no row can be created or deleted for them. They are
// listed with an "Always" chip and no toggle — if they appeared as ordinary
// grants an operator would try to revoke one, watch nothing change, and stop
// trusting the screen.

import { useCallback, useEffect, useState } from 'react'
import { Mail, Loader2, Plus, Star, EyeOff, Eye, Check, AlertTriangle, Users } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { MAILBOX_LABEL_MAX, mailboxInputIssues } from '@/lib/email-mailbox-admin'

const CHIP = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium'

const ROLE_LABEL = {
  owner: 'Owner',
  manager: 'Manager',
  head_coach: 'Head coach',
  staff: 'Staff',
}

function AccessChip({ access }) {
  if (access === 'implicit') {
    return <span className={`${CHIP} bg-purple-500/10 text-purple-700`}>Always</span>
  }
  if (access === 'granted') {
    return <span className={`${CHIP} bg-green-500/10 text-green-700`}>Can read</span>
  }
  return <span className={`${CHIP} bg-slate-500/10 text-slate-700`}>No access</span>
}

export default function EmailMailboxesCard({ locationId }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [mailboxes, setMailboxes] = useState([])
  const [busy, setBusy] = useState(null)
  const [openAccess, setOpenAccess] = useState(null)

  // Add form
  const [address, setAddress] = useState('')
  const [label, setLabel] = useState('')
  const [makeDefault, setMakeDefault] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState(null)

  // Rename
  const [editingId, setEditingId] = useState(null)
  const [editLabel, setEditLabel] = useState('')

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/email/mailboxes`)
      const j = await res.json()
      if (!res.ok || !j.success) {
        setError(j.error || `HTTP ${res.status}`)
        setMailboxes([])
      } else {
        setMailboxes(j.data.mailboxes || [])
      }
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setLoading(false)
    }
  }, [locationId])

  useEffect(() => { load() }, [load])

  // Client-side mirror of the DB's own CHECKs, from the same pure module the
  // route uses — so the message is identical whichever side catches it.
  const draftIssues = mailboxInputIssues({ address, label })
  const draftTouched = address.trim() !== '' || label.trim() !== ''

  async function send(url, method, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }))
    return j
  }

  async function handleAdd(e) {
    e.preventDefault()
    setAddError(null)
    if (draftIssues.length > 0) { setAddError(draftIssues[0]); return }
    setAdding(true)
    const j = await send(`/api/locations/${locationId}/email/mailboxes`, 'POST', {
      address, label, is_default: makeDefault,
    })
    setAdding(false)
    if (!j.success) { setAddError(j.error || 'Could not add that account.'); return }
    setAddress(''); setLabel(''); setMakeDefault(false)
    await load()
  }

  async function patchMailbox(mailboxId, patch, key) {
    setBusy(`${mailboxId}:${key}`)
    setError(null)
    const j = await send(`/api/locations/${locationId}/email/mailboxes/${mailboxId}`, 'PATCH', patch)
    setBusy(null)
    if (!j.success) { setError(j.error || 'Could not save that change.'); return false }
    await load()
    return true
  }

  async function setAccess(mailboxId, profileId, granted) {
    setBusy(`${mailboxId}:${profileId}`)
    setError(null)
    const j = await send(
      `/api/locations/${locationId}/email/mailboxes/${mailboxId}/access`,
      'PUT',
      { profile_id: profileId, granted }
    )
    setBusy(null)
    if (!j.success) { setError(j.error || 'Could not change access.'); return }
    await load()
  }

  if (loading) {
    return (
      <Card title="Email accounts">
        <div className="flex items-center gap-2 text-sm text-un1t-subtle">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading accounts…
        </div>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card title="Email accounts">
        <p className="text-xs text-un1t-muted">
          Each account is an address this studio receives mail at. Everything sent to one lands in
          its own tab in <a href="/communications/tickets" className="underline text-un1t-subtle">Email</a>,
          and replies go back out from the same address. The <strong>default</strong> account is the
          one stamped as Reply-To on campaign and marketing sends.
        </p>
        <p className="mt-2 text-xs text-un1t-muted">
          An address can belong to only one account across the whole estate — inbound mail has to
          route somewhere unambiguous.
        </p>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {mailboxes.length === 0 && (
          <p className="mt-4 rounded-lg border border-un1t-border bg-un1t-bg/60 p-4 text-sm text-un1t-subtle">
            This studio has no email accounts yet. Add one below — until then, nothing routes into
            the Email inbox for this location.
          </p>
        )}

        <ul className="mt-4 space-y-3">
          {mailboxes.map((m) => {
            const isOpen = openAccess === m.id
            const readers = (m.access || []).filter(a => a.access !== 'none').length
            return (
              <li key={m.id} className="rounded-lg border border-un1t-border bg-un1t-bg/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    {editingId === m.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={editLabel}
                          maxLength={MAILBOX_LABEL_MAX}
                          onChange={(e) => setEditLabel(e.target.value)}
                          aria-label={`Label for ${m.address}`}
                          className="w-48 rounded-md border border-un1t-border bg-un1t-bg px-2 py-1 text-sm text-un1t-text focus:border-un1t-muted focus:outline-none"
                        />
                        <Button
                          type="button"
                          size="sm"
                          loading={busy === `${m.id}:label`}
                          onClick={async () => {
                            const ok = await patchMailbox(m.id, { label: editLabel }, 'label')
                            if (ok) setEditingId(null)
                          }}
                        >
                          Save
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <Mail className="h-4 w-4 text-un1t-subtle" aria-hidden="true" />
                        <span className="text-sm font-medium text-un1t-text">{m.label}</span>
                        {m.is_default && (
                          <span className={`${CHIP} bg-blue-500/10 text-blue-700`}>
                            <Star className="h-3 w-3" aria-hidden="true" /> Default
                          </span>
                        )}
                        {!m.active && (
                          <span className={`${CHIP} bg-amber-500/10 text-amber-700`}>Deactivated</span>
                        )}
                      </div>
                    )}
                    <div className="mt-1 font-mono text-xs text-un1t-subtle break-all">{m.address}</div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {editingId !== m.id && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => { setEditingId(m.id); setEditLabel(m.label) }}
                      >
                        Rename
                      </Button>
                    )}
                    {m.active && !m.is_default && (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        icon={Star}
                        loading={busy === `${m.id}:default`}
                        onClick={() => patchMailbox(m.id, { is_default: true }, 'default')}
                      >
                        Make default
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant={m.active ? 'danger' : 'secondary'}
                      icon={m.active ? EyeOff : Eye}
                      loading={busy === `${m.id}:active`}
                      onClick={() => patchMailbox(m.id, { active: !m.active }, 'active')}
                    >
                      {m.active ? 'Deactivate' : 'Reactivate'}
                    </Button>
                  </div>
                </div>

                {!m.active && (
                  <p className="mt-2 text-[11px] text-un1t-muted">
                    Deactivated: mail sent here no longer routes anywhere and the tab is hidden from
                    everyone, owners included. The account and its ticket history are kept, so
                    reactivating restores them exactly.
                  </p>
                )}

                <div className="mt-3 border-t border-un1t-border pt-3">
                  <button
                    type="button"
                    onClick={() => setOpenAccess(isOpen ? null : m.id)}
                    aria-expanded={isOpen}
                    className="inline-flex items-center gap-2 text-xs font-medium text-un1t-subtle hover:text-un1t-text"
                  >
                    <Users className="h-3.5 w-3.5" aria-hidden="true" />
                    {isOpen ? 'Hide' : 'Who can read this'}
                    <span className="text-un1t-muted">({readers})</span>
                  </button>

                  {isOpen && (
                    <ul className="mt-3 space-y-1">
                      {(m.access || []).length === 0 && (
                        <li className="text-xs text-un1t-muted">No staff are assigned to this studio yet.</li>
                      )}
                      {(m.access || []).map((a) => (
                        <li
                          key={a.profile_id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1.5 odd:bg-un1t-bg/40"
                        >
                          <div className="min-w-0">
                            <div className="text-sm text-un1t-text">{a.full_name || a.email || 'Unnamed'}</div>
                            <div className="text-[11px] text-un1t-muted">
                              {ROLE_LABEL[a.role] || a.role || '—'}
                              {a.email && a.full_name ? ` · ${a.email}` : ''}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <AccessChip access={a.access} />
                            {a.access === 'implicit' ? (
                              // No toggle, on purpose — see the file header.
                              <span className="text-[11px] text-un1t-muted">
                                Owners and masters read every account here
                              </span>
                            ) : (
                              <Button
                                type="button"
                                size="sm"
                                variant={a.access === 'granted' ? 'ghost' : 'secondary'}
                                icon={a.access === 'granted' ? undefined : Check}
                                loading={busy === `${m.id}:${a.profile_id}`}
                                onClick={() => setAccess(m.id, a.profile_id, a.access !== 'granted')}
                              >
                                {a.access === 'granted' ? 'Revoke' : 'Grant'}
                              </Button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </Card>

      <Card title="Add an account">
        <form onSubmit={handleAdd} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="mailbox-address" className="mb-1 block text-sm text-un1t-text">Address</label>
              <input
                id="mailbox-address"
                type="email"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="sales@un1tdublin.com"
                className="w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:border-un1t-muted focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="mailbox-label" className="mb-1 block text-sm text-un1t-text">Label</label>
              <input
                id="mailbox-label"
                type="text"
                value={label}
                maxLength={MAILBOX_LABEL_MAX}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Sales"
                className="w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:border-un1t-muted focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-un1t-muted">
                Names the tab staff click. Up to {MAILBOX_LABEL_MAX} characters.
              </p>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-un1t-subtle">
            <input
              type="checkbox"
              checked={makeDefault}
              onChange={(e) => setMakeDefault(e.target.checked)}
              className="rounded border-un1t-border"
            />
            Make this the studio&apos;s default account
            {mailboxes.some(m => m.is_default) && (
              <span className="text-[11px] text-un1t-muted">
                (the current default moves off automatically)
              </span>
            )}
          </label>

          {draftTouched && draftIssues.length > 0 && (
            <p className="text-[11px] text-red-700">{draftIssues[0]}</p>
          )}
          {addError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span>{addError}</span>
            </div>
          )}

          <Button type="submit" icon={Plus} loading={adding} disabled={draftIssues.length > 0}>
            Add account
          </Button>
        </form>
      </Card>
    </div>
  )
}
