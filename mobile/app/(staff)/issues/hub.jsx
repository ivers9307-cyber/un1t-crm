// REPORTS-HUB.1 — the Reports landing screen on mobile.
//
// One "Reports" tile in More opens this. It nests the two issue
// surfaces and routes by access level (Richard's design):
//   • submit + own-history only (all staff)  → straight to My reports
//   • + triage (owner/master)                → a chooser with both cards
// Submitting folds in — the standalone Report tile is gone; My reports
// keeps its + FAB. A single-surface user never sees the chooser (the
// Redirect is instant).

import { useState, useCallback } from 'react'
import { View, Text, Pressable, ScrollView } from 'react-native'
import { useRouter, Redirect, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { resolveLayoutForUser } from '../../../lib/mobile-layout'
import { canMobile } from '../../../lib/permissions'
import { reportsLanding } from '../../../lib/reports'
import { listInboxIssues } from '../../../lib/issues-api'

function ChoiceCard({ icon, title, subtitle, badge, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 flex-row items-center active:opacity-70"
    >
      <View className="w-12 h-12 rounded-full bg-un1t-border/40 items-center justify-center mr-4">
        <Ionicons name={icon} size={24} color="#111827" />
      </View>
      <View className="flex-1">
        <View className="flex-row items-center">
          <Text className="text-base font-semibold text-un1t-text">{title}</Text>
          {badge ? (
            <View className="ml-2 bg-amber-500 rounded-full min-w-[20px] h-5 px-1.5 items-center justify-center">
              <Text className="text-[11px] text-white font-bold">{badge}</Text>
            </View>
          ) : null}
        </View>
        <Text className="text-sm text-un1t-subtle mt-0.5">{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color="#94A3B8" />
    </Pressable>
  )
}

export default function ReportsHub() {
  const router = useRouter()
  const { profile, activeLocation } = useAuth()

  const canTriage = canMobile(profile, 'issue_triage', activeLocation)
  const { more } = resolveLayoutForUser(profile, activeLocation)
  const canSubmit = new Set(more).has('issues')
  const landing = reportsLanding({ canSubmit, canTriage })

  // Open-inbox count for the badge on the Issue inbox card (handlers only).
  const [openCount, setOpenCount] = useState(0)
  useFocusEffect(useCallback(() => {
    if (!canTriage) return
    let alive = true
    listInboxIssues().then((res) => {
      if (alive && res.success !== false && Array.isArray(res.data)) setOpenCount(res.data.length)
    }).catch(() => {})
    return () => { alive = false }
  }, [canTriage]))

  if (!profile) return null

  // Single-surface users skip the chooser entirely — they never see it.
  if (landing === 'inbox') return <Redirect href="/issues/inbox" />
  if (landing === 'myreports') return <Redirect href="/issues" />

  // Both surfaces → let them choose what to view.
  return (
    <ScrollView className="flex-1 bg-un1t-bg" contentContainerClassName="p-4">
      <Text className="text-sm text-un1t-subtle mb-3">What would you like to view?</Text>
      <View className="gap-3">
        <ChoiceCard
          icon="document-text-outline"
          title="My reports"
          subtitle="Report a problem & track your own submissions"
          onPress={() => router.push('/issues')}
        />
        <ChoiceCard
          icon="construct-outline"
          title="Issue inbox"
          subtitle="Triage issues reported at this studio"
          badge={openCount > 0 ? String(openCount) : null}
          onPress={() => router.push('/issues/inbox')}
        />
      </View>
    </ScrollView>
  )
}
