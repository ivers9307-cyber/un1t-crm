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
//
// (RETIRE-TICKETS.1 — the per-account "Move to Mail / Move to Email inbox"
// control lived here during the mig-575 surface A/B. The trial ended
// 2026-08-29: Mail is the only email surface, so there is nowhere to move an
// account to and the row, its chip and its confirm are gone.)

import { useCallback, useEffect, useState } from 'react'
import {
  Mail, Loader2, Plus, Star, EyeOff, Eye, Check, AlertTriangle, Users,
  HardDrive, Trash2, RefreshCw,
} from 'lucide-react'
import { Button, Card } from '@/components/ui'
// MAILBOX-CONNECT.6 — the per-account IMAP connection panel. Its own file
// because this card was already 614 lines and the connect flow is a form, a
// live login check, three states and two required disclosures.
import MailboxConnectionSection from './MailboxConnectionSection'
import { MAILBOX_LABEL_MAX, mailboxInputIssues } from '@/lib/email-mailbox-admin'
import { EMAIL_MAILBOX_QUOTA_BYTES, formatBytes, quotaMessage } from '@/lib/email-attachment-quota'

const CHIP = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium'

const ROLE_LABEL = {
  owner: 'Owner',
  manager: 'Manager',
  head_coach: 'Head coach',
  staff: 'Staff',
}

/**
 * MAILBOX-UNREACHABLE.1 — the banner that says an address cannot receive.
 *
 * The whole notice (headline, detail, remedy, chip word) is built SERVER-side
 * in src/lib/mail/mailbox-reachability.js and arrives on the mailbox row: that
 * module imports node:dns, so a client component cannot import it, and having
 * one author for the sentences is what stops this card and the integration
 * health pane describing the same mailbox two different ways.
 *
 * It renders nothing at all when there is nothing true to say — an address on
 * a domain that does deliver here, a connected account, or a DNS lookup that
 * could not be completed. A quiet mailbox is NEVER a reason for this to
 * appear; the verdict behind it never looks at volume (see that module's
 * header for why).
 */
function ReachabilityNotice({ notice }) {
  if (!notice) return null
  const error = notice.tone === 'error'
  const box = error
    ? 'border-red-500/30 bg-red-500/10 text-red-700'
    : 'border-amber-500/30 bg-amber-500/10 text-amber-700'
  return (
    <div className={`mt-3 flex items-start gap-2 rounded-lg border p-3 text-[11px] ${box}`}>
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <span>
        <strong className="block text-xs">{notice.headline}</strong>
        <span className="mt-1 block">{notice.detail}</span>
        {notice.remedy && <span className="mt-1 block">{notice.remedy}</span>}
      </span>
    </div>
  )
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

// EMAIL-ATTACH.1 — the fill bar's colours per level. Chips follow the repo's
// light-theme recipe (bg-<c>-500/10 + text-<c>-700); the bar itself is a solid
// fill, so it takes the -500 ramp.
const LEVEL_STYLE = {
  ok: { bar: 'bg-un1t-accent', chip: 'bg-slate-500/10 text-slate-700', word: null },
  warning: { bar: 'bg-amber-500', chip: 'bg-amber-500/10 text-amber-700', word: '80% full' },
  critical: { bar: 'bg-orange-500', chip: 'bg-orange-500/10 text-orange-700', word: '95% full' },
  full: { bar: 'bg-red-500', chip: 'bg-red-500/10 text-red-700', word: 'Full' },
}

/**
 * One account's storage, with the release valve attached.
 *
 * The valve is ALWAYS offered once there is anything to reclaim, not only at
 * 100%. An operator who can see the bar filling should be able to act on it
 * before the mailbox stops keeping files, and a control that appears only in
 * the failure state is a control nobody has ever used before they need it.
 */
function StorageRow({ row, onPrune, busy }) {
  const style = LEVEL_STYLE[row.level] || LEVEL_STYLE.ok
  const message = quotaMessage(row)
  const name = row.mailbox_id
    ? (row.label || row.address)
    : 'Unfiled (accounts that were removed)'

  return (
    <li className="rounded-lg border border-un1t-border bg-un1t-bg/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-un1t-text">{name}</span>
        <span className="text-xs text-un1t-subtle">
          {formatBytes(row.bytes_used)} of {formatBytes(row.quota_bytes)}
          {style.word && (
            <span className={`${CHIP} ml-2 ${style.chip}`}>{style.word}</span>
          )}
        </span>
      </div>

      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-un1t-border"
        role="progressbar"
        aria-valuenow={row.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${name} storage used`}
      >
        <div className={`h-full ${style.bar}`} style={{ width: `${row.percent}%` }} />
      </div>

      {message && <p className="mt-2 text-[11px] text-un1t-muted">{message}</p>}

      {row.bytes_used > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={row.level === 'full' ? 'danger' : 'ghost'}
            icon={Trash2}
            loading={busy}
            onClick={() => onPrune(row)}
          >
            Free up space
          </Button>
          <span className="text-[11px] text-un1t-muted">
            Deletes attachments on solved and closed tickets older than a year. The message and
            the file&apos;s name stay on the ticket, so you can still ask for a resend.
          </span>
        </div>
      )}
    </li>
  )
}

export default function EmailMailboxesCard({ locationId }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [mailboxes, setMailboxes] = useState([])
  const [busy, setBusy] = useState(null)
  const [openAccess, setOpenAccess] = useState(null)

  // Storage (EMAIL-ATTACH.1). Loaded alongside the accounts but kept in its
  // own state so a storage fault never blanks the account list — managing
  // addresses has to keep working when the quota view does not.
  const [storage, setStorage] = useState(null)
  const [storageError, setStorageError] = useState(null)
  const [storageNote, setStorageNote] = useState(null)

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

  const loadStorage = useCallback(async () => {
    setStorageError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/email/storage`)
      const j = await res.json()
      if (!res.ok || !j.success) {
        // Said out loud rather than rendered as an empty bar: "0 of 5 GB" on a
        // failed read is the reassuring wrong answer on the one screen an
        // operator opens to find out whether there is room.
        setStorageError(j.error || `HTTP ${res.status}`)
        setStorage(null)
      } else {
        setStorage(j.data)
      }
    } catch (e) {
      setStorageError(e.message || 'Network error')
      setStorage(null)
    }
  }, [locationId])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadStorage() }, [loadStorage])

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

  // Attachments are a member's correspondence and the bytes do not come back,
  // so this confirms before it acts. `confirm` matches the rest of the settings
  // surface; a bespoke modal here would be the only one of its kind.
  async function prune(row) {
    const name = row.mailbox_id ? (row.label || row.address) : 'the unfiled attachments'
    if (!window.confirm(
      `Permanently delete attachments on solved and closed tickets older than a year for ${name}?\n\n` +
      'The messages and the file names stay on the tickets. The files themselves cannot be recovered.'
    )) return

    setBusy(`storage:${row.mailbox_id || 'unfiled'}`)
    setStorageError(null)
    setStorageNote(null)
    const j = await send(`/api/locations/${locationId}/email/storage`, 'POST', {
      action: 'prune',
      mailbox_id: row.mailbox_id,
      older_than_days: 365,
    })
    setBusy(null)
    if (!j.success) { setStorageError(j.error || 'Could not free up space.'); return }

    const freed = formatBytes(j.data.bytes_freed)
    setStorageNote(
      j.data.pruned === 0
        ? 'Nothing to remove — every attachment here is either recent or on a ticket that is still open.'
        : `Removed ${j.data.pruned} attachment${j.data.pruned === 1 ? '' : 's'}, freeing ${freed}.` +
          (j.data.remaining > 0 ? ' There is more to clear — run it again.' : '')
    )
    await loadStorage()
  }

  async function recalculate() {
    setBusy('storage:recalc')
    setStorageError(null)
    setStorageNote(null)
    const j = await send(`/api/locations/${locationId}/email/storage`, 'POST', { action: 'recalculate' })
    setBusy(null)
    if (!j.success) { setStorageError(j.error || 'Could not recalculate.'); return }
    setStorageNote('Recalculated from the stored files.')
    await loadStorage()
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
          its own account filter in{' '}
          <a href="/communications/mail" className="underline text-un1t-subtle">Mail</a>, and
          replies go back out from the same address. The <strong>default</strong> account is the
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
            Mail for this location.
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
                        {/* Next to Default on purpose. "Default" and "Cannot
                            receive" on the same line is the sentence an owner
                            needs to read in one glance — it is the pairing,
                            not either chip, that is the problem. */}
                        {m.reachability?.notice?.chip && (
                          <span className={`${CHIP} bg-red-500/10 text-red-700`}>
                            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                            {m.reachability.notice.chip}
                          </span>
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

                <ReachabilityNotice notice={m.reachability?.notice} />

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

                {/* MAILBOX-CONNECT.6 — how mail REACHES this account. Rendered
                    for deactivated accounts too: an operator must always be
                    able to disconnect a stored login, and hiding the panel
                    would strand the credential. `onChanged` reloads the list so
                    the state chip, which reads off mailbox.ingress, is right
                    immediately after a connect or a disconnect. */}
                <MailboxConnectionSection
                  locationId={locationId}
                  mailbox={m}
                  reachability={m.reachability}
                  onChanged={load}
                />
              </li>
            )
          })}
        </ul>
      </Card>

      {/* EMAIL-ATTACH.1 — storage, on the same screen as the accounts because
          "how full is accounts@" is a question about an account, and a separate
          page is a page nobody opens until the mailbox has already stopped
          keeping files. */}
      <Card title="Attachment storage">
        <p className="text-xs text-un1t-muted">
          Files members send are kept in a private store, {formatBytes(storage?.quota_bytes || EMAIL_MAILBOX_QUOTA_BYTES)} per
          account. <strong>Email is never rejected</strong> — if an account fills up the message still
          arrives in full, and the attachment is listed on the ticket as &ldquo;not stored&rdquo; so you
          can ask for a resend.
        </p>

        {storageError && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <span>Could not read storage usage: {storageError}</span>
          </div>
        )}
        {storageNote && (
          <p className="mt-3 rounded-lg border border-un1t-border bg-un1t-bg/60 p-3 text-sm text-un1t-subtle">
            {storageNote}
          </p>
        )}

        {storage && (
          <>
            <ul className="mt-4 space-y-3">
              {storage.mailboxes.length === 0 && (
                <li className="text-sm text-un1t-subtle">No accounts yet, so nothing is stored.</li>
              )}
              {storage.mailboxes.map(row => (
                <StorageRow
                  key={row.mailbox_id}
                  row={row}
                  onPrune={prune}
                  busy={busy === `storage:${row.mailbox_id}`}
                />
              ))}
              {storage.unfiled && (
                <StorageRow
                  row={storage.unfiled}
                  onPrune={prune}
                  busy={busy === 'storage:unfiled'}
                />
              )}
            </ul>

            {storage.unfiled && (
              <p className="mt-2 text-[11px] text-un1t-muted">
                &ldquo;Unfiled&rdquo; holds files from accounts that no longer exist. Their tickets are
                kept, so the files are still charged to this studio until you clear them.
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-un1t-border pt-3">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                icon={RefreshCw}
                loading={busy === 'storage:recalc'}
                onClick={recalculate}
              >
                Recalculate
              </Button>
              <span className="inline-flex items-center gap-1 text-[11px] text-un1t-muted">
                <HardDrive className="h-3 w-3" aria-hidden="true" />
                Re-counts these figures from the files themselves. Worth doing if a number looks wrong.
              </span>
            </div>
          </>
        )}
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
