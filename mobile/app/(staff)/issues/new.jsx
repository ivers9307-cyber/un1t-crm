// REPORT-ISSUE.1 — submit a new issue. Modal screen presented from
// the More tab. Description (required) + up to 3 photos (camera /
// library), then POST as multipart form data.
//
// Photo flow mirrors mobile/app/expenses/[id].jsx — same
// expo-image-picker calls + permission prompts. Difference: we
// stage multiple photos client-side and send all in one request,
// whereas expense items upload one receipt per line.

import { useState } from 'react'
import {
  View, Text, TextInput, Pressable, ScrollView, ActivityIndicator,
  KeyboardAvoidingView, Platform, Alert, Image,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as ImagePicker from 'expo-image-picker'
import { useAuth } from '../../../lib/auth-context'
import { submitIssue } from '../../../lib/issues-api'

const MAX_PHOTOS = 3
const DESCRIPTION_HINT_AT = 1500   // hint, not a hard cap (cap is 4000 server-side)

export default function NewIssueScreen() {
  const router = useRouter()
  const { activeLocation } = useAuth()
  const [description, setDescription] = useState('')
  const [photos, setPhotos] = useState([])  // [{ uri, name, mimeType, size }]
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  async function pickFromCamera() {
    if (photos.length >= MAX_PHOTOS) return
    const perm = await ImagePicker.requestCameraPermissionsAsync()
    if (!perm.granted) {
      Alert.alert('Camera permission', 'Allow camera access to attach a photo.')
      return
    }
    const r = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      allowsEditing: false,
    })
    if (r.canceled || !r.assets?.[0]) return
    addPhoto(r.assets[0])
  }

  async function pickFromLibrary() {
    if (photos.length >= MAX_PHOTOS) return
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) {
      Alert.alert('Photos permission', 'Allow photo library access to attach an image.')
      return
    }
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      allowsEditing: false,
      selectionLimit: Math.max(1, MAX_PHOTOS - photos.length),
    })
    if (r.canceled || !r.assets?.length) return
    for (const a of r.assets.slice(0, MAX_PHOTOS - photos.length)) {
      addPhoto(a)
    }
  }

  function addPhoto(asset) {
    setPhotos((prev) => [
      ...prev,
      {
        uri: asset.uri,
        name: asset.fileName || `photo-${prev.length + 1}.jpg`,
        mimeType: asset.mimeType || 'image/jpeg',
        size: asset.fileSize || 0,
      },
    ])
  }

  function removePhoto(idx) {
    setPhotos((prev) => prev.filter((_, i) => i !== idx))
  }

  async function onSubmit() {
    setError(null)
    if (description.trim().length === 0) {
      setError('A description is required.')
      return
    }
    setSubmitting(true)
    const r = await submitIssue({ description, photos })
    setSubmitting(false)
    if (r.success === false) {
      setError(r.error || 'Submit failed')
      return
    }
    // Replace so back-button goes to the list, not back to the form.
    router.replace(`/issues/${r.data.id}`)
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-un1t-bg"
    >
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        <Text className="text-2xl font-bold text-un1t-text mb-1">Report a problem</Text>
        <Text className="text-sm text-un1t-subtle mb-4">
          The owners at {activeLocation?.name || 'this studio'} will be notified. You&apos;ll get an update when it&apos;s resolved.
        </Text>

        <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">
          What&apos;s the issue?
        </Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="What's broken / dirty / unsafe? Where in the studio?"
          placeholderTextColor="#475569"
          multiline
          textAlignVertical="top"
          className="bg-un1t-surface border border-un1t-border rounded-xl px-4 py-3 text-base text-un1t-text"
          style={{ minHeight: 140 }}
        />
        {description.length > DESCRIPTION_HINT_AT && (
          <Text className="text-[11px] text-amber-300 mt-1">
            {description.length} / 4000 — keep it punchy where possible.
          </Text>
        )}

        <View className="mt-6 mb-2 flex-row items-center justify-between">
          <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
            Photos (optional)
          </Text>
          <Text className="text-[11px] text-un1t-subtle">
            {photos.length} / {MAX_PHOTOS}
          </Text>
        </View>

        {/* Photo thumbnails */}
        {photos.length > 0 && (
          <View className="flex-row flex-wrap gap-3 mb-3">
            {photos.map((p, i) => (
              <View key={i} className="relative">
                <Image
                  source={{ uri: p.uri }}
                  style={{ width: 96, height: 96, borderRadius: 12 }}
                />
                <Pressable
                  onPress={() => removePhoto(i)}
                  className="absolute -top-1.5 -right-1.5 bg-red-600 w-6 h-6 rounded-full items-center justify-center"
                >
                  <Ionicons name="close" size={14} color="#FFFFFF" />
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {/* Picker buttons */}
        {photos.length < MAX_PHOTOS && (
          <View className="flex-row gap-2">
            <Pressable
              onPress={pickFromCamera}
              className="flex-1 bg-un1t-surface border border-un1t-border active:opacity-80 px-4 py-3 rounded-xl flex-row items-center justify-center"
            >
              <Ionicons name="camera-outline" size={18} color="#FFFFFF" />
              <Text className="text-un1t-text font-semibold ml-2">Camera</Text>
            </Pressable>
            <Pressable
              onPress={pickFromLibrary}
              className="flex-1 bg-un1t-surface border border-un1t-border active:opacity-80 px-4 py-3 rounded-xl flex-row items-center justify-center"
            >
              <Ionicons name="images-outline" size={18} color="#FFFFFF" />
              <Text className="text-un1t-text font-semibold ml-2">Photos</Text>
            </Pressable>
          </View>
        )}

        {error && (
          <View className="mt-4 bg-red-500/10 border border-red-500/30 rounded-md p-3 flex-row items-start">
            <Ionicons name="alert-circle-outline" size={14} color="#EF4444" style={{ marginTop: 2 }} />
            <Text className="text-[12px] text-red-300 ml-2 flex-1">{error}</Text>
          </View>
        )}

        <Pressable
          onPress={onSubmit}
          disabled={submitting || description.trim().length === 0}
          className="mt-6 bg-blue-600 active:opacity-80 disabled:opacity-50 px-4 py-3.5 rounded-xl flex-row items-center justify-center"
        >
          {submitting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Ionicons name="paper-plane-outline" size={18} color="#FFFFFF" />
          )}
          <Text className="text-base font-bold text-white ml-2">
            {submitting ? 'Sending…' : 'Send report'}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
