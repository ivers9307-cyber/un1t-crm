// Modal: My leave (LEAVEPHONE.1).
//
// The coach's own time-off requests — pending, approved, declined, cancelled,
// expired — with the manager's review note. Until this screen the phone showed
// leave only as a card on the day it covers, so a DECLINED request and the
// reason for it were invisible. Reads GET /api/schedule/time-off through
// getMyTimeOff (service-role route; mobile never embeds profiles itself).
// Every decision and every word is in lib/my-leave.js; this file renders.

import { useState, useCallback, useRef } from 'react'
import { useRouter, Stack, useFocusEffect } from 'expo-router'
import { View, Text, Pressable, ScrollView, ActivityIndicator, Alert, RefreshControl } from 'react-native'
import { useAuth } from '../../../lib/auth-context'
import { getMyTimeOff, cancelTimeOffRequest } from '../../../lib/schedule-api'
import {
  myLeaveSections, stillCancellable, myLeaveCancelOutcome,
  MY_LEAVE_EMPTY, MY_LEAVE_CANCEL_CONFIRM, MY_LEAVE_NO_LONGER_PENDING,
} from '../../../lib/my-leave'
import { createInFlightGuard } from '../../../lib/in-flight-guard'

// Status chips: the house recipe, bg-<c>-500/10 + text-<c>-700. Written out as
// whole literal class names — NativeWind only compiles classes it can see.
const TONE = {
  amber: { bg: 'bg-amber-500/10', text: 'text-amber-700' },
  green: { bg: 'bg-green-500/10', text: 'text-green-700' },
  red: { bg: 'bg-red-500/10', text: 'text-red-700' },
  slate: { bg: 'bg-slate-500/10', text: 'text-slate-700' },
}

export default function MyLeave() {
  const { activeLocation, profile } = useAuth()
  const router = useRouter()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const cancelGuard = useRef(null)
  if (cancelGuard.current === null) cancelGuard.current = createInFlightGuard()

  // Resolves the fresh rows, or null when the read failed (the cancel path
  // needs to tell "not pending any more" from "could not find out").
  const load = useCallback(async () => {
    if (!profile?.id) { setLoading(false); return null }
    // No locationId: leave covers the person, so the list is every request of
    // theirs wherever it was filed. profile_id keeps a MANAGER's list to their
    // own rows (the route would otherwise return their whole studio's), and
    // myLeaveSections drops anything that is not the caller's regardless.
    const res = await getMyTimeOff({ profileId: profile.id })
    setLoading(false)
    if (!res?.success) { setError(res?.error || 'Failed to load your leave'); return null }
    const fresh = Array.isArray(res.data) ? res.data : []
    setError(null)
    setRows(fresh)
    return fresh
  }, [profile?.id])

  useFocusEffect(useCallback(() => { load() }, [load]))

  async function refresh() {
    setRefreshing(true)
    try { await load() } finally { setRefreshing(false) }
  }

  function cancel(row) {
    Alert.alert(
      MY_LEAVE_CANCEL_CONFIRM.title,
      MY_LEAVE_CANCEL_CONFIRM.message,
      [
        { text: MY_LEAVE_CANCEL_CONFIRM.keep, style: 'cancel' },
        {
          text: MY_LEAVE_CANCEL_CONFIRM.confirm,
          style: 'destructive',
          onPress: () => cancelGuard.current.run(async () => {
            // Re-read first: a manager may have decided it while this list sat
            // on screen, and the server does not refuse every such cancel (see
            // lib/my-leave.js). Not pending any more = nothing is sent; the
            // fresh read has already redrawn the row as it now is. A failed
            // re-read (null) sends nothing either; load() has set the banner.
            const fresh = await load()
            if (fresh === null) return
            if (!stillCancellable(fresh, row.id, profile)) {
              Alert.alert(MY_LEAVE_NO_LONGER_PENDING.title, MY_LEAVE_NO_LONGER_PENDING.message)
              return
            }
            const res = await cancelTimeOffRequest(row.id, activeLocation?.id)
            const failed = myLeaveCancelOutcome(res)
            if (failed) Alert.alert(failed.title, failed.message)
            // Refresh on ANY outcome, so the list is what the server now holds.
            await load()
          }),
        },
      ],
    )
  }

  const sections = myLeaveSections(rows, profile)

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen
        options={{
          title: 'My leave',
          headerLeft: () => (
            <Pressable
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/schedule'))}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close My leave"
            >
              <Text className="text-base text-un1t-text">Close</Text>
            </Pressable>
          ),
        }}
      />
      <ScrollView
        contentContainerClassName="p-4 pb-10"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        {error ? (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
            <Text className="text-red-700 text-sm">{error}</Text>
          </View>
        ) : null}

        {loading ? (
          <View className="py-10 items-center"><ActivityIndicator /></View>
        ) : sections.length === 0 ? (
          error ? null : (
            <View className="py-10 items-center">
              <Text className="text-sm text-un1t-subtle">{MY_LEAVE_EMPTY}</Text>
            </View>
          )
        ) : sections.map((section) => (
          <View key={section.key} className="mb-5">
            <Text className="text-xs uppercase tracking-wider text-un1t-subtle px-2 mb-2">{section.title}</Text>
            {section.rows.map((r) => (
              <View key={r.id} className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2">
                <View className="flex-row items-center justify-between">
                  <Text className="text-base font-semibold text-un1t-text">{r.title}</Text>
                  <View className={`px-2.5 py-1 rounded-full ${(TONE[r.tone] || TONE.slate).bg}`}>
                    <Text className={`text-xs font-semibold ${(TONE[r.tone] || TONE.slate).text}`}>{r.statusLabel}</Text>
                  </View>
                </View>
                <Text className="text-sm text-un1t-text mt-1">{r.summary}</Text>
                {r.reason ? <Text className="text-xs text-un1t-subtle mt-1">{r.reason}</Text> : null}
                {r.note ? (
                  <View className="mt-3 pt-3 border-t border-un1t-border">
                    <Text className="text-xs uppercase tracking-wider text-un1t-subtle">{r.noteHeading}</Text>
                    <Text className="text-sm text-un1t-text mt-1">{r.note}</Text>
                  </View>
                ) : null}
                {r.canCancel ? (
                  <Pressable
                    onPress={() => cancel(r)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`${MY_LEAVE_CANCEL_CONFIRM.confirm}: ${r.title}, ${r.range}`}
                    className="self-start mt-3 px-3 py-1.5 rounded-full bg-un1t-surface border border-amber-500/40 active:opacity-70"
                  >
                    <Text className="text-xs font-semibold text-amber-700">{MY_LEAVE_CANCEL_CONFIRM.confirm}</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  )
}
