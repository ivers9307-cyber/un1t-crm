'use client'

// EMAIL-TICKET.4 — the ticket inbox: the surface staff actually work the
// email queue from. Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
//
// Three panes: mailbox tabs across the top (the access model made visible),
// the queue on the left, the selected ticket's thread + composer on the right.
//
// WHAT THIS COMPONENT OWNS
// All the fetching and all the state. The three children below it are
// presentational — that keeps "which request am I making" in one file, which
// matters because the ?view= vocabulary is a wire contract (see
// lib/ticket-display.js) rather than free text.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   • No html_body. The thread renders text_body only — sanitised HTML is a
//     later plan and injecting raw email HTML is an XSS hole.
//   • No assignment picker. `assigned_to` is display-only here.
//   • No auto-close, anywhere, ever (Richard, 2026-08-06). A ticket leaves the
//     queue because a person put it there.

import { useCallback, useEffect, useState } from 'react'
import { Mail, RefreshCw, AlertCircle, Plus } from 'lucide-react'
import { EmptyState, Button } from '@/components/ui'
import {
  TICKET_VIEWS,
  DEFAULT_VIEW_ID,
  ticketView,
  buildTicketsUrl,
  mailboxLabel,
  NO_MAILBOX_EMPTY,
} from '@/lib/ticket-display'
import TicketList from './TicketList'
import TicketThread from './TicketThread'
import TicketCompose from './TicketCompose'

// Same cadence as the rest of the inbox family. Realtime is deliberately not
// wired here yet: the email tables' RESTRICTIVE-policy history (mig 485) means
// a listener that silently never fires is a real failure mode, and a poll that
// visibly works beats a subscription that quietly doesn't.
const POLL_MS = 60_000

export default function TicketInbox({ locationId, locationName, userId }) {
  const [mailboxes, setMailboxes] = useState([])
  const [tickets, setTickets] = useState([])
  const [loading, setLoading] = useState(true)
  const [queueError, setQueueError] = useState(null)

  const [mailboxId, setMailboxId] = useState(null)
  const [viewId, setViewId] = useState(DEFAULT_VIEW_ID)

  const [selectedId, setSelectedId] = useState(null)
  const [ticket, setTicket] = useState(null)
  const [messages, setMessages] = useState([])
  // EMAIL-ATTACH.1 — the route reports when its attachment query failed. The
  // thread is still complete; the file lists on it are not, and rendering that
  // silently as "no attachments" is the one wrong answer a support queue must
  // never give.
  const [attachmentsUnavailable, setAttachmentsUnavailable] = useState(false)
  // EMAIL-CC.1 — { to, mode } as the SERVER derived it (or null). Held here
  // rather than worked out from `messages` on purpose: the composer's label
  // and the reply route's actual recipients must come from one computation,
  // or a thread whose last message carried a Bcc could be labelled one way
  // and sent another.
  const [replyRecipients, setReplyRecipients] = useState(null)
  const [threadLoading, setThreadLoading] = useState(false)
  const [threadError, setThreadError] = useState(null)
  const [sending, setSending] = useState(false)
  const [statusSaving, setStatusSaving] = useState(false)

  // EMAIL-TICKET.5 — starting a conversation rather than answering one.
  const [composeOpen, setComposeOpen] = useState(false)

  const view = ticketView(viewId)
  const queueUrl = buildTicketsUrl({ locationId, mailboxId, viewId })

  // ── Queue ──────────────────────────────────────────────────────────
  const loadQueue = useCallback(async (quiet = false) => {
    if (!locationId) { setLoading(false); return }
    if (!quiet) setLoading(true)
    try {
      const res = await fetch(queueUrl, { cache: 'no-store' })
      const body = await res.json()
      if (!body?.success) {
        setQueueError(body?.error || 'Could not load the queue')
        return
      }
      setQueueError(null)
      setMailboxes(body.data?.mailboxes || [])
      setTickets(body.data?.tickets || [])
    } catch {
      // Transient — keep the last good queue on screen rather than blanking
      // it, and say so instead of showing a stale list as if it were fresh.
      setQueueError('Could not reach the server — showing the last loaded queue')
    } finally {
      setLoading(false)
    }
  }, [locationId, queueUrl])

  useEffect(() => { loadQueue() }, [loadQueue])

  useEffect(() => {
    const timer = setInterval(() => loadQueue(true), POLL_MS)
    const onFocus = () => loadQueue(true)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [loadQueue])

  // ── Thread ─────────────────────────────────────────────────────────
  const loadThread = useCallback(async (id) => {
    if (!id) return
    setThreadLoading(true)
    setThreadError(null)
    try {
      const res = await fetch(`/api/email/tickets/${id}`, { cache: 'no-store' })
      const body = await res.json()
      if (!body?.success) {
        setThreadError(body?.error || 'Could not load this ticket')
        return
      }
      setTicket(body.data?.ticket || null)
      setMessages(body.data?.messages || [])
      setAttachmentsUnavailable(!!body.data?.attachments_unavailable)
      setReplyRecipients(body.data?.reply_recipients || null)
    } catch {
      setThreadError('Could not load this ticket')
    } finally {
      setThreadLoading(false)
    }
  }, [])

  useEffect(() => { if (selectedId) loadThread(selectedId) }, [selectedId, loadThread])

  // Marking read is its own endpoint, not a side effect of the GET — so it is
  // explicit and idempotent. Failure is harmless: the badge just stays.
  const markRead = useCallback(async (id) => {
    try {
      const res = await fetch(`/api/email/tickets/${id}/read`, { method: 'POST' })
      const body = await res.json()
      if (!body?.success) return
      setTickets(prev => prev.map(t => (t.id === id ? { ...t, unread_count: 0 } : t)))
    } catch { /* the unread badge clears on the next load */ }
  }, [])

  function selectTicket(row) {
    if (!row?.id) return
    setSelectedId(row.id)
    // Paint the header from the list row immediately; loadThread replaces it
    // with the full record (mailbox + linked contact) a moment later.
    setTicket(row)
    setMessages([])
    setAttachmentsUnavailable(false)
    // The previous ticket's participants must not survive the switch, even for
    // the moment before loadThread answers — a Reply button briefly naming
    // somebody else's colleagues is a click away from being right.
    setReplyRecipients(null)
    setThreadError(null)
    if (row.unread_count > 0) markRead(row.id)
  }

  // Switching tab or view changes what the left pane means, so an open thread
  // from the previous scope would be stranded context. Clear it.
  function changeMailbox(id) {
    setMailboxId(id)
    clearSelection()
  }
  function changeView(id) {
    setViewId(id)
    clearSelection()
  }
  function clearSelection() {
    setSelectedId(null)
    setTicket(null)
    setMessages([])
    setAttachmentsUnavailable(false)
    // A stale set from the previous ticket would label the next one's Reply
    // button with the wrong people. Null degrades to "reply to the requester".
    setReplyRecipients(null)
    setThreadError(null)
  }

  // ── Actions ────────────────────────────────────────────────────────
  // `recipients` are the people the operator ADDED — the thread's own
  // participants are derived server-side and are always included, so there is
  // nothing to send for them and no wire format for removing one (EMAIL-CC.1).
  // A note carries none: the route refuses one that does.
  async function handleSend(text, internal, recipients) {
    if (!selectedId || sending) return { ok: false }
    setSending(true)
    setThreadError(null)
    try {
      const res = await fetch(`/api/email/tickets/${selectedId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(internal ? { text, internal: true } : {
          text,
          to: recipients?.to || [],
          cc: recipients?.cc || [],
          bcc: recipients?.bcc || [],
        }),
      })
      const body = await res.json()
      if (!body?.success) {
        setThreadError(body?.error || 'Could not send that')
        return { ok: false }
      }
      await loadThread(selectedId)
      // A note changes nothing about the queue row (deliberately — a note must
      // not re-describe the ticket or bump it up the list), so only a real
      // reply needs the queue refetched.
      if (!internal) await loadQueue(true)
      return { ok: true }
    } catch {
      setThreadError('Could not send that — check your connection and try again')
      return { ok: false }
    } finally {
      setSending(false)
    }
  }

  async function handleStatus(status) {
    if (!selectedId || statusSaving) return
    setStatusSaving(true)
    setThreadError(null)
    try {
      const res = await fetch(`/api/email/tickets/${selectedId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      const body = await res.json()
      if (!body?.success) {
        setThreadError(body?.error || 'Could not change the status')
        return
      }
      const updated = body.data?.ticket
      if (updated) {
        // Spread the server row OVER the local one: it carries the new status
        // and stamps but not the mailbox/contact the detail route added, so
        // ordering matters here.
        setTicket(prev => (prev ? { ...prev, ...updated } : updated))
        setTickets(prev => prev.map(t => (t.id === updated.id ? { ...t, ...updated } : t)))
      }
      // The row may now fall outside the current view — refetch so the queue
      // tells the truth. The thread stays open regardless.
      await loadQueue(true)
    } catch {
      setThreadError('Could not change the status — check your connection and try again')
    } finally {
      setStatusSaving(false)
    }
  }

  // A composed email IS a ticket, so there is nothing special to do with it:
  // close, refetch the queue so the new row is really there, and open it the
  // same way a click on the list would. The server row is what we select from
  // — it carries the id, the mailbox and the linked contact.
  function handleComposed(newTicket) {
    setComposeOpen(false)
    loadQueue(true)
    if (newTicket?.id) selectTicket(newTicket)
  }

  // ── Render ─────────────────────────────────────────────────────────
  const shellClasses =
    'flex flex-col h-[calc(100vh-13rem)] min-h-[32rem] rounded-xl border border-un1t-border bg-un1t-bg overflow-hidden'

  if (!locationId) {
    return (
      <div className={shellClasses}>
        <EmptyState
          icon={<Mail size={28} />}
          title="No studio selected"
          description="Pick a location in the sidebar to see its email tickets."
        />
      </div>
    )
  }

  // A failed first load leaves us with zero mailboxes for a reason that has
  // nothing to do with access — say THAT, rather than telling an operator
  // their studio has no email accounts because a fetch blipped.
  if (!loading && queueError && mailboxes.length === 0) {
    return (
      <div className={shellClasses}>
        <EmptyState
          icon={<AlertCircle size={28} />}
          title="Could not load the ticket inbox"
          description={queueError}
          action={
            <button
              type="button"
              onClick={() => loadQueue()}
              className="inline-flex items-center gap-1.5 rounded-md border border-un1t-border px-2.5 py-1.5 text-xs text-un1t-subtle hover:text-un1t-text transition-colors"
            >
              <RefreshCw size={13} />
              Try again
            </button>
          }
        />
      </div>
    )
  }

  // No visible mailboxes is a normal state, not an error — and it is a
  // different situation from an empty queue, so it gets its own copy.
  if (!loading && mailboxes.length === 0) {
    return (
      <div className={shellClasses}>
        <EmptyState
          icon={<Mail size={28} />}
          title={NO_MAILBOX_EMPTY.title}
          description={NO_MAILBOX_EMPTY.description}
        />
      </div>
    )
  }

  const mailboxById = Object.fromEntries(mailboxes.map(m => [m.id, m]))
  const showMailboxOnRows = mailboxes.length > 1

  return (
    <div className={shellClasses}>
      {/* Toolbar — mailbox tabs (only when there is a real choice to make;
          a single tab is noise) + the queue's scope and a manual refresh. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-un1t-border px-3 py-2">
        {mailboxes.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Email accounts">
            <TabPill
              active={mailboxId === null}
              onClick={() => changeMailbox(null)}
              label="All accounts"
            />
            {mailboxes.map(m => (
              <TabPill
                key={m.id}
                active={mailboxId === m.id}
                onClick={() => changeMailbox(m.id)}
                label={mailboxLabel(m)}
                title={m.address}
              />
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm min-w-0">
            <Mail size={15} className="shrink-0 text-channel-em" />
            <span className="font-medium text-un1t-text truncate">
              {mailboxes[0] ? mailboxLabel(mailboxes[0]) : 'Email'}
            </span>
            {mailboxes[0]?.address && (
              <span className="text-xs text-un1t-muted truncate hidden sm:inline">
                {mailboxes[0].address}
              </span>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          {/* Starting a conversation, not answering one — the one action here
              that does not need a ticket selected first. */}
          <Button type="button" size="sm" variant="secondary" icon={Plus} onClick={() => setComposeOpen(true)}>
            New email
          </Button>
          <button
            type="button"
            onClick={() => loadQueue()}
            className="inline-flex items-center gap-1.5 rounded-md border border-un1t-border px-2 py-1 text-xs text-un1t-subtle hover:text-un1t-text transition-colors"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
            Refresh
          </button>
        </div>
      </div>

      {/* View filters. `closed` is the wire word for the solved+closed
          archive — the label stays human. */}
      <div className="flex flex-wrap items-center gap-1 border-b border-un1t-border px-3 py-2">
        {TICKET_VIEWS.map(v => (
          <TabPill
            key={v.id}
            active={viewId === v.id}
            onClick={() => changeView(v.id)}
            label={v.label}
            title={v.hint}
          />
        ))}
      </div>

      {queueError && (
        <p
          className="flex items-center gap-1.5 border-b border-un1t-border bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700"
          role="status"
        >
          <AlertCircle size={12} className="shrink-0" />
          {queueError}
        </p>
      )}

      <div className="flex flex-1 min-h-0">
        <div
          className={`${selectedId ? 'hidden md:flex' : 'flex'} w-full flex-col border-r border-un1t-border md:w-[22rem] lg:w-[24rem] shrink-0`}
        >
          <TicketList
            tickets={tickets}
            loading={loading}
            selectedId={selectedId}
            onSelect={selectTicket}
            view={view}
            locationName={locationName}
            showMailbox={showMailboxOnRows}
            mailboxById={mailboxById}
          />
        </div>

        <div className={`${selectedId ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
          <TicketThread
            hasSelection={!!selectedId}
            ticket={ticket}
            messages={messages}
            attachmentsUnavailable={attachmentsUnavailable}
            replyRecipients={replyRecipients}
            loading={threadLoading}
            error={threadError}
            currentUserId={userId}
            onBack={clearSelection}
            onStatusChange={handleStatus}
            statusSaving={statusSaving}
            onSend={handleSend}
            sending={sending}
          />
        </div>
      </div>

      {/* Mounted only while open, so a fresh compose never inherits the last
          one's draft AND the 60s poll re-creating `mailboxes` cannot reset a
          half-typed email. The Modal renders fixed to the viewport — the
          shell's overflow-hidden does not clip it, since nothing here creates
          a containing block for fixed positioning. */}
      {composeOpen && (
        <TicketCompose
          mailboxes={mailboxes}
          initialMailboxId={mailboxId}
          onClose={() => setComposeOpen(false)}
          onSent={handleComposed}
        />
      )}
    </div>
  )
}

// Shared pill for both strips. type="button" is not optional — these sit
// inside a page that also renders forms, and a bare <button> defaults to
// submit (CLAUDE.md).
function TabPill({ active, onClick, label, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active
          ? 'border-transparent bg-un1t-text font-medium text-un1t-bg'
          : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
      }`}
    >
      {label}
    </button>
  )
}
