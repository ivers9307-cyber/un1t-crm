// STUDIO-HUB.1 — mobile TV displays screen.
//
// View the active location's registered TVs + what each is currently
// showing, copy the cast URL (long-press the text to select), and clear
// a TV back to its idle screen. Content authoring (templates / image
// uploads) stays on web — this is the on-the-go visibility + take-down
// surface. Reads/writes tv_displays + tv_content directly (RLS-scoped).

import { useState, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, RefreshControl, Alert,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import { canMobile } from '../../lib/permissions'
import { listTvDisplays, clearTvContent, castUrlForToken } from '../../lib/tv-api'

export default function TvScreen() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()

  const allowed = canMobile(profile, 'tv_displays', activeLocation)

  const [tvs, setTvs] = useState(null)
  const [error, setError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!activeLocation?.id) { setTvs([]); return }
    const r = await listTvDisplays(activeLocation.id)
    if (!r.success) { setError(r.error || 'Failed to load TVs'); setTvs([]); return }
    setError(null)
    setTvs(r.data)
  }, [activeLocation?.id])

  // Re-fetch on focus + whenever the effective identity / location flips
  // (matches the studio cards' impersonation-safe pattern).
  useFocusEffect(useCallback(() => {
    if (allowed) load().catch(() => {})
  }, [allowed, load]))

  async function onRefresh() {
    setRefreshing(true)
    await load().catch(() => {})
    setRefreshing(false)
  }

  function confirmClear(tv) {
    Alert.alert(
      'Clear TV',
      `Clear "${tv.label}"? It will fall back to the idle screen.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            const r = await clearTvContent(tv.id)
            if (!r.success) Alert.alert('Couldn’t clear', r.error || 'Unknown error')
            load().catch(() => {})
          },
        },
      ],
    )
  }

  if (!allowed) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center p-6">
        <Text className="text-sm text-un1t-subtle text-center">
          TV displays aren&apos;t enabled for your role at this location.
        </Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-blue-600">Back</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <ScrollView
      className="flex-1 bg-un1t-bg"
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
    >
      <Text className="text-sm text-un1t-subtle mb-4">
        TVs at {activeLocation?.name || 'your active location'}. Add or design content on the web.
      </Text>

      {tvs === null ? (
        <ActivityIndicator color="#94A3B8" />
      ) : error ? (
        <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3">
          <Text className="text-sm text-red-700">{error}</Text>
        </View>
      ) : tvs.length === 0 ? (
        <Text className="text-sm text-un1t-subtle">No TVs registered at this studio yet. Add one on the web under Admin → TV displays.</Text>
      ) : (
        <View className="gap-3">
          {tvs.map((tv) => (
            <TvCard key={tv.id} tv={tv} onClear={() => confirmClear(tv)} />
          ))}
        </View>
      )}
    </ScrollView>
  )
}

function TvCard({ tv, onClear }) {
  const content = tv.content
  const showing = !!content
  const castUrl = castUrlForToken(tv.token)
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
      <View className="flex-row items-center">
        <Ionicons name="tv-outline" size={18} color="#0EA5E9" />
        <Text className="text-base font-semibold text-un1t-text ml-2 flex-1" numberOfLines={1}>{tv.label}</Text>
        {!tv.active && (
          <View className="bg-gray-500/15 rounded-full px-2 py-0.5">
            <Text className="text-[10px] uppercase tracking-wider text-gray-600">inactive</Text>
          </View>
        )}
      </View>

      <View className="flex-row items-center mt-3">
        <View className={`w-2 h-2 rounded-full mr-2 ${showing ? 'bg-emerald-500' : 'bg-un1t-border'}`} />
        <Text className="text-sm text-un1t-text">
          {showing ? (content.label || `Showing ${content.source_type}`) : 'Idle screen'}
        </Text>
      </View>

      {castUrl ? (
        <View className="mt-3 bg-un1t-bg border border-un1t-border rounded-xl p-2.5">
          <Text className="text-[10px] uppercase tracking-wider text-un1t-subtle mb-0.5">Cast URL</Text>
          <Text selectable className="text-[11px] text-un1t-subtle" numberOfLines={1}>{castUrl}</Text>
        </View>
      ) : null}

      {showing && (
        <Pressable
          onPress={onClear}
          accessibilityRole="button"
          accessibilityLabel={`Clear ${tv.label}`}
          className="mt-3 py-2 rounded-lg items-center border border-red-500/40 active:opacity-70"
        >
          <Text className="text-sm font-semibold text-red-700">Clear to idle</Text>
        </Pressable>
      )}
    </View>
  )
}
