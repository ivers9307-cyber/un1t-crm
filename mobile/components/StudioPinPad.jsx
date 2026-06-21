// mobile/components/StudioPinPad.jsx
// Full-screen opaque PIN pad shown over the app on a paired studio
// device when it's idle-locked or signed out. Enters 4 digits, auto-
// submits to /api/auth/pin-login with mint_session, and hands the minted
// tokens back to the provider. Uses a plain fetch (pin-login is a public
// route — it authenticates by device token + PIN, not a Bearer).
import { useState, useCallback } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import Constants from 'expo-constants'

const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del']

export default function StudioPinPad({ deviceToken, onSuccess }) {
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = useCallback(async (value) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_token: deviceToken, pin: value, mint_session: true }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.access_token) {
        setPin('')
        setError(res.status === 429 ? 'Too many attempts. Wait a few minutes.' : 'Incorrect PIN.')
        setBusy(false)
        return
      }
      // Hand tokens to the provider; the overlay unmounts once the
      // session lands (provider clears `locked` + session becomes truthy).
      await onSuccess({ access_token: json.access_token, refresh_token: json.refresh_token })
    } catch {
      setPin('')
      setError('Network error. Try again.')
      setBusy(false)
    }
  }, [deviceToken, onSuccess])

  const press = useCallback((k) => {
    if (busy) return
    if (k === 'del') { setPin(p => p.slice(0, -1)); return }
    if (k === '') return
    setPin(p => {
      if (p.length >= 4) return p
      const next = p + k
      if (next.length === 4) submit(next)
      return next
    })
  }, [busy, submit])

  return (
    <View className="absolute inset-0 bg-un1t-bg items-center justify-center px-8">
      <Text className="text-2xl font-bold text-un1t-text mb-2">Enter your PIN</Text>
      <Text className="text-sm text-un1t-subtle mb-8">Tap in to use CF Studio</Text>

      <View className="flex-row gap-3 mb-8">
        {[0, 1, 2, 3].map(i => (
          <View key={i} className={`w-4 h-4 rounded-full ${i < pin.length ? 'bg-un1t-text' : 'bg-un1t-border'}`} />
        ))}
      </View>

      {error ? <Text className="text-red-500 text-sm mb-4">{error}</Text> : null}

      {busy ? (
        <ActivityIndicator color="#111827" />
      ) : (
        <View className="w-64 flex-row flex-wrap">
          {KEYS.map((k, i) => (
            <Pressable
              key={i}
              onPress={() => press(k)}
              disabled={k === ''}
              className="w-1/3 h-16 items-center justify-center active:opacity-50"
            >
              <Text className="text-2xl text-un1t-text">{k === 'del' ? '⌫' : k}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}
