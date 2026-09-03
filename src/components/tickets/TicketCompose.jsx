'use client'

// EMAIL-TICKET.5 — starting a conversation from the ticket inbox.
//
// Every ticket used to begin with an inbound email: staff could only ever
// answer what a member had already sent. This is the other half — chase an
// unanswered enquiry, follow up a billing query, email the member who phoned.
//
// WHAT IT IS, AND IS NOT
// It is a TICKET whose first message is outbound. There is no separate "sent
// mail" concept: POST /compose creates the ticket, the parent selects it, and
// from that moment it is an ordinary ticket in the ordinary queue.
//
// RECIPIENTS (EMAIL-CC.1). Several To addresses, plus Cc and Bcc behind the
// editor's own toggle. Unlike a reply, NOTHING here is derived: every address
// on a composed email is one a person typed, because nobody wrote to us first.
// That is why the route logs the whole set to audit_events rather than only
// the additions — a composed email is the one place ticket mail can reach an
// address the member never involved, so the act carries the sender's name.
//
// TWO THINGS THIS FILE IS CAREFUL ABOUT
//   • THE MAILBOX LIST IS THE PERMISSION MODEL. `mailboxes` is the caller's
//     visible set as the queue route resolved it, so the picker can only ever
//     offer an address they may send from. The route re-checks — this is the
//     affordance, not the gate — but the two must not disagree in front of an
//     operator.
//   • A FAILED SEND MUST NOT COST THEM THE DRAFT. Errors render inline and the
//     modal stays exactly as it was, with every field intact.
//
// Mounted only while open (see MailSurface), so state resets per open and the
// inbox's 60s poll re-creating `mailboxes` can never wipe a half-typed email.

import { useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { Modal, Button, Field } from '@/components/ui'
import { mailboxLabel } from '@/lib/ticket-display'
import RecipientEditor, { EMPTY_RECIPIENTS } from './RecipientEditor'
import AttachmentPicker, { readyDrafts, hasPendingUploads } from './AttachmentPicker'
import SignatureHint from './SignatureHint'

// The submit button lives in the Modal's footer, which is a SIBLING of the
// form, not a descendant — so it is wired to the form by id. Only one compose
// modal exists at a time, so a constant id is safe.
const FORM_ID = 'ticket-compose-form'

const INPUT_CLASSES =
  'w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-subtle/60 focus:outline-none focus:ring-1 focus:ring-un1t-text/30'

// MAIL-DOCK.2 — `shell` lets a caller replace the Modal WRAPPER without
// touching the fields or the send: a function of
//   { subject, dirty, sending, requestClose, body, footer }
// that returns what to render around them. The fields, validation, send logic
// and dirty-confirm are IDENTICAL on both paths — `body` is the same <form>,
// `footer` the same Cancel/Send pair, and `requestClose` the same
// confirm-guarded close. With no shell (every pre-existing call site, and
// every below-md compose), the Modal renders byte-for-byte as it always has.
export default function TicketCompose({ mailboxes = [], initialMailboxId = null, onClose, onSent, onSentUnfiled, shell }) {
  // The queue route already orders the tabs default-first, but say it out loud
  // rather than leaning on that ordering from another file.
  const [mailboxId, setMailboxId] = useState(() => (
    (initialMailboxId && mailboxes.some(m => m.id === initialMailboxId) ? initialMailboxId : null)
    || mailboxes.find(m => m.is_default)?.id
    || mailboxes[0]?.id
    || ''
  ))
  const [recipients, setRecipients] = useState(EMPTY_RECIPIENTS)
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [files, setFiles] = useState([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  const mailbox = mailboxes.find(m => m.id === mailboxId) || null

  // TICKET-COMPOSE-DISCARD.1 — Esc, the backdrop, the X and Cancel all come
  // through here. A DIRTY compose asks before it discards: this modal's own
  // rule is that a failed send must not cost the operator the draft, and a
  // stray Esc was costing them the same draft with no failure involved. A
  // pristine one closes silently — confirming the discard of nothing is
  // noise. There is deliberately no draft persistence behind this (a fresh
  // compose must never inherit the last one's text — see the header), so
  // "keep writing" and "discard" are the only two honest outcomes.
  const dirty = Boolean(
    subject.trim() || text.trim()
    || recipients.to.length || recipients.cc.length || recipients.bcc.length
    || files.length,
  )
  function requestClose() {
    if (dirty && !confirm('Discard this email? Nothing has been sent, and the draft is not kept.')) return
    onClose?.()
  }
  // At least one To. A Cc with no To is not an email anyone can reply to, and
  // the route refuses it — say so by leaving the button off.
  //
  // …and no file still on its way up: sending references to objects that are
  // not in the bucket yet is the one way the route's before-the-send refusal
  // could be reached by a healthy operator.
  const uploading = hasPendingUploads(files)
  const canSend =
    Boolean(mailboxId && recipients.to.length && subject.trim() && text.trim()) && !uploading

  async function handleSubmit(e) {
    e.preventDefault()
    if (!canSend || sending) return
    setSending(true)
    setError(null)
    try {
      // EMAIL-OUTBOUND-ATTACH.1 — references only. The bytes went straight to
      // Storage from the picker; a multipart body this size would be rejected
      // by the platform before the route ran.
      const attachments = readyDrafts(files)
      const res = await fetch('/api/email/tickets/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mailbox_id: mailboxId,
          to: recipients.to,
          cc: recipients.cc,
          bcc: recipients.bcc,
          subject: subject.trim(),
          text,
          ...(attachments.length ? { attachments } : {}),
        }),
      })
      const body = await res.json()
      if (!body?.success) {
        // Zod issues are the useful half of a 400 — "Invalid request body"
        // alone tells an operator nothing about which field is wrong.
        const detail = Array.isArray(body?.issues) && body.issues.length
          ? body.issues.map(i => i.message).join('; ')
          : null
        setError(detail || body?.error || 'Could not send that')
        // EMAIL-COMPOSE-UNFILED.1 — `data.sent` on a failure body means the
        // email IS with the recipient and only the filing failed. The modal
        // stays open with the copy above ("Do not resend") and the draft — the
        // only remaining record of what they received — while the parent
        // quietly refetches the queue: when the ticket row WAS created, it
        // should appear behind this modal rather than look like nothing
        // happened.
        if (body?.data?.sent) onSentUnfiled?.()
        return
      }
      // The parent owns closing and opening the new ticket — the modal does
      // not know what a queue is.
      onSent?.(body.data?.ticket || null, body.data?.ticket_id || null)
    } catch {
      setError('Could not send that — check your connection and try again')
    } finally {
      setSending(false)
    }
  }

  // Both paths share these verbatim — the footer is wired to the form by id,
  // so it works as a Modal sibling and inside a dock card's bottom alike.
  const footer = (
    <>
      <Button type="button" variant="secondary" onClick={requestClose} disabled={sending}>
        Cancel
      </Button>
      <Button type="submit" form={FORM_ID} variant="primary" loading={sending} disabled={!canSend}>
        {uploading ? 'Waiting for files…' : 'Send'}
      </Button>
    </>
  )

  const body = (
    <form id={FORM_ID} onSubmit={handleSubmit} className="space-y-3">
        {/* A picker only when there is a real choice. One mailbox needs no
            decision — but the operator still has to know which address the
            reply will come back to, so it is stated rather than hidden. */}
        {mailboxes.length > 1 ? (
          <Field id="ticket-compose-mailbox" label="From" hint="The reply comes back to this account, and the ticket is filed under it.">
            {(p) => (
              <select
                {...p}
                value={mailboxId}
                onChange={(e) => setMailboxId(e.target.value)}
                className={INPUT_CLASSES}
              >
                {mailboxes.map(m => (
                  <option key={m.id} value={m.id}>
                    {mailboxLabel(m)}{m.address ? ` · ${m.address}` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : (
          <p className="text-xs text-un1t-subtle">
            Sending from <span className="text-un1t-text">{mailbox?.address || mailboxLabel(mailbox)}</span>
          </p>
        )}

        <RecipientEditor
          idPrefix="ticket-compose"
          value={recipients}
          onChange={setRecipients}
          disabled={sending}
        />

        <Field id="ticket-compose-subject" label="Subject" required>
          {(p) => (
            <input
              {...p}
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What this is about"
              maxLength={200}
              className={INPUT_CLASSES}
            />
          )}
        </Field>

        <Field id="ticket-compose-text" label="Message" required>
          {(p) => (
            <textarea
              {...p}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={9}
              maxLength={10000}
              placeholder="Write the email…"
              className={INPUT_CLASSES}
            />
          )}
        </Field>

        {/* The sign-off the route now appends (EMAIL-TICKET.5 follow-up) —
            same shared hint as the reply box, so the preview cannot disagree
            with what the member receives. MAILFIX-SIGTRUTH.1: the selected
            From account's location IS the sending context (the send resolves
            the studio half of the signature off the mailbox's own location),
            so switching From re-resolves the hint to that studio. With NO
            From account nothing can send, so there is no sending context to
            preview — the hint is not mounted rather than shown unresolved. */}
        {mailbox && <SignatureHint locationId={mailbox.location_id || null} />}

        {/* Files survive a change of From address, and that is safe rather than
            merely convenient: the draft key is derived from the SENDER'S profile
            id, not the mailbox, and the send re-runs the full send-as gate at
            the mailbox finally chosen. Signing under one visible mailbox and
            sending from another therefore grants nothing — the caller had to
            pass both gates to do it. */}
        <AttachmentPicker
          scope={{ mailbox_id: mailboxId }}
          files={files}
          onChange={setFiles}
          disabled={sending || !mailboxId}
        />

        {error && (
          <p
            className="flex items-start gap-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-700"
            role="alert"
          >
            <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}
      </form>
  )

  // The dock shell (MAIL-DOCK.2). `subject` and `dirty` flow live per render,
  // which is what makes the card's title bar and its dirty-aware Esc ladder
  // possible without lifting any of this component's state.
  if (shell) return shell({ subject, dirty, sending, requestClose, body, footer })

  return (
    <Modal open onClose={requestClose} title="New email" size="lg" footer={footer}>
      {body}
    </Modal>
  )
}
