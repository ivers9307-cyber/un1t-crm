// WA-MEDIA.1 — render inbound WhatsApp media inline in the mobile inbox.
//
// Fetches a short-lived signed URL from /api/whatsapp/media/[id] (which
// re-hosts the bytes from Meta into the private whatsapp-media bucket on
// first view) and shows it: images inline, everything else as a tap-to-
// open link. Falls back to a small "unavailable" note if Meta expired the
// media or the fetch failed. WhatsApp only — Instagram media is a separate
// table/route (follow-up), so MessageBubble gates this on channel.

import { useEffect, useState } from 'react'
import { View, Text, Image, Pressable, Linking, ActivityIndicator } from 'react-native'
import { api } from '../lib/api'
import { mediaRenderKind } from '../../shared/whatsapp-media'

export default function WAMediaThumb({ msg }) {
  const kind = mediaRenderKind(msg.message_type, msg.media_mime_type)
  const [status, setStatus] = useState('loading') // loading | ready | error
  const [url, setUrl] = useState(null)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setUrl(null)
    api(`/api/whatsapp/media/${msg.id}`)
      .then(res => {
        if (cancelled) return
        if (res?.success && res.url) {
          setUrl(res.url)
          setStatus('ready')
        } else {
          setStatus('error')
        }
      })
      .catch(() => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true }
  }, [msg.id])

  if (!kind) return null
  if (status === 'loading') {
    return (
      <View className="py-6 items-center justify-center">
        <ActivityIndicator color="#94A3B8" />
      </View>
    )
  }
  if (status === 'error' || !url) {
    return <Text className="text-xs italic text-un1t-muted">[{kind} unavailable]</Text>
  }

  if (kind === 'image') {
    return (
      <Image
        source={{ uri: url }}
        style={{ width: 220, height: 220, borderRadius: 10 }}
        resizeMode="cover"
        accessibilityLabel="Shared image"
      />
    )
  }
  // video / audio / file — open in the OS handler
  return (
    <Pressable onPress={() => Linking.openURL(url)} hitSlop={6}>
      <Text className="text-sm underline text-blue-300">
        {kind === 'video' ? 'Play video' : kind === 'audio' ? 'Play voice note' : 'Open document'}
      </Text>
    </Pressable>
  )
}
