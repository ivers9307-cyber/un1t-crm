import { useEffect, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, Platform } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import * as SecureStore from 'expo-secure-store'
import { needsAppleHealthResync, HEALTHKIT_READ_TYPES_VERSION } from 'shared/apple-health-perms'
import { getStoredPermsVersion, setStoredPermsVersion } from '../../lib/member/apple-health-perms'
import { hkConnectedKey, hkCursorKey } from '../../lib/member/apple-health-keys'
import { requestAppleHealthAuthorization, enableAppleHealthBackground, syncAppleHealth } from '../../lib/member/apple-health-sync'
import { useAuth } from '../../lib/member/contact-context'

export default function AppleHealthResyncCard() {
  const { contact } = useAuth()
  const contactId = contact?.id
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function check() {
      if (Platform.OS !== 'ios' || !contactId) return
      const connected = (await SecureStore.getItemAsync(hkConnectedKey(contactId))) === 'true'
      const storedVersion = await getStoredPermsVersion(contactId)
      if (!cancelled) setShow(needsAppleHealthResync({ connected, storedVersion }))
    }
    check()
    return () => { cancelled = true }
  }, [contactId])

  if (!show) return null

  async function resync() {
    if (!contactId) return
    setBusy(true)
    const prevCursor = (await SecureStore.getItemAsync(hkCursorKey(contactId))) || undefined
    try {
      await requestAppleHealthAuthorization()
      try { await enableAppleHealthBackground() } catch { /* best-effort — re-registers background delivery for newly-granted types */ }
      let res
      try { res = await syncAppleHealth({ sinceIso: prevCursor }) } catch { /* best-effort */ }
      if (res?.cursor) await SecureStore.setItemAsync(hkCursorKey(contactId), res.cursor)
      await setStoredPermsVersion(contactId, HEALTHKIT_READ_TYPES_VERSION)
    } finally {
      setBusy(false)
      setShow(false)
    }
  }

  return (
    <Pressable onPress={resync} disabled={busy} className="flex-row items-center gap-3 rounded-2xl border border-iron-hairline bg-iron-surface px-4 py-3 active:opacity-70">
      <Ionicons name="heart-circle-outline" size={22} color="#F1EEE7" />
      <View className="flex-1">
        <Text className="text-sm font-body-medium text-chalk">Update Apple Health</Text>
        <Text className="text-xs font-body text-chalk-2">Allow weight syncing so we can track your calories.</Text>
      </View>
      {busy ? <ActivityIndicator color="#B3B2AC" /> : <Ionicons name="chevron-forward" size={14} color="#727170" />}
    </Pressable>
  )
}
