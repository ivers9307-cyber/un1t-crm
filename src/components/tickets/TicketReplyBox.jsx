'use client'

// EMAIL-TICKET.4 — the composer.
//
// TWO MODES, AND THEY MUST NEVER BLUR INTO EACH OTHER:
//   Reply         — sends an email to the requester and moves the ticket to
//                   pending.
//   Internal note — writes staff-only text onto the thread. NOTHING is sent,
//                   the ticket does not move, the member never sees it.
//
// The mode is stated three times over — the selected pill, the colour of the
// composer, and the sentence under it naming exactly who receives what — on
// the principle that someone must never believe a note went to the customer,
// or that a reply stayed private. The submit button says which one it is too;
// it never just says "Send".
//
// SIGNATURE (EMAIL-TICKET.5). The server appends the sender's signature to
// every real reply, so the composer shows it — a writer must be able to see
// what is going out over their name. It is rendered OUTSIDE the textarea, read
// only, and labelled as automatic: making it editable here would imply a
// one-off edit the design does not support (the column is per person, and the
// route reads it fresh at send time). It never appears in note mode, because
// notes are never signed.
//
// RECIPIENTS (EMAIL-CC.1). THERE IS NO REPLY / REPLY-ALL CHOICE, deliberately
// (Richard, 2026-08-07). The server derives everybody on the thread and always
// includes them; this box shows them as locked chips and its button says which
// one is about to happen — "Reply" on a one-person thread, "Reply All (4
// people)" on a wider one. Offering both buttons is precisely the affordance
// that lets someone drop a participant by clicking the wrong one, so neither
// this component nor the route has a way to express it.
//
// Cc and Bcc ADD people and live behind the editor's own toggle. An internal
// note has no recipients at all — the editor is not rendered in note mode, and
// the route refuses a note that carries any.

import { useEffect, useState } from 'react'
import { Send, Lock, PenLine, Users } from 'lucide-react'
import { Button } from '@/components/ui'
import { isArchivedStatus, statusMeta, replyActionLabel } from '@/lib/ticket-display'
import { SIGNATURE_SEPARATOR, normalizeSignature } from '@/lib/email-signature'
import RecipientEditor, { EMPTY_RECIPIENTS } from './RecipientEditor'

const MAX_LENGTH = 10000

export default function TicketReplyBox({
  ticket,
  replyRecipients = null,
  onSend,
  sending = false,
  signature,
}) {
  const [mode, setMode] = useState('reply')
  const [text, setText] = useState('')
  const [recipients, setRecipients] = useState(EMPTY_RECIPIENTS)
  // Only fetched when the parent didn't supply one. The composer is nested two
  // components deep inside the inbox, and the signature belongs to the VIEWER
  // rather than to the ticket, so it is fetched here rather than threaded
  // through props that have nothing else to do with it.
  const [fetchedSignature, setFetchedSignature] = useState('')

  useEffect(() => {
    if (signature !== undefined) return
    let cancelled = false
    fetch('/api/me/preferences')
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && j?.success) setFetchedSignature(j.data?.email_signature || '')
      })
      // A failed lookup just hides the preview. The route appends the
      // signature server-side either way, so this is cosmetic.
      .catch(() => {})
    return () => { cancelled = true }
  }, [signature])

  const isNote = mode === 'note'
  const resolvedSignature = normalizeSignature(signature !== undefined ? signature : fetchedSignature)
  const showSignature = !isNote && !!resolvedSignature
  // The reply route 400s without a requester address. Say so up front rather
  // than letting an operator type a reply into a dead end.
  const canReply = !!ticket?.requester_email
  const archived = isArchivedStatus(ticket?.status)

  // Everybody the server will include whether or not this box asks it to.
  // Falls back to the requester when the server could not derive the set.
  const lockedTo = replyRecipients?.to?.length
    ? replyRecipients.to
    : [ticket?.requester_email].filter(Boolean)
  const sendLabel = replyActionLabel(replyRecipients, recipients.to.length)

  async function handleSubmit(e) {
    e.preventDefault()
    const body = text.trim()
    if (!body || sending) return
    if (!isNote && !canReply) return
    // A note is sent to nobody, so it carries nothing — the route refuses one
    // that does, and this is the client half of the same rule.
    const result = await onSend(body, isNote, isNote ? EMPTY_RECIPIENTS : recipients)
    if (result?.ok) {
      setText('')
      setRecipients(EMPTY_RECIPIENTS)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={`border-t px-4 py-3 ${isNote ? 'border-amber-500/40 bg-amber-500/10' : 'border-un1t-border bg-un1t-bg'}`}
    >
      {/* Mode switch. type="button" on both — a bare <button> inside a <form>
          defaults to submit and would fire the send (CLAUDE.md). */}
      <div className="mb-2 flex flex-wrap items-center gap-1" role="group" aria-label="Compose mode">
        <ModePill
          active={!isNote}
          onClick={() => setMode('reply')}
          icon={Send}
          label="Reply to member"
        />
        <ModePill
          active={isNote}
          onClick={() => setMode('note')}
          icon={Lock}
          label="Internal note"
          tone="note"
        />
      </div>

      {/* Recipients. Never in note mode — a note has none, and a Cc box on a
          staff-only line is an invitation to believe one was sent. */}
      {!isNote && canReply && (
        <div className="mb-2">
          <RecipientEditor
            idPrefix="ticket-reply-recipients"
            value={recipients}
            onChange={setRecipients}
            lockedTo={lockedTo}
            lockedHint={
              lockedTo.length > 1
                ? 'Everybody on this thread is included. To write to fewer people, start a new email instead.'
                : undefined
            }
            disabled={sending}
          />
        </div>
      )}

      <label className="sr-only" htmlFor="ticket-composer">
        {isNote ? 'Internal note (staff only)' : 'Reply to the member'}
      </label>
      <textarea
        id="ticket-composer"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={MAX_LENGTH}
        disabled={!isNote && !canReply}
        placeholder={
          isNote
            ? 'Staff-only note. Nothing is sent.'
            : `Reply to ${ticket?.requester_email || 'the member'}…`
        }
        className={`w-full resize-none rounded-lg border px-3 py-2 text-sm text-un1t-text focus:outline-none disabled:opacity-60 ${
          isNote
            ? 'border-amber-500/50 bg-un1t-bg focus:border-amber-600'
            : 'border-un1t-border bg-un1t-surface focus:border-un1t-accent'
        }`}
      />

      {/* Auto-appended sign-off. Deliberately NOT an input: it sits outside
          the textarea, carries its own label, and links to where it is
          actually changed. */}
      {showSignature && (
        <div className="mt-2 rounded-lg border border-dashed border-un1t-border bg-un1t-surface/60 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-un1t-muted">
              <PenLine size={11} aria-hidden="true" />
              Added automatically
            </span>
            {/* A new tab, not a <Link> soft-nav: navigating away from the
                composer would discard whatever reply is half-written in it. */}
            <a
              href="/account"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-un1t-subtle underline decoration-dotted underline-offset-2 hover:text-un1t-text"
            >
              Edit signature
            </a>
          </div>
          <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-xs text-un1t-subtle">
            {`${SIGNATURE_SEPARATOR}\n${resolvedSignature}`}
          </pre>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className={`text-[11px] ${isNote ? 'text-amber-700' : 'text-un1t-subtle'}`}>
          {isNote ? (
            <>
              <Lock size={11} className="mr-1 inline align-[-1px]" aria-hidden="true" />
              Staff only — this is written to the ticket and <strong>not sent</strong> to{' '}
              {ticket?.requester_email || 'the member'}.
            </>
          ) : canReply ? (
            <>
              Sends an email to <strong>{lockedTo.join(', ')}</strong>
              {recipients.cc.length > 0 && <> · cc {recipients.cc.join(', ')}</>}
              {/* Named, and named as private. Someone about to press send has
                  to be able to see that they blind-copied three people — and
                  that the other recipients cannot. */}
              {recipients.bcc.length > 0 && (
                <> · bcc {recipients.bcc.join(', ')} (hidden from everyone else)</>
              )}
              {ticket?.mailbox?.address && <> · replies come back to {ticket.mailbox.address}</>}
            </>
          ) : (
            'This ticket has no requester address, so it cannot be replied to. You can still add an internal note.'
          )}
        </p>

        <Button
          type="submit"
          size="sm"
          variant={isNote ? 'secondary' : 'primary'}
          loading={sending}
          disabled={!text.trim() || (!isNote && !canReply)}
          icon={isNote ? Lock : (sendLabel === 'Reply' ? Send : Users)}
        >
          {/* The label IS the guard rail — see the header. It states the
              number of people before the click, never after. */}
          {isNote ? 'Add internal note' : sendLabel}
        </Button>
      </div>

      {!isNote && archived && (
        <p className="mt-1.5 text-[11px] text-un1t-muted">
          This ticket is {statusMeta(ticket?.status).label.toLowerCase()} — sending a reply moves it back to pending.
        </p>
      )}
    </form>
  )
}

function ModePill({ active, onClick, icon: Icon, label, tone }) {
  const activeClasses = tone === 'note'
    ? 'border-amber-600 bg-amber-500/10 font-semibold text-amber-700'
    : 'border-transparent bg-un1t-text font-medium text-un1t-bg'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active ? activeClasses : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
      }`}
    >
      <Icon size={12} aria-hidden="true" />
      {label}
    </button>
  )
}
