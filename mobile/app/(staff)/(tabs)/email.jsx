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
// Every branchable decision (page merge/dedupe, time granularity, chip
// derivation, swipe verbs, the empty-state ordering, undo insertion) lives
// in mobile/lib/email-tickets.js under test — this file wires verdicts to
// gestures and pixels.

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react'
import {
  View, Text, FlatList, ScrollView, Pressable, RefreshControl,
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
import { listMail, archiveConversation, setConversationSeen } from '../../../lib/email-api'
import MailRow from '../../../components/MailRow'
import IdentitySwitcher from '../../../components/IdentitySwitcher'
import {
  TICKET_VIEW_TABS, DEFAULT_TICKET_VIEW, NO_MAILBOX_EMPTY,
  MAIL_ERROR_STATE, ARCHIVED_FOOTNOTE, ARCHIVE_UNDO_MS,
  ticketViewTab, ticketViewWire, mailListState, mergeMailPages,
  mailboxFilterChips, archiveToggleMeta, readToggleMeta, segCountLabel,
  insertRowAt,
} from '../../../lib/email-tickets'

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
  // { row, index, meta } — the archive UNDO offer (mockup §02).
  const [snack, setSnack] = useState(null)
  const [countsNotice, setCountsNotice] = useState(null)

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
    const seq = ++loadSeqRef.current
    const key = `${viewId}|${mailboxId || ''}`
    if (rowsKeyRef.current !== key) {
      // Audit F5 — a view/filter switch invalidates the OLD view's cursor
      // BEFORE the fetch, not after it succeeds: on a failed switch the
      // stale cursor otherwise stayed live under the new tab, and the next
      // scroll merged an archived page into the inbox rows.
      nextBeforeRef.current = null
      setHasMore(false)
    }
    const res = await listMail(activeLocation.id, {
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
  }, [activeLocation, canEmail, viewId, mailboxId])

  // The next page, on the route's keyset cursor (mockup §02 note 3 — the
  // list finally admits more mail exists). The cursor is INCLUSIVE, so the
  // boundary row repeats and mergeMailPages dedupes by id.
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !nextBeforeRef.current) return
    if (!activeLocation || !canEmail) return
    const seq = loadSeqRef.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    const res = await listMail(activeLocation.id, {
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
  }, [activeLocation, canEmail, viewId, mailboxId])

  useEffect(() => {
    // A view/filter change also retires any pending UNDO: its remembered
    // index belongs to the old list, and the archive it would revert was
    // already committed.
    clearSnack()
    setLoading(true)
    load().finally(() => { setLoading(false); setReady(true) })
  }, [load, clearSnack])

  // Re-fetch on focus so unread weights and statuses settle after coming
  // back from a thread (opening marks seen; replying flips needs-reply).
  // Same cadence as the Messages tab.
  useFocusEffect(
    useCallback(() => {
      load()
    }, [load])
  )

  async function onRefresh() {
    setRefreshing(true)
    await load()
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
    const index = rows.findIndex(r => r.id === row.id)
    setRows(rs => rs.filter(r => r.id !== row.id))
    clearSnack() // a second archive replaces the offer; the first is committed
    setSnack({ row, index, meta })
    snackTimerRef.current = setTimeout(() => {
      snackTimerRef.current = null
      setSnack(null)
    }, ARCHIVE_UNDO_MS)
    const writePromise = archiveConversation(row.id, meta.next, activeLocation?.id)
    // Audit F7 — the snack carries the in-flight write so UNDO can queue
    // BEHIND it: two independent POSTs can reorder on a flaky link, ending
    // server-archived while the UI shows the row restored.
    setSnack(s => (s?.row.id === row.id ? { ...s, writePromise } : s))
    const res = await writePromise
    if (!res.success) {
      // Withdraw the undo offer only if it is still THIS row's — audit
      // finding S3: archive A then B quickly, and A's late failure must not
      // steal B's live 5-second undo.
      setSnack(s => (s?.row.id === row.id ? null : s))
      setRows(rs => insertRowAt(rs, row, index))
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
    setRows(rs => insertRowAt(rs, s.row, s.index))
    // Audit F7 — serialise behind the original write (a failed original is
    // fine: the undo write states the desired end state either way).
    if (s.writePromise) await s.writePromise.catch(() => {})
    const res = await archiveConversation(s.row.id, s.meta.undoTo, activeLocation?.id)
    if (!res.success) {
      // The undo write failed, so the archive stands — take the row back out
      // rather than showing mail in a state the server disagrees with.
      setRows(rs => rs.filter(r => r.id !== s.row.id))
      setError(res.error || 'Could not undo that')
    }
  }

  // Read toggle (left swipe) — the mail-app gesture for "deal with this
  // later". Optimistic flip; a failed write flips it back.
  async function toggleRead(row) {
    swipeRefs.current.get(row.id)?.close?.()
    const meta = readToggleMeta(row)
    setRows(rs => rs.map(r => (r.id === row.id ? { ...r, unread: !meta.seen } : r)))
    const res = await setConversationSeen(row.id, meta.seen, activeLocation?.id)
    if (!res.success) {
      setRows(rs => rs.map(r => (r.id === row.id ? { ...r, unread: row.unread } : r)))
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
            screen, not an input (the whole screen becomes the query there). */}
        <Pressable
          onPress={() => router.push('/email/search')}
          accessibilityRole="button"
          accessibilityLabel="Search mail"
          className="mt-2.5 h-9 rounded-lg bg-un1t-surface border border-un1t-border flex-row items-center px-3 active:opacity-70"
        >
          <Ionicons name="search-outline" size={14} color="#94A3B8" />
          <Text className="text-[13px] text-un1t-muted ml-2" numberOfLines={1}>
            Search mail — names, subjects, anything said
          </Text>
        </Pressable>

        {/* Views as an underline strip: chips-in-a-row read as filters, an
            underline reads as places. Needs reply carries the live count —
            the number staff are paid to drive to zero. */}
        <View className="flex-row mt-3">
          {TICKET_VIEW_TABS.map(v => {
            const active = viewId === v.id
            const count = v.id === 'needs_reply' ? segCountLabel(needsReplyCount) : null
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

      {/* ── Account filter — only once there is a choice to make. ── */}
      {chips.length > 0 && (
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

      {/* A failure with rows still on screen is a banner, not an empty state
          — the loaded list keeps standing. */}
      {error && rows.length > 0 && (
        <View className="bg-red-500/10 border-b border-red-500/30 px-4 py-2">
          <Text className="text-red-700 text-xs">{error}</Text>
        </View>
      )}

      {/* Audit C2 — a failed/truncated read-state scan must never render as
          "all read": without this line every row quietly loses its unread
          weight and the inbox looks fully triaged. */}
      {countsNotice && !error && (
        <View className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-1.5">
          <Text className="text-amber-700 text-[11px]">{countsNotice}</Text>
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
          Hidden with no mailbox: there is no account to send from. It steps
          above the snackbar rather than under it. */}
      {ready && mailboxes.length > 0 && (
        <Pressable
          onPress={() => router.push('/email/compose')}
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
