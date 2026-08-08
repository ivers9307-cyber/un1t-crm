'use client'

// EMAIL-TICKET.4 — the thread pane: the ticket's header, its correspondence in
// order, and the lifecycle control.
//
// THE ONE THING THIS FILE MUST NEVER GET WRONG
// An internal note is stored with direction='outbound' — same as a real sent
// reply. It is rendered here as a full-width amber panel with the words
// "Internal note — not sent to the member" on it, so it can never be mistaken
// for correspondence the member received, and a real reply can never be
// mistaken for a private note. messageKind() (lib/ticket-display.js) makes the
// call; this file only paints it. Notes are PLAIN TEXT — they never go
// through the HTML path below, whatever the payload says.
//
// HTML RENDERING (EMAIL-TICKET.5)
// This file receives `html_document`: a COMPLETE document, already sanitised
// server-side by src/lib/email-html.js and ready to be handed to an iframe's
// srcdoc. It never sees raw html_body, never sanitises anything, and never
// imports the sanitiser — that would ship sanitize-html and its postcss tree
// to the browser and invite someone to sanitise client-side, where it proves
// nothing. React's raw-HTML escape hatch is not used here or anywhere in src/.
//
// The two security-critical literals below (the sandbox attribute and the
// show-images swap) are asserted against this file's source in
// src/lib/email-html.test.js, because a quiet edit to either removes a whole
// layer of protection without breaking anything visible.
//
// ATTACHMENTS (EMAIL-ATTACH-PREVIEW.1)
// A message's files render as CHIPS — icon, name, size — and nothing else. No
// attachment's bytes are ever rendered inside the thread: clicking a chip opens
// ./AttachmentPreview, which is where the one open file lives, and the chip's
// own download button is the path that has to work for every type. Which types
// may be previewed at all is the SERVER's answer (`preview_kind` on the
// attachment row); this file never forms that judgement.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Lock, Mail, AlertCircle, MailCheck, ImageOff, Maximize2, Minimize2,
  ShieldAlert, Download, FileWarning, Check, MailX, ShieldX, Forward,
} from 'lucide-react'
import { EmptyState, Loading } from '@/components/ui'
import { formatBytes, SKIPPED_REASON_LABEL } from '@/lib/email-attachment-quota'
import AttachmentPreview, { AttachmentIcon } from './AttachmentPreview'
import {
  requesterLabel,
  initialsOf,
  statusMeta,
  priorityMeta,
  STATUS_ORDER,
  messageKind,
  messageTimestamp,
  deliveryMeta,
  deliveryTimestamp,
  assigneeLabel,
  mailboxLabel,
  messageRecipients,
  threadSignature,
  canForwardMessage,
  forwardedMarker,
} from '@/lib/ticket-display'
import TicketReplyBox from './TicketReplyBox'

export default function TicketThread({
  hasSelection,
  ticket,
  messages = [],
  // EMAIL-CC.1 — { to, mode } as the server derived it, or null. Handed
  // straight to the composer, which must never re-derive it from `messages`:
  // a second implementation is a second chance to include a bcc address.
  replyRecipients = null,
  // EMAIL-ATTACH.1 — the attachment query failed. The thread below is complete;
  // the FILE lists on it are not, and saying nothing would render as "no files".
  attachmentsUnavailable = false,
  loading = false,
  error,
  currentUserId,
  onBack,
  onStatusChange,
  statusSaving = false,
  // EMAIL-ASSIGN.1 — claim/release for everyone, reassign for elevated
  // viewers. onAssign takes 'me' | null | <profile id>; the route decides.
  onAssign,
  assignSaving = false,
  viewerIsElevated = false,
  onSend,
  sending = false,
  // EMAIL-FORWARD.1 — opens the forward composer for ONE message. Owned by the
  // inbox (like compose), because a forward is a modal over the whole surface
  // rather than something a bubble can render inside itself.
  onForward,
}) {
  const endRef = useRef(null)
  // EMAIL-ATTACH-RACE.1 — scroll on a NEW message, not on every re-read.
  // The thread now re-reads itself every few seconds while it is settling, so
  // keying this on `messages` (a fresh array each time) would yank an operator
  // back to the bottom mid-read. An attachment row landing on a message that
  // is already on screen is precisely the case where nothing should move.
  const threadKey = threadSignature(messages)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [threadKey])

  // EMAIL-ATTACH-PREVIEW.1 — the attachment overlay is owned HERE, not by the
  // message that holds the file: exactly one may be open at a time, it must
  // cover the whole pane rather than a bubble, and switching tickets has to
  // close it. Only the row is held; the signed URL is minted by the overlay
  // when it opens and lives no longer than it does.
  const [openAttachment, setOpenAttachment] = useState(null)
  const ticketId = ticket?.id
  useEffect(() => { setOpenAttachment(null) }, [ticketId])

  if (!hasSelection) {
    return (
      <EmptyState
        icon={<Mail size={30} />}
        title="Select a ticket"
        description="Pick a ticket from the queue to read the thread and reply."
      />
    )
  }

  const name = requesterLabel(ticket)
  const status = statusMeta(ticket?.status)
  const priority = priorityMeta(ticket?.priority)
  // EMAIL-FORWARD.1 — so a forward's bubble can name the message it passed on.
  // Built once per render rather than inside the map, which would be quadratic
  // on a thread at the 200-message cap.
  const messagesById = new Map(messages.map(m => [m.id, m]))

  return (
    <>
      {/* Header */}
      <div className="border-b border-un1t-border px-4 py-3">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to the queue"
            className="mt-0.5 text-un1t-subtle hover:text-un1t-text md:hidden"
          >
            <ArrowLeft size={18} />
          </button>

          <span className="hidden h-9 w-9 shrink-0 place-items-center rounded-[11px] border border-un1t-border bg-un1t-surface text-[13px] font-semibold text-un1t-text sm:grid">
            {initialsOf(name)}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-un1t-text">
                {ticket?.subject || '(no subject)'}
              </h2>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${status.chip}`}>
                {status.label}
              </span>
              {priority && (
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${priority.chip}`}>
                  {priority.label} priority
                </span>
              )}
            </div>

            <p className="mt-0.5 truncate text-xs text-un1t-subtle">
              {name}
              {ticket?.requester_email && ticket.requester_email !== name && (
                <span className="text-un1t-muted"> · {ticket.requester_email}</span>
              )}
            </p>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-un1t-muted">
              {ticket?.mailbox ? (
                <span title={ticket.mailbox.address || undefined}>
                  To {mailboxLabel(ticket.mailbox)}
                </span>
              ) : (
                // mailbox_id is ON DELETE SET NULL, so a deleted address
                // orphans its correspondence rather than hiding it.
                <span>No mailbox on this ticket</span>
              )}
              <span>{assigneeLabel(ticket, currentUserId)}</span>
              {ticket?.contact?.id ? (
                <Link href={`/contacts/${ticket.contact.id}`} className="text-un1t-accent hover:underline">
                  View contact
                </Link>
              ) : (
                <span>Not linked to a contact</span>
              )}
            </div>
          </div>
        </div>

        {/* Lifecycle. All four states on screen, always: nothing in this
            system closes itself, so closing has to be one click from the
            thread rather than something an operator has to go looking for. */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-un1t-muted">Status</span>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Ticket status">
            {STATUS_ORDER.map(s => {
              const m = statusMeta(s)
              const active = ticket?.status === s
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => onStatusChange(s)}
                  disabled={statusSaving || active}
                  aria-pressed={active}
                  title={m.hint}
                  className={`rounded-md border px-2.5 py-1 text-xs transition-colors disabled:cursor-default ${
                    active
                      ? 'border-transparent bg-un1t-text font-medium text-un1t-bg'
                      : 'border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-50'
                  }`}
                >
                  {m.label}
                </button>
              )
            })}
          </div>
          <span className="text-[11px] text-un1t-muted">Nothing closes itself — close it when it's done.</span>
        </div>

        {/* Ownership (EMAIL-ASSIGN.1). Claim is one click because the common
            case is "I'm answering this"; release undoes exactly that; the
            reassign picker appears only for elevated viewers, fed by the
            assignees route (grant-holders + owners — people who can SEE it). */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-un1t-muted">Owner</span>
          <AssignControl
            ticket={ticket}
            currentUserId={currentUserId}
            viewerIsElevated={viewerIsElevated}
            onAssign={onAssign}
            saving={assignSaving}
          />
        </div>
      </div>

      {/* Thread */}
      <div className="flex-1 space-y-3 overflow-y-auto bg-un1t-bg px-4 py-4">
        {loading && messages.length === 0 ? (
          <Loading label="Loading thread…" />
        ) : messages.length === 0 ? (
          // Only claim the thread is empty when we actually loaded it — the
          // error banner below owns the "we could not read it" case.
          !error && (
            <p className="py-6 text-center text-xs text-un1t-muted">
              No messages on this ticket yet.
            </p>
          )
        ) : (
          messages.map(m => (
            <ThreadMessage
              key={m.id}
              message={m}
              ticketId={ticketId}
              onOpenAttachment={setOpenAttachment}
              onForward={onForward}
              messagesById={messagesById}
            />
          ))
        )}
        <div ref={endRef} />
      </div>

      <AttachmentPreview
        ticketId={ticketId}
        attachment={openAttachment}
        onClose={() => setOpenAttachment(null)}
      />

      {attachmentsUnavailable && <AttachmentsUnavailableNotice />}

      {error && (
        <p
          className="flex items-center gap-1.5 border-t border-un1t-border bg-red-500/10 px-4 py-2 text-xs text-red-700"
          role="alert"
        >
          <AlertCircle size={12} className="shrink-0" />
          {error}
        </p>
      )}

      {/* Keyed on the ticket so switching tickets REMOUNTS the composer.
          Its draft text, reply/note mode, added Cc/Bcc and attached files are
          all local state — carried across a switch, member A's half-written
          reply (and Bcc chips) would send to member B's requester
          (TICKET-COMPOSER-LEAK.1, pinned in TicketThread.composer-reset.test.jsx).
          The inbox already clears the server-derived replyRecipients on
          switch; this is the same rule for the operator-typed half. */}
      <TicketReplyBox
        key={ticketId}
        ticket={ticket}
        replyRecipients={replyRecipients}
        onSend={onSend}
        sending={sending}
      />
    </>
  )
}

// The show-images swap, and the ONLY thing this file does to the sanitised
// document. Both halves are renames of values the server already proved to be
// absolute http(s) URLs and already HTML-escaped:
//   ` data-original-src="` → ` src="`   (a blocked <img>)
//   `x-un1t-blocked:`      → ``         (a blocked CSS url())
// See src/lib/email-html.js. Anything cleverer than a rename here — a parse, a
// regex over the whole document — is a change to the security model.
const UNBLOCK_IMG_FROM = ' data-original-src="'
const UNBLOCK_IMG_TO = ' src="'
const UNBLOCK_CSS_PREFIX = 'x-un1t-blocked:'

function showImagesIn(doc) {
  return String(doc)
    .split(UNBLOCK_IMG_FROM).join(UNBLOCK_IMG_TO)
    .split(UNBLOCK_CSS_PREFIX).join('')
}

/**
 * A stranger's HTML, in a box it cannot get out of.
 *
 * THE SANDBOX ATTRIBUTE IS LAYER 1 AND IT IS WRITTEN OUT LITERALLY BELOW so a
 * reviewer sees it at the point of use. It grants NEITHER `allow-scripts` (so
 * nothing executes, even if the sanitiser were bypassed) NOR
 * `allow-same-origin` (so the frame is an opaque origin that cannot touch this
 * page's DOM, its cookies or the Supabase session). `allow-popups` and its
 * escape are the entire remaining grant, and only so a link an operator clicks
 * actually opens — with no scripts in the frame, nothing can open one by
 * itself.
 *
 * A consequence worth knowing: with no scripts the frame cannot report its own
 * height, so it gets a fixed box that scrolls — vertically, and horizontally
 * for the 600px-wide tables marketing email is built from. The email scrolls
 * inside its box; it never widens the CRM.
 */
function EmailFrame({ html, blockedImages = 0, label, onAccent = false }) {
  const [showImages, setShowImages] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // An outbound message's controls sit on the accent bubble, where the
  // subtle-grey idiom is unreadable.
  const actionClass = onAccent ? 'text-white/90 hover:text-white' : 'text-un1t-accent hover:underline'
  const quietClass = onAccent ? 'text-white/80 hover:text-white' : 'text-un1t-subtle hover:text-un1t-text'
  const noteClass = onAccent ? 'text-white/70' : 'text-un1t-muted'

  return (
    <div className="mt-1.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        {blockedImages > 0 && (
          <button
            type="button"
            onClick={() => setShowImages(v => !v)}
            className={`flex items-center gap-1 text-[11px] ${actionClass}`}
          >
            <ImageOff size={11} className="shrink-0" aria-hidden="true" />
            {showImages ? 'Hide images' : `Show images (${blockedImages})`}
          </button>
        )}
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className={`flex items-center gap-1 text-[11px] ${quietClass}`}
        >
          {expanded
            ? <><Minimize2 size={11} className="shrink-0" aria-hidden="true" />Collapse</>
            : <><Maximize2 size={11} className="shrink-0" aria-hidden="true" />Expand</>}
        </button>
        {blockedImages > 0 && !showImages && (
          // Said plainly, because it is a privacy decision made on the
          // member's behalf: a remote image in an email is usually a tracking
          // pixel, and loading it reports the read to a stranger.
          <span className={`text-[11px] ${noteClass}`}>
            Remote images blocked — loading them tells the sender you read this
          </span>
        )}
      </div>
      <iframe
        srcDoc={showImages ? showImagesIn(html) : html}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        loading="lazy"
        title={label}
        className={`w-full rounded-lg border border-un1t-border bg-white ${expanded ? 'h-[70vh]' : 'h-[420px]'}`}
      />
    </div>
  )
}

/** "HTML could not be displayed safely" — shown INSTEAD of the HTML, never beside it. */
function UnsafeHtmlNotice() {
  return (
    <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-amber-700">
      <ShieldAlert size={11} className="shrink-0" aria-hidden="true" />
      HTML could not be displayed safely — showing the plain-text version.
    </p>
  )
}

/** The formatted version was skipped to keep a pathologically long thread openable. */
function HtmlOmittedNotice() {
  return (
    <p className="mt-1.5 text-[11px] text-un1t-muted">
      Formatted version not loaded — this thread is unusually long.
    </p>
  )
}

/**
 * The files that came with a message (EMAIL-ATTACH.1, restyled as chips in
 * EMAIL-ATTACH-PREVIEW.1).
 *
 * ONE CHIP PER FILE — icon, name, size — which is the resting state every mail
 * client uses and the one Richard asked for. Clicking the chip OPENS it
 * (AttachmentPreview); the small button on the right DOWNLOADS it without
 * opening anything, so the one-click download this row used to be is still one
 * click. Nothing is rendered inline in the thread: a member sending four 2 MB
 * photos must not turn the correspondence into something you scroll past.
 *
 * A NOT-STORED ATTACHMENT IS SHOWN, NOT HIDDEN. That is the whole reason
 * email_ticket_attachments allows a row with no bytes: an oversized or
 * over-quota file that simply vanished from the thread would have staff telling
 * a member "you never sent it". The row keeps the name and the size, so the
 * honest answer — "we have a record of it but not the file, please resend" — is
 * the one on screen. Its reason stays ON THE CHIP, in words, rather than behind
 * a click: there are no bytes, so its chip opens nothing, and an operator must
 * never have to click a file to discover it is not there.
 *
 * The bytes themselves are never in this payload. Both actions ask the server
 * for a short-lived signed URL, which is also where the access check lives.
 */
function Attachments({ ticketId, attachments, onAccent = false, onOpen }) {
  const [busy, setBusy] = useState(null)
  const [failed, setFailed] = useState(null)

  if (!attachments || attachments.length === 0) return null

  const chip = onAccent
    ? 'border-white/25 bg-white/10 text-white hover:bg-white/20'
    : 'border-un1t-border bg-un1t-surface text-un1t-text hover:border-un1t-accent'
  const quiet = onAccent ? 'text-white/70' : 'text-un1t-muted'

  async function download(att) {
    setBusy(att.id)
    setFailed(null)
    try {
      const res = await fetch(`/api/email/tickets/${ticketId}/attachments/${att.id}`)
      const j = await res.json()
      if (!res.ok || !j.success || !j.data?.url) {
        setFailed(j.error || 'That file could not be opened.')
        return
      }
      // noopener/noreferrer: the signed URL points at Supabase Storage, which
      // is a different origin, and the opened tab must not hold a handle back
      // to the CRM. It carries Content-Disposition: attachment, so this saves
      // the file rather than rendering it — which is what makes it the safe
      // fallback for every type that is not previewable.
      window.open(j.data.url, '_blank', 'noopener,noreferrer')
    } catch {
      setFailed('That file could not be opened.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map(att => {
        if (!att.stored) {
          return (
            <span
              key={att.id}
              className={`flex max-w-full items-center gap-1.5 rounded-lg border border-dashed px-2 py-1 text-[11px] ${
                onAccent ? 'border-white/30 text-white/80' : 'border-amber-500/60 text-amber-700'
              }`}
            >
              <FileWarning size={12} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{att.filename}</span>
              <span className={quiet}>{formatBytes(att.size_bytes)}</span>
              <span className="shrink-0">
                {SKIPPED_REASON_LABEL[att.skipped_reason] || 'Not stored'}
              </span>
            </span>
          )
        }
        return (
          <span
            key={att.id}
            className={`flex max-w-[15rem] items-center gap-1 rounded-lg border pl-2 pr-1 text-[11px] transition-colors ${chip}`}
          >
            <button
              type="button"
              onClick={() => onOpen?.(att)}
              title={`${att.filename} · ${formatBytes(att.size_bytes)}`}
              className="flex min-w-0 items-center gap-1.5 py-1 text-left"
            >
              <AttachmentIcon
                mimeType={att.mime_type}
                filename={att.filename}
                size={12}
                className="shrink-0"
                aria-hidden="true"
              />
              <span className="truncate">{att.filename}</span>
              <span className={`shrink-0 ${quiet}`}>{formatBytes(att.size_bytes)}</span>
            </button>
            <button
              type="button"
              onClick={() => download(att)}
              disabled={busy === att.id}
              aria-label={`Download ${att.filename}`}
              title="Download"
              className={`shrink-0 rounded p-1 disabled:opacity-60 ${onAccent ? 'hover:bg-white/20' : 'hover:bg-un1t-bg'}`}
            >
              <Download size={11} aria-hidden="true" />
            </button>
          </span>
        )
      })}
      {failed && (
        <p className={`w-full text-[11px] ${onAccent ? 'text-white/80' : 'text-red-700'}`} role="alert">
          {failed}
        </p>
      )}
    </div>
  )
}

/**
 * "Delivered" — the QUIET half of EMAIL-DELIVERY.1.
 *
 * It rides the meta line the bubble already has, in the same muted ramp, and
 * says one word. Confirming that the normal thing happened normally must never
 * compete for attention with the panel below, which is the whole reason this
 * feature exists. There is deliberately NO counterpart for a message with no
 * event yet: that renders as the bare "Sent to …" it always did.
 */
function DeliveredMarker({ message }) {
  const stamp = deliveryTimestamp(message)
  return (
    <span className="inline-flex items-center gap-0.5" title={stamp ? `Delivered ${stamp}` : 'Delivered'}>
      <Check size={11} className="shrink-0" aria-hidden="true" />
      Delivered
    </span>
  )
}

/**
 * The LOUD half. A failed reply gets its own panel OUTSIDE the bubble, full
 * width, in a colour nothing else in the thread uses.
 *
 * Why not a chip on the bubble: the bubble is a dark accent block whose whole
 * visual language says "we answered them". A small marker on it reads as
 * decoration on a message that looks handled. This breaks the rhythm of the
 * thread instead — which is the accurate signal, because the operator's mental
 * model ("I replied, that's done") is exactly what is wrong.
 *
 * Three lines, in the order an operator needs them: WHAT happened, WHAT TO DO,
 * and then the provider's own words — which is where "mailbox full" and "no
 * such address" actually differ, and why the raw text is shown rather than
 * summarised away.
 */
function DeliveryFailureNotice({ delivery, stamp }) {
  const alarm = delivery.tone === 'alarm'
  const Icon = alarm ? MailX : ShieldX
  const box = alarm
    ? 'border-red-500/60 bg-red-500/10 text-red-700'
    : 'border-amber-500/60 bg-amber-500/10 text-amber-700'

  return (
    <div className={`rounded-xl border px-4 py-3 ${box}`}>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
        <Icon size={12} className="shrink-0" aria-hidden="true" />
        {delivery.headline}
      </p>
      <p className="mt-1 text-xs">{delivery.advice}</p>
      {delivery.detail && (
        // The provider's exact words, not our paraphrase of them.
        <p className="mt-1.5 break-words text-[11px] opacity-90">{delivery.detail}</p>
      )}
      {stamp && <p className="mt-1.5 text-[11px] opacity-75">Reported {stamp}</p>}
    </div>
  )
}

/**
 * The To / Cc / Bcc lines under a message (EMAIL-CC.1).
 *
 * BCC IS VISUALLY SEPARATED, not just labelled. It is rendered with a lock and
 * the sentence "only staff on this ticket can see this" — because the whole
 * risk of showing it at all is someone reading a Bcc line as though the other
 * recipients could see it too. On the accent bubble the muted ramp is
 * unreadable, hence the two colour sets.
 */
function RecipientLines({ message, onAccent = false }) {
  const lines = messageRecipients(message)
  if (lines.length === 0) return null

  const label = onAccent ? 'text-white/60' : 'text-un1t-muted'
  const body = onAccent ? 'text-white/85' : 'text-un1t-subtle'

  return (
    <div className="mb-1 space-y-0.5">
      {lines.map(line => (
        <p key={line.key} className={`flex flex-wrap items-baseline gap-x-1.5 text-[11px] ${body}`}>
          <span className={`inline-flex items-center gap-1 font-medium uppercase tracking-wide ${label}`}>
            {line.staffOnly && <Lock size={9} className="shrink-0" aria-hidden="true" />}
            {line.label}
          </span>
          <span className="break-all">{line.addresses.join(', ')}</span>
          {line.note && <span className={label}>· {line.note}</span>}
        </p>
      ))}
    </div>
  )
}

/**
 * Claim / release / reassign (EMAIL-ASSIGN.1). The assignee list is fetched
 * lazily, once per ticket, and only for elevated viewers — it enumerates
 * colleagues' mailbox access, which the route 403s to everybody else.
 */
function AssignControl({ ticket, currentUserId, viewerIsElevated, onAssign, saving }) {
  const [assignees, setAssignees] = useState(null)
  const mine = !!currentUserId && ticket?.assigned_to === currentUserId
  const assigned = !!ticket?.assigned_to
  const ticketId = ticket?.id || null

  useEffect(() => {
    setAssignees(null)
    if (!viewerIsElevated || !ticketId) return undefined
    let cancelled = false
    fetch(`/api/email/tickets/${ticketId}/assignees`)
      .then(r => r.json())
      .then(j => { if (!cancelled && j?.success) setAssignees(j.data?.assignees || []) })
      // A failed lookup just hides the picker; claim/release still work.
      .catch(() => {})
    return () => { cancelled = true }
  }, [ticketId, viewerIsElevated])

  const btn = 'rounded-md border border-un1t-border px-2.5 py-1 text-xs text-un1t-subtle transition-colors hover:text-un1t-text disabled:opacity-50'

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {!assigned && (
        <button type="button" onClick={() => onAssign?.('me')} disabled={saving} className={btn}>
          Claim
        </button>
      )}
      {(mine || (assigned && viewerIsElevated)) && (
        <button type="button" onClick={() => onAssign?.(null)} disabled={saving} className={btn}>
          {mine ? 'Release' : 'Unassign'}
        </button>
      )}
      {viewerIsElevated && Array.isArray(assignees) && assignees.length > 0 && (
        <select
          aria-label="Assign to"
          value=""
          disabled={saving}
          onChange={(e) => { if (e.target.value) onAssign?.(e.target.value) }}
          className="rounded-md border border-un1t-border bg-un1t-bg px-2 py-1 text-xs text-un1t-subtle focus:outline-none"
        >
          <option value="">Assign to…</option>
          {assignees
            .filter(a => a.id !== ticket?.assigned_to)
            .map(a => (
              <option key={a.id} value={a.id}>{a.full_name || 'Unnamed'}</option>
            ))}
        </select>
      )}
    </div>
  )
}

/** The attachment list itself could not be loaded — say so, don't imply none. */
function AttachmentsUnavailableNotice() {
  return (
    <p className="flex items-center gap-1.5 border-t border-un1t-border bg-amber-500/10 px-4 py-2 text-xs text-amber-700">
      <FileWarning size={12} className="shrink-0" aria-hidden="true" />
      Attachments could not be loaded for this ticket. Messages sent with files may look as though
      they had none.
    </p>
  )
}

/**
 * "Forward" on one message (EMAIL-FORWARD.1).
 *
 * Per-message rather than one control on the thread, because a forward is OF a
 * message — a button at the bottom of the pane would have to ask "which one?",
 * and the answer to that is the click that just happened.
 *
 * NEVER RENDERED ON AN INTERNAL NOTE. canForwardMessage() says so and the
 * route refuses one anyway; the two are deliberately independent, because this
 * is the affordance and that is the gate.
 */
function ForwardAction({ message, onForward, onAccent = false }) {
  if (!onForward || !canForwardMessage(message)) return null
  return (
    <button
      type="button"
      onClick={() => onForward(message)}
      className={`inline-flex items-center gap-1 text-[11px] ${
        onAccent ? 'text-white/80 hover:text-white' : 'text-un1t-subtle hover:text-un1t-text'
      }`}
    >
      <Forward size={11} className="shrink-0" aria-hidden="true" />
      Forward
    </button>
  )
}

/** "Forwarded the message from …" — only on a message that IS a forward. */
function ForwardedMarker({ label, onAccent = false }) {
  if (!label) return null
  return (
    <p className={`mb-1 flex items-center gap-1.5 text-[11px] ${onAccent ? 'text-white/75' : 'text-un1t-muted'}`}>
      <Forward size={11} className="shrink-0" aria-hidden="true" />
      {label}
    </p>
  )
}

function ThreadMessage({ message, ticketId, onOpenAttachment, onForward, messagesById }) {
  const kind = messageKind(message)
  const stamp = messageTimestamp(message.sent_at || message.created_at)
  const body = message.text_body || '(no text content)'
  // Notes never take the HTML path, whatever the payload contains: the route
  // does not emit a document for them, and this guard says so twice.
  const html = kind === 'note' ? null : message.html_document || null
  const forwarded = forwardedMarker(message, messagesById)

  if (kind === 'note') {
    return (
      <div className="rounded-xl border border-dashed border-amber-500/60 bg-amber-500/10 px-4 py-3">
        <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
          <Lock size={12} className="shrink-0" aria-hidden="true" />
          Internal note — not sent to the member
        </p>
        <p className="whitespace-pre-wrap break-words text-sm text-un1t-text">{body}</p>
        <p className="mt-1.5 text-[11px] text-un1t-subtle">
          {/* Who left it. On a shared queue an anonymous note is a note you
              cannot ask anyone about. author_name is NULL for anything written
              before mig 493, so the address is still the fallback. */}
          {message.author_name
            ? `Note by ${message.author_name}`
            : (message.from_email || 'Staff')}
          {stamp && ` · ${stamp}`}
        </p>
      </div>
    )
  }

  if (kind === 'outbound') {
    // EMAIL-DELIVERY.1 — null for "sent, no event yet", which is most messages
    // and every message written before mig 498. Nothing is rendered for it.
    const delivery = deliveryMeta(message)
    return (
      <div className="space-y-1.5">
        <div className="flex justify-end">
          <div className={`rounded-2xl rounded-tr-sm bg-un1t-accent px-4 py-3 text-white ${html ? 'w-full' : 'max-w-[85%]'}`}>
            <p className="mb-1 flex items-center gap-1.5 text-[11px] text-white/75">
              <MailCheck size={12} className="shrink-0" aria-hidden="true" />
              Sent to {message.to_email || 'the member'}
              {message.author_name && ` · Replied by ${message.author_name}`}
              {stamp && ` · ${stamp}`}
              {delivery?.tone === 'quiet' && <>{' · '}<DeliveredMarker message={message} /></>}
            </p>
            {/* Above the recipients, because "this was a forward" changes how
                the To line reads: those addresses are a third party, not the
                member. */}
            <ForwardedMarker label={forwarded} onAccent />
            <RecipientLines message={message} onAccent />
            {html ? (
              <EmailFrame
                html={html}
                blockedImages={message.html_blocked_images}
                label={`Reply sent to ${message.to_email || 'the member'}`}
                onAccent
              />
            ) : (
              <p className="whitespace-pre-wrap break-words text-sm">{body}</p>
            )}
            {message.html_unsafe && <UnsafeHtmlNotice />}
            {message.html_omitted && <HtmlOmittedNotice />}
            <Attachments ticketId={ticketId} attachments={message.attachments} onOpen={onOpenAttachment} onAccent />
            <div className="mt-1.5">
              <ForwardAction message={message} onForward={onForward} onAccent />
            </div>
          </div>
        </div>
        {delivery && delivery.tone !== 'quiet' && (
          <DeliveryFailureNotice delivery={delivery} stamp={deliveryTimestamp(message)} />
        )}
      </div>
    )
  }

  return (
    <div className="flex justify-start">
      <div className={`rounded-2xl rounded-tl-sm border border-un1t-border bg-un1t-surface px-4 py-3 ${html ? 'w-full' : 'max-w-[85%]'}`}>
        <p className="mb-1 text-[11px] text-un1t-subtle">
          From {message.from_email || 'the member'}
          {stamp && ` · ${stamp}`}
        </p>
        {/* THE MEMBER'S OWN Cc. This is the point of capturing it inbound: a
            reply that reaches only the sender, when they copied two
            colleagues, drops those colleagues out of their own conversation. */}
        <RecipientLines message={message} />
        {html ? (
          <EmailFrame
            html={html}
            blockedImages={message.html_blocked_images}
            label={`Email from ${message.from_email || 'the member'}`}
          />
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm text-un1t-text">{body}</p>
        )}
        {message.html_unsafe && <UnsafeHtmlNotice />}
        {message.html_omitted && <HtmlOmittedNotice />}
        <Attachments ticketId={ticketId} attachments={message.attachments} onOpen={onOpenAttachment} />
        <div className="mt-1.5">
          <ForwardAction message={message} onForward={onForward} />
        </div>
      </div>
    </div>
  )
}
