'use client'

// MAIL-TRIAL.B — the reading pane.
//
// 🔴 THIS FILE IS A WRAPPER, NOT A THREAD. Everything that renders
// correspondence — the sandboxed iframe a stranger's HTML goes in, blocked
// remote images, attachment chips and their signed-URL downloads, the internal
// note panel, the delivery marker, the mail-client marker, join markers, the
// message envelope, the composer with its signature and its locked recipient
// chips — lives in TicketThread/TicketReplyBox and is used here UNCHANGED.
//
// Forking it was the obvious way to build a second surface and it would have
// been the wrong one twice over. The sandbox attribute and the show-images
// swap are asserted against TicketThread.jsx's own source by
// src/lib/email-html.test.js, so a copy would be a copy with nothing guarding
// its security literals; and this repo has already watched two restatements of
// deliveryMeta drift apart inside a week. One implementation, three slots.
//
// WHAT THIS SURFACE PUTS IN THOSE SLOTS is the whole visible difference:
//   • statusChip — Archived, or Needs reply, or nothing. Not open/pending/
//     solved/closed: three of those four are ceremony this surface drops.
//   • controls   — Archive (the primary verb), plus Mark read while anything
//     on the conversation is unread. No four-state segmented control, no
//     claim/release, no reassign picker, no merge.
//   • emptyState — a conversation, not a ticket.
//
// The header ABOVE the slots is deliberately kept as it is: the subject, the
// live participant list, which account it arrived at and the linked contact
// are the same facts on both surfaces, and EMAIL-PARTICIPANTS.8 is the reason
// the participant line exists at all — an operator answering the wrong person
// is not a ticketing problem.

import { Archive, ArchiveRestore, Mail, MailOpen } from 'lucide-react'
import { EmptyState } from '@/components/ui'
import TicketThread from '@/components/tickets/TicketThread'
import { isArchived, needsReply, isUnread, MAIL_SHORTCUTS } from './mail-display'

export default function MailThread({
  hasSelection,
  conversation,
  messages = [],
  replyRecipients = null,
  attachmentsUnavailable = false,
  loading = false,
  error,
  currentUserId,
  onBack,
  onSend,
  sending = false,
  onRemoveRecipient,
  onRestoreRecipient,
  participantSaving = false,
  onForward,
  onArchive,
  onMarkRead,
  onMarkUnread,
  actionSaving = false,
}) {
  const archived = isArchived(conversation)
  const waiting = needsReply(conversation)
  const unread = isUnread(conversation)

  return (
    <TicketThread
      hasSelection={hasSelection}
      ticket={conversation}
      messages={messages}
      replyRecipients={replyRecipients}
      attachmentsUnavailable={attachmentsUnavailable}
      loading={loading}
      error={error}
      currentUserId={currentUserId}
      onBack={onBack}
      onSend={onSend}
      sending={sending}
      onRemoveRecipient={onRemoveRecipient}
      onRestoreRecipient={onRestoreRecipient}
      participantSaving={participantSaving}
      onForward={onForward}
      // NOTHING is passed for onStatusChange / onAssign / onMerge / onUnmerge.
      // The slots below replace the rows that would have called them, so the
      // handlers are not merely hidden — this surface has no way to express
      // them at all, which is what "dropping the lifecycle" has to mean.
      statusChip={
        archived ? (
          <span className="rounded-full bg-slate-500/10 px-2 py-0.5 text-[10px] font-medium text-slate-700">
            Archived
          </span>
        ) : waiting ? (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700">
            Needs reply
          </span>
        ) : null
      }
      controls={
        <MailControls
          archived={archived}
          unread={unread}
          saving={actionSaving}
          onArchive={onArchive}
          onMarkRead={onMarkRead}
          onMarkUnread={onMarkUnread}
        />
      }
      // Replying to an archived conversation brings it back — the reply route
      // moves the row to `pending`, which is a live status on this surface.
      // Said in this surface's own words: "closed … back to pending" would be
      // the composer contradicting the chip six lines above it.
      archivedHint={
        <p className="mt-1.5 text-[11px] text-un1t-muted">
          This conversation is archived — replying brings it back to the inbox.
        </p>
      }
      emptyState={
        <EmptyState
          icon={<Mail size={30} />}
          title="Select a conversation"
          description="Pick one from the list to read it and reply. j and k move between conversations, e archives."
        />
      }
    />
  )
}

/**
 * The verbs, and nothing else.
 *
 * Archive is styled as the primary action because on this surface it IS the
 * work: the ticket queue's equivalent is buried in a four-state segmented
 * control inside the thread, which is precisely the ceremony the trial is
 * testing against.
 *
 * 🔴 THERE IS NO "MARK UNREAD". The CRM's read state is a mirror of the IMAP
 * \Seen flag and the poller converges it in both directions, so a CRM-only
 * unread mark would quietly undo itself within about a quarter of an hour.
 * Mark READ is offered — that one is paired all the way to the mailbox — and
 * only while there is something unread to clear.
 *
 * The shortcut hint is rendered, not documented elsewhere: an undiscoverable
 * shortcut is the same as no shortcut.
 */
function MailControls({ archived, unread, saving, onArchive, onMarkRead, onMarkUnread }) {
  const ArchiveIcon = archived ? ArchiveRestore : Archive
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onArchive?.(!archived)}
        disabled={saving}
        className="inline-flex items-center gap-1.5 rounded-md border border-transparent bg-un1t-text px-2.5 py-1 text-xs font-medium text-un1t-bg transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        <ArchiveIcon size={13} aria-hidden="true" />
        {archived ? 'Move back to inbox' : 'Archive'}
      </button>
      <button
        type="button"
        onClick={() => (unread ? onMarkRead?.() : onMarkUnread?.())}
        disabled={saving}
        className="inline-flex items-center gap-1.5 rounded-md border border-un1t-border px-2.5 py-1 text-xs text-un1t-subtle transition-colors hover:text-un1t-text disabled:opacity-50"
      >
        {unread ? <MailOpen size={13} aria-hidden="true" /> : <Mail size={13} aria-hidden="true" />}
        {unread ? 'Mark read' : 'Mark unread'}
      </button>
      {/* A write-back notice deliberately does NOT live here. It describes the
          last ACTION, and archiving moves the operator on — so the
          conversation it belonged to is often no longer the one on screen.
          MailSurface renders it once, above the list. */}
      <span className="text-[11px] text-un1t-muted">
        {MAIL_SHORTCUTS.map(s => `${s.keys} · ${s.description}`).join('   ')}
      </span>
    </div>
  )
}
