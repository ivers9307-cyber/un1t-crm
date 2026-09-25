// mobile/components/schedule/CalendarSubscribeRow.jsx
// ICSFEED.1 — "Subscribe to my shifts" on the Schedule tab (Me view).
//
// No link yet → tap makes one and hands it straight to the calendar app
// (iOS: webcal:// → Apple Calendar's subscribe sheet; Android: Google
// Calendar's add-by-URL page). A link already exists → tap asks whether to make
// a new one here (the old one stops) or turn it off. If no calendar app takes
// the link, the Share sheet offers it instead, so the coach can paste it
// anywhere. Every decision lives in lib/calendar-feed.js.

import { useCallback, useState } from 'react'
import { View, Text, Pressable, Alert, Linking, Platform, Share, ActivityIndicator } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { getMyCalendarFeed, createMyCalendarFeed, turnOffMyCalendarFeed } from '../../lib/calendar-feed-api'
import { feedRowModel, subscribeOpenOrder, REPLACE_PROMPT, TURN_OFF_PROMPT } from '../../lib/calendar-feed'

export default function CalendarSubscribeRow() {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await getMyCalendarFeed()
    // A failed read keeps the last good status; with none, the row offers
    // "create", and the server answers 409 if a link exists after all.
    if (r?.success) setStatus(r.data)
  }, [])

  useFocusEffect(useCallback(() => { load() }, [load]))

  async function openSubscription(urls) {
    for (const url of subscribeOpenOrder(Platform.OS, urls)) {
      try {
        await Linking.openURL(url)
        return
      } catch {
        // No app took it; try the next link.
      }
    }
    await Share.share({ message: urls.url }).catch(() => {})
  }

  async function issue(replace) {
    if (busy) return
    setBusy(true)
    try {
      const r = await createMyCalendarFeed({ replace })
      if (!r?.success) {
        if (r?.status === 409) await load()
        Alert.alert('Couldn’t make your calendar link', r?.error || 'Try again in a moment.')
        return
      }
      await openSubscription(r.data)
      await load()
    } finally {
      setBusy(false)
    }
  }

  function confirmTurnOff() {
    Alert.alert(TURN_OFF_PROMPT.title, TURN_OFF_PROMPT.body, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Turn off',
        style: 'destructive',
        onPress: async () => {
          setBusy(true)
          try {
            const r = await turnOffMyCalendarFeed()
            if (!r?.success) Alert.alert('Couldn’t turn it off', r?.error || 'Try again in a moment.')
            await load()
          } finally {
            setBusy(false)
          }
        },
      },
    ])
  }

  const model = feedRowModel(status, Date.now())

  function onPress() {
    if (model.action === 'create') {
      issue(false)
      return
    }
    Alert.alert(REPLACE_PROMPT.title, REPLACE_PROMPT.body, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Turn off', style: 'destructive', onPress: confirmTurnOff },
      { text: 'New link', onPress: () => issue(true) },
    ])
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={model.title}
      className="mt-6 flex-row items-center bg-un1t-surface border border-un1t-border rounded-2xl p-4 active:opacity-70"
    >
      <Ionicons name="calendar-outline" size={20} color="#111827" />
      <View className="flex-1 ml-3">
        <Text className="text-sm font-semibold text-un1t-text">{model.title}</Text>
        <Text className="text-xs text-un1t-subtle mt-0.5">{model.subtitle}</Text>
      </View>
      {busy ? <ActivityIndicator /> : <Ionicons name="chevron-forward" size={18} color="#94A3B8" />}
    </Pressable>
  )
}
