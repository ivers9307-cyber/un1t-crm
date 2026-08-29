// Mail tab — the studio's email, mail-client shaped (MOBILE-MAIL-REDESIGN.B;
// was MOBILE-MAIL.1's card feed).
//
// EMAIL IS ITS OWN SURFACE, exactly as on web: /communications/mail there,
// this tab here (RETIRE-TICKETS.1 — the ticket queue this screen used to
// mirror is deleted; Mail won the mig-575 A/B). The unified Messages tab
// stays WhatsApp + Instagram.
//
// THE REDESIGN (approved mockup §01/§02/§06): flat edge-to-edge rows with a
// 3px ink rail for unread (MailRow — shared with the search screen, bare),
// a sticky header the screen owns (big "Mail" + location, the search front
// door, underline view segs with a live Needs-reply count), account filter
// chips when there is more than one mailbox, swipe right = archive with a
// five-second UNDO snackbar, swipe left = read toggle, keyset paging on the
// list route's cursor, and a brand-black compose FAB. The native tab header
// is hidden for this screen only — its IdentitySwitcher moves into the
// custom header so dual-identity users lose nothing.
//
// GATED ON `email_inbox`, the TOP-LEVEL key (cross-platform — see
// CROSS_PLATFORM_KEYS in shared/permissions.js). That is the same key every
// /api/email/* route enforces, so the gate that places this tab is the gate
// that lets its calls through. Per-account visibility is a second, separate
// gate (email_mailbox_access), resolved server-side — which is why "no
// mailboxes" is a normal, non-error state here.
//
// Nothing auto-closes: the inbox only shrinks when a person archives, and a
// member's reply brings an archived conversation straight back.
//
// MAIL-ALLLOC.1 — THE MULTI-LOCATION LAYER (locked design). A caller who can
// read Mail at 2+ studios gets a tile row (All + one per studio, each tile
// carrying its needs-reply count) above the view segs, and an All mode that
// renders the estate digest as grouped sticky studio sections — ONE scroll,
// no location pills on rows, each section capped at the digest's five rows
// with a "View all N →" that scopes into that studio (the same move as its
// tile). The chosen scope persists per user (AsyncStorage
// `un1t.mail.scope.<userId>`); scoped mode is today's list pointed at the
// scoped studio; a SINGLE-location caller sees today's UI unchanged — the
// tiles only exist when the digest answers 2+ locations. Swipe verbs on
// digest rows pass THE ROW'S OWN location_id to archive/seen (the per-row
// seam); the account filter appears only when scoped (never a flattened
// cross-studio account list — on this width, nothing renders in All mode).
//
// Every branchable decision (page merge/dedupe, time granularity, chip
// derivation, swipe verbs, the empty-state ordering, undo insertion, and the
// whole multi-location layer via mobile/lib/mail-digest.js) lives in a lib
// under test — this file wires verdicts to gestures and pixels.

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react'
import {
  View, Text, FlatList, SectionList, ScrollView, Pressable, RefreshControl,
  ActivityIndicator,
} from 'react-native'
import { useRouter, useNavigation, useFocusEffect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
// The maintained Swipeable (gesture-handler 2.32 + reanimated 4.5, both
// already in the app — OTA rule: no new native modules).
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import {
  listMail, fetchMailDigest, archiveConversation, setConversationSeen,
} from '../../../lib/email-api'
import MailRow from '../../../components/MailRow'
import IdentitySwitcher from '../../../components/IdentitySwitcher'
import {
  TICKET_VIEW_TABS, DEFAULT_TICKET_VIEW, NO_MAILBOX_EMPTY,
  MAIL_ERROR_STATE, ARCHIVED_FOOTNOTE, ARCHIVE_UNDO_MS,
  ticketViewTab, ticketViewWire, mailListState, mergeMailPages,
  mailboxFilterChips, archiveToggleMeta, readToggleMeta, segCountLabel,
  insertRowAt,
} from '../../../lib/email-tickets'
// MAIL-ALLLOC.1 — every multi-location decision (tiles, sections, scope
// persistence, last-good totals, the optimistic ops over the digest) lives
// in mail-digest.js under test; this screen wires verdicts to pixels.
import {
  ALL_SCOPE, readMailScope, writeMailScope, resolveScope,
  showLocationTiles, locationTiles, tileChipStyle, resolveNeedsReplyTotal,
  buildDigestSections, SECTION_EMPTY_TEXT, sectionUnavailableCopy,
  removeConversation, insertConversation, patchConversation,
  digestCountsNotice, allModeListState, buildScopeParams,
} from '../../../lib/mail-digest'

// ── One swiped row ───────────────────────────────────────────────────
//
// The gesture wraps MailRow HERE, not inside it — the search screen renders
// the same row bare (cross-agent contract). Swiping RIGHT reveals the left
// underlay (archive, in brand ink, the panel following the finger like the
// mockup); swiping LEFT reveals the read toggle. onSwipeableOpen fires once
// the row settles open: the handler closes it and acts, so the row never
// sits half-open while the write runs — the action is optimistic anyway.
function SwipeableMailRow({ row, registerRef, onOpen, onArchive, onToggleRead }) {
  const aMeta = archiveToggleMeta(row)
  const rMeta = readToggleMeta(row)
  return (
    <ReanimatedSwipeable
      ref={(ref) => registerRef(row.id, ref)}
      friction={2}
      leftThreshold={56}
      rightThreshold={56}
      overshootLeft={false}
      overshootRight={false}
      renderLeftActions={() => (
        <View className="flex-1 bg-un1t-text flex-row items-center pl-5">
          <Ionicons name="archive-outline" size={15} color="#FFFFFF" />
          <Text className="text-white text-[11px] font-extrabold tracking-widest ml-2">
            {aMeta.underlay}
          </Text>
        </View>
      )}
      renderRightActions={() => (
        <View className="flex-1 bg-un1t-accent flex-row items-center justify-end pr-5">
          <Text className="text-white text-[11px] font-extrabold tracking-widest mr-2">
            {rMeta.label}
          </Text>
          <Ionicons
            name={rMeta.seen ? 'mail-open-outline' : 'mail-unread-outline'}
            size={15}
            color="#FFFFFF"
          />
        </View>
      )}
      onSwipeableOpen={(direction) => (direction === 'left' ? onArchive() : onToggleRead())}
    >
      <MailRow row={row} onPress={onOpen} onArchiveToggle={onArchive} />
    </ReanimatedSwipeable>
  )
}

// ── The honest states (mockup §06) ───────────────────────────────────
// Which one renders — and crucially in which ORDER — is mailListState's
// verdict, under test. A failure never wears an empty state's clothes.
function MailEmptyState({ state, viewId }) {
  if (state === 'error') {
    return (
      <View className="flex-1 items-center justify-center px-9 py-14">
        <View className="w-12 h-12 rounded-2xl bg-red-500/10 items-center justify-center">
          <Ionicons name="alert-circle-outline" size={22} color="#DC2626" />
        </View>
        <Text className="text-[15px] font-extrabold text-un1t-text mt-3 text-center">
          {MAIL_ERROR_STATE.title}
        </Text>
        <Text className="text-xs text-un1t-subtle mt-1.5 text-center">
          {MAIL_ERROR_STATE.body}
        </Text>
      </View>
    )
  }
  if (state === 'no_mailboxes') {
    return (
      <View className="flex-1 items-center justify-center px-9 py-14">
        <View className="w-12 h-12 rounded-2xl bg-un1t-surface items-center justify-center">
          <Ionicons name="mail-outline" size={22} color="#64748B" />
        </View>
        <Text className="text-[15px] font-extrabold text-un1t-text mt-3 text-center">
          {NO_MAILBOX_EMPTY.title}
        </Text>
        <Text className="text-xs text-un1t-subtle mt-1.5 text-center">
          {NO_MAILBOX_EMPTY.body}
        </Text>
      </View>
    )
  }
  const view = ticketViewTab(viewId)
  return (
    <View className="flex-1 items-center justify-center px-9 py-14">
      <View className="w-12 h-12 rounded-2xl bg-un1t-surface items-center justify-center">
        <Ionicons name="checkmark" size={22} color="#111827" />
      </View>
      <Text className="text-[15px] font-extrabold text-un1t-text mt-3 text-center">
        {view.emptyTitle}
      </Text>
      <Text className="text-xs text-un1t-subtle mt-1.5 text-center">
        {view.emptyBody}
      </Text>
    </View>
  )
}

export default function Email() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const navigation = useNavigation()
  const insets = useSafeAreaInsets()

  const [viewId, setViewId] = useState(DEFAULT_TICKET_VIEW)
  // null = All accounts (send no mailbox_id param).
  const [mailboxId, setMailboxId] = useState(null)
  const [rows, setRows] = useState([])
  const [mailboxes, setMailboxes] = useState([])
  const [needsReplyCount, setNeedsReplyCount] = useState(0)
  const [loading, setLoading] = useState(true)
  // Whether a first load has ever completed. Switching view/filter
  // re-fetches, and swapping the whole screen for a spinner would take the
  // header away from under the finger that just tapped a seg — so the
  // full-screen spinner is for the cold start only; later loads keep the
  // header and spin in the list's place.
  const [ready, setReady] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState(null)
  // { row, index, meta } — the archive UNDO offer (mockup §02). In All mode
  // it carries `all: { locationId, index, conversation }` instead of `index`
  // so UNDO can put the RAW row back into its digest section.
  const [snack, setSnack] = useState(null)
  const [countsNotice, setCountsNotice] = useState(null)

  // ── MAIL-ALLLOC.1 — the estate digest + scope ──────────────────────
  // null until the digest first answers; kept (never cleared) on a failed
  // refresh — the poller's last-good rule.
  const [digestLocations, _setDigestLocations] = useState(null)
  // The summed needs-reply badge under the last-good rule (a partial digest
  // answers null and the last good number stands — never a confident 0).
  const [digestTotal, setDigestTotal] = useState(null)
  const [digestError, setDigestError] = useState(null)
  // 'all' or a location id. Meaningful only when the digest answered 2+
  // locations; defaults to All (the locked design) until a persisted choice
  // hydrates via resolveScope.
  const [scope, setScope] = useState(ALL_SCOPE)
  const digestSeqRef = useRef(0)
  // Which viewId the sections on screen answer — the audit-S1 rule needs it
  // (allModeListState) so a failed load for ANOTHER view never leaves the
  // old view's sections standing mislabeled.
  const digestViewRef = useRef(null)
  const lastGoodTotalRef = useRef(null)
  // The chosen scope (hydrated from AsyncStorage once, then updated on every
  // tile tap). A ref, not state: the digest answer re-resolves scope from it,
  // and hydration must not re-render anything on its own.
  const persistedScopeRef = useRef(null)
  const scopeHydratedRef = useRef(false)
  // Mirror of digestLocations for event handlers (audit M6): a swipe callback
  // reads the LATEST digest, not its render's closure — a focus refetch
  // resolving between render and swipe must not be clobbered by a stale
  // minus-one-row array. Every digest write goes through updateDigest below.
  const digestLocationsRef = useRef(null)
  // Mirror of allMode for loadDigest (identity-stable across mode changes).
  const allModeRef = useRef(false)
  const setDigestLocations = useCallback((next) => {
    const value = typeof next === 'function' ? next(digestLocationsRef.current) : next
    digestLocationsRef.current = value
    _setDigestLocations(value)
  }, [])

  // Paging cursor lives in a ref, not state: only loadMore reads it, and as
  // a dependency it would re-arm the focus effect after every page and
  // double-fetch. `hasMore` is its render-visible shadow (the archived
  // footnote needs it).
  const nextBeforeRef = useRef(null)
  // Monotonic guard: a slow response from a view/filter the user has already
  // left must not clobber the newer list.
  const loadSeqRef = useRef(0)
  const loadingMoreRef = useRef(false)
  const snackTimerRef = useRef(null)
  const swipeRefs = useRef(new Map())

  // The tab is only navigable when this resolves true (shared/mobile-nav →
  // resolveLayoutForUser), but the screen re-checks rather than trusting its
  // own reachability — a stale deep link should read as "not enabled", not
  // as an inbox that 403s on every call.
  const canEmail = canMobile(profile, 'email_inbox', activeLocation)

  // MAIL-ALLLOC.1 — derived mode. Tiles exist only when the digest answered
  // 2+ locations (a single-location caller renders today's UI, unchanged);
  // All mode reads the digest instead of the list; scoped mode is today's
  // list pointed at the scoped studio.
  const multi = showLocationTiles(digestLocations)
  const allMode = multi && scope === ALL_SCOPE
  allModeRef.current = allMode
  // The location every list call and (scoped-mode) swipe write is about. In
  // All mode each ROW carries its own location_id and outranks this.
  const scopedLocationId = multi && scope !== ALL_SCOPE ? scope : activeLocation?.id

  // The screen owns its header (mockup §01): big Mail + location + search +
  // segs. The native one would double the title, so it hides for this tab
  // only; the IdentitySwitcher it carried renders in ours instead.
  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: false })
  }, [navigation])

  // A mailbox filter belongs to the location whose mailboxes it names.
  useEffect(() => { setMailboxId(null) }, [activeLocation?.id])

  const clearSnack = useCallback(() => {
    if (snackTimerRef.current) {
      clearTimeout(snackTimerRef.current)
      snackTimerRef.current = null
    }
    setSnack(null)
  }, [])

  useEffect(() => () => {
    if (snackTimerRef.current) clearTimeout(snackTimerRef.current)
  }, [])

  // First page for the current view + filter. REPLACES the list and resets
  // the cursor — the deliberate paging posture: a re-load (view change,
  // focus, pull) starts from the top rather than trying to patch three
  // loaded pages in place and getting the order subtly wrong.
  // Which (view, account-filter) the rows on screen actually belong to —
  // audit finding S1: keeping the last list on a failed refresh is right for
  // the SAME view ("never a confident zero"), but after a seg switch the
  // kept rows belong to the OLD view and would stand mislabeled under the
  // new tab. A failed load for a DIFFERENT key clears them, so the error
  // empty state renders instead of a quiet lie.
  const rowsKeyRef = useRef(null)

  const load = useCallback(async () => {
    if (!activeLocation || !canEmail) return
    // All mode reads the digest, not the list — loadDigest owns that fetch.
    if (multi && scope === ALL_SCOPE) return
    const locId = multi && scope !== ALL_SCOPE ? scope : activeLocation.id
    const seq = ++loadSeqRef.current
    const key = `${locId}|${viewId}|${mailboxId || ''}`
    if (rowsKeyRef.current !== key) {
      // Audit F5 — a view/filter switch invalidates the OLD view's cursor
      // BEFORE the fetch, not after it succeeds: on a failed switch the
      // stale cursor otherwise stayed live under the new tab, and the next
      // scroll merged an archived page into the inbox rows.
      nextBeforeRef.current = null
      setHasMore(false)
    }
    const res = await listMail(locId, {
      view: ticketViewWire(viewId),
      ...(mailboxId ? { mailboxId } : {}),
    })
    if (seq !== loadSeqRef.current) return // a newer view/filter answered
    if (!res.success) {
      setError(res.error || 'Failed to load your mail')
      if (rowsKeyRef.current !== key) {
        // The rows on screen are another view's — see rowsKeyRef.
        setRows([])
        rowsKeyRef.current = key
      }
      return
    }
    setError(null)
    setRows(res.data || [])
    rowsKeyRef.current = key
    setMailboxes(res.mailboxes || [])
    setNeedsReplyCount(res.needsReplyCount ?? 0)
    // Audit finding C2 — the route forbids either flag to render as "all
    // read"; a failed scan makes every row claim unread:false, so the screen
    // says so instead of looking fully triaged.
    setCountsNotice(res.countsUnavailable
      ? 'Couldn\u2019t check read state \u2014 unread marks may be missing.'
      : res.countsPartial
        ? 'Read state is incomplete on this page.'
        : null)
    nextBeforeRef.current = res.nextBefore ?? null
    setHasMore(res.nextBefore != null)
  }, [activeLocation, canEmail, viewId, mailboxId, multi, scope])

  // MAIL-ALLLOC.1 — the estate digest: tiles for every mode, sections for
  // All mode. Fetched alongside the list on mount/focus/pull (it is also how
  // the screen learns whether tiles should exist at all) and per view change
  // while in All mode (view_total and the section rows answer per view; the
  // tile counts are view-independent). A failure keeps the last good state —
  // the poller's rule — and the scope re-resolves off every answer so a
  // persisted studio that lost its mailboxes falls back to All, never to a
  // broken view.
  const loadDigest = useCallback(async () => {
    if (!canEmail) return
    const seq = ++digestSeqRef.current
    if (!scopeHydratedRef.current) {
      persistedScopeRef.current = await readMailScope(profile?.id)
      scopeHydratedRef.current = true
    }
    const view = viewIdRef.current
    const res = await fetchMailDigest(ticketViewWire(view))
    if (seq !== digestSeqRef.current) return
    if (!res.success) {
      setDigestError(res.error || 'Failed to load your mail')
      return
    }
    setDigestError(null)
    // Audit M2 — in All mode nothing else ever clears a failed-swipe error;
    // a fresh digest answer is the moment the screen is truthful again.
    if (allModeRef.current) setError(null)
    const total = resolveNeedsReplyTotal(res.needsReplyTotal, lastGoodTotalRef.current)
    lastGoodTotalRef.current = total
    setDigestTotal(total)
    setDigestLocations(res.locations)
    digestViewRef.current = view
    if (showLocationTiles(res.locations)) {
      setScope(resolveScope(persistedScopeRef.current, res.locations))
    }
  }, [canEmail, profile?.id, setDigestLocations])

  // viewIdRef mirrors viewId for loadDigest (which must stay identity-stable
  // across view changes so scoped mode does not refetch the digest per seg
  // tap). Declared BEFORE the loading effect so the mirror is current when
  // that effect runs.
  const viewIdRef = useRef(viewId)
  useEffect(() => { viewIdRef.current = viewId }, [viewId])

  // A tile tap (or a section's View-all row). The choice persists per user —
  // fire-and-forget: a scope that could not be saved still applies for this
  // session. The mailbox filter belongs to the location whose accounts it
  // names, so it resets with the scope.
  // Audit M7 — a dual-identity switch swaps profile.id WITHOUT an unmount, and
  // the previous person's hydrated scope must not leak into the next one's
  // resolveScope. Re-hydration happens on the next loadDigest.
  useEffect(() => {
    scopeHydratedRef.current = false
    persistedScopeRef.current = null
  }, [profile?.id])

  const setScopeTo = useCallback((id) => {
    persistedScopeRef.current = id
    setScope(id)
    setMailboxId(null)
    // Audit M2 — an error belongs to the scope that produced it; the next
    // load speaks for the new one.
    setError(null)
    writeMailScope(profile?.id, id)
  }, [profile?.id])

  // The next page, on the route's keyset cursor (mockup §02 note 3 — the
  // list finally admits more mail exists). The cursor is INCLUSIVE, so the
  // boundary row repeats and mergeMailPages dedupes by id.
  // All mode never pages: the digest is a capped triage surface by design
  // (its cursor doesn't exist), and the guard below also keeps a stale
  // cursor from a previous scoped view out of it.
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !nextBeforeRef.current) return
    if (!activeLocation || !canEmail) return
    if (multi && scope === ALL_SCOPE) return
    const locId = multi && scope !== ALL_SCOPE ? scope : activeLocation.id
    const seq = loadSeqRef.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    const res = await listMail(locId, {
      view: ticketViewWire(viewId),
      ...(mailboxId ? { mailboxId } : {}),
      before: nextBeforeRef.current,
    })
    loadingMoreRef.current = false
    setLoadingMore(false)
    if (seq !== loadSeqRef.current) return // the view changed mid-flight
    if (!res.success) {
      // The loaded pages stand; the scroll can simply try again.
      setError(res.error || 'Could not load older conversations')
      return
    }
    setError(null) // an earlier failed page's banner must not outlive a working scroll
    setRows(rs => mergeMailPages(rs, res.data || []))
    nextBeforeRef.current = res.nextBefore ?? null
    setHasMore(res.nextBefore != null)
  }, [activeLocation, canEmail, viewId, mailboxId, multi, scope])

  useEffect(() => {
    // A view/filter/scope change also retires any pending UNDO: its
    // remembered index belongs to the old list, and the archive it would
    // revert was already committed.
    clearSnack()
    setLoading(true)
    const jobs = []
    if (allMode) {
      // Re-fetch only when the sections on screen answer another view — the
      // digest is otherwise refreshed by focus/pull, and entering All mode
      // with a current answer must not spin the whole list for nothing.
      if (digestViewRef.current !== viewId) jobs.push(loadDigest())
    } else {
      jobs.push(load())
      // Cold start: the digest is also how the screen learns single vs multi
      // — ready waits for it so a multi-location caller never flashes the
      // single-location list before the tiles and sections appear.
      if (digestViewRef.current === null) jobs.push(loadDigest())
    }
    Promise.allSettled(jobs).then(() => { setLoading(false); setReady(true) })
  }, [load, loadDigest, allMode, viewId, clearSnack])

  // Re-fetch on focus so unread weights and statuses settle after coming
  // back from a thread (opening marks seen; replying flips needs-reply), and
  // the tile counts alongside them. Same cadence as the Messages tab.
  useFocusEffect(
    useCallback(() => {
      load()
      loadDigest()
    }, [load, loadDigest])
  )

  async function onRefresh() {
    setRefreshing(true)
    // load() no-ops in All mode; the digest refresh covers both.
    await Promise.allSettled([load(), loadDigest()])
    setRefreshing(false)
  }

  const registerSwipeRef = useCallback((id, ref) => {
    if (ref) swipeRefs.current.set(id, ref)
    else swipeRefs.current.delete(id)
  }, [])

  // Archive (or bring back), optimistic with UNDO — mockup §02: the row
  // leaves immediately, the write fires immediately, and the snackbar is
  // the safety net instead of a confirm dialog. A failed write puts the row
  // back and withdraws the undo (there is nothing left to undo).
  async function archiveRow(row) {
    swipeRefs.current.get(row.id)?.close?.()
    const meta = archiveToggleMeta(row)
    // MAIL-ALLLOC.1 — the per-row seam: an All-mode row carries its OWN
    // location_id (stamped by the section builder) and the write must go
    // there, not to the scoped/active location.
    const rowLocationId = row.location_id || scopedLocationId
    const wasAllMode = allMode
    let snackEntry
    if (wasAllMode) {
      // Off the REF (audit M6): a focus refetch resolving between render and
      // this swipe must not be clobbered by the render closure's stale array.
      const { locations, removed } = removeConversation(digestLocationsRef.current, row.id)
      if (!removed) return
      setDigestLocations(locations)
      snackEntry = { row, meta, all: removed }
    } else {
      const index = rows.findIndex(r => r.id === row.id)
      setRows(rs => rs.filter(r => r.id !== row.id))
      snackEntry = { row, index, meta }
    }
    clearSnack() // a second archive replaces the offer; the first is committed
    setSnack(snackEntry)
    snackTimerRef.current = setTimeout(() => {
      snackTimerRef.current = null
      setSnack(null)
    }, ARCHIVE_UNDO_MS)
    const writePromise = archiveConversation(row.id, meta.next, rowLocationId)
    // Audit F7 — the snack carries the in-flight write so UNDO can queue
    // BEHIND it: two independent POSTs can reorder on a flaky link, ending
    // server-archived while the UI shows the row restored.
    setSnack(s => (s?.row.id === row.id ? { ...s, writePromise } : s))
    const res = await writePromise
    // Audit M3 — the tile chips and section headers are server-stamped, never
    // re-derived client-side, so a landed write refetches the digest to let
    // them settle (fire-and-forget; the seq guard drops a superseded answer).
    if (res.success && wasAllMode) loadDigest()
    if (!res.success) {
      // Withdraw the undo offer only if it is still THIS row's — audit
      // finding S3: archive A then B quickly, and A's late failure must not
      // steal B's live 5-second undo.
      setSnack(s => (s?.row.id === row.id ? null : s))
      if (snackEntry.all) {
        setDigestLocations(dl =>
          insertConversation(dl, snackEntry.all.locationId, snackEntry.all.conversation, snackEntry.all.index))
      } else {
        setRows(rs => insertRowAt(rs, row, snackEntry.index))
      }
      setError(res.error || (meta.next ? 'Could not archive that' : 'Could not bring that back'))
    }
    // The write-back half (moving the real message in a connected mailbox)
    // can lag or refuse independently — the server says so in `writeback`,
    // and the DB half above already stands either way. Silent here: the
    // thread screen is where that notice belongs.
  }

  async function undoArchive() {
    const s = snack
    if (!s) return
    clearSnack()
    if (s.all) {
      setDigestLocations(dl => insertConversation(dl, s.all.locationId, s.all.conversation, s.all.index))
    } else {
      setRows(rs => insertRowAt(rs, s.row, s.index))
    }
    // Audit F7 — serialise behind the original write (a failed original is
    // fine: the undo write states the desired end state either way).
    if (s.writePromise) await s.writePromise.catch(() => {})
    const res = await archiveConversation(s.row.id, s.meta.undoTo, s.row.location_id || scopedLocationId)
    if (!res.success) {
      // The undo write failed, so the archive stands — take the row back out
      // rather than showing mail in a state the server disagrees with.
      if (s.all) setDigestLocations(dl => removeConversation(dl, s.row.id).locations)
      else setRows(rs => rs.filter(r => r.id !== s.row.id))
      setError(res.error || 'Could not undo that')
    }
  }

  // Read toggle (left swipe) — the mail-app gesture for "deal with this
  // later". Optimistic flip; a failed write flips it back. In All mode the
  // flip patches the RAW digest conversation (the section builder re-derives
  // the row) and the write carries the row's own location — the same per-row
  // seam as archive.
  async function toggleRead(row) {
    swipeRefs.current.get(row.id)?.close?.()
    const meta = readToggleMeta(row)
    const rowLocationId = row.location_id || scopedLocationId
    const wasAllMode = allMode
    if (wasAllMode) {
      setDigestLocations(dl => patchConversation(dl, row.id, { unread: !meta.seen }))
    } else {
      setRows(rs => rs.map(r => (r.id === row.id ? { ...r, unread: !meta.seen } : r)))
    }
    const res = await setConversationSeen(row.id, meta.seen, rowLocationId)
    if (res.success && wasAllMode) loadDigest() // audit M3 — see archiveRow
    if (!res.success) {
      if (wasAllMode) {
        setDigestLocations(dl => patchConversation(dl, row.id, { unread: row.unread }))
      } else {
        setRows(rs => rs.map(r => (r.id === row.id ? { ...r, unread: row.unread } : r)))
      }
      setError(res.error || 'Could not change the read state')
    }
  }

  if (!canEmail) {
    return (
      <View
        className="flex-1 bg-un1t-bg items-center justify-center px-8"
        style={{ paddingTop: insets.top }}
      >
        <Ionicons name="mail-outline" size={32} color="#94A3B8" />
        <Text className="text-sm text-un1t-subtle mt-2 text-center">
          Mail isn’t enabled for you at this location.
        </Text>
      </View>
    )
  }

  const chips = mailboxFilterChips(mailboxes)
  const listState = mailListState({ error, rows, mailboxes })

  // ── MAIL-ALLLOC.1 render verdicts (all derived in the lib) ──────────
  // Which of All mode's two bodies renders — a failed refresh of the SAME
  // view keeps sections under a banner; sections answering ANOTHER view
  // render the error state instead of a quiet lie.
  const allModeVerdict = allMode
    ? allModeListState({ error: digestError, loadedView: digestViewRef.current, view: viewId })
    : null
  const sections = allMode && allModeVerdict === 'sections'
    ? buildDigestSections(digestLocations)
    : []
  // The Needs-reply seg: the estate sum (last-good) in All mode, the scoped
  // list's own count otherwise.
  const segNeedsReply = allMode ? digestTotal : needsReplyCount
  // Audit M1 — a digest that has NEVER answered while the scoped list loads
  // fine would silently downgrade a multi-studio caller to one studio's mail
  // with nothing on screen saying so: the calm-empty-inbox lie at estate
  // scale. Said out loud instead; the pull that already refetches is the
  // retry. (For a genuinely single-studio caller this is a rare stray notice
  // on a digest blip — over-warning is the safe direction.)
  const digestNeverAnswered = Boolean(digestError) && digestLocations === null
  const bannerText = allMode
    ? (allModeVerdict === 'sections' ? (error || digestError) : error)
    : ((rows.length > 0 ? error : null)
      || (digestNeverAnswered ? 'Couldn\u2019t check mail at your other studios \u2014 pull down to retry.' : null))
  const countsNoticeText = allMode ? digestCountsNotice(digestLocations) : countsNotice
  // Search + compose inherit the scope/studio set through route params
  // (mail-digest.js buildScopeParams; both screens fall back to today's
  // behaviour when the params are absent or malformed).
  const scopeParams = multi ? buildScopeParams(scope, digestLocations) : null

  return (
    <View className="flex-1 bg-un1t-bg">
      {/* ── Sticky header (mockup §01): title + location, the search front
          door, and the view segs as an underline strip. ── */}
      <View
        className="bg-un1t-bg px-4 border-b border-un1t-border"
        style={{ paddingTop: insets.top + 6 }}
      >
        <View className="flex-row items-center justify-between">
          <Text className="text-[26px] font-extrabold tracking-tight text-un1t-text">Mail</Text>
          <View className="flex-row items-center">
            {activeLocation?.name ? (
              <Text className="text-[11px] font-semibold text-un1t-subtle mr-2" numberOfLines={1}>
                {activeLocation.name}
              </Text>
            ) : null}
            <IdentitySwitcher side="staff" />
          </View>
        </View>

        {/* Search is the front door — the field is a doorway to the search
            screen, not an input (the whole screen becomes the query there).
            Multi-location callers hand it the scope: All fans out per studio
            over there; a studio scope searches that studio. */}
        <Pressable
          onPress={() => (scopeParams
            ? router.push({ pathname: '/email/search', params: scopeParams })
            : router.push('/email/search'))}
          accessibilityRole="button"
          accessibilityLabel="Search mail"
          className="mt-2.5 h-9 rounded-lg bg-un1t-surface border border-un1t-border flex-row items-center px-3 active:opacity-70"
        >
          <Ionicons name="search-outline" size={14} color="#94A3B8" />
          <Text className="text-[13px] text-un1t-muted ml-2" numberOfLines={1}>
            Search mail — names, subjects, anything said
          </Text>
        </Pressable>

        {/* ── Location tiles (MAIL-ALLLOC.1, multi only): All + one per
            readable studio, each carrying its needs-reply count — the tile
            row is a triage map before anything is opened. The count is
            ALWAYS needs-reply whatever view is active; an unavailable
            studio's tile makes no claim (no chip, never 0). ── */}
        {multi ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="mt-2.5"
            contentContainerClassName="flex-row"
          >
            {locationTiles(digestLocations, digestTotal).map(t => {
              const active = t.id === scope
              const chip = tileChipStyle(active)
              return (
                <Pressable
                  key={t.id}
                  onPress={() => setScopeTo(t.id)}
                  accessibilityRole="button"
                  accessibilityLabel={t.id === ALL_SCOPE ? 'All locations' : t.label}
                  className={`flex-row items-center rounded-lg border px-2.5 py-1.5 mr-1.5 ${
                    active ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-bg border-un1t-border'
                  }`}
                >
                  <Text className={`text-[12px] font-extrabold ${active ? 'text-white' : 'text-un1t-text'}`}>
                    {t.label}
                  </Text>
                  {t.count ? (
                    <View className={`ml-1.5 px-1.5 py-px rounded-full ${chip.cls}`}>
                      <Text className={`text-[10px] font-extrabold ${chip.text}`}>{t.count}</Text>
                    </View>
                  ) : null}
                </Pressable>
              )
            })}
          </ScrollView>
        ) : null}

        {/* Views as an underline strip: chips-in-a-row read as filters, an
            underline reads as places. Needs reply carries the live count —
            the number staff are paid to drive to zero (the estate sum,
            last-good, in All mode). */}
        <View className="flex-row mt-3">
          {TICKET_VIEW_TABS.map(v => {
            const active = viewId === v.id
            const count = v.id === 'needs_reply' ? segCountLabel(segNeedsReply) : null
            return (
              <Pressable
                key={v.id}
                onPress={() => setViewId(v.id)}
                className={`mr-5 pb-2 flex-row items-center border-b-2 ${
                  active ? 'border-un1t-text' : 'border-transparent'
                }`}
              >
                <Text className={`text-[13px] font-bold ${active ? 'text-un1t-text' : 'text-un1t-subtle'}`}>
                  {v.label}
                </Text>
                {count ? (
                  <View className="ml-1.5 px-1.5 py-px rounded-full bg-un1t-text">
                    <Text className="text-[10px] font-extrabold text-white">{count}</Text>
                  </View>
                ) : null}
              </Pressable>
            )
          })}
        </View>
      </View>

      {/* ── Account filter — only once there is a choice to make, and ONLY
          when scoped to one studio (locked design): All mode never
          enumerates accounts, and on this width the disclosure line is
          dropped rather than squeezed in — never a flattened cross-studio
          account list. ── */}
      {!allMode && chips.length > 0 && (
        <View className="bg-un1t-bg border-b border-un1t-border">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="flex-row px-4 py-2"
          >
            {chips.map(c => {
              const active = mailboxId === c.id
              return (
                <Pressable
                  key={c.id ?? 'all'}
                  onPress={() => setMailboxId(c.id)}
                  className={`px-2.5 py-1 rounded-full mr-1.5 border ${
                    active ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-bg border-un1t-border'
                  }`}
                >
                  <Text className={`text-[11px] font-bold ${active ? 'text-white' : 'text-un1t-subtle'}`}>
                    {c.label}
                  </Text>
                </Pressable>
              )
            })}
          </ScrollView>
        </View>
      )}

      {/* A failure with content still on screen is a banner, not an empty
          state — the loaded list (or the standing sections) keeps standing. */}
      {bannerText && (
        <View className="bg-red-500/10 border-b border-red-500/30 px-4 py-2">
          <Text className="text-red-700 text-xs">{bannerText}</Text>
        </View>
      )}

      {/* Audit C2 — a failed/truncated read-state scan must never render as
          "all read": without this line every row quietly loses its unread
          weight and the inbox looks fully triaged. In All mode the rule sums
          across sections (digestCountsNotice). */}
      {countsNoticeText && !bannerText && (
        <View className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-1.5">
          <Text className="text-amber-700 text-[11px]">{countsNoticeText}</Text>
        </View>
      )}

      {!ready ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : loading && !refreshing ? (
        // A view/filter change, not a cold start — the header stays put.
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : allMode ? (
        /* ── All mode (MAIL-ALLLOC.1): grouped sticky studio sections, ONE
            scroll. Rows render exactly like scoped rows (same MailRow, same
            swipes); the section furniture — header, "View all N", the quiet
            empty, the per-studio error — is the only new element. Empty
            sections stay ([] + ListEmptyComponent covers only the S1 error
            state, when the sections on screen answer another view). ── */
        <SectionList
          className="flex-1"
          sections={sections}
          keyExtractor={(r) => r.id}
          stickySectionHeadersEnabled
          renderItem={({ item }) => (
            <SwipeableMailRow
              row={item}
              registerRef={registerSwipeRef}
              onOpen={() => router.push(`/email/${item.id}`)}
              onArchive={() => archiveRow(item)}
              onToggleRead={() => toggleRead(item)}
            />
          )}
          renderSectionHeader={({ section }) => (
            <View className="bg-un1t-surface border-b border-un1t-border px-4 py-1.5 flex-row items-center justify-between">
              <Text
                className="text-[10px] font-extrabold text-un1t-subtle uppercase"
                style={{ letterSpacing: 1 }}
                numberOfLines={1}
              >
                {section.name || 'Studio'}
              </Text>
              {section.headerDetail ? (
                <Text className="text-[10px] font-extrabold text-amber-700">{section.headerDetail}</Text>
              ) : null}
            </View>
          )}
          renderSectionFooter={({ section }) => {
            if (section.state === 'error') {
              const copy = sectionUnavailableCopy(section.name)
              return (
                <View className="px-4 py-3 border-b border-un1t-border bg-red-500/10 flex-row items-center">
                  <Text className="text-xs text-red-700 flex-1">{copy.text}</Text>
                  <Pressable onPress={() => loadDigest()} hitSlop={8} accessibilityRole="button">
                    <Text className="text-xs font-extrabold text-red-700 underline ml-3">{copy.retry}</Text>
                  </Pressable>
                </View>
              )
            }
            if (section.state === 'empty') {
              return (
                <Text className="px-4 py-3 text-xs text-un1t-muted border-b border-un1t-border">
                  {SECTION_EMPTY_TEXT}
                </Text>
              )
            }
            if (section.viewAllLabel) {
              return (
                <Pressable
                  onPress={() => setScopeTo(section.location_id)}
                  accessibilityRole="button"
                  className="px-4 py-2.5 border-b border-un1t-border bg-un1t-surface items-center active:opacity-70"
                >
                  <Text className="text-xs font-bold text-un1t-text">{section.viewAllLabel}</Text>
                </Pressable>
              )
            }
            return null
          }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />
          }
          contentContainerStyle={{ paddingBottom: 96, flexGrow: 1 }}
          ListEmptyComponent={<MailEmptyState state="error" viewId={viewId} />}
        />
      ) : (
        <FlatList
          className="flex-1"
          data={rows}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => (
            <SwipeableMailRow
              row={item}
              registerRef={registerSwipeRef}
              onOpen={() => router.push(`/email/${item.id}`)}
              onArchive={() => archiveRow(item)}
              onToggleRead={() => toggleRead(item)}
            />
          )}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />
          }
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          contentContainerStyle={{ paddingBottom: 96, flexGrow: 1 }}
          ListEmptyComponent={<MailEmptyState state={listState} viewId={viewId} />}
          ListFooterComponent={
            loadingMore ? (
              <View className="py-3 flex-row items-center justify-center">
                <ActivityIndicator size="small" />
                <Text className="text-xs font-bold text-un1t-subtle ml-2">
                  Loading older conversations…
                </Text>
              </View>
            ) : viewId === 'archived' && rows.length > 0 && !hasMore ? (
              // §06 — why archiving is safe to do freely.
              <Text className="text-[11px] text-un1t-muted text-center px-6 py-3">
                {ARCHIVED_FOOTNOTE}
              </Text>
            ) : null
          }
        />
      )}

      {/* Compose — the one floating object on the screen, in brand black.
          Hidden with no mailbox: there is no account to send from. In All
          mode the digest's presence IS that fact (the route omits locations
          with no visible mailboxes). Multi callers hand compose the studio
          set so its From picker can group by studio. It steps above the
          snackbar rather than under it. */}
      {ready && (allMode ? (digestLocations || []).length > 0 : mailboxes.length > 0) && (
        <Pressable
          onPress={() => (scopeParams
            ? router.push({ pathname: '/email/compose', params: scopeParams })
            : router.push('/email/compose'))}
          accessibilityRole="button"
          accessibilityLabel="New message"
          className={`absolute right-4 ${snack ? 'bottom-24' : 'bottom-6'} w-[52px] h-[52px] rounded-2xl bg-un1t-text items-center justify-center shadow-lg active:opacity-80`}
        >
          <Ionicons name="create-outline" size={20} color="#FFFFFF" />
        </Pressable>
      )}

      {/* UNDO replaces "are you sure" (mockup §02): the archive already
          fired; this brings it back within five seconds. */}
      {snack && (
        <View className="absolute left-3.5 right-3.5 bottom-6 bg-un1t-text rounded-xl px-4 py-3 flex-row items-center justify-between shadow-lg">
          <Text className="text-[13px] font-semibold text-white" numberOfLines={1}>
            {snack.meta.snack}
          </Text>
          <Pressable onPress={undoArchive} hitSlop={10} accessibilityRole="button">
            <Text className="text-[13px] font-extrabold text-white tracking-widest">UNDO</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}
