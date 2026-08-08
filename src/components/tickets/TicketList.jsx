'use client'

// EMAIL-TICKET.4 — the queue pane.
//
// One row per ticket: who wrote in, what about, the last thing said, how long
// it has been sitting, and whether anything on it is unread. When the operator
// can see more than one account, the row also says WHICH address it arrived
// at — otherwise a billing query and a sales enquiry look identical in a
// merged "All accounts" list.
//
// Presentational: every action is a callback up to TicketInbox.

import { Inbox } from 'lucide-react'
import { EmptyState, Loading } from '@/components/ui'
import {
  requesterLabel,
  initialsOf,
  relativeTime,
  statusMeta,
  priorityMeta,
  mailboxLabel,
} from '@/lib/ticket-display'

export default function TicketList({
  tickets = [],
  loading = false,
  selectedId,
  onSelect,
  view,
  locationName,
  showMailbox = false,
  mailboxById = {},
  // EMAIL-ASSIGN.1 — lets a row say 'You' instead of the viewer's own name.
  currentUserId,
}) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-2 border-b border-un1t-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-un1t-subtle">
          {view?.label || 'Tickets'}
          {tickets.length > 0 && (
            <span className="ml-1.5 font-normal text-un1t-muted">{tickets.length}</span>
          )}
        </span>
        {locationName && (
          <span className="truncate text-[11px] text-un1t-muted">{locationName}</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && tickets.length === 0 ? (
          <Loading label="Loading tickets…" />
        ) : tickets.length === 0 ? (
          <EmptyState
            icon={<Inbox size={26} />}
            title={view?.emptyTitle || 'Nothing here'}
            description={view?.emptyDescription}
            padding="md"
          />
        ) : (
          <ul>
            {tickets.map(t => (
              <li key={t.id}>
                <TicketRow
                  ticket={t}
                  selected={selectedId === t.id}
                  onSelect={onSelect}
                  showMailbox={showMailbox}
                  mailbox={mailboxById[t.mailbox_id] || null}
                  currentUserId={currentUserId}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

function TicketRow({ ticket, selected, onSelect, showMailbox, mailbox, currentUserId }) {
  const name = requesterLabel(ticket)
  const unread = ticket.unread_count > 0
  const status = statusMeta(ticket.status)
  const priority = priorityMeta(ticket.priority)
  // The live queue is overwhelmingly `open`, so chipping every row with it
  // would be noise — only the states that change what you do get a chip.
  const showStatus = ticket.status !== 'open'

  return (
    <button
      type="button"
      onClick={() => onSelect(ticket)}
      aria-current={selected ? 'true' : undefined}
      className={`w-full border-b border-un1t-border/60 px-3 py-3 text-left transition-colors hover:bg-un1t-surface ${
        selected ? 'bg-un1t-surface' : ''
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${unread ? 'bg-channel-em' : 'bg-transparent'}`}
          aria-hidden="true"
        />
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border border-un1t-border bg-un1t-surface text-[11px] font-semibold text-un1t-text">
          {initialsOf(name)}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={`truncate text-sm ${unread ? 'font-semibold text-un1t-text' : 'font-medium text-un1t-text'}`}>
              {name}
            </span>
            <span className="shrink-0 text-[11px] text-un1t-muted">
              {relativeTime(ticket.last_message_at || ticket.created_at)}
            </span>
          </span>

          <span className="mt-0.5 block truncate text-xs text-un1t-text">
            {ticket.subject || '(no subject)'}
          </span>

          <span className="mt-0.5 block truncate text-xs text-un1t-subtle">
            {ticket.last_message_direction === 'outbound' && (
              <span className="text-un1t-muted">You: </span>
            )}
            {ticket.last_message_preview || '—'}
          </span>

          {(showMailbox || showStatus || priority || unread || ticket.assigned_to) && (
            <span className="mt-1.5 flex flex-wrap items-center gap-1">
              {ticket.assigned_to && (
                <span className="rounded-full bg-un1t-surface px-1.5 py-0.5 text-[10px] text-un1t-subtle ring-1 ring-inset ring-un1t-border">
                  {currentUserId && ticket.assigned_to === currentUserId
                    ? 'You'
                    : (ticket.assignee_name || 'Assigned')}
                </span>
              )}
              {showMailbox && (
                <span
                  className="rounded-full bg-un1t-surface px-1.5 py-0.5 text-[10px] text-un1t-subtle ring-1 ring-inset ring-un1t-border"
                  title={mailbox?.address || 'No mailbox on this ticket'}
                >
                  {mailboxLabel(mailbox)}
                </span>
              )}
              {showStatus && (
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${status.chip}`}>
                  {status.label}
                </span>
              )}
              {priority && (
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${priority.chip}`}>
                  {priority.label}
                </span>
              )}
              {unread && (
                <span className="ml-auto inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-channel-em px-1 text-[10px] font-semibold text-white">
                  {ticket.unread_count > 99 ? '99+' : ticket.unread_count}
                </span>
              )}
            </span>
          )}
        </span>
      </div>
    </button>
  )
}
