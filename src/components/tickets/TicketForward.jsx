'use client'

// EMAIL-FORWARD.1 — passing one message on the ticket to somebody else.
//
// THE THIRD SEND SURFACE, and the one whose recipients are furthest from the
// member. Reply writes to people the member put on the thread; New email writes
// to somebody a staff member chose; Forward takes what the member sent US and
// gives it to a third party. So this composer's job is to make the operator
// look at three things before they press send:
//
//   WHO gets it        — the recipient editor, with nothing locked and nothing
//                        derived. Unlike a reply, no participant is included
//                        for you: choosing a new audience IS the act.
//   WHAT they can read — the quoted message is shown, in full, above the
//                        editor. A forward is the one send where the operator
//                        may not have read what they are about to pass on.
//   WHICH files go     — every forwardable file, with a checkbox and a running
//                        total. See THE CAP below.
//
// ══ THE CAP, AND WHY IT IS A CHECKBOX LIST ══════════════════════════
// An inbound email may carry 25 MB; one outbound email may carry 7 MiB. So
// "forward everything" is not always available, and the two honest answers are
// "refuse the whole thing" or "let them choose". This is the choose one.
//
// Everything is pre-ticked WHEN EVERYTHING FITS, and NOTHING is pre-ticked when
// it does not (defaultForwardSelection) — a greedy subset would be a set of
// files the operator did not decide to leave out, which is exactly the silent
// drop this feature exists to make impossible. The running total names both
// numbers, the Send button is disabled over budget, and the server refuses an
// over-budget set anyway: this is the affordance, not the gate.
//
// A file with no stored bytes (over quota on arrival, or pruned) is listed but
// NOT selectable, with its reason in words. Hiding it would have staff telling
// a member "you never sent that".
//
// ══ IT IS PLAIN TEXT AND IT SAYS SO ═════════════════════════════════
// The forwarded body is the message's text, never its HTML — see
// src/lib/email-forward.js for why quoting a stranger's markup onto our own
// DKIM signature is the wrong trade. That is a real difference from what the
// operator is looking at in the thread, so it is stated here rather than
// discovered by the recipient.
//
// Mounted only while open (see MailSurface), so state resets per open and the
// thread's background re-read cannot wipe a half-typed forward.

import { useState } from 'react'
import { AlertCircle, Forward, Lock, FileWarning } from 'lucide-react'
import { Modal, Button, Field } from '@/components/ui'
import { formatBytes, SKIPPED_REASON_LABEL } from '@/lib/email-attachment-quota'
import { messageTimestamp } from '@/lib/ticket-display'
import {
  forwardSubject,
  forwardableAttachments,
  forwardBudget,
  defaultForwardSelection,
  forwardSizeError,
} from '@/lib/email-forward'
import RecipientEditor, { EMPTY_RECIPIENTS } from './RecipientEditor'

// The submit button lives in the Modal's footer, a SIBLING of the form, so it
// is wired by id. Only one forward modal exists at a time.
const FORM_ID = 'ticket-forward-form'

const INPUT_CLASSES =
  'w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-subtle/60 focus:outline-none focus:ring-1 focus:ring-un1t-text/30'

export default function TicketForward({ ticket, message, onClose, onSent }) {
  const [recipients, setRecipients] = useState(EMPTY_RECIPIENTS)
  const [note, setNote] = useState('')
  const files = forwardableAttachments(message?.attachments)
  const skipped = (message?.attachments || []).filter(a => !a.stored)
  const [selected, setSelected] = useState(() => defaultForwardSelection(files))
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  const chosen = files.filter(f => selected.includes(f.id))
  const budget = forwardBudget(chosen)
  const canSend = recipients.to.length > 0 && !budget.over

  function toggle(id) {
    setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!canSend || sending) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch(`/api/email/tickets/${ticket.id}/forward`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message_id: message.id,
          to: recipients.to,
          cc: recipients.cc,
          bcc: recipients.bcc,
          note,
          attachment_ids: selected,
        }),
      })
      const body = await res.json()
      if (!body?.success) {
        // Zod issues are the useful half of a 400 — "Invalid request body"
        // alone tells an operator nothing about which field is wrong.
        const detail = Array.isArray(body?.issues) && body.issues.length
          ? body.issues.map(i => i.message).join('; ')
          : null
        setError(detail || body?.error || 'Could not forward that')
        return
      }
      onSent?.()
    } catch {
      setError('Could not forward that — check your connection and try again')
    } finally {
      setSending(false)
    }
  }

  const quoted = message?.text_body || '(no text content)'

  return (
    <Modal
      open
      onClose={onClose}
      title="Forward this message"
      size="lg"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            variant="primary"
            icon={Forward}
            loading={sending}
            disabled={!canSend}
          >
            Forward
          </Button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={handleSubmit} className="space-y-3">
        <p className="text-xs text-un1t-subtle">
          Sending from{' '}
          <span className="text-un1t-text">{ticket?.mailbox?.address || 'this studio'}</span>
          {' · '}
          <span className="text-un1t-muted">{forwardSubject(message?.subject || ticket?.subject)}</span>
        </p>

        {/* NOTHING IS LOCKED HERE, unlike a reply. The people on the thread are
            deliberately absent: forwarding to them would be a reply, and this
            is the one send whose audience is entirely the operator's choice. */}
        <RecipientEditor
          idPrefix="ticket-forward"
          value={recipients}
          onChange={setRecipients}
          disabled={sending}
        />

        <Field id="ticket-forward-note" label="Add a note" hint="Optional — it goes above the forwarded message.">
          {(p) => (
            <textarea
              {...p}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              maxLength={10000}
              placeholder="Why you are passing this on…"
              className={INPUT_CLASSES}
            />
          )}
        </Field>

        {/* WHAT THEY WILL BE ABLE TO READ. Shown as plain text, because plain
            text is exactly what goes out — the preview and the mail are the
            same thing, so there is nothing to be surprised by. */}
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-un1t-muted">
            Forwarded message
          </p>
          <div className="rounded-md border border-un1t-border bg-un1t-surface px-3 py-2">
            <p className="text-[11px] text-un1t-subtle">
              From {message?.from_email || 'unknown'}
              {message?.created_at && ` · ${messageTimestamp(message.sent_at || message.created_at)}`}
            </p>
            <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs text-un1t-text">
              {quoted}
            </pre>
          </div>
          {message?.html_document && (
            <p className="mt-1 text-[11px] text-un1t-muted">
              This message was formatted. It is forwarded as plain text — the layout and any
              images are not included.
            </p>
          )}
        </div>

        {(files.length > 0 || skipped.length > 0) && (
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-un1t-muted">
              Files
            </p>
            <div className="space-y-1">
              {files.map(file => (
                <label
                  key={file.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-un1t-border bg-un1t-bg px-2 py-1.5 text-xs text-un1t-text"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(file.id)}
                    onChange={() => toggle(file.id)}
                    disabled={sending}
                    className="h-3.5 w-3.5 shrink-0 accent-un1t-accent"
                  />
                  <span className="min-w-0 flex-1 truncate">{file.filename}</span>
                  <span className="shrink-0 text-un1t-muted">{formatBytes(file.size_bytes)}</span>
                </label>
              ))}
              {/* Listed, not hidden: a file that vanished from this list would
                  have staff telling a member they never sent it. */}
              {skipped.map(file => (
                <p
                  key={file.id}
                  className="flex items-center gap-2 rounded-md border border-dashed border-amber-500/60 px-2 py-1.5 text-xs text-amber-700"
                >
                  <FileWarning size={12} className="shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{file.filename}</span>
                  <span className="shrink-0">
                    {SKIPPED_REASON_LABEL[file.skipped_reason] || 'Not stored'} — cannot be forwarded
                  </span>
                </p>
              ))}
            </div>
            {files.length > 0 && (
              <p className={`mt-1 text-[11px] ${budget.over ? 'text-red-700' : 'text-un1t-muted'}`}>
                {budget.over
                  ? forwardSizeError(budget.used)
                  : `${formatBytes(budget.used)} of ${formatBytes(budget.limit)} — the most one email can carry.`}
              </p>
            )}
          </div>
        )}

        {recipients.bcc.length > 0 && (
          <p className="flex items-center gap-1.5 text-[11px] text-un1t-muted">
            <Lock size={11} className="shrink-0" aria-hidden="true" />
            {recipients.bcc.join(', ')} is blind-copied — nobody else on this email can see that.
          </p>
        )}

        {/* Said once, plainly, at the point of decision: this leaves the
            conversation the member started and goes to somebody they did not
            name. There is no consent gate on ticket mail (it is transactional),
            so the counterweight is that the act is attributable — the route
            writes every address to audit_events under the sender's name. */}
        <p className="text-[11px] text-un1t-muted">
          This sends the member&rsquo;s message to someone outside the conversation, from the
          studio&rsquo;s own address. It is recorded on the ticket under your name.
        </p>

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
