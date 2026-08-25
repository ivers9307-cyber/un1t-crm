// REPORT-ISSUE.1 — list of the signed-in user's own issue reports,
// newest first. Status pill on each row + a + button to submit a
// new one. Empty state CTAs to the submit form.

import { useState, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, RefreshControl,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { listMyIssues, ISSUE_STATUS_LABELS, ISSUE_STATUS_TONE } from '../../../lib/issues-api'

function StatusPill({ status }) {
  const tone = ISSUE_STATUS_TONE[status] || ISSUE_STATUS_TONE.open
  return (
    <View className={`${tone.bg} ${tone.border} border rounded-full px-2.5 py-0.5`}>
      <Text className={`${tone.fg} text-[11px] font-semibold uppercase tracking-wider`}>
        {ISSUE_STATUS_LABELS[status] || status}
      </Text>
    </View>
  )
}

function timeAgo(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

export default function IssuesListScreen() {
  const router = useRouter()
  const [issues, setIssues] = useState(null)
  const [error, setError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    const r = await listMyIssues()
    if (r.success === false) {
      setError(r.error || 'Could not load reports')
      setIssues([])
      return
    }
    setError(null)
    setIssues(r.data || [])
  }, [])

  useFocusEffect(useCallback(() => {
    let alive = true
    load().catch(() => {})
    return () => { alive = false; void alive }
  }, [load]))

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  if (issues === null) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <ActivityIndicator color="#94A3B8" />
      </View>
    )
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
      >
        {error && (
          <View className="bg-red-500/10 border border-red-500/30 rounded-md p-3 mb-3 flex-row items-start">
            <Ionicons name="alert-circle-outline" size={14} color="#EF4444" style={{ marginTop: 2 }} />
            <Text className="text-[12px] text-red-300 ml-2 flex-1">{error}</Text>
          </View>
        )}

        {issues.length === 0 ? (
          <View className="items-center py-16 px-6">
            <Ionicons name="alert-circle-outline" size={42} color="#475569" />
            <Text className="text-lg font-bold text-un1t-text mt-3 mb-1">No reports yet</Text>
            <Text className="text-sm text-un1t-subtle text-center mb-6">
              Spotted something broken, dirty, or unsafe in the studio? Let the team know with a quick photo.
            </Text>
            <Pressable
              onPress={() => router.push('/issues/new')}
              className="bg-blue-600 active:opacity-80 px-5 py-3 rounded-xl flex-row items-center"
            >
              <Ionicons name="add" size={18} color="#FFFFFF" />
              <Text className="text-white font-bold ml-1.5">Report a problem</Text>
            </Pressable>
          </View>
        ) : (
          <View className="gap-3">
            {issues.map((i) => (
              <Pressable
                key={i.id}
                onPress={() => router.push(`/issues/${i.id}`)}
                className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 active:opacity-80"
              >
                <View className="flex-row items-start justify-between gap-3 mb-1">
                  <StatusPill status={i.status} />
                  <Text className="text-[11px] text-un1t-subtle">{timeAgo(i.created_at)}</Text>
                </View>
                <Text className="text-base text-un1t-text mt-1" numberOfLines={3}>
                  {i.description}
                </Text>
                <View className="flex-row items-center mt-2 gap-3">
                  {i.locations?.name && (
                    <View className="flex-row items-center">
                      <Ionicons name="location-outline" size={11} color="#94A3B8" />
                      <Text className="text-[11px] text-un1t-subtle ml-1">{i.locations.name}</Text>
                    </View>
                  )}
                  {Array.isArray(i.issue_attachments) && i.issue_attachments.length > 0 && (
                    <View className="flex-row items-center">
                      <Ionicons name="image-outline" size={11} color="#94A3B8" />
                      <Text className="text-[11px] text-un1t-subtle ml-1">
                        {i.issue_attachments.length} photo{i.issue_attachments.length === 1 ? '' : 's'}
                      </Text>
                    </View>
                  )}
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>

      {/* FAB */}
      {issues.length > 0 && (
        <Pressable
          onPress={() => router.push('/issues/new')}
          className="absolute bottom-6 right-6 bg-blue-600 active:opacity-80 w-14 h-14 rounded-full items-center justify-center shadow-lg"
        >
          <Ionicons name="add" size={26} color="#FFFFFF" />
        </Pressable>
      )}
    </View>
  )
}
