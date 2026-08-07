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
// Mounted only while open (see TicketInbox), so state resets per open and the
// inbox's 60s poll re-creating `mailboxes` can never wipe a half-typed email.

import { useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { Modal, Button, Field } from '@/components/ui'
import { mailboxLabel } from '@/lib/ticket-display'
import RecipientEditor, { EMPTY_RECIPIENTS } from './RecipientEditor'

// The submit button lives in the Modal's footer, which is a SIBLING of the
// form, not a descendant — so it is wired to the form by id. Only one compose
// modal exists at a time, so a constant id is safe.
const FORM_ID = 'ticket-compose-form'

const INPUT_CLASSES =
  'w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-subtle/60 focus:outline-none focus:ring-1 focus:ring-un1t-text/30'

export default function TicketCompose({ mailboxes = [], initialMailboxId = null, onClose, onSent }) {
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
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  const mailbox = mailboxes.find(m => m.id === mailboxId) || null
  // At least one To. A Cc with no To is not an email anyone can reply to, and
  // the route refuses it — say so by leaving the button off.
  const canSend = Boolean(mailboxId && recipients.to.length && subject.trim() && text.trim())

  async function handleSubmit(e) {
    e.preventDefault()
    if (!canSend || sending) return
    setSending(true)
    setError(null)
    try {
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

  return (
    <Modal
      open
      onClose={onClose}
      title="New email"
      size="lg"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} variant="primary" loading={sending} disabled={!canSend}>
            Send
          </Button>
        </>
      }
    >
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
    </Modal>
  )
}
