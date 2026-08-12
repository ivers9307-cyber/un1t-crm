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
// REMOVING ONE, THOUGH, IS EXPLICIT (EMAIL-PARTICIPANTS.7). The audience is
// derived from the WHOLE thread now, so it can include people an operator has
// a real reason to take off — and a derived set nobody can edit is its own
// trap. The chips above the textarea are that edit and the ONLY one: a × per
// address, no free-form box to type a new one (Richard). Subtracting from a
// derived set cannot reach anyone the thread did not already include; adding
// to it can, and that is what compose and forward are for. The removal is
// sticky, stored per ticket by the participants route, and it is the SERVER's
// answer that repaints these chips — this box never edits the list it renders.
//
// Cc and Bcc ADD people and live behind the editor's own toggle. An internal
// note has no recipients at all — the editor is not rendered in note mode, and
// the route refuses a note that carries any.
//
// ATTACHMENTS (EMAIL-OUTBOUND-ATTACH.1) follow the same two-modes rule as
// everything else here: a reply can carry files, an internal note cannot,
// because a note is sent to nobody and there is nothing for a file to ride on.
// The picker is therefore hidden in note mode — and if files are already
// attached, switching to note mode does NOT silently drop them: it says so and
// blocks the note until they are removed. The route refuses the combination
// too, so the rule is stated in both places.

import { useState } from 'react'
import { Send, Lock, Users, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui'
import { isArchivedStatus, statusMeta, replyActionLabel } from '@/lib/ticket-display'
import SignatureHint from './SignatureHint'
import RecipientEditor, { EMPTY_RECIPIENTS } from './RecipientEditor'
import AttachmentPicker, { readyDrafts, hasPendingUploads } from './AttachmentPicker'

const MAX_LENGTH = 10000

export default function TicketReplyBox({
  ticket,
  replyRecipients = null,
  onSend,
  onRemoveRecipient,
  sending = false,
  signature,
}) {
  const [mode, setMode] = useState('reply')
  const [text, setText] = useState('')
  const [recipients, setRecipients] = useState(EMPTY_RECIPIENTS)
  const [files, setFiles] = useState([])

  const isNote = mode === 'note'
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

  // A note can never carry files, so files present + note mode is a state the
  // operator has to resolve rather than one we resolve for them by dropping
  // their uploads.
  const filesBlockNote = isNote && files.length > 0
  const uploading = hasPendingUploads(files)
  // The reply route refuses an audience over the cap (EMAIL-PARTICIPANTS.5).
  // A note reaches nobody, so it can never be over one.
  const overCap = !isNote && !!replyRecipients?.over_cap

  async function handleSubmit(e) {
    e.preventDefault()
    const body = text.trim()
    if (!body || sending) return
    if (!isNote && !canReply) return
    // Never send a partial set: a chip on screen that did not go with the email
    // is the same lie as a file the thread claims was sent.
    if (uploading || filesBlockNote) return
    if (overCap) return
    // A note is sent to nobody, so it carries NEITHER recipients NOR files —
    // the route refuses one that does, and this is the client half of the same
    // rule for both. One `extras` object rather than two positional arguments,
    // so adding a third thing a send can carry does not renumber the callers.
    const result = await onSend(body, isNote, isNote
      ? { recipients: EMPTY_RECIPIENTS, attachments: [] }
      : { recipients, attachments: readyDrafts(files) })
    if (result?.ok) {
      setText('')
      setRecipients(EMPTY_RECIPIENTS)
      // The drafts were consumed by the send (their objects moved to the
      // message's own keys), so clearing is not just tidying — holding them
      // would offer the operator references that no longer resolve.
      setFiles([])
    }
    // Anything else keeps the draft — INCLUDING `result.sent`, the
    // delivered-but-unfiled case (EMAIL-REPLY-UNFILED.1): the mail went out
    // but the thread could not record it, so the words in this box are the
    // operator's only copy of what the member received, and the banner above
    // says not to send them again. Clearing here would make that failure look
    // like a clean success.
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

      {!isNote && lockedTo.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-un1t-muted">To</span>
          {lockedTo.map(address => (
            <span
              key={address}
              className="inline-flex items-center gap-1 rounded-full bg-un1t-border/40 px-2 py-0.5 text-[11px] text-un1t-subtle"
            >
              {address}
              {/* Removal is the ONLY edit offered. Adding an arbitrary address
                  belongs to compose and forward — keeping the audience derived
                  is what stops a reply quietly reaching someone the thread
                  never included. A one-person thread keeps its × so the last
                  recipient can still be removed deliberately; the reply route
                  then refuses the send rather than mailing them anyway. */}
              {onRemoveRecipient && (
                <button
                  type="button"
                  aria-label={`Remove ${address}`}
                  onClick={() => onRemoveRecipient(address)}
                  className="text-un1t-muted hover:text-un1t-text"
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {overCap && (
        <p className="mb-2 text-[11px] text-amber-700">
          This thread has {lockedTo.length} recipients and the limit is 25. Remove some before replying.
        </p>
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

      {/* Auto-appended sign-off — the shared hint, so the reply box and the
          composer can never disagree about what the server adds. Never shown
          on a note: a note is sent to nobody. */}
      {!isNote && <SignatureHint signature={signature} />}

      {/* Files ride on a reply only. In note mode the picker is gone but any
          already-attached files stay visible in the notice below — dropping
          them silently would be the thing this composer is most careful about
          everywhere else. */}
      {!isNote && canReply && (
        <AttachmentPicker
          scope={{ ticket_id: ticket?.id }}
          files={files}
          onChange={setFiles}
          disabled={sending}
        />
      )}

      {filesBlockNote && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-700" role="alert">
          <AlertCircle size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
          {files.length === 1 ? 'A file is' : `${files.length} files are`} attached, and an internal
          note is not sent to anyone. Switch back to Reply to send {files.length === 1 ? 'it' : 'them'},
          or remove {files.length === 1 ? 'it' : 'them'} there first.
        </p>
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
          disabled={!text.trim() || (!isNote && !canReply) || uploading || filesBlockNote}
          icon={isNote ? Lock : (sendLabel === 'Reply' ? Send : Users)}
        >
          {/* The label IS the guard rail — see the header. It states the
              number of people before the click, never after; a file still on
              its way up displaces it only because pressing send then would be
              the one click that cannot do what the label says. */}
          {isNote ? 'Add internal note' : uploading ? 'Waiting for files…' : sendLabel}
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
