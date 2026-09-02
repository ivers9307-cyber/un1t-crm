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

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Archive, ArchiveRestore, Link2, Mail, MailOpen, X } from 'lucide-react'
import { EmptyState, Modal } from '@/components/ui'
import TicketThread from '@/components/tickets/TicketThread'
import { requesterLabel } from '@/lib/ticket-display'
import { isArchived, needsReply, isUnread, MAIL_SHORTCUTS } from './mail-display'
// MAIL-REFINE.1 (03) — relating conversations. All decisions are pure and live
// in mail-relate.js; this file owns only the fetch lifecycle and the pixels.
import {
  relatedUrl, parseRelated, relatedNudge, candidateLine, mergeButtonLabel,
  mergeConversations, unmergeConversations,
} from './mail-relate'

export default function MailThread({
  hasSelection,
  conversation,
  messages = [],
  replyRecipients = null,
  attachmentsUnavailable = false,
  loading = false,
  error,
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
  // ── MAIL-REFINE.1 (03) — the two things only the surface can do ──────
  // The nudge's "View" opens another conversation, and a completed merge (or
  // undo) changed rows the surface owns — selection and refresh both live in
  // MailSurface, so they arrive as callbacks. Both OPTIONAL and degradable:
  // with no onOpenConversation the View link simply is not offered, and with
  // no onThreadChanged the surface's own polls pick the change up late rather
  // than never. Wiring (MailSurface):
  //   onOpenConversation={(row) => selectConversation(row)}
  //   onThreadChanged={async () => { await loadThread(selectedId, { quiet: true }); refreshList(true) }}
  onOpenConversation,
  onThreadChanged,
  mergedSources,
  // Audit M2 — the house Modal has no focus trap, so MailSurface's e/j/k
  // guard must know when THIS pane's picker is open; without it an escaped
  // keypress archives the conversation behind the modal.
  onModalOpenChange,
  // MAIL-DOCK.1 — which card the thread is living in ('dock' | 'full'),
  // forwarded verbatim so the sandboxed frames size to their window. Absent
  // (a caller that never heard of the dock) TicketThread keeps its pre-dock
  // heights.
  frameSize,
}) {
  const archived = isArchived(conversation)
  const waiting = needsReply(conversation)
  const unread = isUnread(conversation)
  const conversationId = conversation?.id

  // ── related conversations state ─────────────────────────────────────
  // `related` is parseRelated's answer: null until loaded AND on any failure
  // (a failed read must never render as "no related conversations" — it
  // renders as nothing). Everything resets on conversation switch: a nudge,
  // a picker or a toast describing the LAST conversation over this one would
  // be worse than none.
  const [related, setRelated] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  // Audit A1 — the attachment preview is the second overlay that owns
  // Escape; the guard hears the OR of both.
  const [attachmentOverlayOpen, setAttachmentOverlayOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState(null)
  // { ids } of a JUST-COMPLETED merge — the success toast, whose Undo is the
  // only place un-merge is offered (no persistent UI, per the design).
  const [mergeToast, setMergeToast] = useState(null)
  const [undoing, setUndoing] = useState(false)
  const [toastError, setToastError] = useState(null)
  // Supersede guard: the id this pane last asked about. A slow answer for a
  // conversation the operator has already left must be dropped, not painted.
  const relatedFor = useRef(null)
  // Audit M1 — the pane's identity, written ONLY by the switch effect. The
  // merge/undo continuations close over the id they started on; without this
  // a late `await loadRelated(A)` resuming after a switch to B re-took the
  // supersede guard for A and painted A's sender's related list under B —
  // from which the picker would offer a CROSS-SENDER merge into B.
  const currentId = useRef(null)

  const loadRelated = useCallback(async (id) => {
    // A request for a conversation this pane is no longer showing must not
    // run at all — running it would steal relatedFor back for a stale id.
    if (!id || id !== currentId.current) return
    relatedFor.current = id
    try {
      const res = await fetch(relatedUrl(id))
      const body = await res.json().catch(() => null)
      if (relatedFor.current !== id || currentId.current !== id) return // superseded
      setRelated(parseRelated(body))
    } catch {
      if (relatedFor.current === id && currentId.current === id) setRelated(null)
    }
  }, [])

  useEffect(() => {
    onModalOpenChange?.(pickerOpen || attachmentOverlayOpen)
    return () => onModalOpenChange?.(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notify on open-state changes only
  }, [pickerOpen, attachmentOverlayOpen])

  useEffect(() => {
    setRelated(null)
    setPickerOpen(false)
    setSelectedIds(new Set())
    setMerging(false)
    setMergeError(null)
    setMergeToast(null)
    setUndoing(false)
    setToastError(null)
    currentId.current = conversationId || null
    if (!conversationId) { relatedFor.current = null; return }
    loadRelated(conversationId)
  }, [conversationId, loadRelated])

  // The toast is a moment, not a fixture: it dismisses itself. Held open
  // while an undo is in flight — its own result needs somewhere to land.
  useEffect(() => {
    if (!mergeToast || undoing) return undefined
    const timer = setTimeout(() => setMergeToast(null), 15_000)
    return () => clearTimeout(timer)
  }, [mergeToast, undoing])

  function toggleSelected(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleMergeConfirm() {
    if (merging || !conversationId) return
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const paneId = conversationId
    setMerging(true)
    setMergeError(null)
    const result = await mergeConversations({ ids, into: paneId })
    // Whatever happened, anything that DID merge changed the thread and the
    // list — refresh both, and re-read related so the picker and the nudge
    // tell the truth again (merged rows leave the related answer server-side).
    if (result.merged.length > 0) onThreadChanged?.()
    // Audit M1 — the operator left this conversation mid-flight: the data
    // refresh above still ran, but none of THIS pane's UI state may be
    // written for a conversation no longer on screen.
    if (currentId.current !== paneId) return
    setMerging(false)
    await loadRelated(paneId)
    if (currentId.current !== paneId) return
    if (result.failed) {
      // 🔴 A failed merge must never look merged: the picker STAYS OPEN, the
      // failure is named in the server's own words, and only the genuinely
      // un-merged survivors stay ticked.
      // Audit M4 — the FAILED conversation stays ticked: unticking it made a
      // re-confirm silently skip exactly the one that needs retrying.
      setSelectedIds(new Set(ids.filter(id => !result.merged.includes(id))))
      const doneCount = result.merged.length
      setMergeError(
        doneCount > 0
          ? `Merged ${doneCount} of ${ids.length}, then stopped: ${result.failed.error}. The rest were not merged.`
          : `Nothing was merged: ${result.failed.error}`
      )
      return
    }
    setPickerOpen(false)
    setSelectedIds(new Set())
    setMergeToast({ ids: result.merged })
  }

  async function handleUndo() {
    if (undoing || !mergeToast) return
    const ids = mergeToast.ids
    const paneId = conversationId
    setUndoing(true)
    setToastError(null)
    const result = await unmergeConversations({ ids })
    if (result.unmerged.length > 0) onThreadChanged?.()
    if (currentId.current !== paneId) return // audit M1 — pane moved on
    setUndoing(false)
    await loadRelated(paneId)
    if (currentId.current !== paneId) return
    if (result.failed) {
      // The ones that came back are back; the toast keeps offering Undo for
      // exactly what is still merged, and says why it stopped.
      setMergeToast({ ids: ids.filter(id => !result.unmerged.includes(id)) })
      setToastError(result.failed.error)
      return
    }
    setMergeToast(null)
  }

  // The nudge: same requester, other OPEN conversations. Never on a tombstone
  // — a merged-away thread is read-only and must not invite more merging into
  // it — and relatedNudge itself answers null for a failed read or zero open.
  const nudge = conversation?.merged_into_id
    ? null
    : relatedNudge(related, requesterLabel(conversation))

  const relatedList = related?.related || []
  const pickerCount = selectedIds.size

  return (
    <>
    <TicketThread
      hasSelection={hasSelection}
      ticket={conversation}
      messages={messages}
      // MAIL-DOCK.1 — the card is a smaller window than the old pane, so the
      // frames size to it, and the composer opens as the mockup's slim pill
      // in BOTH dock and full (a saved draft auto-expands it; see
      // TicketReplyBox's startCollapsed).
      frameSize={frameSize}
      replyStartCollapsed
      mergedSources={mergedSources}
      onOverlayOpenChange={setAttachmentOverlayOpen}
      onOpenMergedInto={onOpenConversation ? (id) => onOpenConversation({ id }) : undefined}
      replyRecipients={replyRecipients}
      attachmentsUnavailable={attachmentsUnavailable}
      loading={loading}
      error={error}
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
      banner={
        // MAIL-REFINE.1 (03) — the related-conversations nudge, under the
        // header. Rendered only when the related endpoint reported ≥1 OPEN
        // conversation for this requester; a failed read renders nothing
        // (never a confident zero).
        nudge && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-blue-500/20 bg-blue-500/10 px-4 py-2 text-xs text-blue-700"
        >
          <Link2 size={12} className="shrink-0" aria-hidden="true" />
          <span>
            <span className="font-semibold">{nudge.name}</span>
            {' has '}
            <span className="font-semibold">{nudge.label}</span>
          </span>
          <span aria-hidden="true">—</span>
          {/* View opens the newest related OPEN thread — selection belongs to
              the surface, so no handler means no link, not a dead one. */}
          {nudge.viewId && onOpenConversation && (
            <button
              type="button"
              onClick={() => onOpenConversation({ id: nudge.viewId })}
              className="font-semibold underline"
            >
              View
            </button>
          )}
          {nudge.viewId && onOpenConversation && <span aria-hidden="true">·</span>}
          <button
            type="button"
            onClick={() => { setMergeError(null); setPickerOpen(true) }}
            className="font-semibold underline"
          >
            Merge into this one
          </button>
        </div>
      )}
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

    {/* MAIL-REFINE.1 (03) — the merge picker. ALL related conversations
        (open + archived), checkboxes, per the mockup. The house Modal gives
        role="dialog", which is also what keeps the e/j/k shortcuts inert
        while it is open (isTypingTarget's dialog guard). */}
    <Modal
      open={pickerOpen}
      onClose={() => { if (!merging) setPickerOpen(false) }}
      title="Merge conversations"
      size="md"
      footer={
        <>
          <button
            type="button"
            onClick={() => setPickerOpen(false)}
            disabled={merging}
            className="rounded-md border border-un1t-border bg-un1t-bg px-3 py-1.5 text-xs font-medium text-un1t-text transition-colors hover:bg-un1t-surface disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleMergeConfirm}
            disabled={merging || pickerCount === 0}
            className="rounded-md bg-un1t-text px-3 py-1.5 text-xs font-semibold text-un1t-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {merging ? 'Merging…' : mergeButtonLabel(pickerCount)}
          </button>
        </>
      }
    >
      <p className="mb-3 text-xs text-un1t-subtle">
        Their messages move into “{conversation?.subject || 'this conversation'}”. Each merged
        conversation keeps a pointer here — nothing is deleted.
      </p>
      <div className="divide-y divide-un1t-border/60 rounded-lg border border-un1t-border">
        {related === null ? (
          // Audit M3 — a failed related read must not wear the empty state's
          // clothes INSIDE the picker either: unmerged candidates may exist.
          <p className="px-3 py-3 text-xs text-amber-700">
            Couldn’t load related conversations.{' '}
            <button type="button" className="font-semibold underline" onClick={() => loadRelated(conversationId)}>
              Retry
            </button>
          </p>
        ) : relatedList.length === 0 ? (
          <p className="px-3 py-3 text-xs text-un1t-muted">
            No other conversations from this sender.
          </p>
        ) : relatedList.map(item => (
          <label key={item.id} className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5">
            <input
              type="checkbox"
              checked={selectedIds.has(item.id)}
              onChange={() => toggleSelected(item.id)}
              disabled={merging}
              className="accent-un1t-text"
            />
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold text-un1t-text">
                {item.subject || '(no subject)'}
              </span>
              <span className="block truncate text-[11px] text-un1t-subtle">
                {candidateLine(item)}
              </span>
            </span>
          </label>
        ))}
      </div>
      {mergeError && (
        // 🔴 A failed merge must never look merged: the picker stays open and
        // says, in the server's words, exactly how far it got.
        <p className="mt-2 text-xs text-red-700" role="alert">{mergeError}</p>
      )}
    </Modal>

    {/* The success toast — the ONLY place Undo lives (no persistent UI).
        Dismisses itself after a few seconds; an in-flight undo holds it. */}
    {/* Audit A3 — PORTALLED: the toast carries the only Undo, and rendered
        inside the dock's subtree a minimise (md:hidden on an ancestor) would
        silently kill a live Undo affordance. On document.body it survives
        minimise and never overlaps the reply pill. */}
    {mergeToast && mergeToast.ids.length > 0 && typeof document !== 'undefined' && createPortal(
      <div
        role="status"
        className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-black px-4 py-2.5 text-xs text-white shadow-lg"
      >
        <span>
          Merged {mergeToast.ids.length} conversation{mergeToast.ids.length === 1 ? '' : 's'} into this one.
        </span>
        <button
          type="button"
          onClick={handleUndo}
          disabled={undoing}
          className="font-semibold underline disabled:opacity-60"
        >
          {undoing ? 'Undoing…' : 'Undo'}
        </button>
        <button
          type="button"
          onClick={() => setMergeToast(null)}
          aria-label="Dismiss"
          className="opacity-70 transition-opacity hover:opacity-100"
        >
          <X size={13} aria-hidden="true" />
        </button>
        {/* A dark island: the low ramp is legible here, and the bg-black on
            the same element is what the accent-text lint recipe asks for. */}
        {toastError && (
          <span className="w-full bg-black text-red-300" role="alert">{toastError}</span>
        )}
      </div>,
      document.body
    )}
    </>
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
