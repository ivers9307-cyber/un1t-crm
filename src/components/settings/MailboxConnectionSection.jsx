'use client'

// MAILBOX-CONNECT.6 — connecting ONE email account to its own mailbox login.
//
// WHERE THIS LIVES AND WHY IT IS ITS OWN FILE
// It renders inside each account's row in EmailMailboxesCard, under "Who can
// read this". EmailMailboxesCard was already 614 lines before this arrived and
// the connect flow is a form, a live check, three states and two disclosures —
// putting it inline would have doubled a file that is already the longest on
// the settings surface. The card renders <MailboxConnectionSection/> and knows
// nothing about IMAP.
//
// WHAT AN OPERATOR IS ACTUALLY DOING HERE
// Until now a studio could only receive mail on a domain whose MX we control.
// `un1t.com` is the franchisor's, so `stillorgan@un1t.com` sits in the account
// list looking live while every reply to it lands in a Google mailbox the
// platform cannot see. Supplying the mailbox's own login is what makes the
// account's claim true. See docs/superpowers/specs/2026-08-26-imap-mailbox-
// connector-design.md.
//
// TWO DISCLOSURES ARE SHOWN BEFORE THE CONNECT BUTTON, AND BOTH ARE REQUIRED:
//   1. Mail pulled in here is PERMANENT. GDPR contact erasure deliberately
//      skips the email tables, so deleting a contact does not delete their
//      correspondence. That is a knowing trade (spec §6) and the operator is
//      the one who has to live with it — they get told before they opt in, not
//      after a subject-access request.
//   2. Replies sent from their OWN mail client will not appear in the CRM yet.
//      This release polls INBOX only; a reply someone sends from Gmail goes to
//      Sent, never to INBOX, so the ticket sits "needs reply" and a colleague
//      answers the member a second time (spec §5 — the one divergence that is
//      customer-facing rather than cosmetic). Polling Sent is Phase 8. An
//      operator who is told this arranges their team around it; one who is not
//      discovers it through a confused member.
//
// THE PASSWORD FIELD IS WRITE-ONLY, IN BOTH DIRECTIONS. The server never sends
// a stored credential — not even a masked tail, which would leak the last four
// characters of a live app password to every owner-shaped session — so the
// field renders blank on an already-connected account and a blank save keeps
// what is stored.

import { useCallback, useEffect, useState } from 'react'
import {
  Link2, Link2Off, Loader2, AlertTriangle, CheckCircle2, ShieldAlert, PauseCircle, Clock,
} from 'lucide-react'
import { Button } from '@/components/ui'

const CHIP = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium'
const INPUT =
  'w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text ' +
  'placeholder:text-un1t-muted focus:border-un1t-muted focus:outline-none'

/**
 * Host/port/TLS/sent-folder defaults per provider.
 *
 * These exist because the single biggest support burden of any mailbox
 * connector is an operator guessing a hostname, and the second biggest is the
 * TLS pair: 465 is implicit TLS (secure true), 587 is STARTTLS (secure FALSE),
 * and pairing 587 with true fails as an opaque connect timeout rather than as
 * a TLS error. Presets set the pair together so that combination is never
 * typed by hand.
 *
 * Exported so the section's tests assert the values rather than the markup —
 * a wrong port here is a support ticket, not a rendering bug.
 */
export const PROVIDER_PRESETS = {
  gmail: {
    label: 'Gmail / Google Workspace',
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    imap_secure: true,
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    smtp_secure: true,
    sent_folder: '[Gmail]/Sent Mail',
    supported: true,
  },
  microsoft: {
    label: 'Microsoft 365 / Outlook',
    imap_host: 'outlook.office365.com',
    imap_port: 993,
    imap_secure: true,
    smtp_host: 'smtp.office365.com',
    smtp_port: 587,
    smtp_secure: false,
    sent_folder: 'Sent Items',
    // 🔴 KEPT IN THE LIST AND DISABLED, deliberately. Exchange Online stopped
    // accepting a mailbox password over IMAP, so this cannot be connected at
    // all until the OAuth work lands (mig 572's auth_type comment defers it).
    // Removing the option would leave an operator searching for Microsoft,
    // failing to find it, and concluding the connector is broken. Naming it
    // and saying why sends them to ask for the thing that would fix it.
    supported: false,
  },
  custom: {
    label: 'Other IMAP host',
    imap_host: '',
    imap_port: 993,
    imap_secure: true,
    smtp_host: '',
    smtp_port: 465,
    smtp_secure: true,
    sent_folder: '',
    supported: true,
  },
}

const MICROSOFT_NOTE =
  'Microsoft 365 and Outlook accounts cannot be connected yet. Exchange Online no longer accepts ' +
  'a mailbox password over IMAP, so these need a Microsoft sign-in (OAuth) that this release does ' +
  'not include. Gmail, Google Workspace and any host that still issues app passwords work today.'

/**
 * Turn the route's state into the one chip an operator reads at a glance.
 *
 * PURE, and exported, so the states are tested directly. "Connected" and
 * "failing" being indistinguishable is the failure this whole panel exists to
 * prevent — a connector that cannot say whether it is working is precisely the
 * standing audit finding this feature was built to retire.
 *
 * `folders: null` means the health read itself failed. That is NOT reported as
 * a fault with the mailbox: the connection may be perfectly fine and blaming
 * it would send an operator hunting for a new app password.
 *
 * @param {{ingress?: string, connection?: object|null, folders?: Array|null, now?: number}} state
 */
export function connectionStatus({ ingress, connection, folders, now = Date.now() } = {}) {
  if (!connection || ingress !== 'imap') {
    return {
      tone: 'idle',
      label: 'Not connected',
      chip: 'bg-slate-500/10 text-slate-700',
      detail: 'Mail reaches this account through the standard route. Connect its mailbox login to pull mail in directly.',
    }
  }

  const inbox = (folders || []).find(f => f.folder === 'inbox') || null

  if (folders === null) {
    return {
      tone: 'ok',
      label: 'Connected',
      chip: 'bg-green-500/10 text-green-700',
      detail: 'Recent check history could not be read just now. The connection itself is unaffected.',
    }
  }

  const pausedUntil = inbox?.paused_until ? Date.parse(inbox.paused_until) : NaN
  if (Number.isFinite(pausedUntil) && pausedUntil > now) {
    // A pause must be LOUD. Pausing quietly is how a mailbox stops receiving
    // for a week and nobody finds out.
    return {
      tone: 'paused',
      label: 'Paused',
      chip: 'bg-orange-500/10 text-orange-700',
      detail: `Checking has been paused after repeated failures. ${inbox.last_error || ''}`.trim(),
    }
  }

  if (inbox?.last_error) {
    return {
      tone: 'failing',
      label: 'Connection failing',
      chip: 'bg-red-500/10 text-red-700',
      detail: inbox.last_error,
    }
  }

  if (!inbox || !inbox.last_ok_at) {
    return {
      tone: 'pending',
      label: 'Waiting for the first check',
      chip: 'bg-amber-500/10 text-amber-700',
      detail: 'The login worked. Mail that arrives from now on will appear here within a few minutes.',
    }
  }

  return {
    tone: 'ok',
    label: 'Connected',
    chip: 'bg-green-500/10 text-green-700',
    detail: null,
  }
}

/** Dublin-friendly short stamp; an unparseable value renders as nothing. */
function when(value) {
  if (!value) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * The Gmail app-password walkthrough, inline.
 *
 * Written out rather than linked because this is the step every operator gets
 * stuck on: an app password is NOT the Google account password, it is only
 * offered once 2-Step Verification is on, and the 16 characters are shown
 * once. A link alone produces a support ticket per connection.
 */
function GmailHelp() {
  return (
    <div className="rounded-lg border border-un1t-border bg-un1t-bg/60 p-3 text-[11px] text-un1t-muted">
      <p className="font-medium text-un1t-subtle">Getting a Gmail app password</p>
      <ol className="mt-1 list-decimal space-y-1 pl-4">
        <li>Sign in to the Google account for this address (not your own, unless they are the same).</li>
        <li>
          Turn on 2-Step Verification at{' '}
          <span className="font-mono">myaccount.google.com/security</span> — Google only offers app
          passwords once it is on.
        </li>
        <li>
          Go to <span className="font-mono">myaccount.google.com/apppasswords</span>, name it
          something like &ldquo;CRM&rdquo;, and create it.
        </li>
        <li>
          Copy the 16 characters it shows and paste them below. Google shows them <strong>once</strong>;
          spaces do not matter.
        </li>
      </ol>
      <p className="mt-2">
        Use the app password, never the account password — the account password will be rejected.
        On a Workspace account an administrator may have to allow app passwords first.
      </p>
    </div>
  )
}

/**
 * The two things an operator must know before mail starts being pulled in.
 * Rendered above the connect button, not behind a link.
 */
function Disclosures() {
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-700">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        <span>
          <strong>Mail pulled in here is kept permanently.</strong> Deleting a contact under a
          data-erasure request removes their contact record, but it does <strong>not</strong> remove
          email that arrived at this account — correspondence is kept as a business record. Connect
          an account only if you are comfortable with that.
        </span>
      </div>
      <div className="flex items-start gap-2 rounded-lg border border-un1t-border bg-un1t-bg/60 p-3 text-[11px] text-un1t-muted">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        <span>
          <strong>Replies you send from Gmail or Outlook will not show up here yet.</strong> Only mail
          arriving in the inbox is read. If someone answers a member from their own mail app, the
          ticket will still look unanswered and a colleague may answer a second time — so reply from
          the CRM while this is the case.
        </span>
      </div>
    </div>
  )
}

/**
 * @param {{ locationId: string, mailbox: object, onChanged?: Function }} props
 *   `mailbox` is a row from the mailbox-admin list — it carries `ingress`,
 *   which is why MAILBOX_COLUMNS was widened: the chip renders from the list
 *   the card already holds, so opening the Email settings page does not fire
 *   one request per account.
 */
export default function MailboxConnectionSection({ locationId, mailbox, onChanged }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [state, setState] = useState(null)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)

  const [form, setForm] = useState(() => ({
    provider: 'gmail',
    username: mailbox.address || '',
    password: '',
    ...PROVIDER_PRESETS.gmail,
  }))

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/email/mailboxes/${mailbox.id}/connection`)
      const j = await res.json()
      if (!res.ok || !j.success) {
        // Said out loud rather than rendered as "Not connected": a failed read
        // on a live connection would invite an owner to re-paste a credential
        // that is working perfectly.
        setError(j.error || `HTTP ${res.status}`)
        setState(null)
        return null
      } else {
        setState(j.data)
        if (j.data.connection) {
          setForm(f => ({
            ...f,
            provider: j.data.connection.provider || 'custom',
            username: j.data.connection.username || '',
            password: '',
            imap_host: j.data.connection.imap_host || '',
            imap_port: j.data.connection.imap_port ?? 993,
            imap_secure: j.data.connection.imap_secure !== false,
            smtp_host: j.data.connection.smtp_host || '',
            smtp_port: j.data.connection.smtp_port ?? 465,
            smtp_secure: j.data.connection.smtp_secure !== false,
            sent_folder: j.data.connection.sent_folder || '',
          }))
        }
        // Handed back as well as set: `setState` does not land before the
        // caller's next line, and save() has to JUDGE what the reload said
        // before it decides what to claim. Reading `state` there would read
        // the pre-save render.
        return j.data
      }
    } catch (e) {
      setError(e.message || 'Network error')
      setState(null)
    } finally {
      setLoading(false)
    }
    return null
  }, [locationId, mailbox.id])

  // Lazily — a studio with six accounts must not fire six health requests just
  // because someone opened the Email settings page.
  useEffect(() => { if (open) load() }, [open, load])

  const applyPreset = (provider) => {
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom
    setForm(f => ({
      ...f,
      provider,
      // 'custom' carries empty defaults, so switching to it keeps whatever the
      // operator has already typed rather than wiping the row they were part
      // way through.
      imap_host: preset.imap_host || f.imap_host,
      imap_port: preset.imap_port,
      imap_secure: preset.imap_secure,
      smtp_host: preset.smtp_host || f.smtp_host,
      smtp_port: preset.smtp_port,
      smtp_secure: preset.smtp_secure,
      sent_folder: preset.sent_folder || f.sent_folder,
    }))
  }

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setNote(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/email/mailboxes/${mailbox.id}/connection`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: form.provider,
          username: form.username,
          password: form.password,
          imap_host: form.imap_host,
          imap_port: Number(form.imap_port) || 993,
          imap_secure: !!form.imap_secure,
          smtp_host: form.smtp_host || null,
          smtp_port: form.smtp_port ? Number(form.smtp_port) : null,
          smtp_secure: !!form.smtp_secure,
          sent_folder: form.sent_folder || null,
        }),
      })
      const j = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }))
      if (!j.success) { setError(j.error || 'Could not connect that account.'); return }
      // Never keep the typed password in component state after a save — there
      // is no reason for it to survive the request that consumed it.
      setForm(f => ({ ...f, password: '' }))
      setEditing(false)

      // 🔴 THE NOTE IS WRITTEN AFTER THE RELOAD, AND ONLY IF THE RELOAD AGREES
      // WITH IT. MAILBOX-CONNECT.8: this panel used to print "Connected. The
      // login was checked against the mail server before it was saved."
      // unconditionally, next to a chip reading "Paused" and the stale error
      // from the password that had just been replaced — two confident,
      // contradictory statements about the same mailbox, one of them wrong.
      // The route now clears that state on a verified save, so the ordinary
      // case simply resolves; this is the half that does not depend on the
      // server getting it right. When the panel's own re-read still says
      // paused or failing, the chip below wins and the note stops asserting
      // that everything is fine.
      const fresh = await load()
      const after = fresh
        ? connectionStatus({ ingress: fresh.ingress, connection: fresh.connection, folders: fresh.folders })
        : null
      setNote(after && (after.tone === 'paused' || after.tone === 'failing')
        ? 'Saved — the login was checked against the mail server before it was stored. This account is ' +
          'still reporting the problem shown below; if that has not cleared by the next check, disconnect ' +
          'it and connect it again.'
        : 'Connected. The login was checked against the mail server before it was saved.')
      if (onChanged) await onChanged()
    } catch (err) {
      setError(err.message || 'Network error')
    } finally {
      setSaving(false)
    }
  }

  async function disconnect() {
    // `confirm` matches the rest of the settings surface (the storage prune on
    // the same card uses it); a bespoke modal here would be the only one.
    if (!window.confirm(
      `Stop pulling mail into ${mailbox.label} <${mailbox.address}>?\n\n` +
      'The stored password is deleted. Tickets that already arrived are kept, and mail sent to this ' +
      'address goes back to the standard route.'
    )) return

    setSaving(true)
    setError(null)
    setNote(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/email/mailboxes/${mailbox.id}/connection`, {
        method: 'DELETE',
      })
      const j = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }))
      if (!j.success) { setError(j.error || 'Could not disconnect that account.'); return }
      setNote('Disconnected. The stored password has been deleted.')
      await load()
      if (onChanged) await onChanged()
    } catch (err) {
      setError(err.message || 'Network error')
    } finally {
      setSaving(false)
    }
  }

  // The collapsed chip reads off the mailbox row the card already holds, so it
  // is correct before anything is fetched.
  const status = connectionStatus(
    state
      ? { ingress: state.ingress, connection: state.connection, folders: state.folders }
      : { ingress: mailbox.ingress, connection: mailbox.ingress === 'imap' ? {} : null, folders: [] }
  )
  const connected = !!state?.connection
  const inbox = (state?.folders || []).find(f => f.folder === 'inbox') || null
  const showForm = !connected || editing
  const preset = PROVIDER_PRESETS[form.provider] || PROVIDER_PRESETS.custom

  return (
    <div className="mt-3 border-t border-un1t-border pt-3">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-2 text-xs font-medium text-un1t-subtle hover:text-un1t-text"
      >
        <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
        {open ? 'Hide' : 'Mailbox connection'}
        <span className={`${CHIP} ${status.chip}`}>{status.label}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {loading && (
            <div className="flex items-center gap-2 text-xs text-un1t-subtle">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Reading the connection…
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
          {note && (
            <p className="rounded-lg border border-un1t-border bg-un1t-bg/60 p-3 text-xs text-un1t-subtle">{note}</p>
          )}

          {status.detail && !loading && (
            <p className="text-[11px] text-un1t-muted">{status.detail}</p>
          )}

          {connected && !loading && (
            <div className="rounded-lg border border-un1t-border bg-un1t-bg/40 p-3">
              <dl className="grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
                <div>
                  <dt className="text-un1t-muted">Signs in as</dt>
                  <dd className="font-mono text-un1t-text break-all">{state.connection.username}</dd>
                </div>
                <div>
                  <dt className="text-un1t-muted">Reading from</dt>
                  <dd className="font-mono text-un1t-text break-all">
                    {state.connection.imap_host}:{state.connection.imap_port}
                  </dd>
                </div>
                {inbox?.last_ok_at && (
                  <div>
                    <dt className="text-un1t-muted">Last successful check</dt>
                    <dd className="text-un1t-text">
                      <Clock className="mr-1 inline h-3 w-3" aria-hidden="true" />
                      {when(inbox.last_ok_at)}
                    </dd>
                  </div>
                )}
                {inbox?.paused_until && (
                  <div>
                    <dt className="text-un1t-muted">Paused until</dt>
                    <dd className="text-un1t-text">
                      <PauseCircle className="mr-1 inline h-3 w-3" aria-hidden="true" />
                      {when(inbox.paused_until)}
                    </dd>
                  </div>
                )}
              </dl>

              {/* The password is never shown, not even as a masked tail —
                  there is nothing here to reveal. */}
              <p className="mt-2 text-[11px] text-un1t-muted">
                The password is stored encrypted and is never shown again. Replacing it means typing
                a new one.
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {!editing && (
                  <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(true)}>
                    Change settings or password
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  icon={Link2Off}
                  loading={saving}
                  onClick={disconnect}
                >
                  Disconnect
                </Button>
              </div>
            </div>
          )}

          {showForm && !loading && (
            <form onSubmit={save} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor={`provider-${mailbox.id}`} className="mb-1 block text-sm text-un1t-text">
                    Mail provider
                  </label>
                  <select
                    id={`provider-${mailbox.id}`}
                    value={form.provider}
                    onChange={(e) => applyPreset(e.target.value)}
                    className={INPUT}
                  >
                    {Object.entries(PROVIDER_PRESETS).map(([key, p]) => (
                      <option key={key} value={key} disabled={!p.supported}>
                        {p.label}{p.supported ? '' : ' — not supported yet'}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor={`username-${mailbox.id}`} className="mb-1 block text-sm text-un1t-text">
                    Sign in as
                  </label>
                  <input
                    id={`username-${mailbox.id}`}
                    type="text"
                    value={form.username}
                    onChange={(e) => setForm(f => ({ ...f, username: e.target.value }))}
                    placeholder={mailbox.address}
                    className={INPUT}
                  />
                  <p className="mt-1 text-[11px] text-un1t-muted">
                    Usually the address itself. Some hosts use a separate account name.
                  </p>
                </div>
              </div>

              {form.provider === 'microsoft' && (
                <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[11px] text-red-700">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                  <span>{MICROSOFT_NOTE}</span>
                </div>
              )}

              {form.provider === 'gmail' && <GmailHelp />}

              <div>
                <label htmlFor={`password-${mailbox.id}`} className="mb-1 block text-sm text-un1t-text">
                  {form.provider === 'gmail' ? 'App password' : 'Password'}
                </label>
                <input
                  id={`password-${mailbox.id}`}
                  type="password"
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(e) => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder={connected ? 'Leave blank to keep the current password' : ''}
                  className={INPUT}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="sm:col-span-2">
                  <label htmlFor={`imap-host-${mailbox.id}`} className="mb-1 block text-sm text-un1t-text">
                    Incoming (IMAP) server
                  </label>
                  <input
                    id={`imap-host-${mailbox.id}`}
                    type="text"
                    value={form.imap_host}
                    onChange={(e) => setForm(f => ({ ...f, imap_host: e.target.value }))}
                    placeholder="imap.example.com"
                    className={INPUT}
                  />
                </div>
                <div>
                  <label htmlFor={`imap-port-${mailbox.id}`} className="mb-1 block text-sm text-un1t-text">
                    Port
                  </label>
                  <input
                    id={`imap-port-${mailbox.id}`}
                    type="number"
                    value={form.imap_port}
                    onChange={(e) => setForm(f => ({ ...f, imap_port: e.target.value }))}
                    className={INPUT}
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="sm:col-span-2">
                  <label htmlFor={`smtp-host-${mailbox.id}`} className="mb-1 block text-sm text-un1t-text">
                    Outgoing (SMTP) server — optional
                  </label>
                  <input
                    id={`smtp-host-${mailbox.id}`}
                    type="text"
                    value={form.smtp_host}
                    onChange={(e) => setForm(f => ({ ...f, smtp_host: e.target.value }))}
                    placeholder="smtp.example.com"
                    className={INPUT}
                  />
                  <p className="mt-1 text-[11px] text-un1t-muted">
                    Checked now if you enter one. Replies still leave through the standard mail
                    route until sending from this account is switched on — leave it blank to
                    connect for receiving only.
                  </p>
                </div>
                <div>
                  <label htmlFor={`smtp-port-${mailbox.id}`} className="mb-1 block text-sm text-un1t-text">
                    Port
                  </label>
                  <input
                    id={`smtp-port-${mailbox.id}`}
                    type="number"
                    value={form.smtp_port}
                    onChange={(e) => setForm(f => ({ ...f, smtp_port: e.target.value }))}
                    className={INPUT}
                  />
                </div>
              </div>

              {!connected && <Disclosures />}

              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm" icon={CheckCircle2} loading={saving} disabled={!preset.supported}>
                  {connected ? 'Check and save' : 'Check and connect'}
                </Button>
                {connected && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); setError(null) }}>
                    Cancel
                  </Button>
                )}
                <span className="text-[11px] text-un1t-muted">
                  The login is tried against the mail server before anything is stored.
                </span>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  )
}
