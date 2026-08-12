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
//   • Assignment is claim/release for everyone and reassign for elevated
//     viewers (EMAIL-ASSIGN.1) — the picker lives in TicketThread.
//   • No auto-close, anywhere, ever (Richard, 2026-08-06). A ticket leaves the
//     queue because a person put it there.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Mail, RefreshCw, AlertCircle, Plus } from 'lucide-react'
import { EmptyState, Button } from '@/components/ui'
import {
  TICKET_VIEWS,
  DEFAULT_VIEW_ID,
  ticketView,
  buildTicketsUrl,
  mailboxLabel,
  NO_MAILBOX_EMPTY,
  threadRefreshMs,
} from '@/lib/ticket-display'
import TicketList from './TicketList'
import TicketThread from './TicketThread'
import TicketCompose from './TicketCompose'
import TicketForward from './TicketForward'

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
  const [assignSaving, setAssignSaving] = useState(false)
  // EMAIL-PARTICIPANTS.7 — a removal is in flight. Re-entrancy guard only (see
  // handleRemoveRecipient): the column is read-modify-written server-side.
  const [participantSaving, setParticipantSaving] = useState(false)
  // EMAIL-ASSIGN.1 — whether the viewer may reassign; the queue route says.
  const [viewerIsElevated, setViewerIsElevated] = useState(false)

  // EMAIL-TICKET.5 — starting a conversation rather than answering one.
  const [composeOpen, setComposeOpen] = useState(false)
  // EMAIL-FORWARD.1 — the ONE message being forwarded, or null. Held here
  // rather than in the thread because the composer is a modal over the whole
  // surface, and because closing it has to be able to re-read the thread.
  const [forwarding, setForwarding] = useState(null)

  const view = ticketView(viewId)
  const queueUrl = buildTicketsUrl({ locationId, mailboxId, viewId })

  // TICKET-FETCH-RACE.1 — which request each pane currently belongs to (the
  // AttachmentPreview requestFor idiom). Fetched responses apply only while
  // they are still the one the operator is looking at: a slow read for the
  // previous ticket or the previous view landing late must not overwrite the
  // pane — the thread would caption the WRONG selectedId, and handleSend posts
  // to selectedId. Pinned in TicketInbox.race.test.jsx.
  const queueRequest = useRef(null)
  const threadFor = useRef(null)

  // ── Queue ──────────────────────────────────────────────────────────
  const loadQueue = useCallback(async (quiet = false) => {
    if (!locationId) { setLoading(false); return }
    const url = queueUrl
    queueRequest.current = url
    if (!quiet) setLoading(true)
    try {
      const res = await fetch(url, { cache: 'no-store' })
      const body = await res.json()
      if (queueRequest.current !== url) return // superseded — a newer scope owns the list
      if (!body?.success) {
        setQueueError(body?.error || 'Could not load the queue')
        return
      }
      setQueueError(null)
      setMailboxes(body.data?.mailboxes || [])
      setTickets(body.data?.tickets || [])
      setViewerIsElevated(!!body.data?.viewer_is_elevated)
    } catch {
      if (queueRequest.current !== url) return
      // Transient — keep the last good queue on screen rather than blanking
      // it, and say so instead of showing a stale list as if it were fresh.
      setQueueError('Could not reach the server — showing the last loaded queue')
    } finally {
      // A superseded request must not clear the spinner either: the newer
      // request set it, and only that request knows when it is done.
      if (queueRequest.current === url) setLoading(false)
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
  // `quiet` is a re-read of a thread already on screen (the poll below), as
  // opposed to opening one. It shows no spinner and, crucially, PAINTS NO
  // ERROR: a blip on a background read must not replace correspondence the
  // operator is in the middle of with a failure message. The thread they have
  // is still true — it is just a few seconds old — and the next read fixes it.
  const loadThread = useCallback(async (id, { quiet = false } = {}) => {
    if (!id) return
    if (!quiet) {
      setThreadLoading(true)
      setThreadError(null)
    }
    try {
      const res = await fetch(`/api/email/tickets/${id}`, { cache: 'no-store' })
      const body = await res.json()
      if (threadFor.current !== id) return // superseded — the operator switched tickets
      if (!body?.success) {
        if (!quiet) setThreadError(body?.error || 'Could not load this ticket')
        return
      }
      setTicket(body.data?.ticket || null)
      setMessages(body.data?.messages || [])
      setAttachmentsUnavailable(!!body.data?.attachments_unavailable)
      setReplyRecipients(body.data?.reply_recipients || null)
    } catch {
      if (threadFor.current !== id) return
      if (!quiet) setThreadError('Could not load this ticket')
    } finally {
      // The stale request's spinner-clear is skipped too — the selection that
      // superseded it set the spinner, and its own read clears it.
      if (!quiet && threadFor.current === id) setThreadLoading(false)
    }
  }, [])

  useEffect(() => { if (selectedId) loadThread(selectedId) }, [selectedId, loadThread])

  // EMAIL-ATTACH-RACE.1 — an open thread re-reads itself.
  //
  // Until now it was fetched once per selection and never again, so anything
  // written after that read stayed invisible until the operator reloaded the
  // page. The inbound webhook writes email_ticket_attachments AFTER the message
  // row it hangs off (FK, and attachment work must never delay filing the
  // mail), so a ticket opened inside that window rendered a member's photo as
  // no attachment at all — live, 2026-08-07. A skipped file is written in the
  // same place and was equally invisible, which is worse: it has a reason to
  // show and showed nothing.
  //
  // Deliberately a re-read rather than a realtime subscription. Nothing on this
  // surface subscribes today (see POLL_MS above — mig 485's silently-dead
  // listeners are why), and a push-based fix would have to survive the webhook
  // successfully poking it AFTER the attachments land; if that step failed, the
  // operator would be back to a frozen thread with no way out but a reload.
  // This has no such step.
  //
  // The cadence is computed from the thread itself: fast while its newest
  // message is young enough that rows may still be arriving, the queue's own
  // 60s otherwise. It is a primitive, so a poll that changes nothing does not
  // restart the interval.
  const threadPollMs = threadRefreshMs(messages)
  useEffect(() => {
    if (!selectedId) return undefined
    const timer = setInterval(() => loadThread(selectedId, { quiet: true }), threadPollMs)
    const onFocus = () => loadThread(selectedId, { quiet: true })
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [selectedId, threadPollMs, loadThread])

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
    threadFor.current = row.id
    setSelectedId(row.id)
    // A forward composer left open across a ticket switch would be holding a
    // message from the ticket you just left — one click from sending somebody
    // else's correspondence to the address you were about to type.
    setForwarding(null)
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
    // Invalidates any in-flight thread read as well — with no selection there
    // is nothing a late response could honestly be applied to.
    threadFor.current = null
    setSelectedId(null)
    setTicket(null)
    setMessages([])
    setAttachmentsUnavailable(false)
    setForwarding(null)
    // A stale set from the previous ticket would label the next one's Reply
    // button with the wrong people. Null degrades to "reply to the requester".
    setReplyRecipients(null)
    setThreadError(null)
  }

  // ── Actions ────────────────────────────────────────────────────────
  // `extras.recipients` are the people the operator ADDED — the thread's own
  // participants are derived server-side and are always included, so there is
  // nothing to send for them and no wire format for removing one (EMAIL-CC.1).
  //
  // `extras.attachments` is a list of REFERENCES to files the composer already
  // uploaded straight to Storage, never bytes: a multipart body over ~4.5 MB is
  // rejected by the platform before the route runs (EMAIL-OUTBOUND-ATTACH.1).
  // The key is OMITTED (not sent empty) when there are none, so a reply without
  // files is byte-identical to every reply sent before that shipped.
  //
  // A note carries neither: the route refuses one that does.
  async function handleSend(text, internal, extras = {}) {
    const { recipients, attachments = [] } = extras
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
          ...(attachments.length ? { attachments } : {}),
        }),
      })
      const body = await res.json()
      if (!body?.success) {
        setThreadError(body?.error || 'Could not send that')
        // EMAIL-REPLY-UNFILED.1 — `data.sent` on a failure body is the route
        // saying the reply IS with the member and only the filing failed. The
        // server best-effort-advanced the ticket, so refresh rather than leave
        // a queue row inviting the second send — QUIETLY, because a refresh
        // hiccup repainting the banner as "could not load" would bury the one
        // sentence that stops the resend. `sent` rides on the result so the
        // composer keeps the draft: at this point it is the only surviving
        // copy of what the member received.
        if (body?.data?.sent) {
          await loadThread(selectedId, { quiet: true })
          await loadQueue(true)
          return { ok: false, sent: true }
        }
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

  // EMAIL-ASSIGN.1 — claim ('me'), release (null) or reassign (profile id).
  // Same merge discipline as handleStatus: spread the server row OVER the
  // local one (it lacks the mailbox/contact the detail route added), then
  // refetch the queue — the row may have just left or entered 'mine'.
  async function handleAssign(assignee) {
    if (!selectedId || assignSaving) return
    // TICKET-FETCH-RACE.1's rule extends to action responses: if the operator
    // switches tickets while this POST is in flight, ticket A's row must not
    // paint over ticket B's thread (review finding 3).
    const id = selectedId
    setAssignSaving(true)
    setThreadError(null)
    try {
      const res = await fetch(`/api/email/tickets/${selectedId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignee }),
      })
      const body = await res.json()
      if (threadFor.current !== id) return // superseded — the operator switched tickets
      if (!body?.success) {
        const friendly = {
          already_assigned: 'Somebody claimed this ticket just now — refresh to see who',
          assignee_cannot_see: 'That person cannot see this mailbox — grant them access first',
          not_yours: 'This ticket is assigned to somebody else',
          not_elevated: 'Only an owner can reassign tickets',
        }
        setThreadError(friendly[body?.error] || body?.error || 'Could not change the assignee')
        return
      }
      const updated = body.data?.ticket
      if (updated) {
        const withName = { ...updated, assignee_name: body.data?.assignee_name ?? null }
        setTicket(prev => (prev ? { ...prev, ...withName } : withName))
        setTickets(prev => prev.map(t => (t.id === updated.id ? { ...t, ...withName } : t)))
      }
      await loadQueue(true)
    } catch {
      if (threadFor.current === id) {
        setThreadError('Could not change the assignee — check your connection and try again')
      }
    } finally {
      setAssignSaving(false)
    }
  }

  async function handleStatus(status) {
    if (!selectedId || statusSaving) return
    const id = selectedId // guard stale responses across a ticket switch
    setStatusSaving(true)
    setThreadError(null)
    try {
      const res = await fetch(`/api/email/tickets/${selectedId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      const body = await res.json()
      if (threadFor.current !== id) return // superseded — the operator switched tickets
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

  // EMAIL-PARTICIPANTS.7 — take ONE address off this ticket's reply audience.
  //
  // Lives here, with the other mutations, because the removal is only half the
  // work: the audience itself is never stored — resolveReplyAudience() derives
  // it from the thread on every read and subtracts the operator's exclusions —
  // so the chips tell the truth only after the ticket is re-read. Editing a
  // local copy of replyRecipients instead would be a second implementation of a
  // derivation the whole programme exists to keep singular.
  //
  // ON FAILURE THE CHIP STAYS. The write did not land, so that address is still
  // exactly who the next reply reaches; a chip that vanished anyway would be a
  // lie about the audience, which is the failure this feature is meant to end.
  // Nothing here is optimistic for that reason, and the banner says what
  // happened in the same place a failed status change or assignment does.
  async function handleRemoveRecipient(address) {
    if (!selectedId || !address || participantSaving) return
    const id = selectedId // guard stale responses across a ticket switch
    // Serialised deliberately: the route read-modify-writes
    // excluded_participants, so two removals in flight together would leave
    // whichever landed second having overwritten the first — one address
    // silently back on the audience. A dropped second click leaves its chip on
    // screen, which is the honest half of that trade.
    setParticipantSaving(true)
    setThreadError(null)
    try {
      const res = await fetch(`/api/email/tickets/${id}/participants`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remove: [address] }),
      })
      const body = await res.json()
      if (threadFor.current !== id) return // superseded — the operator switched tickets
      if (!body?.success) {
        setThreadError(body?.error || `Could not take ${address} off this reply`)
        return
      }
      await loadThread(id)
    } catch {
      if (threadFor.current === id) {
        setThreadError(`Could not take ${address} off this reply — check your connection and try again`)
      }
    } finally {
      setParticipantSaving(false)
    }
  }

  // A forward is an outbound message on THIS ticket, so the thread re-read is
  // all that is needed — and it is all that is done. The QUEUE is deliberately
  // not refetched, because the route deliberately does not touch the ticket:
  // forwarding a member's question to the accountant is not answering the
  // member, so the row must keep saying they are waiting (EMAIL-FORWARD.1).
  async function handleForwarded() {
    setForwarding(null)
    await loadThread(selectedId)
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
            currentUserId={userId}
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
            onAssign={handleAssign}
            assignSaving={assignSaving}
            viewerIsElevated={viewerIsElevated}
            onSend={handleSend}
            sending={sending}
            onRemoveRecipient={handleRemoveRecipient}
            onForward={setForwarding}
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
          // EMAIL-COMPOSE-UNFILED.1 — the email went out but filing failed.
          // The modal stays open (draft + "Do not resend" copy); this only
          // refetches the queue quietly, so a ticket row that WAS created
          // appears behind it instead of looking like nothing happened.
          onSentUnfiled={() => loadQueue(true)}
        />
      )}

      {/* Mounted only while forwarding, for the same reason compose is: a
          half-typed forward must not survive the thread's background re-read,
          and a fresh one must not inherit the last one's recipients. */}
      {forwarding && ticket && (
        <TicketForward
          ticket={ticket}
          message={forwarding}
          onClose={() => setForwarding(null)}
          onSent={handleForwarded}
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
