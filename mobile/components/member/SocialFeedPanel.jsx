// Feed segment for the Social screen — sessions, achievements, tier-ups.
// Reactions with optimistic toggle. Paging via "Load more" button.

import { useState, useEffect, useCallback } from 'react'
import { View, Text, Pressable, FlatList, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { api } from '../../lib/member/api'
import Card from './ui/Card'
import ErrorRetry from './ErrorRetry'
import { REACTIONS } from 'shared/social'
import { PEARL } from '../../lib/member/brand'

// ── Helpers ───────────────────────────────────────────────────────────

function relativeTime(tsMs) {
  const diff = Date.now() - tsMs
  const mins = Math.floor(diff / 60_000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(tsMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

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

// ── Reaction row ──────────────────────────────────────────────────────

function ReactionRow({ reactions, entityType, entityId, onOptimisticUpdate }) {
  const [busy, setBusy] = useState(false)

  async function tap(key) {
    if (busy) return
    setBusy(true)
    const wasmine = reactions.mine === key
    onOptimisticUpdate(entityId, key, wasmine)
    try {
      if (wasmine) {
        await api('/api/social/reactions', {
          method: 'DELETE',
          body: { entityType, entityId },
        })
      } else {
        await api('/api/social/reactions', {
          method: 'POST',
          body: { entityType, entityId, reaction: key },
        })
      }
    } catch {
      // optimistic; ignore errors
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
      {REACTIONS.map((r) => {
        const count = reactions?.counts?.[r.key] ?? 0
        const isMine = reactions?.mine === r.key
        return (
          <Pressable
            key={r.key}
            onPress={() => tap(r.key)}
            disabled={busy}
            accessibilityLabel={`${r.label} reaction${count > 0 ? `, ${count}` : ''}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 10,
              paddingVertical: 4,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: isMine ? PEARL : '#2A2A31',
              backgroundColor: isMine ? 'rgba(214,210,201,0.15)' : 'transparent',
              opacity: busy ? 0.6 : 1,
            }}
          >
            <Text style={{ fontSize: 13 }}>{r.emoji}</Text>
            {count > 0 && (
              <Text style={{ fontSize: 11, fontFamily: 'Figtree_600SemiBold', color: isMine ? PEARL : '#B3B2AC' }}>
                {count}
              </Text>
            )}
          </Pressable>
        )
      })}
    </View>
  )
}

// ── Card types ────────────────────────────────────────────────────────

function SessionCard({ item, onOptimisticUpdate }) {
  const statsLine = [
    `${item.points} pts`,
    item.z4plus > 0 ? `${item.z4plus} min Zone 4+` : null,
    `${item.minutes} min`,
  ].filter(Boolean).join(' · ')

  return (
    <Card className="mb-3">
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <Avatar name={item.who} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <Text style={{ fontSize: 14, fontFamily: 'Figtree_600SemiBold', color: '#F1EEE7' }}>{item.who}</Text>
            <Text style={{ fontSize: 12, fontFamily: 'IBMPlexMono_500Medium', color: '#727170' }}>{relativeTime(item.ts)}</Text>
          </View>
          <Text style={{ fontSize: 12, fontFamily: 'Figtree_400Regular', color: '#B3B2AC', marginTop: 2 }} numberOfLines={1}>
            {item.className}
          </Text>
          <Text style={{ fontSize: 13, fontFamily: 'IBMPlexMono_500Medium', color: '#F1EEE7', marginTop: 4 }}>
            {statsLine}
          </Text>
          <ReactionRow
            reactions={item.reactions}
            entityType="session"
            entityId={item.entityId}
            onOptimisticUpdate={onOptimisticUpdate}
          />
        </View>
      </View>
    </Card>
  )
}

function AchievementCard({ item, onOptimisticUpdate }) {
  return (
    <Card className="mb-3">
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <Avatar name={item.who} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <Text style={{ fontSize: 14, fontFamily: 'Figtree_600SemiBold', color: '#F1EEE7' }}>{item.who}</Text>
            <Text style={{ fontSize: 12, fontFamily: 'IBMPlexMono_500Medium', color: '#727170' }}>{relativeTime(item.ts)}</Text>
          </View>
          <Text style={{ fontSize: 12, fontFamily: 'Figtree_400Regular', color: '#B3B2AC', marginTop: 2 }}>
            Unlocked achievement
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <Ionicons name="trophy-outline" size={16} color={PEARL} />
            <Text style={{ fontSize: 13, fontFamily: 'Figtree_600SemiBold', color: '#F1EEE7' }}>{item.name}</Text>
          </View>
          <ReactionRow
            reactions={item.reactions}
            entityType="achievement"
            entityId={item.entityId}
            onOptimisticUpdate={onOptimisticUpdate}
          />
        </View>
      </View>
    </Card>
  )
}

function TierUpCard({ item }) {
  return (
    <Card className="mb-3">
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <Avatar name={item.who} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <Text style={{ fontSize: 14, fontFamily: 'Figtree_600SemiBold', color: '#F1EEE7' }}>{item.who}</Text>
            <Text style={{ fontSize: 12, fontFamily: 'IBMPlexMono_500Medium', color: '#727170' }}>{relativeTime(item.ts)}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <Ionicons name="medal-outline" size={16} color={PEARL} />
            <Text style={{ fontSize: 13, fontFamily: 'Figtree_400Regular', color: '#F1EEE7' }}>
              reached <Text style={{ fontFamily: 'ArchivoExpanded-SemiBold' }}>{item.tier}</Text>
            </Text>
          </View>
        </View>
      </View>
    </Card>
  )
}

// ── Main panel ────────────────────────────────────────────────────────

// `header` (optional): a React node rendered as the FlatList's header. The Social
// screen passes the segmented control here so, when the Feed tab owns the scroll
// (see social.jsx), the control scrolls with the feed and virtualization stays on.
// `contentPadding` (optional): applied to contentContainerStyle when this panel is
// the scroll host (so it can reproduce the parent ScrollView's p-5 pb-24 padding).
export default function SocialFeedPanel({ header = null, contentPadding = false }) {
  const [items, setItems] = useState([])
  const [nextBefore, setNextBefore] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(false)

  const fetchFeed = useCallback(async (before = null) => {
    const path = before
      ? `/api/social/feed?before=${encodeURIComponent(before)}&limit=20`
      : '/api/social/feed?limit=20'
    return api(path)
  }, [])

  const reload = useCallback(() => {
    let cancelled = false
    setError(false)
    setLoading(true)
    fetchFeed().then((d) => {
      if (cancelled) return
      if (d?.success === false) {
        setError(true)
      } else if (d?.ok) {
        setItems(d.items || [])
        setNextBefore(d.nextBefore ?? null)
      }
      setLoading(false)
    }).catch(() => { if (!cancelled) { setError(true); setLoading(false) } })
    return () => { cancelled = true }
  }, [fetchFeed])

  useEffect(() => {
    return reload()
  }, [reload])

  async function loadMore() {
    if (!nextBefore || loadingMore) return
    setLoadingMore(true)
    try {
      const d = await fetchFeed(nextBefore)
      if (d?.ok) {
        setItems((prev) => [...prev, ...(d.items || [])])
        setNextBefore(d.nextBefore ?? null)
      }
    } finally {
      setLoadingMore(false)
    }
  }

  function handleOptimisticUpdate(entityId, key, wasmine) {
    setItems((prev) =>
      prev.map((item) => {
        if (item.entityId !== entityId) return item
        const oldCounts = { ...(item.reactions?.counts ?? {}) }
        const oldMine = item.reactions?.mine ?? null
        if (oldMine && oldCounts[oldMine] !== undefined) {
          oldCounts[oldMine] = Math.max(0, oldCounts[oldMine] - 1)
        }
        let newMine = null
        if (!wasmine) {
          oldCounts[key] = (oldCounts[key] ?? 0) + 1
          newMine = key
        }
        const total = Object.values(oldCounts).reduce((a, v) => a + v, 0)
        return { ...item, reactions: { counts: oldCounts, total, mine: newMine } }
      })
    )
  }

  // Non-list states still need to render the header (the segmented control) so the
  // user can switch tabs. When this panel owns the scroll, `header` is non-null;
  // as an embedded panel (header=null) these render exactly as before. When the
  // panel is the scroll host we also apply the same p-5 padding the FlatList uses
  // via contentContainerStyle, so the header keeps its screen margins.
  const wrapState = (children) => (
    <View style={contentPadding ? { padding: 20 } : undefined}>
      {header}
      {children}
    </View>
  )

  if (loading) {
    return wrapState(
      <View style={{ alignItems: 'center', paddingVertical: 64 }}>
        <ActivityIndicator color="#F1EEE7" />
      </View>
    )
  }

  if (error && items.length === 0) {
    return wrapState(<ErrorRetry onPress={reload} />)
  }

  if (items.length === 0) {
    return wrapState(
      <Card>
        <View style={{ alignItems: 'center', paddingVertical: 32, gap: 8 }}>
          <Ionicons name="people-outline" size={28} color="#727170" />
          <Text style={{ fontSize: 14, fontFamily: 'Figtree_600SemiBold', color: '#F1EEE7' }}>No activity yet</Text>
          <Text style={{ fontSize: 12, fontFamily: 'Figtree_400Regular', color: '#B3B2AC', textAlign: 'center', maxWidth: 240 }}>
            Add friends to see their workouts here.
          </Text>
        </View>
      </Card>
    )
  }

  function renderItem({ item }) {
    if (item.type === 'session') {
      return (
        <SessionCard
          item={item}
          onOptimisticUpdate={handleOptimisticUpdate}
        />
      )
    }
    if (item.type === 'achievement') {
      return (
        <AchievementCard
          item={item}
          onOptimisticUpdate={handleOptimisticUpdate}
        />
      )
    }
    if (item.type === 'tier_up') {
      return <TierUpCard item={item} />
    }
    return null
  }

  function keyExtractor(item) {
    return `${item.type}-${item.entityId ?? item.ts}`
  }

  function ListFooter() {
    if (!nextBefore) return null
    return (
      <Pressable
        onPress={loadMore}
        disabled={loadingMore}
        style={{
          marginTop: 4,
          marginBottom: 12,
          paddingVertical: 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: '#2A2A31',
          backgroundColor: '#1C1C21',
          alignItems: 'center',
          opacity: loadingMore ? 0.5 : 1,
        }}
      >
        {loadingMore
          ? <ActivityIndicator size="small" color="#B3B2AC" />
          : <Text style={{ fontSize: 14, fontFamily: 'Figtree_500Medium', color: '#B3B2AC' }}>Load more</Text>
        }
      </Pressable>
    )
  }

  // When `header` is provided the Social screen renders this panel OUTSIDE its
  // ScrollView, so this FlatList owns the scroll and virtualization is active —
  // off-screen rows unmount instead of accumulating. When embedded (header=null,
  // legacy path) it stays non-scrolling inside the parent ScrollView.
  const ownsScroll = header != null
  return (
    <FlatList
      data={items}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      ListHeaderComponent={header}
      ListFooterComponent={ListFooter}
      scrollEnabled={ownsScroll}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={contentPadding ? { padding: 20, paddingBottom: 96 } : undefined}
      removeClippedSubviews={ownsScroll}
      initialNumToRender={10}
      maxToRenderPerBatch={10}
      windowSize={11}
    />
  )
}
