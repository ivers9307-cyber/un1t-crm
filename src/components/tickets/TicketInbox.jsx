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
import Link from 'next/link'
import { Mail, RefreshCw, AlertCircle, Plus } from 'lucide-react'
import { EmptyState, Button } from '@/components/ui'
import {
  TICKET_VIEWS,
  DEFAULT_VIEW_ID,
  ticketView,
  buildTicketsUrl,
  mailboxLabel,
  NO_MAILBOX_EMPTY,
  MAILBOXES_ON_MAIL_EMPTY,
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
  // INBOX-SURFACE.E — labels of this location's mailboxes that moved to
  // Mail (`email_mailboxes.surface = 'inbox'`). Always an array on the wire
  // (the route's own early return keeps it `[]`), but an OLD server mid-
  // deploy-skew won't send the key at all — `|| []` below treats that
  // exactly like an empty list rather than crashing on undefined.
  const [mailboxesOnMail, setMailboxesOnMail] = useState([])

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
  // EMAIL-PARTICIPANTS.7 — a remove/restore is in flight. Both the re-entrancy
  // guard (see patchParticipants) and what disables the chip buttons: a guard
  // nothing renders is a click that silently does nothing.
  const [participantSaving, setParticipantSaving] = useState(false)
  // EMAIL-MERGE.6 — a merge or its undo is in flight. One flag for both
  // directions, because they are the same pair of tickets and a second write
  // landing on top of the first is how a merge and its reversal race.
  const [mergeSaving, setMergeSaving] = useState(false)
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
      setMailboxesOnMail(body.data?.mailboxes_on_mail || [])
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

  // EMAIL-PARTICIPANTS.7 — take ONE address off this ticket's reply audience,
  // or put it back. One function for both directions, because they are the same
  // write to the same column and any difference between them would be a way for
  // the two to disagree about what just happened.
  //
  // Lives here, with the other mutations, because the write is only half the
  // work: the audience itself is never stored — resolveReplyAudience() derives
  // it from the thread on every read and subtracts the operator's exclusions —
  // so the chips tell the truth only after the ticket is re-read. Editing a
  // local copy of replyRecipients instead would be a second implementation of a
  // derivation the whole programme exists to keep singular.
  //
  // ON FAILURE THE CHIP STAYS PUT. The write did not land, so the audience is
  // still exactly what it was; a chip that moved between the two groups anyway
  // would be a lie about who the next reply reaches, which is the failure this
  // feature is meant to end. Nothing here is optimistic for that reason, and
  // the banner says what happened in the same place a failed status change or
  // assignment does.
  async function patchParticipants(address, { body, failure }) {
    if (!selectedId || !address || participantSaving) return
    const id = selectedId // guard stale responses across a ticket switch
    // Remove and restore are serialised against EACH OTHER, not just against
    // themselves: the route read-modify-writes excluded_participants, so two
    // writes in flight together would leave whichever landed second having
    // overwritten the first — an address silently back on the audience, or
    // silently off it. A dropped second click leaves its chip where it was,
    // which is the honest half of that trade.
    setParticipantSaving(true)
    setThreadError(null)
    try {
      const res = await fetch(`/api/email/tickets/${id}/participants`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const answer = await res.json()
      if (threadFor.current !== id) return // superseded — the operator switched tickets
      if (!answer?.success) {
        setThreadError(answer?.error || failure)
        return
      }
      await loadThread(id)
    } catch {
      if (threadFor.current === id) {
        setThreadError(`${failure} — check your connection and try again`)
      }
    } finally {
      setParticipantSaving(false)
    }
  }

  function handleRemoveRecipient(address) {
    return patchParticipants(address, {
      body: { remove: [address] },
      failure: `Could not take ${address} off this reply`,
    })
  }

  function handleRestoreRecipient(address) {
    return patchParticipants(address, {
      body: { restore: [address] },
      failure: `Could not put ${address} back on this reply`,
    })
  }

  // EMAIL-MERGE.6 — fold this ticket into another, and undo it.
  //
  // Both live here rather than in TicketMerge for the reason every other
  // mutation on this pane does: the write is only half the work. A merge takes
  // the source OUT of the queue (scopeToUnmerged hides tombstones) and rewrites
  // the survivor's row, and an undo brings both back — none of which a
  // presentational component can reflect.
  //
  // THE SELECTION DELIBERATELY DOES NOT MOVE ON SUCCESS. Landing the operator
  // on the survivor is the friendlier-looking choice and would quietly make
  // this feature one-way: the tombstone is hidden from every list the moment it
  // is stamped, so navigating away puts the Undo out of reach. Staying put
  // re-reads the same ticket, which now carries merged_into_id (EMAIL-MERGE.5)
  // and renders the banner — survivor one click away, reversal one click away.
  //
  // Returns { ok, error?, stale? } so the dialog can distinguish a failure it
  // should stay open for from one it should get out of the way of — the shape
  // handleSend already answers the composer with.
  async function handleMerge(targetId) {
    if (!selectedId || !targetId || mergeSaving) return { ok: false }
    const id = selectedId // guard stale responses across a ticket switch
    setMergeSaving(true)
    setThreadError(null)
    try {
      const res = await fetch(`/api/email/tickets/${id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ into: targetId }),
      })
      const body = await res.json()
      if (threadFor.current !== id) return { ok: false } // superseded
      if (!body?.success) {
        // 409 — somebody merged this ticket while the dialog was open. The
        // view on screen is now wrong about where this conversation lives, so
        // it is refreshed rather than left to argue with the server: the
        // re-read paints the banner naming the survivor somebody ELSE chose.
        // Quietly, because loadThread's own error painting would replace the
        // one sentence that explains what happened.
        if (res.status === 409) {
          setThreadError(body?.error || 'Somebody else merged this ticket while you were looking at it.')
          await loadThread(id, { quiet: true })
          await loadQueue(true)
          return { ok: false, stale: true }
        }
        // Everything else stays IN the dialog. The route answers 404 for every
        // refusal it will not explain (self-merge, cross-location, either side
        // already merged or having absorbed a merge), so the operator gets a
        // sentence naming the ones they can act on rather than "Not found".
        return {
          ok: false,
          error: res.status === 404
            ? 'These two tickets cannot be merged. They may be at different studios, or one of them has already been merged — reload and try again.'
            : (body?.error || 'Could not merge these tickets'),
        }
      }
      await loadThread(id)
      await loadQueue(true)
      return { ok: true }
    } catch {
      if (threadFor.current !== id) return { ok: false }
      return { ok: false, error: 'Could not merge these tickets — check your connection and try again' }
    } finally {
      setMergeSaving(false)
    }
  }

  // The exact undo. Its failures land in the thread's own error banner rather
  // than a dialog return value, because Undo is a button ON that banner — the
  // operator is already looking at the place the message appears, exactly as
  // with a failed status change or assignment.
  async function handleUnmerge() {
    if (!selectedId || mergeSaving) return
    const id = selectedId // guard stale responses across a ticket switch
    setMergeSaving(true)
    setThreadError(null)
    try {
      const res = await fetch(`/api/email/tickets/${id}/merge`, { method: 'DELETE' })
      const body = await res.json()
      if (threadFor.current !== id) return // superseded
      if (!body?.success) {
        // The route's refusal is a bare 404 — including for the case that
        // actually happens, which is somebody else having already undone it.
        // Refreshing is the useful half of saying so.
        setThreadError(res.status === 404
          ? 'This ticket is not merged any more — refreshed to show where things stand'
          : (body?.error || 'Could not undo the merge'))
        await loadThread(id, { quiet: true })
        await loadQueue(true)
        return
      }
      await loadThread(id)
      await loadQueue(true)
    } catch {
      if (threadFor.current === id) {
        setThreadError('Could not undo the merge — check your connection and try again')
      }
    } finally {
      setMergeSaving(false)
    }
  }

  // The merged banner's Open. The survivor is deliberately looked up in the
  // queue but not required to be there: a mailbox tab or a view filter can
  // exclude it, and refusing to open it then would leave the banner pointing
  // at a ticket the operator cannot reach.
  function handleOpenTicket(id) {
    if (!id) return
    const row = tickets.find(t => t.id === id)
    selectTicket(row || { id })
    // selectTicket marks read off the ROW's unread_count, which we do not have
    // when the survivor is outside the current view. Opening a ticket is
    // exactly when marking read is right, so do it explicitly in that case —
    // and only that case, so a row we DO have is not asked twice.
    if (!row) markRead(id)
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
  //
  // INBOX-SURFACE.E — but "no visible mailboxes" has TWO distinct causes and
  // NO_MAILBOX_EMPTY's copy is only honest for one of them. If this
  // location's only mailbox(es) moved to Mail rather than never existing or
  // never being granted, `mailboxes_on_mail` says so — and telling the
  // operator "you have not been given access" when access was never touched
  // is how a deliberate surface move turns into a support ping about broken
  // permissions. Same shell, same icon — only the copy and the destination
  // link differ.
  //
  // AUDIT #4 — this full-screen branch must ALSO require `tickets.length ===
  // 0`. scopeToVisibleMailboxes (src/app/api/email/tickets/_helpers.js) keeps
  // returning NULL-mailbox orphan tickets to an ELEVATED caller even when
  // every mailbox has moved to Mail — its own comment calls a vanished record
  // "the one outcome this split must never produce" — and the Mail surface
  // (INBOX-SURFACE.C) explicitly excludes orphans, so a full-screen takeover
  // here on `mailboxes.length === 0` alone would show them NEITHER surface:
  // this one lies ("answered on Mail, open Mail") and Mail has genuinely
  // never carried them. `tickets` is present in that response — falling
  // through to the ordinary populated list is what keeps the record visible;
  // the moved-accounts pointer survives too, as the banner below instead of a
  // full-screen claim it made alone before.
  if (!loading && mailboxes.length === 0 && tickets.length === 0) {
    if (mailboxesOnMail.length > 0) {
      const movedCopy = MAILBOXES_ON_MAIL_EMPTY(mailboxesOnMail)
      return (
        <div className={shellClasses}>
          <EmptyState
            icon={<Mail size={28} />}
            title={movedCopy.title}
            description={movedCopy.description}
            action={
              <Link
                href="/communications/mail"
                className="inline-flex items-center gap-1.5 rounded-md border border-un1t-border px-2.5 py-1.5 text-xs text-un1t-subtle hover:text-un1t-text transition-colors"
              >
                Open Mail
              </Link>
            }
          />
        </div>
      )
    }
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

      {/* AUDIT #4 — the moved-accounts pointer, kept alive as a slim banner
          rather than the full-screen takeover it used to be alone. Only
          reachable here at all because `mailboxes.length === 0` with
          `tickets.length > 0` fell through the empty-state branch above
          (an elevated caller's orphan tickets, INBOX-SURFACE.C's own "must
          never vanish" case) — informational, not an error, hence the blue
          idiom (TicketMerge.jsx) rather than the amber one above. */}
      {mailboxes.length === 0 && mailboxesOnMail.length > 0 && (
        <p
          className="flex flex-wrap items-center gap-1.5 border-b border-un1t-border bg-blue-500/10 px-3 py-1.5 text-xs text-blue-700"
          role="status"
        >
          <Mail size={12} className="shrink-0" />
          {MAILBOXES_ON_MAIL_EMPTY(mailboxesOnMail).description}
          <Link href="/communications/mail" className="font-medium underline hover:no-underline">
            Open Mail
          </Link>
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
            onRestoreRecipient={handleRestoreRecipient}
            participantSaving={participantSaving}
            onForward={setForwarding}
            onMerge={handleMerge}
            onUnmerge={handleUnmerge}
            onOpenTicket={handleOpenTicket}
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
