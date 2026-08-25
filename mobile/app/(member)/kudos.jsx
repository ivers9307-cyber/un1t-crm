// Coach Kudos — full list of shout-outs a member has received from their
// coaches. Newest first. Registered as a normal stack screen in _layout.jsx
// (NOT via NotificationRouter). Reachable from the Home "Coach kudos" card.
//
// Reads public.coach_kudos scoped to the signed-in member. RLS already
// constrains rows to `contact_id = private.auth_contact_id()`, but we ALSO
// add an explicit `.eq('contact_id', contact.id)` — matching the achievements
// screen pattern (defence in depth; a read is only ever the member's own).
//
// On open we fire the mark-seen route (best-effort) so the unseen accent on
// the Home card clears once the member has actually looked.

import { useState, useCallback } from 'react'
import { View, Text, FlatList, ActivityIndicator, RefreshControl, Pressable } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/member/contact-context'
import { supabase } from '../../lib/member/supabase'
import { api } from '../../lib/member/api'
import Card from '../../components/member/ui/Card'
import ErrorRetry from '../../components/member/ErrorRetry'
import { PEARL } from '../../lib/member/brand'
import { toKudosView, kudosRelativeTime, isUnseen } from 'shared/coach-kudos'

const SELECT =
  'id, message, emoji, sender_name, created_at, seen_at'

export default function Kudos() {
  const { contact } = useAuth()
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [rows, setRows] = useState([])
  // Ids that were UNSEEN at load time — drives the "new" accent for this visit
  // so the member can see which kudos are fresh, independent of the local
  // seen_at stamp below (re-audit: the accent used to key on raw seen_at,
  // which went stale the moment the mark-seen call landed server-side).
  const [freshIds, setFreshIds] = useState(() => new Set())
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!contact?.id) { setLoading(false); return }
    setError(null)
    try {
      const { data, error: err } = await supabase
        .from('coach_kudos')
        .select(SELECT)
        // RLS already scopes to self; explicit eq mirrors the achievements screen.
        .eq('contact_id', contact.id)
        .order('created_at', { ascending: false })
        .limit(100)
      if (err) throw err
      const list = data || []
      setRows(list)
      setFreshIds(new Set(list.filter(isUnseen).map((r) => r.id)))

      // Mark everything seen once the member is looking at the full list.
      // Best-effort: a failure just leaves the unseen accent for next time.
      // On success, stamp the local rows too so state matches the server —
      // the visit's "new" accents stay (freshIds), but nothing is stale.
      if (list.some(isUnseen)) {
        api('/api/kudos/seen', { method: 'POST', body: {} })
          .then((r) => {
            if (!r?.ok) return
            const stamp = new Date().toISOString()
            setRows((rs) => rs.map((row) => (row.seen_at ? row : { ...row, seen_at: stamp })))
          })
          .catch(() => {})
      }
    } catch (e) {
      setError(e?.message || 'Failed to load kudos')
    } finally {
      setLoading(false)
    }
  }, [contact?.id])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  useFocusEffect(
    useCallback(() => {
      load()
    }, [load])
  )

  if (loading) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg items-center justify-center">
        <ActivityIndicator color="#F1EEE7" size="large" />
      </SafeAreaView>
    )
  }

  if (error) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg">
        <Header onBack={() => router.back()} />
        <View className="p-5">
          <ErrorRetry
            message="We couldn't load your kudos. If it keeps happening, drop us a line."
            onPress={load}
          />
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-iron-bg">
      <Header onBack={() => router.back()} />
      <FlatList
        contentContainerClassName="px-5 pb-24"
        data={rows}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#F1EEE7" />
        }
        ListHeaderComponent={
          <Text className="mt-1 mb-5 text-sm font-body text-chalk-2">
            Shout-outs from your coaches.
          </Text>
        }
        ListEmptyComponent={
          <Card className="items-center py-8">
            <Ionicons name="chatbubble-ellipses-outline" size={32} color="#727170" />
            <Text className="mt-3 text-base font-body-semibold text-chalk">No kudos yet</Text>
            <Text className="mt-1 text-sm font-body text-chalk-2 text-center">
              Your coaches' shout-outs will show up here.
            </Text>
          </Card>
        }
        ItemSeparatorComponent={() => <View className="h-3" />}
        renderItem={({ item }) => <KudosRow row={item} fresh={freshIds.has(item.id)} />}
      />
    </SafeAreaView>
  )
}

function Header({ onBack }) {
  return (
    <View className="px-5 pt-2 pb-1 flex-row items-center gap-3">
      <Pressable
        onPress={onBack}
        hitSlop={10}
        className="active:opacity-60"
        accessibilityRole="button"
        accessibilityLabel="Back"
      >
        <Ionicons name="chevron-back" size={24} color="#F1EEE7" />
      </Pressable>
      <Text className="text-2xl font-display-bold text-chalk">Coach kudos</Text>
    </View>
  )
}

// `fresh` = was unseen when the list loaded (this visit's "new" accent).
// Deliberately NOT raw seen_at: the mark-seen call stamps rows moments after
// load, and the accent should hold for the visit, then clear next time.
function KudosRow({ row, fresh }) {
  const v = toKudosView(row)
  return (
    <Card className={fresh ? 'border-pearl' : ''}>
      <View className="flex-row gap-3">
        {v.emoji ? (
          <Text className="text-2xl" style={{ lineHeight: 30 }}>{v.emoji}</Text>
        ) : (
          <View className="h-8 w-8 items-center justify-center rounded-full bg-iron-raised">
            <Ionicons name="heart" size={16} color={PEARL} />
          </View>
        )}
        <View className="flex-1 min-w-0">
          <Text className="text-[15px] leading-5 font-body text-chalk">{v.message}</Text>
          <View className="mt-2 flex-row items-center justify-between gap-3">
            <Text className="text-xs font-body-medium text-chalk-2 flex-1" numberOfLines={1}>
              — {v.senderName}
            </Text>
            <Text className="text-xs font-body text-chalk-3">
              {kudosRelativeTime(v.createdAt)}
            </Text>
          </View>
        </View>
      </View>
    </Card>
  )
}
