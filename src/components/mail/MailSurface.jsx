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
import { useRouter, useSearchParams } from 'next/navigation'
import { Mail, RefreshCw, AlertCircle, Plus } from 'lucide-react'
import { EmptyState, Button } from '@/components/ui'
import { NO_MAILBOX_EMPTY, threadRefreshMs } from '@/lib/ticket-display'
import TicketCompose from '@/components/tickets/TicketCompose'
import TicketForward from '@/components/tickets/TicketForward'
import MailList from './MailList'
import MailRail from './MailRail'
import MailThread from './MailThread'
import MailDock from './MailDock'
import ComposeDock from './ComposeDock'
import {
  MAIL_VIEWS, DEFAULT_MAIL_VIEW, mailView, buildMailUrl,
  isArchived, isUnread, isTypingTarget, neighbourId,
  needsReply,
} from './mail-vocabulary'
import {
  DENSITIES, DEFAULT_DENSITY, readDensity, writeDensity,
  composeBlocksKeys, slotOccupancy,
} from './mail-preferences'
import { UUID_SHAPE } from '@/lib/uuid-shape'
import { useActionQueue } from './use-action-queue'
import { useDockSlot } from './use-dock-slot'
import { useVisibleInterval } from './use-visible-interval'
import {
  MAIL_SCOPE_ALL, isUuidShaped, readMailScope, writeMailScope, resolveMailScope,
  buildDigestSections, flattenSectionRows, resolveNeedsReplyTotal,
  buildLocationTiles, withLocationNeedsReply, buildSearchSections,
  groupMailboxesByStudio,
} from './mail-digest'

const POLL_MS = 60_000
// 🔴 DEBOUNCED. Every keystroke is otherwise a full-text scan plus a
// conversation-count pass, and a fast typist queues eight of them to see the
// result of the last.
const SEARCH_DEBOUNCE_MS = 350

// MAIL-DEEPLINK-SEC.1 — `?c=` is an operator-editable URL, not server data.
// Interpolated raw it turns into a same-origin request forger (a crafted
// `?c=..%2F..%2Ffoo` aimed via loadThread at a route this file never meant to
// call, still carrying the operator's own session), so the mount read below
// is validated against the house id shape before it is trusted with
// anything — every id in this system is one, so a non-uuid `?c=` is not a
// legitimate deep link and is ignored outright, the same as if it were
// absent. The shape is the house one from `@/lib/uuid-shape` (homed there by
// MAIL-ARCH.2, #1618) — it used to be replicated here because the tickets
// route helper that owned it did not export it.

// MAIL-ALLLOC.1 — `locations` is the page-resolved eligible set ({id, name},
// name-sorted): every studio where the caller holds `email_inbox`. With 2+
// entries this surface runs in MULTI mode — location tiles, an All-locations
// grouped digest, a per-user persisted scope. With one (or none, the legacy
// prop shape), everything below the scope block is byte-for-byte today's
// single-location surface: `scope` stays null and no multi path ever runs.
export default function MailSurface({ locationId, locationName, userId, locations }) {
  const router = useRouter()
  const searchParams = useSearchParams()

  // Audit F1 — keyed on CONTENT, not the array. page.js rebuilds `locations`
  // on every server render and this page is force-dynamic, so every
  // router.replace (each selection, each j/k step) delivers a fresh array;
  // an identity-keyed memo would cascade through searchFanout → refreshList
  // and re-fire a non-quiet fetch + poll reset per keystroke.
  const eligibleKey = Array.isArray(locations)
    ? locations.map(l => `${l.id}\u0000${l.name ?? ''}`).join('\u0001')
    : ''
  const eligible = useMemo(() => (
    Array.isArray(locations) && locations.length > 0
      ? locations
      : (locationId ? [{ id: locationId, name: locationName }] : [])
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `locations` is represented by eligibleKey (see above)
  ), [eligibleKey, locationId, locationName])
  const multi = eligible.length >= 2

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

  // ── MAIL-ALLLOC.1 scope ──────────────────────────────────────────────
  //
  // `scope` is MAIL_SCOPE_ALL or a location id; null in single-location mode,
  // where none of this runs. All is the multi-location default, but the
  // chosen scope persists per user (localStorage, hydrated AFTER mount for
  // the same SSR reason as density) and `?loc=` — validated like `?c=`, uuid
  // shape or ignored — wins over the stored value for a shared deep link.
  // `scopeReady` holds the FIRST fetch until that hydration has settled, so
  // a persisted studio scope costs one fetch, not a discarded All fetch
  // followed by the real one.
  const [scope, setScope] = useState(multi ? MAIL_SCOPE_ALL : null)
  const [scopeReady, setScopeReady] = useState(!multi)

  // The last digest answer: tiles + All-mode sections come from it. The ref
  // mirrors the state so callbacks (the search fan-out) can read the CURRENT
  // locations without depending on the object's identity — a state dep there
  // would re-create the refresh callback on every digest poll and turn the
  // "refetch on scope/view change" effect into a self-feeding loop.
  const [digest, setDigest] = useState(null)
  const digestRef = useRef(null)
  const applyDigest = useCallback((updater) => {
    setDigest(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      digestRef.current = next
      return next
    })
  }, [])

  // The summed badge. resolveNeedsReplyTotal keeps the LAST GOOD number when
  // a partial digest answers null — an unknown must never render as 0 — and
  // null only before anything was ever known (the rail omits it entirely).
  const [allTotal, setAllTotal] = useState(null)

  // All-mode section metadata (digest sections, or search fan-out sections
  // while a query is active); null whenever the flat single-studio list is
  // what is on screen.
  const [sections, setSections] = useState(null)

  const allMode = multi && scope === MAIL_SCOPE_ALL
  // The location the EXISTING single-studio paths run against. In multi mode
  // it is the scoped studio (null in All mode — those paths idle); otherwise
  // it is exactly the prop it always was.
  const scopedId = multi ? (allMode ? null : scope) : (locationId || null)
  const scopedName = multi
    ? (allMode ? null : (eligible.find(l => l.id === scope)?.name || null))
    : (locationName || null)

  // MAIL-DENSITY.1 — the row layout preference. Starts at the DEFAULT (never
  // read from storage in the initial useState: the server renders with no
  // localStorage, and reading it during render would mismatch the server's
  // HTML) and is hydrated once, after mount, below.
  const [density, setDensity] = useState(DEFAULT_DENSITY)

  // ── MAIL-DOCK.1/.2 — the reader/compose slot machine lives in
  // use-dock-slot.js (MAIL-HOOKS.1); the hook is called below, once
  // `selectedId` exists to feed its `hasReader` input. What stays here is
  // the one compose input that is NOT slot machinery:
  // Audit F3 — the From options frozen at open (see the compose render).
  const [composeBoxesAtOpen, setComposeBoxesAtOpen] = useState([])

  // MAIL-SEARCH — the raw box value, and the value that actually drives the
  // request. `queryText` updates on every keystroke; `debouncedQuery` lags it
  // by DEBOUNCE_MS so a fast typist does not queue a full-text scan plus a
  // conversation-count pass per keystroke to see only the last one's result.
  const [queryText, setQueryText] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')

  const [selectedId, setSelectedId] = useState(null)
  const [conversation, setConversation] = useState(null)
  const [messages, setMessages] = useState([])
  // MAIL-REFINE.2 — provenance for the thread's Merged-in dividers.
  const [mergedSources, setMergedSources] = useState([])
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

  // Audit M2 — MailThread's merge picker is a dialog the shortcut guard must respect.

  const [threadModalOpen, setThreadModalOpen] = useState(false)
  const [forwarding, setForwarding] = useState(null)

  // ── MAIL-DOCK.1/.2 — reader + compose modes, and the ONE bottom-right
  // slot they share (use-dock-slot.js). Reader occupancy is `!!selectedId`;
  // compose occupancy is the hook's own `composeOpen`. Unconditional, above
  // every early return, so hook order is stable across renders.
  const {
    readerMode, chooseReaderMode, minimiseReader, restoreReader,
    unminimiseReader, readerEscStep, claimReaderSlot,
    composeOpen, composeMode, composeVariant,
    chooseComposeMode, minimiseCompose, restoreCompose, closeCompose,
    handleComposeEscape, openComposeSlot,
  } = useDockSlot({ hasReader: !!selectedId })

  const view = mailView(viewId)
  const listUrl = buildMailUrl({ locationId: scopedId, mailboxId, viewId, q: debouncedQuery })

  // Hydrate the density preference AFTER mount, never during render — the
  // server has no localStorage, so reading it in the initial useState would
  // mismatch the server's own HTML. The reader/compose modes hydrate the
  // same way in use-dock-slot's own mount effect — same storage, same SSR
  // reasoning, same once-only cadence, same commit.
  useEffect(() => {
    setDensity(readDensity())
  }, [])

  function chooseDensity(next) {
    setDensity(next)
    writeDensity(next)
  }

  // MAIL-ALLLOC.1 — scope hydration, once, after mount (localStorage does not
  // exist during SSR, exactly the density story). `?loc=` beats the stored
  // value — a pasted link should land where it points — and either source is
  // resolved against the ELIGIBLE set: a studio the caller can no longer read
  // falls back to All rather than to a blank screen scoped to nothing. (The
  // digest applies the same rule again once it answers, below — eligibility
  // is permission-shaped, the digest is mailbox-shaped, and both can shrink.)
  useEffect(() => {
    if (!multi) return
    const locParam = searchParams.get('loc')
    const candidate = isUuidShaped(locParam) ? locParam : readMailScope(userId)
    setScope(resolveMailScope(candidate, eligible.map(l => l.id)))
    setScopeReady(true)
    // Mount-only, same contract as the ?c= read: after this, the tiles own
    // the scope and the URL is written TO, not synced FROM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A persisted/deep-linked scope can name a studio the DIGEST no longer
  // answers for (mailboxes removed since last visit); and a digest that
  // answers exactly one studio means this caller is not meaningfully
  // multi-location today — collapse to that studio so they see the plain
  // single-studio surface rather than a one-section "All". Neither move is
  // persisted: the operator did not choose it, and their stored preference
  // should win again the day the second studio comes back.
  useEffect(() => {
    if (!multi || !digest) return
    const locs = Array.isArray(digest.locations) ? digest.locations : []
    const fallbackTo = scope === MAIL_SCOPE_ALL
      ? (locs.length === 1 ? locs[0].location_id : null)
      : (scope && !locs.some(l => l.location_id === scope) ? MAIL_SCOPE_ALL : null)
    if (!fallbackTo) return
    setScope(fallbackTo)
    // Audit F2 — a fallback is still a scope change, so it clears the same
    // context changeScope clears: the account filter belongs to the studio
    // that vanished (left in place it would dress the next studio's mail in
    // a calm empty list), a live search must not silently widen into a
    // fan-out, and a stale ?loc= would make a shared link lie. Only the
    // PERSISTENCE is skipped — the operator did not choose this.
    setMailboxId(null)
    setQueryText('')
    setDebouncedQuery('')
    const params = new URLSearchParams(searchParams.toString())
    if (fallbackTo === MAIL_SCOPE_ALL) params.delete('loc')
    else params.set('loc', fallbackTo)
    const qs = params.toString()
    router.replace(qs ? `/communications/mail?${qs}` : '/communications/mail', { scroll: false })
  }, [multi, digest, scope, searchParams, router])

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

  // TASK 2 — mirrors listRequest/threadFor's "ref for a fact that must never
  // itself trigger a render" idiom. Set true on mount, false in the unmount
  // cleanup; the archive queue (below) checks it before every setState call
  // that follows an `await`, so a write still in flight when the operator
  // navigates away never touches a component that is no longer there.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // ── Deep link (?c=<id>) ────────────────────────────────────────────
  //
  // MAIL-DEEPLINK.1. Read ONCE, on mount — after that this surface's own
  // clicks and keyboard own the selection, and the URL exists to be walked
  // TO, not synced FROM continuously (an external edit to the address bar
  // while the surface is open is not a supported gesture here, the same way
  // it is not for KanbanBoard's `?contact=`). `initialDeepLinkRef` is what
  // makes it once-only: every later `router.replace` this file makes (below)
  // also changes `searchParams`, and without the ref this effect would fire
  // again on the surface's OWN writes and re-select whatever `?c=` happened
  // to hold at that moment.
  const initialDeepLinkRef = useRef(false)
  // The id a deep link seeded that has not yet been checked against a real
  // list row — disarmed (never re-armed) the moment the reconciliation
  // effect below gets its ONE look, win or lose; also disarmed early by
  // selectConversation/clearSelection if the operator moves on first. Lets
  // the mount effect select and load a conversation that is NOT ON PAGE 1
  // (the ordinary case for a link named by relevance rather than recency)
  // without waiting on the list at all: loadThread fetches by id
  // unconditionally.
  const deepLinkReconcileRef = useRef(null)
  // CONTRACTS finding 1+2 — a SEPARATE ref from the one above, and the fix
  // for the sharper of the two bugs that ref alone had: mark-read must not
  // be keyed off list membership at all (an off-page row was read and
  // answered but never marked read; worse, the old code kept firing against
  // WHATEVER the operator was looking at the moment the id eventually
  // resurfaced in some later list payload — new mail landing on the original
  // conversation 40 minutes on, surfaced by the routine poll, silently
  // marked read on arrival). Cleared by loadThread's own success handler
  // (below, near its declaration) the instant that read genuinely happens —
  // the one fact list membership can never stand in for.
  const deepLinkMarkReadRef = useRef(null)

  // Selection writes `?c=<id>` with router.replace — REPLACE, not push, so
  // j/k walking the list does not spam browser history with one entry per
  // row (the operator would need dozens of Back presses just to leave the
  // surface). `null` removes it. Built from the CURRENT searchParams rather
  // than a bare template string so a future param this surface does not yet
  // know about survives a selection change untouched — the same reasoning as
  // KanbanBoard's `?contact=` writer.
  //
  // L6 — a no-op guard: `clearSelection` calls this UNCONDITIONALLY (see
  // there), and `changeMailbox`/`changeView` call `clearSelection`
  // unconditionally too — so switching tabs with nothing selected used to
  // `router.replace` the CURRENT url with itself on every click. This route
  // is `force-dynamic`, so that is not a no-op in Next's eyes: a wasted RSC
  // refetch (and a fresh `getCurrentUser()`) per click. Skipped whenever the
  // target value already matches what is in the URL.
  const writeSelectedParam = useCallback((id) => {
    if ((searchParams.get('c') || null) === (id || null)) return
    const params = new URLSearchParams(searchParams.toString())
    if (id) params.set('c', id)
    else params.delete('c')
    const qs = params.toString()
    router.replace(qs ? `/communications/mail?${qs}` : '/communications/mail', { scroll: false })
  }, [router, searchParams])

  useEffect(() => {
    if (initialDeepLinkRef.current) return
    initialDeepLinkRef.current = true
    const id = searchParams.get('c')
    // MAIL-DEEPLINK-SEC.1 — anything that is not the house id shape is not a
    // legitimate deep link. Ignored outright rather than sanitised and used
    // anyway: every id this surface ever deals in is a uuid, so a non-uuid
    // value here has no honest interpretation.
    if (!id || !UUID_SHAPE.test(id)) return
    threadFor.current = id
    setSelectedId(id)
    // Painted minimally — selectConversation's usual "paint from the list row
    // immediately" has no row to paint from yet. The existing selectedId
    // effect below fires loadThread within one round trip, which is also
    // where the mark-read for this id actually happens — see loadThread's
    // own success handler, near its declaration.
    setConversation({ id })
    deepLinkReconcileRef.current = id
    deepLinkMarkReadRef.current = id
    // Deliberately does NOT call writeSelectedParam: the param is already
    // there (that is where `id` came from) — replacing it with itself would
    // only cost a needless history-API call on every mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The reconciliation effect for the block above lives further down, right
  // before selectConversation (it needs `loading`, `conversations` and
  // `selectedId`, all already in scope by then).

  // ── List ───────────────────────────────────────────────────────────
  const loadList = useCallback(async (quiet = false) => {
    if (!scopedId) { setLoading(false); return }
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
      // A scoped list never renders sections — and a stale sections array
      // left behind by a scope switch would keep grouping the flat list.
      setSections(null)
      setNextBefore(body.data?.next_before || null)
      setNeedsReplyCount(body.data?.needs_reply_count || 0)
      // MAIL-ALLLOC.1 — the tile count is ALWAYS needs-reply, and a scoped
      // refresh knows its own studio's fresh number; fold it into the last
      // digest answer so this studio's tile stays honest between digest
      // polls. withLocationNeedsReply no-ops on a non-number.
      if (multi) {
        applyDigest(prev => (prev
          ? { ...prev, locations: withLocationNeedsReply(prev.locations, scopedId, body.data?.needs_reply_count) }
          : prev))
      }
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
  }, [scopedId, listUrl, multi, applyDigest])

  // ── MAIL-ALLLOC.1: the digest (All mode's list, every mode's tiles) ──
  //
  // Same poller slot as the scoped list — in All mode the digest is polled
  // INSTEAD of the list, same cadence, via the dispatcher below. The
  // `listRequest` superseding guard is shared with loadList on purpose: a
  // scope flip mid-flight makes whichever request lost the race drop its
  // own repaint, exactly as a mailbox flip always has.
  const loadDigest = useCallback(async (quiet = false) => {
    const url = viewId && viewId !== DEFAULT_MAIL_VIEW
      ? `/api/email/mail/digest?view=${encodeURIComponent(viewId)}`
      : '/api/email/mail/digest'
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
      const data = body.data || {}
      setListError(null)
      applyDigest(data)
      // Partial digest → null total → keep the last good number, never 0.
      setAllTotal(prev => resolveNeedsReplyTotal(data.needs_reply_total, prev))
      const built = buildDigestSections(data)
      setSections(built)
      // The flat, section-ordered row list: what j/k walks, what the archive
      // successor is computed against, what every mutation updates — the
      // sections only GROUP it, so there is no second row state to drift.
      setConversations(flattenSectionRows(built))
      setNextBefore(null) // the digest pages by scoping into a studio, never by cursor
      setCountsUnavailable(built.some(s => s.countsPartial))
      setSearchPartial(false)
    } catch {
      if (listRequest.current !== url) return
      setListError('Could not reach the server — showing the last loaded list')
    } finally {
      if (listRequest.current === url) setLoading(false)
    }
  }, [viewId, applyDigest])

  // Scoped multi-location callers still need tile counts once — fetched
  // quietly, feeding ONLY the digest/tiles, never the list on screen.
  //
  // MAIL-PERF.1 — `counts=only`: the tiles read location_id, name, unavailable
  // and needs_reply_count and nothing else, so this poll asks the route to skip
  // the row payload (five conversations + their per-row counts, per studio,
  // every minute). The shape is otherwise the digest's — `locations` still
  // carries every studio, so the scope-reconciliation effect above reads it
  // unchanged; the empty `conversations` arrays are never rendered from this
  // path (All-mode sections come from loadDigest's FULL fetch).
  const loadTileDigest = useCallback(async () => {
    try {
      const res = await fetch('/api/email/mail/digest?counts=only', { cache: 'no-store' })
      const body = await res.json()
      if (!body?.success) return
      applyDigest(body.data || null)
      setAllTotal(prev => resolveNeedsReplyTotal(body.data?.needs_reply_total, prev))
    } catch {
      // Tiles keep their unknown (chip-less) counts — never an error banner
      // over chrome.
    }
  }, [applyDigest])

  const tileDigestFiredRef = useRef(false)
  useEffect(() => {
    if (!multi || !scopeReady || tileDigestFiredRef.current) return
    tileDigestFiredRef.current = true
    // In All mode the very first loadDigest covers the tiles already.
    if (!allMode) loadTileDigest()
  }, [multi, scopeReady, allMode, loadTileDigest])

  // Audit F3 — scoped multi mode: the scoped studio's own tile follows its
  // list poll, but every OTHER studio's tile (and All's sum) would otherwise
  // freeze at mount value for the session — a stale number worn as a
  // confident one on the tile whose job is "where is work". Same 60s
  // cadence, quiet, list path untouched.
  //
  // MAIL-PERF.1 — visibility-gated (use-visible-interval.js): a hidden tab
  // stops the clock; coming back is one immediate refresh, then the cadence.
  // Was a bare setInterval with no focus refresh; the tiles now refresh on a
  // window focus too, which is cheap under counts=only.
  useVisibleInterval(loadTileDigest, POLL_MS, { enabled: multi && scopeReady && !allMode })

  // ── MAIL-ALLLOC.1: All-mode search — a client-side fan-out ───────────
  //
  // One scoped-list request per digest location, merged into the same
  // grouped sections. A failed studio becomes an inline error section while
  // the others render; results are grouped, uncapped, per studio. Reads the
  // digest's location set through the REF so this callback's identity does
  // not churn with every digest poll (see digestRef's own comment).
  const searchFanout = useCallback(async (quiet = false) => {
    const q = debouncedQuery
    const key = `digest-search:${q}`
    listRequest.current = key
    if (!quiet) setLoading(true)
    const targets = (digestRef.current?.locations?.length
      ? digestRef.current.locations.map(l => ({ locationId: l.location_id, name: l.name }))
      : eligible.map(l => ({ locationId: l.id, name: l.name })))
    try {
      const settled = await Promise.all(targets.map(async (l) => {
        try {
          const res = await fetch(buildMailUrl({ locationId: l.locationId, q }), { cache: 'no-store' })
          const body = await res.json()
          if (!body?.success) return [l.locationId, { ok: false }]
          return [l.locationId, {
            ok: true,
            conversations: body.data?.conversations || [],
            searchPartial: !!body.data?.search_partial,
          }]
        } catch {
          return [l.locationId, { ok: false }]
        }
      }))
      if (listRequest.current !== key) return
      const built = buildSearchSections(targets, Object.fromEntries(settled))
      setListError(null)
      setSections(built)
      setConversations(flattenSectionRows(built))
      setNextBefore(null)
      setCountsUnavailable(false)
      // Truncation is said PER SECTION in All mode — the global banner would
      // blame every studio for one studio's partial scan.
      setSearchPartial(false)
    } finally {
      if (listRequest.current === key) setLoading(false)
    }
  }, [debouncedQuery, eligible])

  // The dispatcher every existing "refresh the list" site now goes through:
  // All mode polls the digest (or fans a search out); scoped/single mode is
  // today's list path, untouched.
  const refreshList = useCallback((quiet = false) => {
    if (allMode) return debouncedQuery ? searchFanout(quiet) : loadDigest(quiet)
    return loadList(quiet)
  }, [allMode, debouncedQuery, searchFanout, loadDigest, loadList])

  useEffect(() => { if (scopeReady) refreshList() }, [refreshList, scopeReady])

  // MAIL-PERF.1 — the list poll, visibility-gated. Was setInterval + a focus
  // listener that ran hidden tab or not; the hook keeps the focus refresh and
  // adds: hidden → no clock, visible again → immediate refresh then cadence.
  // The callback travels through a ref, so a refreshList re-created on a
  // scope/view change no longer resets the clock — the effect just above
  // already refetches at that moment.
  const pollList = useCallback(() => refreshList(true), [refreshList])
  useVisibleInterval(pollList, POLL_MS, { enabled: scopeReady })

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
        buildMailUrl({ locationId: scopedId, mailboxId, viewId, before: nextBefore, q: debouncedQuery }),
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
      const res = await fetch(`/api/email/mail/${encodeURIComponent(id)}/seen`, {
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
      const res = await fetch(`/api/email/tickets/${encodeURIComponent(id)}`, { cache: 'no-store' })
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
      setMergedSources(body.data?.merged_sources || [])
      setAttachmentsUnavailable(!!body.data?.attachments_unavailable)
      setReplyRecipients(body.data?.reply_recipients || null)
      // CONTRACTS finding 1+2 — the deep-link mark-read belongs HERE, keyed
      // off a genuinely successful load of THIS id, not off list membership
      // (see deepLinkMarkReadRef's own comment near the top of this file).
      // Unconditional on unread state: the ticket-detail payload carries no
      // `unread` flag to check, and marking an already-read conversation
      // read again is a harmless no-op — the only failure mode worth
      // avoiding is the one this replaces (never marking it at all, or
      // marking the WRONG one later).
      if (deepLinkMarkReadRef.current === id) {
        deepLinkMarkReadRef.current = null
        markRead(id, { incidental: true })
      }
    } catch {
      if (threadFor.current !== id) return
      if (!quiet) setThreadError('Could not load this conversation')
    } finally {
      if (!quiet && threadFor.current === id) setThreadLoading(false)
    }
  }, [markRead])

  useEffect(() => { if (selectedId) loadThread(selectedId) }, [selectedId, loadThread])

  // An open conversation re-reads itself — fast while its newest message is
  // young enough that attachment rows may still be arriving, the list's own
  // 60s otherwise (EMAIL-ATTACH-RACE.1's cadence, shared).
  //
  // MAIL-PERF.1 — visibility-gated like the list (see pollList above). A
  // thread switch no longer restarts the clock (the selectedId effect above
  // loads the new thread at once); a change of cadence still does.
  const threadPollMs = threadRefreshMs(messages)
  const pollThread = useCallback(() => {
    if (selectedId) loadThread(selectedId, { quiet: true })
  }, [selectedId, loadThread])
  useVisibleInterval(pollThread, threadPollMs, { enabled: !!selectedId })


  // MAIL-DEEPLINK.1's reconciliation half — see the effect's own comment
  // where deepLinkReconcileRef is declared, near the top of this file.
  //
  // CONTRACTS finding 1+2 — this used to ALSO mark the row read whenever it
  // matched, which was wrong twice over: (a) mark-read now lives on
  // loadThread's own success (above, near its declaration) — list membership
  // was never "the operator read it", and (b) the ref stayed armed
  // indefinitely, so a match arriving MUCH LATER (new mail landing on the
  // original id during a routine 60s poll, long after the operator moved on)
  // would repaint fields into whatever conversation is on screen NOW — a
  // second surface's row briefly wearing the first one's data. Disarmed
  // unconditionally the first time the list settles (matched or not — this
  // effect gets exactly ONE look) and again early by selectConversation/
  // clearSelection if the operator moves on before the list even answers.
  useEffect(() => {
    if (loading) return // the first list payload has not settled yet
    const id = deepLinkReconcileRef.current
    if (!id) return
    deepLinkReconcileRef.current = null // one attempt, win or lose — never re-armed
    if (selectedId !== id) return // the operator has since moved on
    const row = conversations.find(c => c.id === id)
    if (!row) return
    // `row` first, whatever loadThread already painted last — the ticket
    // detail may carry richer fields (mailbox, contact) the list row does
    // not, and those must not be clobbered by reconciling against it.
    setConversation(prev => ({ ...row, ...(prev || {}) }))
  }, [loading, conversations, selectedId])

  function selectConversation(row) {
    if (!row?.id) return
    threadFor.current = row.id
    setSelectedId(row.id)
    writeSelectedParam(row.id)
    // CONTRACTS finding 1+2 — a normal selection supersedes any still-armed
    // deep link: without this, a MUCH LATER list refresh (or successful
    // thread load) that happens to match the ORIGINAL deep-linked id would
    // repaint fields into whatever conversation is on screen NOW.
    deepLinkReconcileRef.current = null
    deepLinkMarkReadRef.current = null
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
  //
  // MAIL-DEEPLINK.1 — this is also the ONE place `?c=` gets cleared, and that
  // is deliberate rather than an oversight needing a second call site:
  // changeMailbox/changeView (below) both call clearSelection() already (a
  // switch of context is a genuinely fresh one, same reasoning as the notice
  // above), so the param drops for free there too. The id in the URL names a
  // SELECTION; whenever there is none, the URL should stop claiming otherwise.
  // MAIL-ALLLOC.1 — `skipUrl` is for changeScope, which writes ?loc= and
  // clears ?c= in ONE router.replace of its own: two replaces in one handler
  // would each build from the same stale searchParams and the second would
  // silently undo the first's param.
  function clearSelection({ keepNotice = false, skipUrl = false } = {}) {
    threadFor.current = null
    setSelectedId(null)
    if (!skipUrl) writeSelectedParam(null)
    // Same reasoning as selectConversation's own disarm, above.
    deepLinkReconcileRef.current = null
    deepLinkMarkReadRef.current = null
    setConversation(null)
    setMessages([])
    setAttachmentsUnavailable(false)
    setForwarding(null)
    setReplyRecipients(null)
    setThreadError(null)
    if (!keepNotice) setWritebackNotice(null)
    // MAIL-DOCK.1 — `min` is a transient state of an OPEN card. A close from
    // it must hand the NEXT open back to the real mode underneath, or the
    // next conversation would open as a bare title bar nobody asked for.
    unminimiseReader()
  }

  function changeMailbox(id) { setMailboxId(id); clearSelection() }

  // ── MAIL-ALLLOC.1: the scope switch — a tile, a View-all row, or the
  // digest's own fallback all land here ─────────────────────────────────
  //
  // A scope change is a genuinely fresh context, exactly like a mailbox or
  // view switch: selection cleared, search cleared (the same honesty rule as
  // changeView — a search kept across a scope flip would silently rescope
  // its results), account filter reset (it belongs to ONE studio), cursor
  // dropped. The choice persists per user, and `?loc=` mirrors it so the URL
  // stays shareable — written in the SAME replace that drops `?c=`, because
  // two replaces built from one stale searchParams would fight.
  function changeScope(next) {
    if (!multi || next === scope) return
    setScope(next)
    writeMailScope(userId, next)
    const params = new URLSearchParams(searchParams.toString())
    params.delete('c')
    if (next === MAIL_SCOPE_ALL) params.delete('loc')
    else params.set('loc', next)
    const qs = params.toString()
    router.replace(qs ? `/communications/mail?${qs}` : '/communications/mail', { scroll: false })
    setMailboxId(null)
    setQueryText('')
    setDebouncedQuery('')
    setSections(null)
    setConversations([])
    setNextBefore(null)
    clearSelection({ skipUrl: true })
  }

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
  //
  // 🔴 THIS is the write itself — performArchive does not decide WHETHER to
  // run, only HOW. It used to also bail on `actionSaving`, which is the bug
  // Task 2 fixes: an operator hover-archiving five rows click-click-click had
  // clicks 2–5 silently do nothing, because only the click whose POST
  // happened to resolve first got to run. That guard is gone from here; it
  // moves to the QUEUE below, which serialises writes the same way but
  // without dropping any of them.
  const performArchive = useCallback(async (row, archived) => {
    const id = row.id
    setThreadError(null)
    setWritebackNotice(null)
    try {
      const res = await fetch(`/api/email/mail/${encodeURIComponent(id)}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived }),
      })
      const body = await res.json()
      if (!mountedRef.current) return
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
      // over an action that succeeded. Through the dispatcher: in All mode
      // the row came from a digest section, so the digest is what must
      // re-answer (its per-section counts and View-all totals just changed).
      if (mountedRef.current) await refreshList(true)
    } catch {
      if (!mountedRef.current) return
      setThreadError('Could not reach the server — nothing was changed')
    }
    // `conversations`/`selectedId` are read for the successor, so they belong
    // in the dependency list even though the callback is only ever invoked
    // from the queue worker below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, selectedId, viewId, debouncedQuery, refreshList])

  // ── Spam (MAIL-SPAM.1) ─────────────────────────────────────────────
  //
  // Mark as spam / Not spam — POST /api/email/mail/[id]/spam with the STATE
  // asked for, the same shape as archive. The flag is orthogonal to the
  // lifecycle, so this never touches status; the route decides what
  // "release" owes (the push and the unread mirror the quarantine withheld).
  //
  // ROW MEMBERSHIP IS BY THE FLAG, EVEN MID-SEARCH. Unlike archive, where a
  // search deliberately spans inbox and archive, the quarantine is applied to
  // search results too (the route scopes is_spam whatever `q` says) — so a
  // row whose flag no longer matches the view has left this list for real,
  // and keeping it here would be the one thing the next refetch undoes.
  const performSpam = useCallback(async (row, spam) => {
    const id = row.id
    setThreadError(null)
    setWritebackNotice(null)
    try {
      const res = await fetch(`/api/email/mail/${encodeURIComponent(id)}/spam`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spam }),
      })
      const body = await res.json()
      if (!mountedRef.current) return
      if (!body?.success) {
        setThreadError(body?.error || (spam ? 'Could not mark that as spam' : 'Could not release that'))
        return
      }
      const updated = body.data?.conversation
      const stillHere = viewId === 'spam' ? spam : !spam
      if (stillHere) {
        setConversations(prev => prev.map(c => (c.id === id ? { ...c, ...updated } : c)))
        setConversation(prev => (prev?.id === id ? { ...prev, ...updated } : prev))
      } else {
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
      // Quietly, as archive does: the badge and the digest just changed.
      if (mountedRef.current) await refreshList(true)
    } catch {
      if (!mountedRef.current) return
      setThreadError('Could not reach the server — nothing was changed')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, selectedId, viewId, refreshList])

  // The defer verb. Paired with markUnseen() over IMAP by the route, so it
  // survives the poller's convergence — see the seen route's header.
  const performMarkUnread = useCallback(async (row) => {
    const id = row.id
    setWritebackNotice(null)
    try {
      const res = await fetch(`/api/email/mail/${encodeURIComponent(id)}/seen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seen: false }),
      })
      const body = await res.json()
      if (!mountedRef.current) return
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
      if (!mountedRef.current) return
      setThreadError('Could not reach the server — nothing was changed')
    }
  }, [])

  // markRead itself already has no actionSaving guard (it is the incidental
  // side effect of opening a conversation, not a verb an operator mashes) —
  // this is only the queue-worker shape of the button-triggered path.
  const performMarkRead = useCallback(async (row) => {
    await markRead(row.id)
  }, [markRead])

  // ── Action queue ───────────────────────────────────────────────────
  //
  // TASK 2 / MAIL-HOOKS.1 — rapid single archives must not vanish; the
  // serial queue that guarantees it (ref + tick, one write at a time,
  // pending-target toggle map, unmount stop) lives in use-action-queue.js.
  // The perform* callbacks stay HERE because they close over
  // conversations/selectedId/view state — the hook's drain effect is keyed
  // on them so each queued item runs against the CURRENT render's state.
  const { archive, markUnreadAction, markReadAction, spamAction } = useActionQueue({
    performArchive,
    performMarkUnread,
    performMarkRead,
    performSpam,
    setActionSaving,
    setBusyId,
    mountedRef,
  })

  // ── Send / participants ────────────────────────────────────────────
  // Both are the ticket surface's routes, unchanged — see the header.
  async function handleSend(text, internal, extras = {}) {
    const { recipients, attachments = [] } = extras
    if (!selectedId || sending) return { ok: false }
    setSending(true)
    setThreadError(null)
    try {
      const res = await fetch(`/api/email/tickets/${encodeURIComponent(selectedId)}/reply`, {
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
          await refreshList(true)
          return { ok: false, sent: true }
        }
        return { ok: false }
      }
      await loadThread(selectedId)
      // A note changes nothing about the row (deliberately — it must not
      // re-describe the conversation or bump it up the list).
      if (!internal) await refreshList(true)
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
      const res = await fetch(`/api/email/tickets/${encodeURIComponent(id)}/participants`, {
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
    closeCompose()
    refreshList(true)
    // MAIL-DOCK.2 — the send frees the slot, and opening the new ticket is a
    // deliberate open: restore the reader's CARD if compose had minimised it,
    // or the fresh conversation would appear as a bare bar nobody asked for.
    if (newTicket?.id) {
      unminimiseReader()
      selectConversation(newTicket)
    }
  }

  // ── MAIL-ALLLOC.1: compose from All mode ─────────────────────────────
  //
  // The digest carries no mailboxes (it is a triage payload), so the From
  // options are gathered on FIRST compose-open by asking each digest studio's
  // own list route — the exact payload the scoped surface would have had —
  // then grouped by studio name (groupMailboxesByStudio; TicketCompose
  // renders a flat select, and that file is not this task's to change, so
  // "grouped" is the studio name leading each option's label). Cached in a
  // ref for the session: mailbox sets change on an admin's timescale, not a
  // compose's. Scoped/single mode never comes here — compose opens with the
  // list's own mailboxes, exactly as before.
  //
  // A studio that fails the gather contributes no options rather than
  // blocking the composer — losing one studio's From addresses to a blip is
  // recoverable (retry by reopening), an unopenable composer is not. Only
  // when NOTHING loads does the surface refuse, out loud.
  //
  // State, not a ref, because TicketCompose renders from it (react-hooks/refs
  // forbids a `.current` read during render — and rightly: a ref write does
  // not re-render, so the composer could open against a stale value).
  const [composeMailboxes, setComposeMailboxes] = useState(null)
  const [composeLoading, setComposeLoading] = useState(false)

  // MAIL-DOCK.2 — every compose entry lands here. The slot half (variant
  // frozen at open, the reader's card yielding the corner, never opening as
  // a bare title bar) is use-dock-slot's openComposeSlot; what stays here is
  // the freeze of the From options, which is list data, not slot machinery.
  function openComposeCard(boxesOverride) {
    // Audit F3 — freeze the From options NOW: the picker must show exactly
    // the list the send will draw from, whatever the rail does mid-draft.
    // The All path passes its freshly-gathered union explicitly because its
    // setComposeMailboxes has not flushed by the time this runs.
    setComposeBoxesAtOpen(boxesOverride ?? (allMode ? (composeMailboxes || []) : mailboxes))
    openComposeSlot()
  }

  async function openCompose() {
    if (!allMode) { openComposeCard(); return }
    if (composeMailboxes?.length) { openComposeCard(); return }
    setComposeLoading(true)
    try {
      // Audit F4 — same fallback as searchFanout: with no digest answer yet
      // (first seconds of All mode, or a failed digest) the eligible set is
      // still known from the server render, and "could not load" must mean
      // TRIED, not skipped.
      const targets = (digestRef.current?.locations?.length
        ? digestRef.current.locations
        : eligible.map(l => ({ location_id: l.id, name: l.name })))
      const perLocation = await Promise.all(targets.map(async (l) => {
        try {
          const res = await fetch(buildMailUrl({ locationId: l.location_id }), { cache: 'no-store' })
          const body = await res.json()
          return {
            locationId: l.location_id,
            name: l.name,
            mailboxes: body?.success ? (body.data?.mailboxes || []) : [],
          }
        } catch {
          return { locationId: l.location_id, name: l.name, mailboxes: [] }
        }
      }))
      const grouped = groupMailboxesByStudio(perLocation)
      if (!mountedRef.current) return
      if (grouped.length === 0) {
        setListError('Could not load the accounts you can send from — try again')
        return
      }
      setComposeMailboxes(grouped)
      openComposeCard(grouped)
    } finally {
      if (mountedRef.current) setComposeLoading(false)
    }
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
      // MAIL-DOCK.2 — the compose guard is now MODE-AWARE: an open compose
      // CARD (dock, full, or the below-md Modal, which never reaches min)
      // keeps every key inert exactly as before, but a compose MINIMISED to
      // its bar lifts the guard — j/k/e/u flow to the reader again while the
      // draft waits, and Esc inside the card never gets here at all
      // (ComposeDock stops its propagation).
      if (composeBlocksKeys(composeOpen, composeMode) || forwarding || threadModalOpen) return
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
        return
      }
      // MAIL-DOCK.1 — the Esc ladder: full → dock, dock → close, min → close.
      // The guards above are the whole reason Esc can live here at all: while
      // the operator is typing, or while a modal owns the keyboard, this
      // handler already returned — Esc in a compose window is the MODAL's
      // Esc, and stealing it to close the card underneath would throw away a
      // half-written email. The step down (and its never-persist rule) is
      // use-dock-slot's readerEscStep; false means the ladder is exhausted
      // and Esc means close.
      if (key === 'Escape') {
        if (!selectedId) return
        e.preventDefault()
        if (!readerEscStep()) clearSelection()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // `readerMode` stays in the deps even though nothing here reads it
    // directly any more: the handler reads it only THROUGH readerEscStep,
    // whose closure this dep keeps fresh — drop it and Esc in `full` runs a
    // stale step that returns false and CLOSES the conversation instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationIds, conversations, selectedId, archive, composeOpen, composeMode, forwarding, threadModalOpen, readerMode])

  // ── Render ─────────────────────────────────────────────────────────
  // MAIL-DOCK.1 — `relative`, because the dock is an ABSOLUTE card pinned to
  // this shell's bottom-right corner (full mode is viewport-fixed instead and
  // ignores it). The shell's overflow-hidden is what keeps the docked card
  // inside the Mail pane rather than over the sidebar.
  // MAIL-DOCK.2 audit F1 (BLOCKER) — the compose element renders on EVERY
  // return path. Three early returns below swap the whole tree for an
  // EmptyState, and the dock (unlike the old Modal) leaves the rail and
  // tiles clickable mid-draft — a scope switch onto a mailbox-less studio,
  // or a failed digest, would have UNMOUNTED a dirty compose with no
  // confirm. The card is fixed/absolute, so it overlays an EmptyState fine.
  // (Mounted only while open, so a fresh compose never inherits the last
  // one's draft.)
  const composeEl = composeOpen ? (
        <TicketCompose
          key="compose-dock"
          // All mode: the lazily-gathered, studio-labelled union (see
          // openCompose); scoped/single mode: the list's own mailboxes,
          // exactly as before. Sending is unchanged either way — compose
          // takes mailbox_id, and the mailbox carries its own location.
          // Audit F3 — SNAPSHOT at open, never the live list: the dock leaves
          // the rail clickable mid-draft, and a scope switch swapping the
          // prop made the From picker render blank while the send posted the
          // frozen (correct) mailbox_id. What the picker shows is what sends.
          mailboxes={composeBoxesAtOpen}
          initialMailboxId={allMode ? null : mailboxId}
          onClose={closeCompose}
          onSent={handleComposed}
          onSentUnfiled={() => refreshList(true)}
          // MAIL-DOCK.2 — the dock shell, only for a session opened at md+
          // (the variant froze at open, so a resize cannot remount the form
          // mid-draft). Below md there is no shell and TicketCompose renders
          // its Modal byte-for-byte. `dirty` and `requestClose` are the
          // component's own — the card's ✕ and Esc ladder reuse the exact
          // confirm the Modal always had.
          shell={composeVariant === 'dock' ? ({ subject, dirty, requestClose, body, footer }) => (
            <ComposeDock
              mode={composeMode}
              subject={subject}
              readerOccupancy={slotOccupancy(!!selectedId, readerMode)}
              onMinimise={minimiseCompose}
              onRestore={restoreCompose}
              onExpand={() => chooseComposeMode('full')}
              onContract={() => chooseComposeMode('dock')}
              onClose={requestClose}
              onEscape={() => handleComposeEscape(dirty, requestClose)}
              footer={footer}
            >
              {body}
            </ComposeDock>
          ) : undefined}
        />
  ) : null

  const shellClasses =
    'relative flex flex-col h-[calc(100vh-13rem)] min-h-[32rem] rounded-xl border border-un1t-border bg-un1t-bg overflow-hidden'

  if (!multi && !scopedId) {
    return (
      <>
      <div className={shellClasses}>
        <EmptyState
          icon={<Mail size={28} />}
          title="No studio selected"
          description="Pick a location in the sidebar to see its mail."
        />
      </div>
      {composeEl}
      </>
    )
  }

  // MAIL-ALLLOC.1 — "have we anything to show" is mode-shaped: the scoped
  // list's tell is its mailboxes, All mode's is whether any digest ever
  // answered (sections). Both feed the same two guards below.
  const noContentYet = allMode ? sections === null : mailboxes.length === 0
  // No digest locations at all = no studio with a visible mailbox anywhere
  // the caller can read — the same "normal, explained" empty as a single
  // studio with no accounts.
  const noMailboxesAnywhere = allMode ? (sections !== null && sections.length === 0) : mailboxes.length === 0

  // A failed first load leaves us with zero mailboxes for a reason that has
  // nothing to do with access — say THAT, rather than telling an operator
  // their studio has no mail accounts because a fetch blipped.
  if (!loading && listError && noContentYet) {
    return (
      <>
      <div className={shellClasses}>
        <EmptyState
          icon={<AlertCircle size={28} />}
          title="Could not load your mail"
          description={listError}
          action={
            <button
              type="button"
              onClick={() => refreshList()}
              className="inline-flex items-center gap-1.5 rounded-md border border-un1t-border px-2.5 py-1.5 text-xs text-un1t-subtle transition-colors hover:text-un1t-text"
            >
              <RefreshCw size={13} />
              Try again
            </button>
          }
        />
      </div>
      {composeEl}
      </>
    )
  }

  // No mail-surface mailboxes is a NORMAL state — every existing mailbox
  // defaults to the ticket surface, so this is what a studio that has not
  // opted into the trial sees.
  if (!loading && noMailboxesAnywhere) {
    return (
      <>
      <div className={shellClasses}>
        <EmptyState
          icon={<Mail size={28} />}
          title={NO_MAILBOX_EMPTY.title}
          description={NO_MAILBOX_EMPTY.description}
        />
      </div>
      {composeEl}
      </>
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
    // All mode's number is the digest's summed total, last-good under a
    // partial answer and null before anything was ever known (the rail
    // omits null — never a fabricated 0).
    count: v.id === 'needs_reply' ? (allMode ? allTotal : needsReplyCount) : null,
  }))

  // MAIL-ALLLOC.1 — the tile row: eligible names immediately (no flash while
  // the digest is in flight, counts unknown), the digest's own set once it
  // answers. MailRail hides the block below 2 studios.
  const tiles = multi
    ? buildLocationTiles({ eligible, digestLocations: digest?.locations || null, allCount: allTotal })
    : null

  return (
    <>
    <div className={shellClasses}>
      <div className="flex items-center justify-end gap-2 border-b border-un1t-border px-3 py-2">
        <Button type="button" size="sm" variant="secondary" icon={Plus} loading={composeLoading} onClick={openCompose}>
          New email
        </Button>
        <button
          type="button"
          onClick={() => refreshList()}
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
            // All mode never enumerates accounts — the filter belongs to ONE
            // studio (the rail shows its disclosure line instead).
            mailboxes={allMode ? [] : mailboxes}
            mailboxId={mailboxId}
            onMailbox={changeMailbox}
            locationLabel={scopedName}
            tiles={tiles}
            scope={scope}
            onScope={changeScope}
          />
        </div>

        {/* MAIL-DOCK.1 — the list takes the FULL remaining width: the split
            pane is gone, so the comfortable two-line row finally has room
            (flex gives the snippet the space; MailList needed no change).
            Below `md` the selected conversation is still the takeover it
            always was, so the list steps aside exactly as before. */}
        <div
          className={`${selectedId ? 'hidden md:flex' : 'flex'} w-full min-w-0 flex-col`}
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
            // Audit A2 — a mouse CLICK on a row is "open this": it restores a
            // minimised card (else the click retitles an invisible bar and
            // Mail reads as broken). j/k deliberately keep the contracted
            // retarget-without-restoring behaviour — they go through
            // selectConversation directly.
            onSelect={(row) => {
              // MAIL-DOCK.2 — a click ends with the reader as a CARD either
              // way (claimReaderSlot: an open compose card yields the slot,
              // a minimised reader comes back). j/k stay bar-retargeting
              // and never come through here.
              claimReaderSlot()
              selectConversation(row)
            }}
            onArchive={archive}
            onMarkRead={markReadAction}
            onMarkUnread={markUnreadAction}
            busyId={busyId}
            view={view}
            locationName={allMode ? 'All locations' : scopedName}
            showMailbox={!allMode && mailboxes.length > 1}
            mailboxById={mailboxById}
            hasMore={!!nextBefore}
            onLoadMore={loadMore}
            loadingMore={loadingMore}
            countsUnavailable={countsUnavailable}
            density={density}
            searchActive={!!debouncedQuery}
            searchQuery={debouncedQuery}
            searchPartial={searchPartial}
            sections={allMode ? sections : null}
            onScopeLocation={changeScope}
            onRetrySection={() => refreshList()}
          />
        </div>

        {/* MAIL-DOCK.1 — the conversation is a CARD over the list, not a
            pane beside it: mounted only while something is selected, so the
            old "Select a conversation" empty pane has nothing to render on.
            Below `md` MailDock degrades to the plain full-pane thread this
            div always was — mobile is untouched. */}
        {selectedId && (
          <MailDock
            mode={readerMode}
            // MAIL-DOCK.2 — the compose CARD owns right-4 while it is a card;
            // the reader's minimised bar steps left of it so both stay
            // visible and clickable (j/k must still retarget the bar).
            shifted={slotOccupancy(composeOpen, composeMode) === 'card'}
            subject={conversation?.subject}
            needsReply={needsReply(conversation)}
            onMinimise={minimiseReader}
            onRestore={restoreReader}
            onExpand={() => chooseReaderMode('full')}
            onContract={() => chooseReaderMode('dock')}
            onClose={() => clearSelection()}
          >
          <MailThread
            hasSelection={!!selectedId}
            frameSize={readerMode === 'full' ? 'full' : 'dock'}
            mergedSources={mergedSources}
            // MAIL-REFINE.1 — the related-nudge seam: View selects the related
            // row like any list click, and a landed merge/undo re-reads the
            // open thread + the list so nothing shows a state the server left.
            onOpenConversation={(row) => selectConversation(row)}
            onThreadChanged={async () => {
              if (selectedId) await loadThread(selectedId, { quiet: true })
              refreshList(true)
            }}
            onModalOpenChange={setThreadModalOpen}
            conversation={conversation}
            messages={messages}
            replyRecipients={replyRecipients}
            attachmentsUnavailable={attachmentsUnavailable}
            loading={threadLoading}
            error={threadError}
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
            onSpam={(next) => spamAction(conversation, next)}
            onMarkRead={() => markReadAction(conversation)}
            onMarkUnread={() => markUnreadAction(conversation)}
            actionSaving={actionSaving}
          />
          </MailDock>
        )}
      </div>

      {forwarding && conversation && (
        <TicketForward
          ticket={conversation}
          message={forwarding}
          onClose={() => setForwarding(null)}
          onSent={handleForwarded}
        />
      )}
    </div>
    {/* Audit F1 — composeEl is the fragment's SECOND CHILD on every return
        path (the empty-state returns share this exact shape): position
        identity is what keeps React from remounting — and blanking — a
        dirty draft when the tree swaps between the list and an EmptyState. */}
    {composeEl}
    </>
  )
}
