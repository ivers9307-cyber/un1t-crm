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

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Lock, Mail, AlertCircle, MailCheck, ImageOff, Maximize2, Minimize2, ShieldAlert } from 'lucide-react'
import { EmptyState, Loading } from '@/components/ui'
import {
  requesterLabel,
  initialsOf,
  statusMeta,
  priorityMeta,
  STATUS_ORDER,
  messageKind,
  messageTimestamp,
  assigneeLabel,
  mailboxLabel,
} from '@/lib/ticket-display'
import TicketReplyBox from './TicketReplyBox'

export default function TicketThread({
  hasSelection,
  ticket,
  messages = [],
  loading = false,
  error,
  currentUserId,
  onBack,
  onStatusChange,
  statusSaving = false,
  onSend,
  sending = false,
}) {
  const endRef = useRef(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [messages])

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
          messages.map(m => <ThreadMessage key={m.id} message={m} />)
        )}
        <div ref={endRef} />
      </div>

      {error && (
        <p
          className="flex items-center gap-1.5 border-t border-un1t-border bg-red-500/10 px-4 py-2 text-xs text-red-700"
          role="alert"
        >
          <AlertCircle size={12} className="shrink-0" />
          {error}
        </p>
      )}

      <TicketReplyBox ticket={ticket} onSend={onSend} sending={sending} />
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

function ThreadMessage({ message }) {
  const kind = messageKind(message)
  const stamp = messageTimestamp(message.sent_at || message.created_at)
  const body = message.text_body || '(no text content)'
  // Notes never take the HTML path, whatever the payload contains: the route
  // does not emit a document for them, and this guard says so twice.
  const html = kind === 'note' ? null : message.html_document || null

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
    return (
      <div className="flex justify-end">
        <div className={`rounded-2xl rounded-tr-sm bg-un1t-accent px-4 py-3 text-white ${html ? 'w-full' : 'max-w-[85%]'}`}>
          <p className="mb-1 flex items-center gap-1.5 text-[11px] text-white/75">
            <MailCheck size={12} className="shrink-0" aria-hidden="true" />
            Sent to {message.to_email || 'the member'}
            {message.author_name && ` · Replied by ${message.author_name}`}
            {stamp && ` · ${stamp}`}
          </p>
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
        </div>
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
      </div>
    </div>
  )
}
