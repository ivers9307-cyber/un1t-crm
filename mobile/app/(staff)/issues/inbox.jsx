// W1 — issue triage: the handler inbox. Owner/master only (gated by the
// issue_triage mobile permission + isHandler server-side). Lists issues
// at the active studio; tap to claim / resolve / close. Open work shows
// first; Resolved / Closed are history tabs.
import { useState, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { useRouter, Stack, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { listInboxIssues, ISSUE_STATUS_LABELS, ISSUE_STATUS_TONE } from '../../../lib/issues-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

const TABS = [
  { key: 'open', label: 'Open', status: undefined },        // server default = open + in_progress
  { key: 'resolved', label: 'Resolved', status: 'resolved' },
  { key: 'closed', label: 'Closed', status: 'closed' },
]

function StatusPill({ status }) {
  const tone = ISSUE_STATUS_TONE[status] || ISSUE_STATUS_TONE.open
  return (
    <View className={`${tone.bg} ${tone.border} border rounded-full px-2.5 py-0.5 self-start`}>
      <Text className={`${tone.fg} text-[10px] font-semibold uppercase tracking-wider`}>
        {ISSUE_STATUS_LABELS[status] || status}
      </Text>
    </View>
  )
}

function fmtWhen(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export default function IssueInbox() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const canTriage = canMobile(profile, 'issue_triage', activeLocation)

  const [tab, setTab] = useState('open')
  const [issues, setIssues] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    const status = TABS.find(t => t.key === tab)?.status
    const res = await listInboxIssues({ status })
    if (res.success === false) { setError(res.error || 'Failed to load issues'); setIssues([]); return }
    setIssues(Array.isArray(res.data) ? res.data : [])
  }, [tab])

  useFocusEffect(useCallback(() => {
    if (!canTriage) { setLoading(false); return }
    load().finally(() => setLoading(false))
  }, [canTriage, load]))

  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false) }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen
        options={{
          title: 'Issue inbox',
          headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" tint="#FFFFFF" />,
        }}
      />

      {!canTriage ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">
            The issue inbox is owner/master only.
          </Text>
        </View>
      ) : (
        <>
          <View className="flex-row gap-2 px-4 pt-3 pb-2">
            {TABS.map(t => {
              const active = tab === t.key
              return (
                <Pressable
                  key={t.key}
                  onPress={() => { setTab(t.key); setLoading(true) }}
                  className={`px-3 py-1.5 rounded-full border ${active ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-surface border-un1t-border'}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text className={`text-xs font-medium ${active ? 'text-un1t-bg' : 'text-un1t-subtle'}`}>{t.label}</Text>
                </Pressable>
              )
            })}
          </View>

          <ScrollView
            contentContainerClassName="px-4 pb-10"
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
          >
            {error && (
              <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
                <Text className="text-red-500 text-sm">{error}</Text>
              </View>
            )}

            {loading ? (
              <View className="py-12 items-center"><ActivityIndicator /></View>
            ) : issues.length === 0 ? (
              <View className="py-16 items-center px-6">
                <Ionicons name="checkmark-done-circle-outline" size={32} color="#10B981" />
                <Text className="text-base font-semibold text-un1t-text mt-3">
                  {tab === 'open' ? 'Nothing to triage' : 'None here'}
                </Text>
                <Text className="text-xs text-un1t-subtle text-center mt-1">
                  {tab === 'open' ? 'Reported issues at this studio will show up here.' : 'Pull down to refresh.'}
                </Text>
              </View>
            ) : (
              issues.map(it => (
                <Pressable
                  key={it.id}
                  onPress={() => router.push(`/issues/inbox/${it.id}`)}
                  className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2 active:opacity-70"
                >
                  <View className="flex-row items-center justify-between mb-1.5">
                    <StatusPill status={it.status} />
                    <View className="flex-row items-center">
                      {Array.isArray(it.issue_attachments) && it.issue_attachments.length > 0 && (
                        <View className="flex-row items-center mr-2">
                          <Ionicons name="image-outline" size={12} color="#94A3B8" />
                          <Text className="text-[11px] text-un1t-subtle ml-0.5">{it.issue_attachments.length}</Text>
                        </View>
                      )}
                      <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
                    </View>
                  </View>
                  <Text className="text-base text-un1t-text" numberOfLines={2}>{it.description}</Text>
                  <Text className="text-[11px] text-un1t-subtle mt-1.5">
                    {it.submitter?.full_name ? `${it.submitter.full_name} · ` : ''}{fmtWhen(it.created_at)}
                  </Text>
                </Pressable>
              ))
            )}
          </ScrollView>
        </>
      )}
    </View>
  )
}
