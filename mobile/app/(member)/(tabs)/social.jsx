// Member social screen — Feed | Friends | Boards segmented control.
// Feed and Boards are placeholders; Friends segment is built.
//
// First-class tab (Wave 4 IA). Route stays /social — (tabs) is a pathless
// group — so the `friend_request`/`feed` push deep-links (/social?seg=friends,
// /social?seg=feed) still land here unchanged.

import { useState, useCallback, useEffect, useRef } from 'react'
import {
  View, Text, ScrollView, TextInput, Pressable,
  ActivityIndicator, Switch, Alert,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { api } from '../../../lib/member/api'
import Card from '../../../components/member/ui/Card'
import ErrorRetry from '../../../components/member/ErrorRetry'
import SocialFeedPanel from '../../../components/member/SocialFeedPanel'
import BoardsPanel from '../../../components/member/BoardsPanel'
import { PEARL } from '../../../lib/member/brand'

const TABS = ['Feed', 'Friends', 'Boards']

// Surface an otherwise-swallowed social action failure (accept/decline/unfriend/
// block). api() returns { success:false, error } instead of throwing, so callers
// check the result and route here. Low-risk, non-blocking: a single OK alert.
function notifyActionFailed(error) {
  Alert.alert(
    'Something went wrong',
    error || "That didn't go through. Please try again.",
  )
}

// ── Avatar initials circle ────────────────────────────────────────────

function Avatar({ name, size = 36 }) {
  const initials = (name || '?')
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return (
    <View
      style={{
        width: size, height: size,
        borderRadius: size / 2,
        backgroundColor: '#24242A',
        borderWidth: 1,
        borderColor: '#2A2A31',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: '#F1EEE7', fontSize: 12, fontFamily: 'Figtree_600SemiBold' }}>{initials}</Text>
    </View>
  )
}

// ── Private mode toggle ───────────────────────────────────────────────

function PrivateModeRow() {
  const [privateMode, setPrivateMode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    api('/api/social/settings').then((d) => { if (d?.ok) setPrivateMode(d.privateMode); setLoaded(true) }).catch(() => setLoaded(true))
  }, [])

  async function toggle(next) {
    if (busy) return
    setBusy(true)
    try {
      const d = await api('/api/social/settings', {
        method: 'PUT',
        body: { privateMode: next },
      })
      if (d?.ok) setPrivateMode(d.privateMode)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mb-4">
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-1">
          <Text className="text-sm font-body-semibold text-chalk">Private mode</Text>
          <Text className="text-xs font-body text-chalk-2 mt-0.5">
            Hides you from search & friends' feeds
          </Text>
        </View>
        <Switch
          value={privateMode}
          onValueChange={toggle}
          disabled={busy || !loaded}
          trackColor={{ false: '#24242A', true: PEARL }}
          thumbColor="#F1EEE7"
          ios_backgroundColor="#24242A"
        />
      </View>
    </Card>
  )
}

// ── Requests section ──────────────────────────────────────────────────

function RequestsSection({ incoming, outgoing, onMutation }) {
  const [busy, setBusy] = useState({})

  async function accept(friendshipId) {
    setBusy((b) => ({ ...b, [friendshipId]: true }))
    try {
      const d = await api('/api/social/friends/accept', { method: 'POST', body: { friendshipId } })
      if (d?.success === false) { notifyActionFailed(d.error); return }
      onMutation()
    } finally {
      setBusy((b) => ({ ...b, [friendshipId]: false }))
    }
  }

  async function decline(friendshipId) {
    setBusy((b) => ({ ...b, [friendshipId]: true }))
    try {
      const d = await api('/api/social/friends/decline', { method: 'POST', body: { friendshipId } })
      if (d?.success === false) { notifyActionFailed(d.error); return }
      onMutation()
    } finally {
      setBusy((b) => ({ ...b, [friendshipId]: false }))
    }
  }

  if (incoming.length === 0 && outgoing.length === 0) return null

  return (
    <View className="mb-4">
      <Text className="font-mono text-[10px] uppercase text-chalk-3 mb-2" style={{ letterSpacing: 2 }}>
        Friend requests
      </Text>
      <Card>
        <View className="gap-3">
          {incoming.map((req) => (
            <View key={req.friendshipId} className="flex-row items-center gap-3">
              <Avatar name={req.name} />
              <Text className="flex-1 text-sm font-body-medium text-chalk" numberOfLines={1}>
                {req.name}
              </Text>
              <Pressable
                onPress={() => accept(req.friendshipId)}
                disabled={busy[req.friendshipId]}
                style={{ backgroundColor: PEARL, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, opacity: busy[req.friendshipId] ? 0.5 : 1 }}
              >
                <Text style={{ color: '#131316', fontSize: 12, fontFamily: 'Figtree_600SemiBold' }}>Accept</Text>
              </Pressable>
              <Pressable
                onPress={() => decline(req.friendshipId)}
                disabled={busy[req.friendshipId]}
                style={{ borderWidth: 1, borderColor: '#2A2A31', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, opacity: busy[req.friendshipId] ? 0.5 : 1 }}
              >
                <Text style={{ color: '#B3B2AC', fontSize: 12, fontFamily: 'Figtree_600SemiBold' }}>Decline</Text>
              </Pressable>
            </View>
          ))}
          {outgoing.map((req) => (
            <View key={req.friendshipId} className="flex-row items-center gap-3">
              <Avatar name={req.name} />
              <Text className="flex-1 text-sm font-body-medium text-chalk" numberOfLines={1}>
                {req.name}
              </Text>
              <Text style={{ fontSize: 12, color: '#727170', fontFamily: 'Figtree_500Medium' }}>Pending</Text>
            </View>
          ))}
        </View>
      </Card>
    </View>
  )
}

// ── Friends list ──────────────────────────────────────────────────────

function FriendsList({ friends, onMutation }) {
  const [busy, setBusy] = useState({})

  function confirmUnfriend(contactId, name) {
    Alert.alert(
      'Remove friend',
      `Remove ${name} from your friends?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unfriend', style: 'destructive', onPress: () => unfriend(contactId) },
        { text: 'Block', style: 'destructive', onPress: () => block(contactId) },
      ]
    )
  }

  async function unfriend(contactId) {
    setBusy((b) => ({ ...b, [contactId]: true }))
    try {
      const d = await api(`/api/social/friends/${contactId}`, { method: 'DELETE' })
      if (d?.success === false) { notifyActionFailed(d.error); return }
      onMutation()
    } finally {
      setBusy((b) => ({ ...b, [contactId]: false }))
    }
  }

  async function block(contactId) {
    setBusy((b) => ({ ...b, [contactId]: true }))
    try {
      const d = await api(`/api/social/friends/${contactId}`, { method: 'POST', body: { block: true } })
      if (d?.success === false) { notifyActionFailed(d.error); return }
      onMutation()
    } finally {
      setBusy((b) => ({ ...b, [contactId]: false }))
    }
  }

  return (
    <View className="mb-4">
      <Text className="font-mono text-[10px] uppercase text-chalk-3 mb-2" style={{ letterSpacing: 2 }}>
        Your friends{friends.length > 0 ? ` (${friends.length})` : ''}
      </Text>
      <Card>
        {friends.length === 0 ? (
          <View className="items-center py-6 gap-2">
            <Ionicons name="people-outline" size={24} color="#727170" />
            <Text className="text-sm font-body text-chalk-2 text-center">
              No friends yet — search below to add some.
            </Text>
          </View>
        ) : (
          <View className="gap-3">
            {friends.map((f) => (
              <View key={f.contactId} className="flex-row items-center gap-3">
                <Avatar name={f.name} />
                <Text className="flex-1 text-sm font-body-medium text-chalk" numberOfLines={1}>
                  {f.name}
                </Text>
                <Pressable
                  onPress={() => confirmUnfriend(f.contactId, f.name)}
                  disabled={busy[f.contactId]}
                  hitSlop={8}
                  style={{ opacity: busy[f.contactId] ? 0.4 : 1 }}
                >
                  <Ionicons name="close-outline" size={20} color="#727170" />
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </Card>
    </View>
  )
}

// ── Search ────────────────────────────────────────────────────────────

function SearchSection({ onMutation }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState({})
  const [sent, setSent] = useState({})
  const debounceRef = useRef(null)

  useEffect(() => {
    return () => { clearTimeout(debounceRef.current) }
  }, [])

  const search = useCallback(async (q) => {
    if (!q.trim()) { setResults([]); return }
    setSearching(true)
    try {
      const d = await api(`/api/social/search?q=${encodeURIComponent(q)}`)
      if (d?.ok) setResults(d.results || [])
    } finally {
      setSearching(false)
    }
  }, [])

  function onChangeText(v) {
    setQuery(v)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => search(v), 350)
  }

  async function sendRequest(contactId) {
    setBusy((b) => ({ ...b, [contactId]: true }))
    try {
      await api('/api/social/friends/request', { method: 'POST', body: { contactId } })
      setSent((s) => ({ ...s, [contactId]: true }))
      onMutation()
      await search(query)
    } finally {
      setBusy((b) => ({ ...b, [contactId]: false }))
    }
  }

  function statusLabel(status) {
    if (status === 'friends') return 'Friends'
    if (status === 'outgoing') return 'Pending'
    if (status === 'incoming') return 'Respond above'
    if (status === 'blocked') return 'Blocked'
    return null
  }

  return (
    <View className="mb-4">
      <Text className="font-mono text-[10px] uppercase text-chalk-3 mb-2" style={{ letterSpacing: 2 }}>
        Add friends
      </Text>
      <Card>
        {/* Search input */}
        <View className="flex-row items-center bg-iron-raised rounded-xl px-3 mb-3" style={{ borderWidth: 1, borderColor: '#2A2A31' }}>
          <Ionicons name="search-outline" size={16} color="#727170" />
          <TextInput
            value={query}
            onChangeText={onChangeText}
            placeholder="Search by name..."
            placeholderTextColor="#727170"
            style={{ flex: 1, color: '#F1EEE7', fontSize: 14, fontFamily: 'Figtree_400Regular', paddingVertical: 10, paddingHorizontal: 8 }}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="search"
          />
          {searching && <ActivityIndicator size="small" color="#727170" />}
        </View>

        {results.length > 0 && (
          <View className="gap-3">
            {results.map((res) => {
              const label = statusLabel(res.status)
              const wasSent = sent[res.contactId]
              const canAdd = !res.status && !wasSent
              return (
                <View key={res.contactId} className="flex-row items-center gap-3">
                  <Avatar name={res.name} />
                  <Text className="flex-1 text-sm font-body-medium text-chalk" numberOfLines={1}>
                    {res.name}
                  </Text>
                  {canAdd ? (
                    <Pressable
                      onPress={() => sendRequest(res.contactId)}
                      disabled={busy[res.contactId]}
                      style={{ backgroundColor: PEARL, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, opacity: busy[res.contactId] ? 0.5 : 1 }}
                    >
                      <Text style={{ color: '#131316', fontSize: 12, fontFamily: 'Figtree_600SemiBold' }}>
                        {busy[res.contactId] ? '...' : 'Add'}
                      </Text>
                    </Pressable>
                  ) : (
                    <Text style={{ fontSize: 12, color: '#727170', fontFamily: 'Figtree_500Medium' }}>
                      {wasSent ? 'Pending' : label}
                    </Text>
                  )}
                </View>
              )
            })}
          </View>
        )}

        {query.trim() && !searching && results.length === 0 && (
          <Text className="text-sm font-body text-chalk-2 text-center py-2">
            No results for "{query}"
          </Text>
        )}

        {!query.trim() && (
          <Text className="text-xs font-body text-chalk-3 text-center">
            Type a name to find people from your gym
          </Text>
        )}
      </Card>
    </View>
  )
}

// ── Suggestions ───────────────────────────────────────────────────────

function SuggestionsSection({ suggestions, friendContactIds, onMutation }) {
  const [busy, setBusy] = useState({})
  const [sent, setSent] = useState({})

  async function sendRequest(contactId) {
    setBusy((b) => ({ ...b, [contactId]: true }))
    try {
      await api('/api/social/friends/request', { method: 'POST', body: { contactId } })
      setSent((s) => ({ ...s, [contactId]: true }))
      onMutation()
    } finally {
      setBusy((b) => ({ ...b, [contactId]: false }))
    }
  }

  if (suggestions.length === 0) return null

  return (
    <View className="mb-4">
      <Text className="font-mono text-[10px] uppercase text-chalk-3 mb-2" style={{ letterSpacing: 2 }}>
        Trained together
      </Text>
      <Card>
        <View className="gap-3">
          {suggestions.map((s) => {
            const isFriend = (friendContactIds || []).includes(s.contactId)
            const wasSent = sent[s.contactId]
            return (
              <View key={s.contactId} className="flex-row items-center gap-3">
                <Avatar name={s.name} />
                <View className="flex-1 min-w-0">
                  <Text className="text-sm font-body-medium text-chalk" numberOfLines={1}>
                    {s.name}
                  </Text>
                  <Text className="text-xs font-body text-chalk-3">
                    {s.sharedClasses} {s.sharedClasses === 1 ? 'class' : 'classes'} together
                  </Text>
                </View>
                {isFriend ? (
                  <Text style={{ fontSize: 12, color: '#727170', fontFamily: 'Figtree_500Medium' }}>Friends</Text>
                ) : wasSent ? (
                  <Text style={{ fontSize: 12, color: '#727170', fontFamily: 'Figtree_500Medium' }}>Pending</Text>
                ) : (
                  <Pressable
                    onPress={() => sendRequest(s.contactId)}
                    disabled={busy[s.contactId]}
                    style={{ backgroundColor: PEARL, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, opacity: busy[s.contactId] ? 0.5 : 1 }}
                  >
                    <Text style={{ color: '#131316', fontSize: 12, fontFamily: 'Figtree_600SemiBold' }}>
                      {busy[s.contactId] ? '...' : 'Add'}
                    </Text>
                  </Pressable>
                )}
              </View>
            )
          })}
        </View>
      </Card>
    </View>
  )
}

// ── Friends panel (assembled) ─────────────────────────────────────────

function FriendsPanel() {
  const [friends, setFriends] = useState([])
  const [friendContactIds, setFriendContactIds] = useState([])
  const [incoming, setIncoming] = useState([])
  const [outgoing, setOutgoing] = useState([])
  const [suggestions, setSuggestions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  // Track whether we've ever loaded data successfully.
  const hasData = friends.length > 0 || incoming.length > 0 || outgoing.length > 0

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const [fr, rq, sg] = await Promise.all([
        api('/api/social/friends'),
        api('/api/social/requests'),
        api('/api/social/suggestions'),
      ])
      // If the primary friends call fails, surface an error (but only when we
      // have no stale data to show).
      if (fr?.success === false) {
        setError(true)
      } else {
        if (fr?.ok) { setFriends(fr.friends || []); setFriendContactIds(fr.friendContactIds || []) }
        if (rq?.ok) { setIncoming(rq.incoming || []); setOutgoing(rq.outgoing || []) }
        if (sg?.ok) setSuggestions(sg.suggestions || [])
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useFocusEffect(useCallback(() => { loadAll() }, [loadAll]))

  if (loading) {
    return (
      <View className="items-center justify-center py-16">
        <ActivityIndicator color="#F1EEE7" />
      </View>
    )
  }

  if (error && !hasData) {
    return <ErrorRetry onPress={loadAll} />
  }

  return (
    <View>
      <PrivateModeRow />
      <RequestsSection incoming={incoming} outgoing={outgoing} onMutation={loadAll} />
      <FriendsList friends={friends} onMutation={loadAll} />
      <SearchSection onMutation={loadAll} />
      <SuggestionsSection suggestions={suggestions} friendContactIds={friendContactIds} onMutation={loadAll} />
    </View>
  )
}

// ── Screen ────────────────────────────────────────────────────────────

const SEG_MAP = { feed: 'Feed', friends: 'Friends', boards: 'Boards' }

export default function SocialScreen() {
  const { seg } = useLocalSearchParams()
  const [tab, setTab] = useState(SEG_MAP[seg] || 'Friends')
  const [disabled, setDisabled] = useState(false)

  useEffect(() => {
    api('/api/social/friends').then(d => { if (d?.disabled) setDisabled(true) }).catch(() => {})
  }, [])

  // Header (title "Social" + dark styling) now comes from the Tabs navigator
  // in (tabs)/_layout.jsx — no per-screen <Stack.Screen> needed.
  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      {(() => {
        if (disabled) {
          return (
            <View className="flex-1 items-center justify-center px-8">
              <Text style={{ color: '#B3B2AC', fontSize: 15, fontFamily: 'Figtree_400Regular', textAlign: 'center' }}>
                Social isn&apos;t switched on at your gym yet.
              </Text>
            </View>
          )
        }

        // Segmented control — shared across all three tabs. Extracted so the Feed
        // tab can hand it to SocialFeedPanel as a FlatList header (letting the feed
        // own the scroll + keep virtualization) while Friends/Boards keep it as the
        // top of the parent ScrollView.
        const segmentedControl = (
          <View className="flex-row rounded-xl bg-iron-surface mb-6 p-1 gap-1" style={{ borderWidth: 1, borderColor: '#2A2A31' }}>
            {TABS.map((t) => (
              <Pressable
                key={t}
                onPress={() => setTab(t)}
                style={{
                  flex: 1,
                  borderRadius: 10,
                  paddingVertical: 8,
                  alignItems: 'center',
                  backgroundColor: tab === t ? PEARL : 'transparent',
                }}
              >
                <Text style={{ fontSize: 14, fontFamily: 'Figtree_600SemiBold', color: tab === t ? '#131316' : '#B3B2AC' }}>
                  {t}
                </Text>
              </Pressable>
            ))}
          </View>
        )

        // Feed tab: render OUTSIDE the ScrollView so the feed's FlatList owns the
        // scroll and virtualizes off-screen rows (fixes unbounded mounted rows).
        // A nested VirtualizedList inside a ScrollView would both disable
        // virtualization and warn — this avoids that entirely.
        if (tab === 'Feed') {
          return <SocialFeedPanel header={segmentedControl} contentPadding />
        }

        // Friends/Boards: short, non-virtualized content — keep them in the
        // ScrollView with the segmented control at the top, exactly as before.
        return (
          <ScrollView contentContainerClassName="p-5 pb-24">
            {segmentedControl}
            {tab === 'Friends' && <FriendsPanel />}
            {tab === 'Boards' && <BoardsPanel />}
          </ScrollView>
        )
      })()}
    </SafeAreaView>
  )
}
