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
// call; this file only paints it.
//
// text_body ONLY — html_body is never fetched and never injected.

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { ArrowLeft, Lock, Mail, AlertCircle, MailCheck } from 'lucide-react'
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

function ThreadMessage({ message }) {
  const kind = messageKind(message)
  const stamp = messageTimestamp(message.sent_at || message.created_at)
  // text_body only. html_body is not fetched by the API and must never be
  // injected here — sanitised HTML rendering is a separate, later plan.
  const body = message.text_body || '(no text content)'

  if (kind === 'note') {
    return (
      <div className="rounded-xl border border-dashed border-amber-500/60 bg-amber-500/10 px-4 py-3">
        <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
          <Lock size={12} className="shrink-0" aria-hidden="true" />
          Internal note — not sent to the member
        </p>
        <p className="whitespace-pre-wrap break-words text-sm text-un1t-text">{body}</p>
        <p className="mt-1.5 text-[11px] text-un1t-subtle">
          {message.from_email || 'Staff'}
          {stamp && ` · ${stamp}`}
        </p>
      </div>
    )
  }

  if (kind === 'outbound') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-un1t-accent px-4 py-3 text-white">
          <p className="mb-1 flex items-center gap-1.5 text-[11px] text-white/75">
            <MailCheck size={12} className="shrink-0" aria-hidden="true" />
            Sent to {message.to_email || 'the member'}
            {stamp && ` · ${stamp}`}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">{body}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-un1t-border bg-un1t-surface px-4 py-3">
        <p className="mb-1 text-[11px] text-un1t-subtle">
          From {message.from_email || 'the member'}
          {stamp && ` · ${stamp}`}
        </p>
        <p className="whitespace-pre-wrap break-words text-sm text-un1t-text">{body}</p>
      </div>
    </div>
  )
}
