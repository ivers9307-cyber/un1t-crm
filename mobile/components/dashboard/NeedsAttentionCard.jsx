// MOBILE-TODAY-FEED — the "Needs attention" triage card on the Today
// dashboard. Mobile mirror of the feed section on web
// /dashboard/today: one row per queue/watcher the viewer can see
// (server-side gating in /api/mobile/today-feed → fetchTodayFeed),
// count on the right, deep-link where a mobile screen exists
// (today-feed-nav.js — rows without one render non-tappable).
//
// Self-contained like TodayChecklistCard: renders nothing while
// loading, on error, or when the feed is empty (all clear / no queue
// permissions) — staff see exactly the dashboard they had before.
//
// Freshness per the #364 convention: load() is keyed on profile +
// activeLocation (so a "View as user" switch or location flip
// refetches via the replaced context refs) and re-fires on tab focus.

import { View } from 'react-native'
import { useState, useEffect, useCallback } from 'react'
import { useRouter, useFocusEffect } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { fetchTodayFeedRows } from '../../lib/today-feed-api'
import { mobileRouteForFeedRow } from '../../lib/today-feed-nav'
import { SectionHeader, ListCard, PendingRow } from './cards'

// Ionicons name per feed-row id (ids owned by shared/today-feed.js).
const ROW_ICONS = {
  approvals: 'checkmark-done-outline',
  issues: 'alert-circle-outline',
  invoices: 'file-tray-full-outline',
  whatsapp: 'chatbubbles-outline',
  bookings: 'calendar-outline',
  churn: 'pulse-outline',
  tasks: 'checkbox-outline',
  lowfill: 'flag-outline',
}

// One context line under a row: the detail string (e.g. the churn
// delta) followed by up to three item labels — same composition as
// the web feedSubtitle().
function subtitleFor(row) {
  const items = (row.items || []).map((it) =>
    it.sublabel ? `${it.label} (${it.sublabel})` : it.label)
  return [row.detail, ...items].filter(Boolean).join(' · ') || undefined
}

export default function NeedsAttentionCard() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const [rows, setRows] = useState([])

  const load = useCallback(async () => {
    if (!profile) return
    try {
      const res = await fetchTodayFeedRows()
      if (res?.success) setRows(res.data?.rows || [])
    } catch {
      // Best-effort card — keep whatever is on screen; never block Today.
    }
  }, [profile, activeLocation]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])
  useFocusEffect(useCallback(() => { load() }, [load]))

  if (!rows.length) return null

  return (
    <View className="mb-4">
      <SectionHeader title="Needs attention" count={rows.length} />
      <ListCard>
        {rows.map((row, i) => {
          const route = mobileRouteForFeedRow(row.id)
          return (
            <PendingRow
              key={row.id}
              icon={ROW_ICONS[row.id]}
              title={row.label}
              subtitle={subtitleFor(row)}
              time={String(row.count)}
              onPress={route ? () => router.push(route) : undefined}
              isLast={i === rows.length - 1}
            />
          )
        })}
      </ListCard>
    </View>
  )
}
