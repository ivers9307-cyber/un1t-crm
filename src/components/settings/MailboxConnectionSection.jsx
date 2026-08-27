'use client'

// MAILBOX-CONNECT.6 — connecting ONE email account to its own mailbox login.
//
// WHERE THIS LIVES AND WHY IT IS ITS OWN FILE
// It renders inside each account's row in EmailMailboxesCard, under "Who can
// read this". EmailMailboxesCard was already 614 lines before this arrived and
// the connect flow is a form, a live check, three states and a disclosure —
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
// ONE DISCLOSURE IS SHOWN BEFORE THE CONNECT BUTTON, AND IT IS REQUIRED:
//   Mail pulled in here is PERMANENT. GDPR contact erasure deliberately skips
//   the email tables, so deleting a contact does not delete their
//   correspondence. That is a knowing trade (spec §6) and the operator is the
//   one who has to live with it — they get told before they opt in, not after
//   a subject-access request.
//
// THERE WAS A SECOND ONE AND PHASE 8 RETRACTED IT (MAILBOX-COEXIST.1). It
// warned that replies sent from their own mail client would not appear in the
// CRM, because the receive-only release polled INBOX only and a reply typed in
// Gmail goes to Sent (spec §5 — the one divergence that was customer-facing
// rather than cosmetic). Phase 8 polls the Sent folder, so the warning became
// FALSE the moment it shipped, and a false warning on this screen is worse
// than none: it would have a team routing every reply through the CRM to avoid
// a problem that no longer exists, and give them no reason to trust the panel
// that is still true. Deleted, not softened — see PermanenceDisclosure.
//
// THE PASSWORD FIELD IS WRITE-ONLY, IN BOTH DIRECTIONS. The server never sends
// a stored credential — not even a masked tail, which would leak the last four
// characters of a live app password to every owner-shaped session — so the
// field renders blank on an already-connected account and a blank save keeps
// what is stored.

import { useCallback, useEffect, useState } from 'react'
import {
  Link2, Link2Off, Loader2, AlertTriangle, CheckCircle2, ShieldAlert, PauseCircle, Clock, LogIn,
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
    // How this provider authenticates on this screen. 'password' renders the
    // host/port form; 'oauth' replaces it with a single sign-in button and no
    // fields at all, because for an OAuth provider every one of those fields is
    // ours to know and none of them is the operator's to guess.
    auth: 'password',
    supported: true,
    // MAILBOX-OAUTH.6 — the key in the server's oauth_providers catalogue whose
    // refusal belongs on THIS row. Gmail connects with an app password today,
    // and 'Sign in with Google' is the thing that does not exist; the reason
    // comes from the server so there is exactly one copy of it.
    oauthKey: 'google',
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
    // 🔴 MAILBOX-OAUTH.6 — THIS ROW USED TO SAY `supported: false`, AND THE
    // REASON IT GAVE HAS STOPPED BEING TRUE. Exchange Online still refuses a
    // mailbox password over IMAP — that half stands, and is exactly why this
    // provider is OAuth-only rather than OAuth-as-an-option. What changed is
    // that the Microsoft sign-in now exists (…/oauth/start), so the disabled
    // option and its 'not supported yet' note would now be a false statement
    // rendered next to the button that contradicts it.
    //
    // A retracted limitation is REWRITTEN, not softened — the same call
    // MAILBOX-COEXIST.1 made when Phase 8 falsified its own warning about
    // replies sent from a mail client.
    auth: 'oauth',
    supported: true,
    oauthKey: 'microsoft',
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
    auth: 'password',
    supported: true,
    oauthKey: null,
  },
}

/**
 * The provider sign-in note for a preset, taken from the SERVER's catalogue.
 *
 * Returns null when there is nothing to say — the provider is available, or the
 * catalogue has not loaded, or this preset has no OAuth counterpart. Never
 * invents a sentence: an unavailable provider whose reason we do not have is
 * shown as nothing rather than as a guess, because the whole value of this
 * paragraph is that it names the real blocker (Google's app verification and
 * CASA assessment) rather than 'not supported'.
 *
 * Pure and exported so the states are tested directly rather than through the
 * markup.
 */
export function providerNote(preset, catalogue) {
  if (!preset?.oauthKey || !Array.isArray(catalogue)) return null
  const entry = catalogue.find(p => p && p.key === preset.oauthKey)
  if (!entry || entry.status === 'available') return null
  return entry.unavailableReason || null
}

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
 * 🔴 MAILBOX-UNREACHABLE.1 REWROTE THE 'NOT CONNECTED' BRANCH, because it was
 * the single sentence this feature's founding bug is made of. It read "Mail
 * reaches this account through the standard route" — an unconditional claim,
 * printed underneath `stillorgan@un1t.com`, where the standard route is
 * Postmark's inbound webhook and `un1t.com`'s MX points at Google and always
 * will. Not connected is the RIGHT label for that account; "and mail reaches
 * it anyway" was the lie. The verdict (src/lib/mail/mailbox-reachability.js)
 * is passed in rather than computed here — that module imports node:dns and a
 * client component cannot touch it.
 *
 * @param {{ingress?: string, connection?: object|null, folders?: Array|null, reachability?: object|null, now?: number}} state
 */
export function connectionStatus({ ingress, connection, folders, reachability, now = Date.now() } = {}) {
  if (!connection || ingress !== 'imap') {
    const state = reachability?.state
    return {
      tone: state === 'unreachable' ? 'unreachable' : 'idle',
      label: 'Not connected',
      chip: state === 'unreachable'
        ? 'bg-red-500/10 text-red-700'
        : 'bg-slate-500/10 text-slate-700',
      detail: state === 'unreachable'
        // Deliberately NOT the full banner text — that is already on the row
        // above, always visible; this panel collapses, and a truth folded
        // behind a toggle is not a truth anybody was told. This is the
        // one-line version plus the thing this panel is for.
        ? 'Mail sent to this address does not reach the platform at all — see the warning above. ' +
          'Connecting its mailbox login here is what fixes that.'
        : state === 'indirect'
          ? 'Mail reaches this account through a forward set up at the mail host, not through ' +
            'anything the platform controls. Connect its mailbox login to remove that dependency.'
          : 'Mail reaches this account through the standard route. Connect its mailbox login to pull mail in directly.',
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
 * The one thing an operator must know before mail starts being pulled in.
 * Rendered above the connect button, not behind a link.
 *
 * IT USED TO BE TWO, AND THE SECOND ONE WAS RETRACTED BY PHASE 8
 * (MAILBOX-COEXIST.1). It said replies sent from Gmail or Outlook would not
 * show up here, and told the operator to reply from the CRM while that was the
 * case. Phase 8 polls the Sent folder, so that is no longer true — a reply
 * typed in a mail client is filed on the ticket and clears "needs reply".
 *
 * A retired warning is DELETED, not softened. Left standing it is worse than
 * never having been shown: it tells a team to work around a limitation that no
 * longer exists, and the operator has no way to know which of the two panels
 * on this screen still holds. Softening it to "replies may take a few minutes
 * to appear" would have been a different claim about polling latency, invented
 * here rather than measured, on a screen whose whole job is to be believed.
 *
 * The permanence disclosure below is untouched and still true: GDPR contact
 * erasure deliberately skips the email tables (spec §6).
 */
function PermanenceDisclosure() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-700">
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <span>
        <strong>Mail pulled in here is kept permanently.</strong> Deleting a contact under a
        data-erasure request removes their contact record, but it does <strong>not</strong> remove
        email that arrived at this account — correspondence is kept as a business record. Connect
        an account only if you are comfortable with that.
      </span>
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
export default function MailboxConnectionSection({ locationId, mailbox, reachability, onChanged }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [state, setState] = useState(null)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)

  // MAILBOX-OAUTH.6 — what the server says about provider sign-ins. Held rather
  // than hard-coded so Google's refusal (app verification + a CASA assessment)
  // has exactly one author. Null until the panel is opened and the state loads,
  // which is why providerNote() answers null rather than guessing.
  const [providers, setProviders] = useState(null)

  // The outcome of a consent round trip, read once off the URL the callback
  // redirected to. A returning operator lands on a page with one collapsed row
  // per account, so this both OPENS the right panel and says what happened.
  const [oauthOutcome, setOauthOutcome] = useState(null)

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
        if (Array.isArray(j.data.oauth_providers)) setProviders(j.data.oauth_providers)
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

  // MAILBOX-OAUTH.6 — the return leg of a consent flow.
  //
  // Read from window.location rather than useSearchParams() deliberately: this
  // component renders inside a card inside a server page, and pulling in the
  // navigation hook would put every mailbox row in a Suspense boundary for a
  // value that is read once, on mount, in a browser. It runs in an effect so
  // there is no window access during render.
  //
  // The params are CLEARED from the URL afterwards. A "connected" banner that
  // survives a refresh — or a bookmark, or a shared link — is a claim about a
  // check that ran minutes ago, and the chip below is the live answer. Removing
  // them with replaceState also keeps a mailbox id out of anything the operator
  // pastes to a colleague.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('email_oauth_mailbox') !== mailbox.id) return
    const connected = params.get('email_oauth_connected')
    const failed = params.get('email_oauth_error')
    if (!connected && !failed) return

    setOauthOutcome(connected ? { ok: true, message: connected } : { ok: false, message: failed })
    // Opening the panel triggers the load() effect above, so the chip beside
    // this message is the freshly-read state and not a stale render.
    setOpen(true)

    params.delete('email_oauth_mailbox')
    params.delete('email_oauth_connected')
    params.delete('email_oauth_error')
    const query = params.toString()
    window.history.replaceState(
      null, '', `${window.location.pathname}${query ? `?${query}` : ''}`
    )
  }, [mailbox.id])

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
        ? connectionStatus({ ingress: fresh.ingress, connection: fresh.connection, folders: fresh.folders, reachability })
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
      ? { ingress: state.ingress, connection: state.connection, folders: state.folders, reachability }
      : { ingress: mailbox.ingress, connection: mailbox.ingress === 'imap' ? {} : null, folders: [], reachability }
  )
  const connected = !!state?.connection
  const inbox = (state?.folders || []).find(f => f.folder === 'inbox') || null
  const showForm = !connected || editing
  const preset = PROVIDER_PRESETS[form.provider] || PROVIDER_PRESETS.custom
  // MAILBOX-OAUTH.6 — this provider signs in rather than takes a password, so
  // the host/port/password fields are not merely optional here, they are
  // meaningless: every one of those values is ours to supply and none of them is
  // the operator's to guess. The form is REPLACED, not disabled.
  const isOAuthProvider = preset.auth === 'oauth'
  // Google's sentence when gmail is selected; null when there is nothing true
  // to say. Never a fallback string — see providerNote(). Named for what it IS
  // rather than `note`, which this component already uses for the transient
  // banner a save writes.
  const providerRefusal = providerNote(preset, providers)
  // Whether the STORED connection is a provider sign-in, which is a different
  // question from which provider is selected in the form above.
  const connectedViaOAuth = state?.connection?.auth_type === 'oauth'
  const oauthStartHref =
    `/api/locations/${locationId}/email/mailboxes/${mailbox.id}/oauth/start?provider=${encodeURIComponent(preset.oauthKey || '')}`

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

          {/* MAILBOX-OAUTH.6 — what came back from the provider. Rendered ABOVE
              the chip's own detail so the two read in the order they happened:
              what you just did, then where the account stands now. It never
              contradicts the chip, because it says what the callback observed
              and the chip says what the panel just re-read. */}
          {oauthOutcome && (
            <div
              className={oauthOutcome.ok
                ? 'flex items-start gap-2 rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-700'
                : 'flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700'}
            >
              {oauthOutcome.ok
                ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                : <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />}
              <span>{oauthOutcome.message}</span>
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

              {/* Neither credential is ever shown, not even as a masked tail —
                  there is nothing here to reveal. The two sentences differ
                  because the two REMEDIES differ: a password is retyped, a
                  provider sign-in is redone at the provider, and telling an
                  operator to "type a new password" for a Microsoft account
                  would send them looking for something that does not exist. */}
              <p className="mt-2 text-[11px] text-un1t-muted">
                {connectedViaOAuth
                  ? 'This account is connected with a provider sign-in. Nothing is stored that anyone ' +
                    'can read or reuse, and access renews itself. If the provider ever withdraws it, ' +
                    'sign in again here.'
                  : 'The password is stored encrypted and is never shown again. Replacing it means typing ' +
                    'a new one.'}
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {!editing && !connectedViaOAuth && (
                  <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(true)}>
                    Change settings or password
                  </Button>
                )}
                {connectedViaOAuth && (
                  // A plain link, not a fetch: the provider's consent screen is
                  // a full page navigation and there is nothing to POST. It
                  // re-runs the same flow, which is what "sign in again" means
                  // after a grant is withdrawn.
                  <a
                    href={`/api/locations/${locationId}/email/mailboxes/${mailbox.id}/oauth/start?provider=${encodeURIComponent(state.connection.provider || '')}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-un1t-border px-3 py-1.5 text-xs font-medium text-un1t-text hover:bg-un1t-bg"
                  >
                    <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                    Sign in again
                  </a>
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
                        {p.label}
                        {p.supported ? (p.auth === 'oauth' ? ' — sign in' : '') : ' — not supported yet'}
                      </option>
                    ))}
                  </select>
                </div>
                {/* An OAuth provider authenticates AS the address — Microsoft's
                    XOAUTH2 exchange takes it verbatim, and for a shared mailbox
                    it is deliberately the shared address rather than whoever
                    signed in. There is nothing here for an operator to choose,
                    so the field is not shown rather than shown and ignored. */}
                {!isOAuthProvider && (
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
                )}
              </div>

              {/* MAILBOX-OAUTH.6 — the provider's own sentence about why its
                  sign-in is unavailable, served by the API so there is one copy
                  of it. Today that is Google: app verification plus an annual
                  CASA Tier 2 assessment. Shown on the GMAIL row, where it is
                  useful — beside the app-password walkthrough that DOES work —
                  rather than as a separate dead option in the list. */}
              {providerRefusal && (
                <div className="flex items-start gap-2 rounded-lg border border-un1t-border bg-un1t-bg/60 p-3 text-[11px] text-un1t-muted">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-700" aria-hidden="true" />
                  <span>{providerRefusal}</span>
                </div>
              )}

              {form.provider === 'gmail' && <GmailHelp />}

              {isOAuthProvider ? (
                <div className="rounded-lg border border-un1t-border bg-un1t-bg/60 p-3">
                  <p className="text-[11px] text-un1t-muted">
                    Microsoft 365 and Outlook accounts sign in at Microsoft — there is no password to
                    type, and Exchange Online will not accept one over IMAP in any case. You will be
                    asked to sign in as <span className="font-mono">{mailbox.address}</span> and to
                    allow this CRM to read that mailbox and send as it. Server settings are filled in
                    for you and the sign-in is checked against the real mailbox before anything is saved.
                  </p>
                  {!connected && <div className="mt-3"><PermanenceDisclosure /></div>}
                  <a
                    href={oauthStartHref}
                    className="mt-3 inline-flex items-center gap-2 rounded-md bg-un1t-text px-3 py-2 text-sm font-medium text-un1t-bg hover:opacity-90"
                  >
                    <LogIn className="h-4 w-4" aria-hidden="true" />
                    Sign in with Microsoft
                  </a>
                  <p className="mt-2 text-[11px] text-un1t-muted">
                    If Microsoft refuses, an administrator on that tenant may need to allow this app
                    and switch IMAP on for the mailbox.
                  </p>
                </div>
              ) : (
                <>
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
                  {!connected && <PermanenceDisclosure />}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="submit" size="sm" icon={CheckCircle2} loading={saving}>
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
                </>
              )}
            </form>
          )}
        </div>
      )}
    </div>
  )
}
