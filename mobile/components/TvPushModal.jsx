// TV-MOBILE.B — push content to a TV from mobile.
//
// Three modes mirroring the web PushModal:
//   • Template — pick a saved template, type each zone's text (uses the
//     template's saved geometry + styling; no canvas drag/resize on
//     mobile), push as source_type='template' + template_values.
//   • Photo    — pick from library or camera → upload via the service-
//     role upload route → push as source_type='storage'.
//   • URL      — paste an image URL → push as source_type='url'.
//
// All pushes upsert the single tv_content row (RLS-direct).

import { useState, useEffect } from 'react'
import {
  Modal, View, Text, TextInput, Pressable, ActivityIndicator, ScrollView,
  KeyboardAvoidingView, Platform, Image, Alert,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import * as ImagePicker from 'expo-image-picker'
import {
  listTvTemplates, seedTemplateValues, tvImageUrl, uploadTvImage, pushTvContent,
} from '../lib/tv-api'
import TvTemplateCanvas from './TvTemplateCanvas'

const TABS = [
  { key: 'template', icon: 'albums-outline', label: 'Template' },
  { key: 'photo', icon: 'image-outline', label: 'Photo' },
  { key: 'url', icon: 'link-outline', label: 'URL' },
]

export default function TvPushModal({ visible, tv, locationId, userId, onClose, onPushed }) {
  const insets = useSafeAreaInsets()
  const [mode, setMode] = useState('template')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const [templates, setTemplates] = useState(null)
  const [templateId, setTemplateId] = useState('')
  const [zoneText, setZoneText] = useState({})

  const [photo, setPhoto] = useState(null) // { uri, name, mimeType }
  const [url, setUrl] = useState('')

  useEffect(() => {
    if (!visible) return
    setMode('template'); setLabel(''); setError(null)
    setTemplateId(''); setZoneText({}); setPhoto(null); setUrl('')
    setTemplates(null)
    listTvTemplates(locationId).then((r) => {
      const list = r.success ? r.data : []
      setTemplates(list)
      // TV-REMEMBER.1 — if the TV is currently showing a template
      // push, pre-select that template and seed from its prior
      // values instead of blank defaults, so staff restyling the
      // same recurring board don't redo the same work every time.
      const content = tv?.content
      if (content?.source_type === 'template') {
        const tpl = list.find((t) => t.id === content.source_ref)
        if (tpl) {
          setTemplateId(tpl.id)
          setZoneText(seedTemplateValues(tpl, content.template_values))
        }
      }
    })
  }, [visible, locationId, tv])

  const selectedTemplate = templates?.find((t) => t.id === templateId) || null

  function pickTemplate(id) {
    setTemplateId(id)
    const tpl = templates?.find((t) => t.id === id)
    // Only overlay the TV's prior values when picking the SAME
    // template already on the TV — a different template starts from
    // its own defaults.
    const content = tv?.content
    const priorValues = (content?.source_type === 'template' && content.source_ref === id)
      ? content.template_values
      : null
    setZoneText(seedTemplateValues(tpl, priorValues))
  }

  function setZone(zoneId, text) {
    setZoneText((v) => ({ ...v, [zoneId]: { ...v[zoneId], text } }))
  }

  async function pickPhoto(fromCamera) {
    const permFn = fromCamera ? ImagePicker.requestCameraPermissionsAsync : ImagePicker.requestMediaLibraryPermissionsAsync
    const perm = await permFn()
    if (!perm.granted) { Alert.alert('Permission needed', 'Allow photo access to push an image.'); return }
    const launch = fromCamera ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync
    const r = await launch({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.9 })
    if (r.canceled) return
    const a = r.assets?.[0]
    if (a) setPhoto({ uri: a.uri, name: a.fileName || 'tv-image.jpg', mimeType: a.mimeType || 'image/jpeg' })
  }

  async function submit() {
    if (busy || !tv?.id) return
    setBusy(true)
    setError(null)
    try {
      let payload
      if (mode === 'url') {
        if (!url.trim()) { setError('Paste an image URL.'); setBusy(false); return }
        payload = { source_type: 'url', source_ref: url.trim(), label: label.trim() || null }
      } else if (mode === 'photo') {
        if (!photo) { setError('Pick a photo first.'); setBusy(false); return }
        const up = await uploadTvImage(photo, locationId)
        if (!up.success) { setError(up.error || 'Upload failed'); setBusy(false); return }
        payload = { source_type: 'storage', source_ref: up.path, label: label.trim() || photo.name }
      } else {
        if (!selectedTemplate) { setError('Pick a template first.'); setBusy(false); return }
        payload = { source_type: 'template', source_ref: selectedTemplate.id, label: label.trim() || selectedTemplate.name, template_values: zoneText }
      }
      const r = await pushTvContent(tv.id, payload, userId)
      setBusy(false)
      if (!r.success) { setError(r.error || 'Push failed'); return }
      onPushed?.()
    } catch (e) {
      setBusy(false)
      setError(e.message || 'Push failed')
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View className="flex-1 bg-black/40 justify-end">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View className="bg-un1t-bg rounded-t-3xl max-h-[88%]">
            <View className="flex-row items-center justify-between px-4 pt-4 pb-1">
              <Text className="text-lg font-bold text-un1t-text" numberOfLines={1}>Push to {tv?.label || 'TV'}</Text>
              <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={24} color="#111827" /></Pressable>
            </View>

            {/* Tab strip */}
            <View className="flex-row px-4 pt-2 gap-2">
              {TABS.map((t) => (
                <Pressable
                  key={t.key}
                  onPress={() => setMode(t.key)}
                  className={`flex-1 flex-row items-center justify-center py-2 rounded-lg border ${mode === t.key ? 'bg-un1t-text border-un1t-text' : 'border-un1t-border'}`}
                >
                  <Ionicons name={t.icon} size={14} color={mode === t.key ? '#FFFFFF' : '#64748B'} />
                  <Text className={`text-xs ml-1.5 ${mode === t.key ? 'text-un1t-bg font-semibold' : 'text-un1t-subtle'}`}>{t.label}</Text>
                </Pressable>
              ))}
            </View>

            <ScrollView
              style={{ flexShrink: 1 }}
              contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16 }}
              keyboardShouldPersistTaps="handled"
            >
              {mode === 'template' && (
                <TemplateBody
                  templates={templates}
                  templateId={templateId}
                  selectedTemplate={selectedTemplate}
                  zoneText={zoneText}
                  onPick={pickTemplate}
                  onZone={setZone}
                />
              )}

              {mode === 'photo' && (
                <View className="gap-3">
                  {photo ? (
                    <Image source={{ uri: photo.uri }} resizeMode="cover" className="w-full h-44 rounded-xl bg-un1t-surface" />
                  ) : (
                    <View className="w-full h-44 rounded-xl bg-un1t-surface border border-un1t-border items-center justify-center">
                      <Ionicons name="image-outline" size={32} color="#94A3B8" />
                      <Text className="text-xs text-un1t-subtle mt-2">No photo picked</Text>
                    </View>
                  )}
                  <View className="flex-row gap-2">
                    <Pressable onPress={() => pickPhoto(false)} className="flex-1 flex-row items-center justify-center py-2.5 rounded-lg border border-un1t-border active:opacity-70">
                      <Ionicons name="images-outline" size={16} color="#111827" />
                      <Text className="text-sm text-un1t-text ml-1.5">Library</Text>
                    </Pressable>
                    <Pressable onPress={() => pickPhoto(true)} className="flex-1 flex-row items-center justify-center py-2.5 rounded-lg border border-un1t-border active:opacity-70">
                      <Ionicons name="camera-outline" size={16} color="#111827" />
                      <Text className="text-sm text-un1t-text ml-1.5">Camera</Text>
                    </Pressable>
                  </View>
                </View>
              )}

              {mode === 'url' && (
                <View>
                  <Text className="text-xs text-un1t-subtle mb-1">Image URL</Text>
                  <TextInput
                    value={url}
                    onChangeText={setUrl}
                    autoCapitalize="none"
                    keyboardType="url"
                    placeholder="https://…image.jpg"
                    placeholderTextColor="#94A3B8"
                    className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-2.5 text-base text-un1t-text"
                  />
                  <Text className="text-[11px] text-un1t-muted mt-1.5">The cast loads this URL directly — make sure it&apos;s publicly accessible.</Text>
                </View>
              )}

              {/* Label */}
              <View className="mt-4">
                <Text className="text-xs text-un1t-subtle mb-1">Label (optional)</Text>
                <TextInput
                  value={label}
                  onChangeText={setLabel}
                  placeholder="e.g. Welcome Sarah"
                  placeholderTextColor="#94A3B8"
                  className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-2.5 text-base text-un1t-text"
                />
              </View>

              <Pressable
                onPress={submit}
                disabled={busy}
                className={`mt-4 py-3 rounded-xl items-center ${busy ? 'bg-un1t-border' : 'bg-un1t-text'}`}
              >
                {busy ? <ActivityIndicator /> : <Text className="text-un1t-bg font-semibold">Push to TV</Text>}
              </Pressable>
              {!!error && <Text className="text-xs text-red-500 mt-2">{error}</Text>}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  )
}

function TemplateBody({ templates, templateId, selectedTemplate, zoneText, onPick, onZone }) {
  if (templates === null) return <ActivityIndicator color="#94A3B8" />
  if (templates.length === 0) {
    return (
      <Text className="text-sm text-un1t-subtle">
        No templates yet. Create one on the web (Admin → TV displays → Templates) to push branded messages.
      </Text>
    )
  }
  return (
    <View>
      <Text className="text-xs text-un1t-subtle mb-2">Template</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} className="mb-3">
        {templates.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => onPick(t.id)}
            className={`rounded-xl border overflow-hidden w-28 ${templateId === t.id ? 'border-un1t-text' : 'border-un1t-border'}`}
          >
            <Image source={{ uri: tvImageUrl(t.base_image_path) }} resizeMode="cover" className="w-28 h-16 bg-un1t-surface" />
            <Text className="text-[11px] text-un1t-text px-1.5 py-1" numberOfLines={1}>{t.name}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* TV-MOBILE.F — live read-only preview so staff aren't typing
          blind. Mirrors what the TV will actually show: same canvas,
          same zone resolution, updates on every keystroke via
          `values`. No drag/resize here — editable stays false. */}
      {selectedTemplate && (
        <View className="mb-3">
          <TvTemplateCanvas
            imageUri={tvImageUrl(selectedTemplate.base_image_path)}
            zones={selectedTemplate.zones}
            values={zoneText}
            editable={false}
          />
        </View>
      )}

      {selectedTemplate && (
        (selectedTemplate.zones || []).length === 0 ? (
          <Text className="text-[11px] text-un1t-muted">This template has no text zones — it pushes as-is.</Text>
        ) : (
          <View className="gap-2.5">
            {(selectedTemplate.zones || []).map((z) => (
              <View key={z.id}>
                <Text className="text-[11px] uppercase tracking-wide text-un1t-subtle mb-1">{z.label}</Text>
                <TextInput
                  value={zoneText[z.id]?.text ?? ''}
                  onChangeText={(t) => onZone(z.id, t)}
                  multiline
                  placeholder={z.defaultText || 'Type the text for this zone…'}
                  placeholderTextColor="#94A3B8"
                  className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-2 text-base text-un1t-text min-h-[44px]"
                  textAlignVertical="top"
                />
              </View>
            ))}
          </View>
        )
      )}
    </View>
  )
}
