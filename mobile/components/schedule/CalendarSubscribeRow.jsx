// mobile/components/schedule/CalendarSubscribeRow.jsx
// ICSFEED.1 — "Subscribe to my shifts" on the Schedule tab (Me view).
//
// No link yet → tap makes one, then offers a CHOICE: Apple Calendar (iOS,
// webcal://), Google Calendar, and always Share / copy link (the https URL, so
// a Google Calendar user on iOS can get it too). The link is shown once, so it
// is kept in state for the rest of the session: the row then reads "Add my
// shifts to a calendar" and tapping it offers the choice again. A link that
// already exists (and is not in hand) → tap asks whether to make a new one
// (the old one stops) or turn it off. An open that throws falls back to the
// share sheet. A long press always reaches "new link / turn off". Every
// decision lives in lib/calendar-feed.js.

import { useCallback, useState } from 'react'
import { View, Text, Pressable, Alert, Linking, Platform, Share, ActivityIndicator } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { getMyCalendarFeed, createMyCalendarFeed, turnOffMyCalendarFeed } from '../../lib/calendar-feed-api'
import { feedRowModel, subscribeChoices, CHOOSE_PROMPT, REPLACE_PROMPT, TURN_OFF_PROMPT } from '../../lib/calendar-feed'

export default function CalendarSubscribeRow() {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  // The one-time links, held for this session only (never persisted: they are
  // a secret). Cleared when the link is turned off.
  const [links, setLinks] = useState(null)

  const load = useCallback(async () => {
    const r = await getMyCalendarFeed()
    // A failed read keeps the last good status; with none, the row offers
    // "create", and the server answers 409 if a link exists after all.
    if (r?.success) setStatus(r.data)
  }, [])

  useFocusEffect(useCallback(() => { load() }, [load]))

  async function share(urls) {
    try {
      await Share.share({ message: urls.url })
    } catch {
      // The share sheet itself failed; the row still holds the link, so the
      // coach can tap again.
    }
  }

  async function runChoice(choice, urls) {
    if (choice.kind === 'share') return share(urls)
    try {
      await Linking.openURL(choice.url)
    } catch {
      // No app took it: offer the link to paste anywhere instead.
      await share(urls)
    }
  }

  function offerChoices(urls) {
    const choices = subscribeChoices(Platform.OS, urls)
    if (choices.length === 0) return
    Alert.alert(CHOOSE_PROMPT.title, CHOOSE_PROMPT.body, [
      ...choices.map((c) => ({ text: c.label, onPress: () => { runChoice(c, urls) } })),
      { text: 'Cancel', style: 'cancel' },
    ])
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
      setLinks(r.data)
      await load()
      offerChoices(r.data)
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
            else setLinks(null)
            await load()
          } finally {
            setBusy(false)
          }
        },
      },
    ])
  }

  const model = feedRowModel(status, Date.now(), { linkInHand: !!links })

  function onPress() {
    if (model.action === 'create') {
      issue(false)
      return
    }
    if (model.action === 'choose') {
      offerChoices(links)
      return
    }
    manage()
  }

  function manage() {
    Alert.alert(REPLACE_PROMPT.title, REPLACE_PROMPT.body, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Turn off', style: 'destructive', onPress: confirmTurnOff },
      { text: 'New link', onPress: () => issue(true) },
    ])
  }

  return (
    <Pressable
      onPress={onPress}
      // While a new link is in hand the tap offers it again, so "new link" and
      // "turn off" stay reachable on a long press (and on the next launch).
      onLongPress={status?.active ? manage : undefined}
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
