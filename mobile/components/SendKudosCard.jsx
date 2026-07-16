// CC-M.1 — compact mobile mirror of the web SendKudosCard (COACH KUDOS).
// A coach sends a short congratulatory note (+ optional emoji) the member
// reads in the champ app. Write-only surface: a successful send flashes a
// confirmation and clears the form; there is no staff-side kudos list.
//
// POSTs /api/contacts/[id]/kudos via api() (sendContactKudos). The route
// is gated on the web `consultations` permission server-side; the screen
// gates visibility with canDashboard(profile, 'consultations',
// activeLocation), which resolves the same top-level key against the same
// web defaults, so mobile mirrors the web card's gating exactly.
import { useState } from 'react'
import { View, Text, TextInput, Pressable } from 'react-native'
import { Button } from './ui'
import { colors } from '../lib/colors'
import { sendContactKudos } from '../lib/contacts-api'

const MAX = 500

// Same on-brand quick-pick as the web card. Tapping toggles selection.
const EMOJI_CHOICES = ['💪', '🔥', '👏', '⭐', '🙌']

export default function SendKudosCard({ contactId }) {
  const [message, setMessage] = useState('')
  const [emoji, setEmoji] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [sent, setSent] = useState(false)

  const trimmed = message.trim()
  const canSend = trimmed.length > 0 && message.length <= MAX && !busy

  async function submit() {
    if (!canSend) return
    setBusy(true)
    setError(null)
    setSent(false)
    const res = await sendContactKudos(contactId, { message: trimmed, emoji })
    setBusy(false)
    if (!res?.success) {
      setError(res?.error || 'Could not send kudos')
      return
    }
    setMessage('')
    setEmoji('')
    setSent(true)
  }

  return (
    <View className="mt-5">
      <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle px-1 mb-2" accessibilityRole="header">
        Send kudos
      </Text>
      <View className="bg-white border border-un1t-border rounded-2xl p-4">
        <Text className="text-xs text-un1t-subtle mb-2">
          A short note of encouragement your member sees in their app.
        </Text>
        <TextInput
          value={message}
          onChangeText={(v) => { setMessage(v); setSent(false) }}
          multiline
          maxLength={MAX}
          placeholder="Great work today, you smashed that session!"
          placeholderTextColor={colors.muted}
          className="text-base text-un1t-text min-h-[64px]"
          textAlignVertical="top"
          accessibilityLabel="Kudos message"
        />
        <View className="flex-row items-center justify-between mt-2">
          <View className="flex-row items-center gap-1.5">
            {EMOJI_CHOICES.map((e) => {
              const active = emoji === e
              return (
                <Pressable
                  key={e}
                  onPress={() => { setEmoji(active ? '' : e); setSent(false) }}
                  accessibilityRole="button"
                  accessibilityLabel={`Kudos emoji ${e}`}
                  accessibilityState={{ selected: active }}
                  className={`h-8 w-8 items-center justify-center rounded-full ${active ? 'bg-un1t-border' : 'bg-un1t-surface'}`}
                >
                  <Text className="text-base">{e}</Text>
                </Pressable>
              )
            })}
          </View>
          <Text className="text-xs text-un1t-subtle">{message.length}/{MAX}</Text>
        </View>
        <View className="mt-3">
          <Button label="Send kudos" size="sm" onPress={submit} loading={busy} disabled={!canSend} />
        </View>
        {sent && !error && <Text className="text-xs text-green-700 mt-2">Kudos sent.</Text>}
        {!!error && <Text className="text-xs text-red-700 mt-2">{error}</Text>}
      </View>
    </View>
  )
}
