// Progress photos — the member's full gallery + a full-screen viewer.
//
// Pushed from the Coaching hub's "View all ›". Reads the CRM-API route
// GET /api/consultation-photos/me (crmApi attaches the member's Bearer JWT;
// the route mints short-lived signed URLs, so we refetch on focus). VIEW-only —
// uploading is a later native-release phase.

import { useState, useCallback } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator, Image, Modal, useWindowDimensions } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { crmApi } from '../../../lib/member/api'
import Card from '../../../components/member/ui/Card'
import ErrorRetry from '../../../components/member/ErrorRetry'

const fmtDate = (iso) => {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  return new Intl.DateTimeFormat('en-IE', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(t))
}

export default function ProgressPhotos() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const [loading, setLoading] = useState(true)
  const [photos, setPhotos] = useState([])
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null) // index into photos, or null

  const load = useCallback(async () => {
    setError(null)
    const res = await crmApi('/api/consultation-photos/me').catch((e) => ({ success: false, error: e?.message }))
    if (res?.success === false) {
      setError(res.error || 'Failed to load photos')
    } else {
      setPhotos(res?.data || [])
    }
    setLoading(false)
  }, [])

  useFocusEffect(useCallback(() => { load() }, [load]))

  // 3-column grid. p-5 = 20px each side (40 total), two 8px gaps (16).
  const tileW = (width - 40 - 16) / 3

  if (loading) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg items-center justify-center" edges={['left', 'right']}>
        <ActivityIndicator color="#F1EEE7" size="large" />
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      <ScrollView contentContainerClassName="p-5 pb-24" showsVerticalScrollIndicator={false}>
        <Header onBack={() => router.back()} />

        {error && photos.length === 0 ? (
          <View className="mt-6"><ErrorRetry onPress={load} /></View>
        ) : photos.length === 0 ? (
          <Card className="mt-6 items-center py-8">
            <Ionicons name="images-outline" size={32} color="#727170" />
            <Text className="mt-3 text-base font-display text-chalk">No photos yet</Text>
            <Text className="mt-1 text-sm text-chalk-2 text-center">
              Your progress photos show here. Your coach can add them during a consultation.
            </Text>
          </Card>
        ) : (
          <View className="mt-6 flex-row flex-wrap" style={{ gap: 8 }}>
            {photos.map((p, i) => (
              <Pressable key={p.id || i} onPress={() => setSelected(i)} className="active:opacity-80" style={{ width: tileW }}>
                <View className="rounded-[12px] overflow-hidden bg-iron-raised" style={{ width: tileW, height: tileW }}>
                  {p.url ? (
                    <Image source={{ uri: p.url }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                  ) : (
                    <View className="flex-1 items-center justify-center">
                      <Ionicons name="image-outline" size={20} color="#727170" />
                    </View>
                  )}
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>

      <PhotoViewer photo={selected !== null ? photos[selected] : null} onClose={() => setSelected(null)} />
    </SafeAreaView>
  )
}

function Header({ onBack }) {
  return (
    <View>
      <Pressable onPress={onBack} className="flex-row items-center gap-1 mb-4 self-start active:opacity-60">
        <Ionicons name="chevron-back-outline" size={18} color="#B3B2AC" />
        <Text className="text-sm text-chalk-2">Back</Text>
      </Pressable>
      <Text className="text-2xl font-display-bold text-chalk">Progress photos</Text>
    </View>
  )
}

// Full-screen viewer — the image contained on near-black, with date / label /
// caption and a close button. Plain RN Modal so it overlays the whole stack.
function PhotoViewer({ photo, onClose }) {
  return (
    <Modal visible={!!photo} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.96)' }}>
        <SafeAreaView className="flex-1" edges={['top', 'left', 'right', 'bottom']}>
          <View className="flex-row justify-end p-4">
            <Pressable onPress={onClose} hitSlop={12} className="active:opacity-60">
              <Ionicons name="close" size={28} color="#F1EEE7" />
            </Pressable>
          </View>
          <View className="flex-1 items-center justify-center px-4">
            {photo?.url ? (
              <Image source={{ uri: photo.url }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
            ) : null}
          </View>
          {photo ? (
            <View className="p-5">
              {photo.label ? <Text className="text-base font-body-semibold text-chalk">{photo.label}</Text> : null}
              <Text className="mt-0.5 font-mono text-xs text-chalk-2">{fmtDate(photo.taken_at)}</Text>
              {photo.caption ? <Text className="mt-2 text-sm text-chalk-2">{photo.caption}</Text> : null}
            </View>
          ) : null}
        </SafeAreaView>
      </View>
    </Modal>
  )
}
