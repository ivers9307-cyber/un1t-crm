'use client'

// MAIL-TRIAL.B — the Mail surface: list on the left, the conversation on the
// right, archive as the verb that empties the left.
//
// WHY IT EXISTS AT ALL. `accounts@hatchstreetfitness.com` stays on the ticket
// queue, `hatchstreet@un1t.com` runs here, and Richard picks one. So this has
// to be a genuine alternative rather than the same queue in different words —
// if the two surfaces agree about how mail is worked, the trial answers
// nothing. What is deliberately different is set out in MailList.jsx (the row)
// and MailThread.jsx (the pane); this file owns the fetching, the state and
// the keyboard.
//
// WHAT IT REUSES, AND WHY IT MUST
//   • the thread + composer            — TicketThread / TicketReplyBox, through
//                                        three slots rather than a fork
//   • the new-email composer            — TicketCompose, unchanged
//   • the forward composer              — TicketForward, unchanged
//   • reading a conversation            — GET /api/email/tickets/[id]
//   • sending, forwarding, participants — the same routes as the ticket queue
// Only the LIST and the two verbs this surface actually adds (archive, read
// state) are new routes, because only they are things the ticket surface does
// not have. A second reply path would be a second chance to send a member the
// wrong thing.
//
// POLLING, NOT REALTIME, for the same reason the ticket queue polls: the email
// tables' RESTRICTIVE-policy history (mig 485) means a listener that silently
// never fires is a real failure mode here, and a poll that visibly works beats
// a subscription that quietly does not.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Mail, RefreshCw, AlertCircle, Plus } from 'lucide-react'
import { EmptyState, Button } from '@/components/ui'
import { NO_MAILBOX_EMPTY, threadRefreshMs } from '@/lib/ticket-display'
import TicketCompose from '@/components/tickets/TicketCompose'
import TicketForward from '@/components/tickets/TicketForward'
import MailList from './MailList'
import MailRail from './MailRail'
import MailThread from './MailThread'
import {
  MAIL_VIEWS, DEFAULT_MAIL_VIEW, mailView, buildMailUrl,
  isArchived, isUnread, isTypingTarget, neighbourId,
  DENSITIES, DEFAULT_DENSITY, readDensity, writeDensity,
} from './mail-display'

const POLL_MS = 60_000
// 🔴 DEBOUNCED. Every keystroke is otherwise a full-text scan plus a
// conversation-count pass, and a fast typist queues eight of them to see the
// result of the last.
const SEARCH_DEBOUNCE_MS = 350

export default function MailSurface({ locationId, locationName, userId }) {
  const [mailboxes, setMailboxes] = useState([])
  const [conversations, setConversations] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listError, setListError] = useState(null)
  const [nextBefore, setNextBefore] = useState(null)
  const [needsReplyCount, setNeedsReplyCount] = useState(0)
  const [countsUnavailable, setCountsUnavailable] = useState(false)
  // The scan behind the search results was truncated — real results, maybe
  // not all of them. Task 3's route stamps this beside counts_partial.
  const [searchPartial, setSearchPartial] = useState(false)

  const [mailboxId, setMailboxId] = useState(null)
  const [viewId, setViewId] = useState(DEFAULT_MAIL_VIEW)

  // MAIL-DENSITY.1 — the row layout preference. Starts at the DEFAULT (never
  // read from storage in the initial useState: the server renders with no
  // localStorage, and reading it during render would mismatch the server's
  // HTML) and is hydrated once, after mount, below.
  const [density, setDensity] = useState(DEFAULT_DENSITY)

  // MAIL-SEARCH — the raw box value, and the value that actually drives the
  // request. `queryText` updates on every keystroke; `debouncedQuery` lags it
  // by DEBOUNCE_MS so a fast typist does not queue a full-text scan plus a
  // conversation-count pass per keystroke to see only the last one's result.
  const [queryText, setQueryText] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')

  const [selectedId, setSelectedId] = useState(null)
  const [conversation, setConversation] = useState(null)
  const [messages, setMessages] = useState([])
  const [attachmentsUnavailable, setAttachmentsUnavailable] = useState(false)
  const [replyRecipients, setReplyRecipients] = useState(null)
  const [threadLoading, setThreadLoading] = useState(false)
  const [threadError, setThreadError] = useState(null)
  const [sending, setSending] = useState(false)
  const [participantSaving, setParticipantSaving] = useState(false)
  // One flag for archive and read-state together: they are two writes against
  // the same row, and letting them overlap is how a conversation ends up
  // archived-and-unread when the operator asked for neither.
  const [actionSaving, setActionSaving] = useState(false)
  const [busyId, setBusyId] = useState(null)
  // The mailbox half of a paired write did not land. NOT an error: the action
  // is recorded here, and this sentence says which half is behind. Cleared on
  // the next action and on a selection change, so it can never outlive the
  // thing it describes.
  const [writebackNotice, setWritebackNotice] = useState(null)

  const [composeOpen, setComposeOpen] = useState(false)
  const [forwarding, setForwarding] = useState(null)

  const view = mailView(viewId)
  const listUrl = buildMailUrl({ locationId, mailboxId, viewId, q: debouncedQuery })

  // Hydrate the density preference AFTER mount, never during render — the
  // server has no localStorage, so reading it in the initial useState would
  // mismatch the server's own HTML.
  useEffect(() => { setDensity(readDensity()) }, [])

  function chooseDensity(next) {
    setDensity(next)
    writeDensity(next)
  }

  // The debounce: `debouncedQuery` only moves SEARCH_DEBOUNCE_MS after the
  // last keystroke, and that value alone feeds `listUrl` above — never
  // `queryText` directly.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(queryText.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [queryText])

  // Which request each pane currently belongs to — the ticket surface's
  // TICKET-FETCH-RACE.1 idiom, kept because the failure it prevents is worse
  // here: handleSend posts to `selectedId`, so a late thread read painting the
  // WRONG conversation over the pane is one click from mailing the wrong
  // member.
  const listRequest = useRef(null)
  const threadFor = useRef(null)

  // ── List ───────────────────────────────────────────────────────────
  const loadList = useCallback(async (quiet = false) => {
    if (!locationId) { setLoading(false); return }
    const url = listUrl
    listRequest.current = url
    if (!quiet) setLoading(true)
    try {
      const res = await fetch(url, { cache: 'no-store' })
      const body = await res.json()
      if (listRequest.current !== url) return // superseded — a newer scope owns the list
      if (!body?.success) {
        setListError(body?.error || 'Could not load your mail')
        return
      }
      setListError(null)
      setMailboxes(body.data?.mailboxes || [])
      setConversations(body.data?.conversations || [])
      setNextBefore(body.data?.next_before || null)
      setNeedsReplyCount(body.data?.needs_reply_count || 0)
      // Two different failures, one operator-visible consequence: either way
      // the read state on this page is not to be trusted, and the list says so
      // rather than rendering every row as read.
      setCountsUnavailable(!!body.data?.counts_unavailable || !!body.data?.counts_partial)
      // The search scan itself was truncated — the rows shown are real, but
      // may not be all of them (Task 3's route stamps this beside the flag
      // above, and it means something different: "not found yet", not "not
      // here").
      setSearchPartial(!!body.data?.search_partial)
    } catch {
      if (listRequest.current !== url) return
      // Transient — keep the last good list on screen rather than blanking it,
      // and say so instead of showing a stale list as if it were fresh.
      setListError('Could not reach the server — showing the last loaded list')
    } finally {
      if (listRequest.current === url) setLoading(false)
    }
  }, [locationId, listUrl])

  useEffect(() => { loadList() }, [loadList])

  useEffect(() => {
    const timer = setInterval(() => loadList(true), POLL_MS)
    const onFocus = () => loadList(true)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [loadList])

  // "Older" — a keyset cursor, appended. It deliberately does NOT touch
  // `listRequest`: a page-2 read is not a new scope, and stamping it as one
  // would make the next background poll look superseded and skip its own
  // repaint.
  //
  // 🔴 `q` MUST TRAVEL WITH THE CURSOR. The route ignores `view` entirely
  // once `q` is present (a search deliberately spans inbox and archive), so a
  // page-2 request built without `q` does not narrow that scope — it takes a
  // completely different branch of the route, re-imposes the current view,
  // and hands back the newest 50 rows in THAT scope older than the cursor.
  // Appended onto page 1's search results, that is unrelated mail rendered as
  // search hits (with `e` one keystroke from archiving the wrong message out
  // of a real mailbox), while genuine matches beyond page 1 become
  // unreachable — no request that would return them is ever issued.
  async function loadMore() {
    if (!nextBefore || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await fetch(
        buildMailUrl({ locationId, mailboxId, viewId, before: nextBefore, q: debouncedQuery }),
        { cache: 'no-store' }
      )
      const body = await res.json()
      if (!body?.success) {
        setListError(body?.error || 'Could not load older conversations')
        return
      }
      const older = body.data?.conversations || []
      // De-duplicated on id: a conversation that received mail between the two
      // reads moves to the top of page 1 and would otherwise arrive twice.
      setConversations(prev => {
        const seen = new Set(prev.map(c => c.id))
        return [...prev, ...older.filter(c => !seen.has(c.id))]
      })
      setNextBefore(body.data?.next_before || null)
      // Page 2 of a search can be truncated exactly like page 1 — carry the
      // flag through, or a partial scan on this page silently reads as
      // complete because page 1 happened to say so.
      setSearchPartial(!!body.data?.search_partial)
    } catch {
      setListError('Could not load older conversations — check your connection and try again')
    } finally {
      setLoadingMore(false)
    }
  }

  // ── Conversation ───────────────────────────────────────────────────
  // The ticket surface's own detail route, unchanged. Its payload is what
  // TicketThread already knows how to render, and a second read path would be
  // a second sanitiser decision, a second attachment shape and a second
  // reply-audience derivation.
  const loadThread = useCallback(async (id, { quiet = false } = {}) => {
    if (!id) return
    if (!quiet) {
      setThreadLoading(true)
      setThreadError(null)
    }
    try {
      const res = await fetch(`/api/email/tickets/${id}`, { cache: 'no-store' })
      const body = await res.json()
      if (threadFor.current !== id) return // superseded — the operator moved on
      if (!body?.success) {
        if (!quiet) setThreadError(body?.error || 'Could not load this conversation')
        return
      }
      // The detail row carries the mailbox and the linked contact; the list row
      // carries this surface's derived flags. Spread the server row UNDER the
      // flags so neither loses to the other.
      setConversation(prev => ({ ...(prev || {}), ...(body.data?.ticket || {}) }))
      setMessages(body.data?.messages || [])
      setAttachmentsUnavailable(!!body.data?.attachments_unavailable)
      setReplyRecipients(body.data?.reply_recipients || null)
    } catch {
      if (threadFor.current !== id) return
      if (!quiet) setThreadError('Could not load this conversation')
    } finally {
      if (!quiet && threadFor.current === id) setThreadLoading(false)
    }
  }, [])

  useEffect(() => { if (selectedId) loadThread(selectedId) }, [selectedId, loadThread])

  // An open conversation re-reads itself — fast while its newest message is
  // young enough that attachment rows may still be arriving, the list's own
  // 60s otherwise (EMAIL-ATTACH-RACE.1's cadence, shared).
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

  // ── Read state ─────────────────────────────────────────────────────
  //
  // Opening a conversation marks it read, which is what an inbox does. The
  // state lives on the messages (`seen_at`, mig 575), which is the column that
  // MIRRORS the IMAP \Seen flag — so this is the same fact the operator's own
  // mail client is looking at, and the route writes both halves.
  //
  // markUnreadAction below is its mirror, and it is a PAIRED write for the same
  // reason: the poller converges seen_at against the mailbox in both
  // directions, so a CRM-only unread mark would undo itself within about a
  // quarter of an hour. The route clears \Seen over IMAP too.
  //
  // `incidental` distinguishes the two callers, and the distinction is the
  // whole reason this parameter exists. markReadAction is the operator pressing
  // a button — its result supersedes whatever the last action said. Selecting a
  // conversation ALSO marks it read, and that one is a side effect the operator
  // never asked for; it must not be allowed to speak over the action that moved
  // them here. See the notice rule at the setWritebackNotice call below.
  const markRead = useCallback(async (id, { incidental = false } = {}) => {
    if (!id) return { ok: false }
    try {
      const res = await fetch(`/api/email/mail/${id}/seen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seen: true }),
      })
      const body = await res.json()
      if (!body?.success) return { ok: false, error: body?.error }
      setConversations(prev => prev.map(c => (
        c.id === id ? { ...c, unread: false, unread_count_messages: 0 } : c
      )))
      setConversation(prev => (prev?.id === id ? { ...prev, unread: false } : prev))
      // Said out loud when the mailbox half is behind — an operator whose Gmail
      // still shows the message bold has to be able to find out why.
      //
      // 🔴 AN INCIDENTAL MARK-READ MAY ADD A NOTICE BUT NEVER ERASE ONE. This
      // used to clear unconditionally, which quietly undid the guarantee two
      // comments down in selectConversation: archiving moves the operator to
      // the next conversation, that move marks the successor read, and this
      // line — resolving a few hundred milliseconds later with no notice of its
      // own — wiped the sentence explaining that the archive never reached
      // Gmail. Nothing converges archive state, so that sentence was the ONLY
      // signal the operator would ever get, and on the ordinary path (an unread
      // successor) it was guaranteed to be erased before it could be read.
      const notice = body.data?.writeback_notice || null
      if (notice) setWritebackNotice(notice)
      else if (!incidental) setWritebackNotice(null)
      return { ok: true }
    } catch {
      // A read mark that did not land costs a bold row, not a message. It is
      // never worth an error banner over correspondence the operator can
      // already see.
      return { ok: false }
    }
  }, [])

  function selectConversation(row) {
    if (!row?.id) return
    threadFor.current = row.id
    setSelectedId(row.id)
    // A forward composer left open across a switch would be holding a message
    // from the conversation you just left — one click from sending somebody
    // else's correspondence to the address you were about to type.
    setForwarding(null)
    // Paint from the list row immediately; loadThread replaces it a moment
    // later with the full record.
    setConversation(row)
    setMessages([])
    setAttachmentsUnavailable(false)
    // The previous conversation's participants must not survive the switch,
    // even for the moment before loadThread answers — a Reply button briefly
    // naming somebody else's colleagues is a click away from being right.
    setReplyRecipients(null)
    setThreadError(null)
    // The write-back notice is deliberately NOT cleared here. Archiving moves
    // the operator to the next conversation, so clearing on selection would
    // wipe the sentence explaining the archive that caused the move — the one
    // case where it matters most. Each action clears it before it starts.
    if (isUnread(row)) markRead(row.id, { incidental: true })
  }

  // `keepNotice` is for the archive that empties the list: the notice belongs
  // to the ACTION, not to the selection, and the last conversation leaving is
  // exactly when a failed mailbox write most needs saying. Switching mailbox or
  // view is a genuinely fresh context, so those clear it.
  function clearSelection({ keepNotice = false } = {}) {
    threadFor.current = null
    setSelectedId(null)
    setConversation(null)
    setMessages([])
    setAttachmentsUnavailable(false)
    setForwarding(null)
    setReplyRecipients(null)
    setThreadError(null)
    if (!keepNotice) setWritebackNotice(null)
  }

  function changeMailbox(id) { setMailboxId(id); clearSelection() }

  // 🔴 A VIEW CLICK DURING A SEARCH MUST DO SOMETHING, NOT LOOK LIKE IT DID.
  // The route ignores `view` entirely while `q` is present (search spans
  // inbox and archive on purpose), so switching views mid-search used to
  // refetch, relabel the rail, and close the reading pane while returning
  // EXACTLY the same rows — visible feedback for a filter that filtered
  // nothing. Of the two honest options (clear the search so the click does
  // what it reads as, or grey the rail out while a search is active), this
  // clears the search: it needs no change outside this file (muting the rail
  // buttons would mean teaching MailRail a disabled state, which is out of
  // scope here), and it matches the convention operators already know from
  // Gmail — clicking a folder while searching takes you to that folder,
  // un-scoped by whatever you were searching for.
  function changeView(id) {
    setViewId(id)
    setQueryText('')
    setDebouncedQuery('')
    clearSelection()
  }

  // ── Archive ────────────────────────────────────────────────────────
  //
  // THE PRIMARY VERB, and the one thing this surface does that the ticket
  // queue expresses as a lifecycle transition. On disk it IS that transition
  // (`status='closed'`) — there is no second lifecycle — but the route only
  // accepts the two states this surface can mean, so the inbox is structurally
  // incapable of writing `solved` or `pending`.
  //
  // ON SUCCESS THE ROW LEAVES THE LIST when it no longer belongs to the view,
  // and the selection moves to the next conversation. That is the behaviour
  // that makes an inbox clearable: waiting for the next 60s poll to remove a
  // row an operator has just dealt with is what turns a list into a queue.
  const archive = useCallback(async (row, archived) => {
    const id = row?.id
    if (!id || actionSaving) return
    setActionSaving(true)
    setBusyId(id)
    setThreadError(null)
    setWritebackNotice(null)
    try {
      const res = await fetch(`/api/email/mail/${id}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived }),
      })
      const body = await res.json()
      if (!body?.success) {
        setThreadError(body?.error || (archived ? 'Could not archive that' : 'Could not bring that back'))
        return
      }
      // The archive IS recorded; a notice only says the mailbox half is
      // behind. Set before the row may leave the list, so it survives.
      setWritebackNotice(body.data?.writeback_notice || null)
      const updated = body.data?.conversation
      // Does it still belong on this list? Ordinarily that is a question about
      // the VIEW — the archive tab wants archived rows, the other two want
      // live ones. But the route ignores `view` entirely while a search is
      // active (a search deliberately spans inbox and archive), so the list is
      // not scoped by view at all right now — an archived match is still a
      // legitimate result. Without this, the row would be filtered out here,
      // the selection would jump, and the very next quiet refetch below would
      // bring the row straight back — moving the operator off what they were
      // reading for nothing.
      const stillHere = debouncedQuery
        ? true
        : (viewId === 'archived' ? archived : !archived)

      if (stillHere) {
        setConversations(prev => prev.map(c => (c.id === id ? { ...c, ...updated } : c)))
        setConversation(prev => (prev?.id === id ? { ...prev, ...updated } : prev))
      } else {
        // Work out the successor BEFORE the row goes, or there is nothing left
        // to be next to.
        const ids = conversations.map(c => c.id)
        const successor = selectedId === id
          ? (neighbourId(ids, id, 1) || neighbourId(ids, id, -1))
          : null
        setConversations(prev => prev.filter(c => c.id !== id))
        if (selectedId === id) {
          const next = successor ? conversations.find(c => c.id === successor) : null
          if (next) selectConversation(next)
          else clearSelection({ keepNotice: true })
        }
      }
      // Quietly, so a refresh hiccup cannot repaint the surface as an error
      // over an action that succeeded.
      await loadList(true)
    } catch {
      setThreadError('Could not reach the server — nothing was changed')
    } finally {
      setActionSaving(false)
      setBusyId(null)
    }
    // `conversations`/`selectedId` are read for the successor, so they belong
    // in the dependency list even though the callback is only ever invoked
    // from an event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionSaving, conversations, selectedId, viewId, debouncedQuery, loadList])

  // The defer verb. Paired with markUnseen() over IMAP by the route, so it
  // survives the poller's convergence — see the seen route's header.
  const markUnreadAction = useCallback(async (row) => {
    const id = row?.id
    if (!id || actionSaving) return
    setActionSaving(true)
    setBusyId(id)
    setWritebackNotice(null)
    try {
      const res = await fetch(`/api/email/mail/${id}/seen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seen: false }),
      })
      const body = await res.json()
      if (!body?.success) {
        setThreadError(body?.error || 'Could not mark that unread')
        return
      }
      const unreadCount = body.data?.unread || 0
      setConversations(prev => prev.map(c => (
        c.id === id ? { ...c, unread: unreadCount > 0, unread_count_messages: unreadCount } : c
      )))
      setConversation(prev => (prev?.id === id ? { ...prev, unread: unreadCount > 0 } : prev))
      setWritebackNotice(body.data?.writeback_notice || null)
    } catch {
      setThreadError('Could not reach the server — nothing was changed')
    } finally {
      setActionSaving(false)
      setBusyId(null)
    }
  }, [actionSaving])

  const markReadAction = useCallback(async (row) => {
    const id = row?.id
    if (!id || actionSaving) return
    setActionSaving(true)
    setBusyId(id)
    try {
      await markRead(id)
    } finally {
      setActionSaving(false)
      setBusyId(null)
    }
  }, [actionSaving, markRead])

  // ── Send / participants ────────────────────────────────────────────
  // Both are the ticket surface's routes, unchanged — see the header.
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
        // `data.sent` is the route saying the reply IS with the member and only
        // the filing failed. Refresh QUIETLY and keep the draft: at that point
        // the words in the box are the only surviving copy of what was sent.
        if (body?.data?.sent) {
          await loadThread(selectedId, { quiet: true })
          await loadList(true)
          return { ok: false, sent: true }
        }
        return { ok: false }
      }
      await loadThread(selectedId)
      // A note changes nothing about the row (deliberately — it must not
      // re-describe the conversation or bump it up the list).
      if (!internal) await loadList(true)
      return { ok: true }
    } catch {
      setThreadError('Could not send that — check your connection and try again')
      return { ok: false }
    } finally {
      setSending(false)
    }
  }

  async function patchParticipants(address, { body, failure }) {
    if (!selectedId || !address || participantSaving) return
    const id = selectedId
    setParticipantSaving(true)
    setThreadError(null)
    try {
      const res = await fetch(`/api/email/tickets/${id}/participants`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const answer = await res.json()
      if (threadFor.current !== id) return // superseded
      if (!answer?.success) {
        setThreadError(answer?.error || failure)
        return
      }
      // Nothing here is optimistic: the audience is derived server-side, so
      // the chips only tell the truth after a re-read.
      await loadThread(id)
    } catch {
      if (threadFor.current === id) setThreadError(`${failure} — check your connection and try again`)
    } finally {
      setParticipantSaving(false)
    }
  }

  async function handleForwarded() {
    setForwarding(null)
    await loadThread(selectedId)
  }

  function handleComposed(newTicket) {
    setComposeOpen(false)
    loadList(true)
    if (newTicket?.id) selectConversation(newTicket)
  }

  // ── Keyboard ───────────────────────────────────────────────────────
  //
  // 🔴 THE TYPING GUARD IS THE FEATURE. This surface's main control is a
  // composer, so a bare `e` handler either archives a conversation or types
  // the letter e into a half-written reply — and getting it backwards loses
  // somebody's draft. isTypingTarget covers inputs, textareas, selects and
  // contentEditable hosts; modified keystrokes are left alone entirely so
  // nothing here shadows a browser shortcut.
  const conversationIds = useMemo(() => conversations.map(c => c.id), [conversations])
  useEffect(() => {
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // 🔴 A HELD KEY IS ONE INTENT, NOT MANY. Archiving moves the selection to
      // the next conversation, so autorepeat on `e` walks the list archiving
      // each one it lands on — and every one of those moves a real message out
      // of head office's INBOX. j/k repeating is harmless and arguably wanted,
      // but the cost of being wrong is not symmetric, so the whole handler
      // ignores repeats rather than only the destructive branch.
      if (e.repeat) return
      // 🔴 A MODAL OWNS THE KEYBOARD. Both modals render inside this subtree, so
      // their keydowns bubble to this window listener; and Modal focuses its own
      // panel DIV rather than a field, so isTypingTarget alone did not catch the
      // first keystroke. Unguarded, typing a recipient starting with `e` archived
      // the conversation BEHIND the compose window — a real Gmail message moved
      // out of INBOX, with the letter never reaching the box — and `j`/`k` called
      // selectConversation, which unmounts the forward form and discards a
      // half-written forward.
      if (composeOpen || forwarding) return
      if (isTypingTarget(e.target)) return
      const key = e.key
      if (key === 'j' || key === 'k') {
        const nextId = neighbourId(conversationIds, selectedId, key === 'j' ? 1 : -1)
        if (!nextId) return
        const row = conversations.find(c => c.id === nextId)
        if (!row) return
        e.preventDefault()
        selectConversation(row)
        return
      }
      if (key === 'u') {
        if (!selectedId) return
        e.preventDefault()
        clearSelection()
        return
      }
      if (key === 'e') {
        const row = conversations.find(c => c.id === selectedId)
        if (!row) return
        e.preventDefault()
        archive(row, !isArchived(row))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationIds, conversations, selectedId, archive, composeOpen, forwarding])

  // ── Render ─────────────────────────────────────────────────────────
  const shellClasses =
    'flex flex-col h-[calc(100vh-13rem)] min-h-[32rem] rounded-xl border border-un1t-border bg-un1t-bg overflow-hidden'

  if (!locationId) {
    return (
      <div className={shellClasses}>
        <EmptyState
          icon={<Mail size={28} />}
          title="No studio selected"
          description="Pick a location in the sidebar to see its mail."
        />
      </div>
    )
  }

  // A failed first load leaves us with zero mailboxes for a reason that has
  // nothing to do with access — say THAT, rather than telling an operator
  // their studio has no mail accounts because a fetch blipped.
  if (!loading && listError && mailboxes.length === 0) {
    return (
      <div className={shellClasses}>
        <EmptyState
          icon={<AlertCircle size={28} />}
          title="Could not load your mail"
          description={listError}
          action={
            <button
              type="button"
              onClick={() => loadList()}
              className="inline-flex items-center gap-1.5 rounded-md border border-un1t-border px-2.5 py-1.5 text-xs text-un1t-subtle transition-colors hover:text-un1t-text"
            >
              <RefreshCw size={13} />
              Try again
            </button>
          }
        />
      </div>
    )
  }

  // No mail-surface mailboxes is a NORMAL state — every existing mailbox
  // defaults to the ticket surface, so this is what a studio that has not
  // opted into the trial sees.
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

  // MAIL-RAIL.1's shape: `{id, label, count}`, count `null` when unknown.
  // needs_reply is the one view whose count this surface actually tracks —
  // an unknown count must not render as 0 (the rail already omits `null`),
  // so inbox/archived pass null rather than a fabricated zero.
  const railViews = MAIL_VIEWS.map(v => ({
    id: v.id,
    label: v.label,
    count: v.id === 'needs_reply' ? needsReplyCount : null,
  }))

  return (
    <div className={shellClasses}>
      <div className="flex items-center justify-end gap-2 border-b border-un1t-border px-3 py-2">
        <Button type="button" size="sm" variant="secondary" icon={Plus} onClick={() => setComposeOpen(true)}>
          New email
        </Button>
        <button
          type="button"
          onClick={() => loadList()}
          className="inline-flex items-center gap-1.5 rounded-md border border-un1t-border px-2 py-1 text-xs text-un1t-subtle transition-colors hover:text-un1t-text"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
          Refresh
        </button>
      </div>

      {listError && (
        <p
          className="flex items-center gap-1.5 border-b border-un1t-border bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700"
          role="status"
        >
          <AlertCircle size={12} className="shrink-0" />
          {listError}
        </p>
      )}

      {/* The mailbox half of a paired write did not land. Surface-level, not
          in the thread pane: it describes the last ACTION, and an archive
          moves the operator on, so the conversation it belonged to is usually
          not the one on screen any more. It is INFORMATION, not a failure —
          the action itself is recorded. */}
      {writebackNotice && (
        <p
          className="flex items-center gap-1.5 border-b border-un1t-border bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700"
          role="status"
        >
          <AlertCircle size={12} className="shrink-0" />
          {writebackNotice}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        {/* MailRail's own root sets a fixed `w-44 shrink-0` — neither it nor
            the list column below (`w-full shrink-0`) can shrink, so below
            `md` the row is 176px wider than this shell, which clips it
            (`shellClasses` carries `overflow-hidden`) with no scroll to
            reach the rest — the date and hover actions on every row go
            unreachable. The list/thread panes already solve this same
            problem with `hidden md:flex` keyed off `selectedId`; the rail
            has no such per-selection state, so it is unconditional — the
            rail is chrome the shell cannot afford below `md` at all. */}
        <div className="hidden shrink-0 md:flex">
          <MailRail
            views={railViews}
            viewId={viewId}
            onView={changeView}
            mailboxes={mailboxes}
            mailboxId={mailboxId}
            onMailbox={changeMailbox}
            locationLabel={locationName}
          />
        </div>

        <div
          className={`${selectedId ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r border-un1t-border md:w-[22rem] lg:w-[24rem]`}
        >
          <div className="flex items-center gap-2 border-b border-un1t-border px-2 py-1.5">
            <input
              type="search"
              role="searchbox"
              aria-label="Search mail"
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder="Search mail"
              className="min-w-0 flex-1 rounded-md border border-un1t-border bg-un1t-surface px-2.5 py-1 text-[13px] text-un1t-text placeholder:text-un1t-muted focus:border-un1t-muted focus:outline-none"
            />
            {/* MAIL-DENSITY.1's two-button toggle — Compact/Comfortable, not a
                select, so the current density is always visible without a
                click. */}
            <div className="flex shrink-0 overflow-hidden rounded-md border border-un1t-border" role="group" aria-label="Row density">
              {DENSITIES.map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => chooseDensity(d)}
                  aria-pressed={density === d}
                  className={`px-2 py-1 text-[11px] font-medium transition-colors ${
                    density === d ? 'bg-un1t-text text-un1t-bg' : 'bg-un1t-bg text-un1t-subtle hover:text-un1t-text'
                  }`}
                >
                  {d === 'compact' ? 'Compact' : 'Comfortable'}
                </button>
              ))}
            </div>
          </div>

          <MailList
            conversations={conversations}
            loading={loading}
            selectedId={selectedId}
            onSelect={selectConversation}
            onArchive={archive}
            onMarkRead={markReadAction}
            onMarkUnread={markUnreadAction}
            busyId={busyId}
            view={view}
            locationName={locationName}
            showMailbox={mailboxes.length > 1}
            mailboxById={mailboxById}
            hasMore={!!nextBefore}
            onLoadMore={loadMore}
            loadingMore={loadingMore}
            countsUnavailable={countsUnavailable}
            density={density}
            searchActive={!!debouncedQuery}
            searchQuery={debouncedQuery}
            searchPartial={searchPartial}
          />
        </div>

        <div className={`${selectedId ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
          <MailThread
            hasSelection={!!selectedId}
            conversation={conversation}
            messages={messages}
            replyRecipients={replyRecipients}
            attachmentsUnavailable={attachmentsUnavailable}
            loading={threadLoading}
            error={threadError}
            currentUserId={userId}
            onBack={clearSelection}
            onSend={handleSend}
            sending={sending}
            onRemoveRecipient={(address) => patchParticipants(address, {
              body: { remove: [address] },
              failure: `Could not take ${address} off this reply`,
            })}
            onRestoreRecipient={(address) => patchParticipants(address, {
              body: { restore: [address] },
              failure: `Could not put ${address} back on this reply`,
            })}
            participantSaving={participantSaving}
            onForward={setForwarding}
            onArchive={(next) => archive(conversation, next)}
            onMarkRead={() => markReadAction(conversation)}
            onMarkUnread={() => markUnreadAction(conversation)}
            actionSaving={actionSaving}
          />
        </div>
      </div>

      {/* Mounted only while open, so a fresh compose never inherits the last
          one's draft AND the 60s poll re-creating `mailboxes` cannot reset a
          half-typed email. */}
      {composeOpen && (
        <TicketCompose
          mailboxes={mailboxes}
          initialMailboxId={mailboxId}
          onClose={() => setComposeOpen(false)}
          onSent={handleComposed}
          onSentUnfiled={() => loadList(true)}
        />
      )}

      {forwarding && conversation && (
        <TicketForward
          ticket={conversation}
          message={forwarding}
          onClose={() => setForwarding(null)}
          onSent={handleForwarded}
        />
      )}
    </div>
  )
}
