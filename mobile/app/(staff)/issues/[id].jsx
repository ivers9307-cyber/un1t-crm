// REPORT-ISSUE.1 — drill-in for an issue the user submitted.
// Shows description, status, photos (signed URLs), and the
// resolution notes if the issue has been resolved. Read-only in
// PR 1 — there are no submitter-side actions until we wire close-
// the-loop ack in PR 2.

import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, ActivityIndicator, Image, Pressable } from 'react-native'
import { useLocalSearchParams, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import {
  getMyIssue, getIssueAttachmentUrl,
  ISSUE_STATUS_LABELS, ISSUE_STATUS_TONE,
} from '../../../lib/issues-api'

function StatusPill({ status }) {
  const tone = ISSUE_STATUS_TONE[status] || ISSUE_STATUS_TONE.open
  return (
    <View className={`${tone.bg} ${tone.border} border rounded-full px-2.5 py-0.5 self-start`}>
      <Text className={`${tone.fg} text-[11px] font-semibold uppercase tracking-wider`}>
        {ISSUE_STATUS_LABELS[status] || status}
      </Text>
    </View>
  )
}

function PhotoCard({ issueId, attachment }) {
  const [url, setUrl] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    getIssueAttachmentUrl(issueId, attachment.id).then((r) => {
      if (!alive) return
      if (r.success === false || !r.data?.url) {
        setError(true)
        return
      }
      setUrl(r.data.url)
    })
    return () => { alive = false }
  }, [issueId, attachment.id])

  if (error) {
    return (
      <View className="bg-un1t-surface border border-un1t-border rounded-xl p-3 items-center justify-center" style={{ height: 200 }}>
        <Ionicons name="warning-outline" size={20} color="#F59E0B" />
        <Text className="text-[11px] text-amber-200 mt-1">Could not load photo</Text>
      </View>
    )
  }
  if (!url) {
    return (
      <View className="bg-un1t-surface border border-un1t-border rounded-xl items-center justify-center" style={{ height: 200 }}>
        <ActivityIndicator color="#94A3B8" />
      </View>
    )
  }
  return (
    <Image
      source={{ uri: url }}
      resizeMode="cover"
      style={{ width: '100%', height: 240, borderRadius: 12 }}
    />
  )
}

function fmtDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

export default function IssueDetailScreen() {
  const { id } = useLocalSearchParams()
  const [issue, setIssue] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    const r = await getMyIssue(id)
    if (r.success === false) {
      setError(r.error || 'Could not load report')
      setIssue(null)
      return
    }
    setError(null)
    setIssue(r.data)
  }, [id])

  useFocusEffect(useCallback(() => {
    let alive = true
    load().catch(() => {})
    return () => { alive = false; void alive }
  }, [load]))

  if (error) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center p-6">
        <Ionicons name="alert-circle-outline" size={42} color="#EF4444" />
        <Text className="text-lg font-bold text-un1t-text mt-3 mb-1">Could not load</Text>
        <Text className="text-sm text-un1t-subtle text-center mb-4">{error}</Text>
        <Pressable onPress={load} className="bg-un1t-surface border border-un1t-border px-5 py-2.5 rounded-xl active:opacity-80">
          <Text className="text-un1t-text font-semibold">Try again</Text>
        </Pressable>
      </View>
    )
  }
  if (!issue) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <ActivityIndicator color="#94A3B8" />
      </View>
    )
  }

  const attachments = Array.isArray(issue.issue_attachments) ? issue.issue_attachments : []
  const isResolved = issue.status === 'resolved' || issue.status === 'closed'

  return (
    <ScrollView className="flex-1 bg-un1t-bg" contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      {/* Header */}
      <View className="mb-4">
        <View className="flex-row items-center gap-2 mb-2">
          <StatusPill status={issue.status} />
          {issue.locations?.name && (
            <View className="flex-row items-center">
              <Ionicons name="location-outline" size={11} color="#94A3B8" />
              <Text className="text-[11px] text-un1t-subtle ml-1">{issue.locations.name}</Text>
            </View>
          )}
        </View>
        <Text className="text-[11px] text-un1t-subtle">
          Submitted {fmtDateTime(issue.created_at)}
        </Text>
      </View>

      {/* Description */}
      <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-4">
        <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-1">
          The report
        </Text>
        <Text className="text-base text-un1t-text">{issue.description}</Text>
      </View>

      {/* Photos */}
      {attachments.length > 0 && (
        <View className="mb-4">
          <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2 px-1">
            Photos
          </Text>
          <View className="gap-3">
            {attachments
              .sort((a, b) => (a.position || 0) - (b.position || 0))
              .map((a) => (
                <PhotoCard key={a.id} issueId={issue.id} attachment={a} />
              ))}
          </View>
        </View>
      )}

      {/* Resolution */}
      {isResolved && (
        <View className="bg-green-500/10 border border-green-500/30 rounded-2xl p-4 mb-4">
          <View className="flex-row items-center gap-2 mb-1">
            <Ionicons name="checkmark-circle" size={16} color="#22C55E" />
            <Text className="text-xs font-semibold uppercase tracking-wider text-green-200">
              Resolved {issue.resolved_at ? fmtDateTime(issue.resolved_at) : ''}
            </Text>
          </View>
          {issue.resolution_notes ? (
            <Text className="text-base text-un1t-text mt-1">{issue.resolution_notes}</Text>
          ) : (
            <Text className="text-sm text-un1t-subtle mt-1">No notes added.</Text>
          )}
        </View>
      )}

      {/* Pending state — set expectation */}
      {!isResolved && (
        <View className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4">
          <View className="flex-row items-start gap-2">
            <Ionicons name="time-outline" size={14} color="#F59E0B" style={{ marginTop: 2 }} />
            <Text className="text-[12px] text-amber-200 flex-1">
              The owners at this studio have been notified. You&apos;ll get an update here when they mark it resolved.
            </Text>
          </View>
        </View>
      )}
    </ScrollView>
  )
}
