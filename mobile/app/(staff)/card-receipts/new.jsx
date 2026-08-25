// SPEND.P3 (mobile) — capture + submit a company-card receipt.
// Modal-presented from the Card receipts list. The WHOLE flow is taking
// a photo: an attachment is a photo of the paper receipt (expo-image-picker
// — camera or library) OR a PDF (expo-document-picker). It uploads
// direct-to-storage via submitCardReceipt() (the same 3-step flow the
// contractor invoice / SPEND.P1 receipt path uses), which auto-files to
// the bookkeeper queue.
//
// STANDALONE — one receipt per purchase (not a batched claim). The
// submitter types NO financial fields: accounts read amount / merchant /
// date / VAT off the photo downstream in /invoices. The only inputs are
// an optional card last-4 and an optional note; the only REQUIREMENT to
// submit is an attached photo/PDF.

import { useState } from 'react'
import {
  View, Text, TextInput, Pressable, ScrollView,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useRouter, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { useAuth } from '../../../lib/auth-context'
import { submitCardReceipt } from '../../../lib/card-receipts-api'

const MAX_BYTES = 10 * 1024 * 1024 // 10 MB — matches the server cap

// expo-image-picker re-encodes captures to JPEG in practice; synthesise
// the stored filename's extension from the asset's real MIME so the
// extension always matches the bytes (an iPhone may report a stale .HEIC
// name on a re-encoded JPEG).
function extFromMime(mime) {
  switch (mime) {
    case 'image/png': return 'png'
    case 'image/webp': return 'webp'
    case 'image/heic': return 'heic'
    case 'image/heif': return 'heif'
    case 'application/pdf': return 'pdf'
    default: return 'jpg'
  }
}

export default function NewCardReceiptScreen() {
  const { activeLocation } = useAuth()
  const router = useRouter()

  const [cardLast4, setCardLast4] = useState('')
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState(null) // { uri, name, mimeType, size }
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  async function pickPdf() {
    setError(null)
    const r = await DocumentPicker.getDocumentAsync({
      type: 'application/pdf',
      multiple: false,
      copyToCacheDirectory: true,
    })
    if (r.canceled) return
    const asset = r.assets?.[0]
    if (!asset) return
    if (asset.size && asset.size > MAX_BYTES) {
      setError('PDF must be 10 MB or less.')
      return
    }
    setFile({
      uri: asset.uri,
      name: asset.name || 'receipt.pdf',
      mimeType: asset.mimeType || 'application/pdf',
      size: asset.size,
    })
  }

  function applyImageAsset(asset) {
    if (asset.fileSize && asset.fileSize > MAX_BYTES) {
      setError('Photo must be 10 MB or less.')
      return
    }
    const mime = asset.mimeType || 'image/jpeg'
    setFile({
      uri: asset.uri,
      name: `receipt-${Date.now()}.${extFromMime(mime)}`,
      mimeType: mime,
      size: asset.fileSize || 0,
    })
  }

  async function pickFromCamera() {
    setError(null)
    const perm = await ImagePicker.requestCameraPermissionsAsync()
    if (!perm.granted) {
      Alert.alert('Camera permission', 'Allow camera access to photograph a receipt.')
      return
    }
    const r = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      allowsEditing: false,
    })
    if (r.canceled || !r.assets?.[0]) return
    applyImageAsset(r.assets[0])
  }

  async function pickFromLibrary() {
    setError(null)
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) {
      Alert.alert('Photos permission', 'Allow photo library access to attach a receipt.')
      return
    }
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      allowsEditing: false,
      selectionLimit: 1,
    })
    if (r.canceled || !r.assets?.[0]) return
    applyImageAsset(r.assets[0])
  }

  async function handleSubmit() {
    setError(null)
    if (!file) {
      setError('Please attach a receipt (photo or PDF).')
      return
    }
    if (cardLast4.trim() && !/^\d{4}$/.test(cardLast4.trim())) {
      setError('Card last-4 must be exactly 4 digits (or leave it blank).')
      return
    }
    if (!activeLocation?.id) {
      setError('No active location — pick a studio in the side menu before submitting.')
      return
    }
    setSubmitting(true)
    try {
      const r = await submitCardReceipt({
        cardLast4: cardLast4.trim() || null,
        notes: notes.trim() || null,
        locationId: activeLocation.id,
        file,
      })
      if (!r.success) {
        setError(r.error || 'Submit failed')
        setSubmitting(false)
        return
      }
      // Done — pop back to the list. The list re-fetches on focus.
      router.back()
    } catch (e) {
      setError(e?.message || 'Submit failed')
      setSubmitting(false)
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: 'New receipt' }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1 bg-un1t-bg"
      >
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text className="text-sm text-un1t-subtle mb-5">
            Snap the receipt — accounts read the details off it and file it to Xero.
            You don&rsquo;t need to type anything else.
            {activeLocation?.name ? ` Submitting for ${activeLocation.name} — switch studios in the side menu to change.` : ''}
          </Text>

          <Field label="Receipt">
            {file ? (
              <View className="bg-un1t-surface border border-un1t-border rounded-xl p-4 mb-3 flex-row items-center">
                <Ionicons
                  name={file.mimeType === 'application/pdf' ? 'document-text' : 'image'}
                  size={20}
                  color="#2563EB"
                />
                <View className="flex-1 ml-3">
                  <Text className="text-sm font-semibold text-un1t-text" numberOfLines={1}>
                    {file.name}
                  </Text>
                  <Text className="text-xs text-un1t-subtle mt-0.5">
                    {file.size ? `${(file.size / 1024 / 1024).toFixed(2)} MB · ` : ''}Attached
                  </Text>
                </View>
                <Pressable onPress={() => setFile(null)} hitSlop={8} className="ml-2 active:opacity-60">
                  <Ionicons name="close-circle" size={22} color="#94A3B8" />
                </Pressable>
              </View>
            ) : null}
            <View className="flex-row gap-2">
              <AttachButton icon="camera-outline" label="Take photo" onPress={pickFromCamera} />
              <AttachButton icon="image-outline" label="Photo" onPress={pickFromLibrary} />
              <AttachButton icon="document-text-outline" label="PDF" onPress={pickPdf} />
            </View>
            <Text className="text-xs text-un1t-subtle mt-2">
              {file ? 'Pick again to replace.' : 'Photograph the paper receipt or attach a PDF.'}
            </Text>
          </Field>

          <Field label="Card last 4 (optional)">
            <TextInput
              keyboardType="number-pad"
              value={cardLast4}
              onChangeText={(v) => setCardLast4(v.replace(/[^0-9]/g, ''))}
              placeholder="e.g. 4321"
              placeholderTextColor="#64748B"
              maxLength={4}
              className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-3 text-base text-un1t-text"
            />
          </Field>

          <Field label="Note (optional)">
            <TextInput
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={3}
              maxLength={500}
              placeholder="Anything accounts should know"
              placeholderTextColor="#64748B"
              className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-3 text-base text-un1t-text"
              style={{ minHeight: 80, textAlignVertical: 'top' }}
            />
          </Field>

          {error && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-4 flex-row items-start">
              <Ionicons name="alert-circle" size={16} color="#DC2626" />
              <Text className="text-sm text-red-700 ml-2 flex-1">{error}</Text>
            </View>
          )}

          <Pressable
            onPress={handleSubmit}
            disabled={submitting}
            className="bg-blue-600 active:opacity-80 disabled:opacity-50 px-4 py-4 rounded-xl items-center flex-row justify-center mt-2"
          >
            {submitting
              ? <ActivityIndicator color="#FFFFFF" />
              : <Ionicons name="cloud-upload-outline" size={18} color="#FFFFFF" />}
            <Text className="text-base font-semibold text-white ml-2">
              {submitting ? 'Submitting…' : 'Submit receipt'}
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  )
}

function Field({ label, children }) {
  return (
    <View className="mb-4">
      <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-2">{label}</Text>
      {children}
    </View>
  )
}

function AttachButton({ icon, label, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-1 bg-un1t-surface border border-dashed border-un1t-border rounded-xl py-4 items-center active:opacity-70"
    >
      <Ionicons name={icon} size={22} color="#2563EB" />
      <Text className="text-xs font-semibold text-un1t-text mt-1.5">{label}</Text>
    </Pressable>
  )
}
