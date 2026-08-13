// WA-MEDIA.1 / IG-MEDIA.3 — render inbound message media inline in the mobile
// inbox, for WhatsApp AND Instagram.
//
// Fetches a short-lived signed URL from the channel's media route (which
// re-hosts the bytes into the private whatsapp-media bucket on first view) and
// shows it: images inline, everything else as a tap-to-open link. Falls back to
// a small "unavailable" note if the source expired or the fetch failed.
//
// Instagram was previously excluded, so no IG photo or story mention ever
// rendered on mobile — and once story mentions stopped carrying a text
// placeholder, that showed as an empty bubble.

import { useEffect, useState } from 'react'
import { View, Text, Image, Pressable, Linking, ActivityIndicator } from 'react-native'
import { api } from '../lib/api'
import { mediaRenderKind } from 'shared/whatsapp-media'

const MEDIA_ENDPOINT = {
  whatsapp: '/api/whatsapp/media',
  instagram: '/api/instagram/media',
}

export default function WAMediaThumb({ msg, channel = 'whatsapp' }) {
  const [status, setStatus] = useState('loading') // loading | ready | error
  const [url, setUrl] = useState(null)
  // The route resolves the kind server-side from the re-hosted MIME, which is
  // authoritative: an Instagram story mention is 'file' until re-hosting has
  // fetched it, then 'image'/'video'. Preferring the response avoids rendering
  // a download link for a picture we've just stored.
  const [servedKind, setServedKind] = useState(null)
  const kind = servedKind || mediaRenderKind(msg.message_type, msg.media_mime_type)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setUrl(null)
    setServedKind(null)
    const base = MEDIA_ENDPOINT[channel] || MEDIA_ENDPOINT.whatsapp
    api(`${base}/${msg.id}`)
      .then(res => {
        if (cancelled) return
        if (res?.success && res.url) {
          setUrl(res.url)
          if (res.kind) setServedKind(res.kind)
          setStatus('ready')
        } else {
          setStatus('error')
        }
      })
      .catch(() => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true }
  }, [msg.id, channel])

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
