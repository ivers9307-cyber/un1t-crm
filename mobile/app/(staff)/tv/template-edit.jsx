// TV-MOBILE.C — mobile template editor (create / edit).
//
// Name + base image + draggable text zones (TvTemplateCanvas) + a
// per-zone property panel. Saves to tv_templates (RLS-direct). The web
// editor's drag/resize canvas, mirrored to RN with PanResponder; styling
// uses a curated colour palette + chip pickers in place of the desktop
// colour input. Authoring stays available on web too.

import { useState, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, TextInput, ActivityIndicator, Alert,
} from 'react-native'
import { useLocalSearchParams, useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as ImagePicker from 'expo-image-picker'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import {
  getTvTemplate, saveTvTemplate, deleteTvTemplate, uploadTvImage, tvImageUrl,
} from '../../../lib/tv-api'
import TvTemplateCanvas from '../../../components/TvTemplateCanvas'

const WEIGHTS = [
  { value: 400, label: 'Reg' }, { value: 600, label: 'Semi' },
  { value: 700, label: 'Bold' }, { value: 800, label: 'X-Bold' }, { value: 900, label: 'Black' },
]
const COLORS = ['#FFFFFF', '#000000', '#0EA5E9', '#EF4444', '#F59E0B', '#10B981', '#A855F7', '#FACC15']
const ALIGNS = [
  { value: 'left', icon: 'text-outline' }, { value: 'center', icon: 'text-outline' }, { value: 'right', icon: 'text-outline' },
]
const VALIGNS = ['top', 'middle', 'bottom']

function newZone() {
  return {
    id: 'z' + Math.random().toString(36).slice(2, 10),
    label: 'Text', x: 12, y: 40, width: 76, height: 18,
    fontSize: 8, fontWeight: 700, color: '#FFFFFF',
    align: 'center', vAlign: 'middle', uppercase: false, lineHeight: 1.15, defaultText: '',
  }
}

export default function TemplateEditScreen() {
  const params = useLocalSearchParams()
  const id = Array.isArray(params.id) ? params.id[0] : params.id
  const isNew = !id
  const router = useRouter()
  const { profile, activeLocation } = useAuth()
  const allowed = canMobile(profile, 'tv_displays', activeLocation)

  const [loaded, setLoaded] = useState(isNew)
  const [name, setName] = useState('')
  const [basePath, setBasePath] = useState(null)
  const [zones, setZones] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (isNew) { setLoaded(true); return }
    const r = await getTvTemplate(id)
    if (!r.success) { setError(r.error || 'Could not load template'); setLoaded(true); return }
    setName(r.data.name || '')
    setBasePath(r.data.base_image_path || null)
    setZones(Array.isArray(r.data.zones) ? r.data.zones : [])
    setLoaded(true)
  }, [id, isNew])

  useFocusEffect(useCallback(() => { if (allowed && !loaded) load() }, [allowed, loaded, load]))

  const selected = zones.find((z) => z.id === selectedId) || null

  function patchZone(zoneId, patch) {
    setZones((zs) => zs.map((z) => (z.id === zoneId ? { ...z, ...patch } : z)))
  }
  function addZone() {
    const z = newZone()
    setZones((zs) => [...zs, z])
    setSelectedId(z.id)
  }
  function removeZone(zoneId) {
    setZones((zs) => zs.filter((z) => z.id !== zoneId))
    setSelectedId(null)
  }

  async function pickBaseImage() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) { Alert.alert('Permission needed', 'Allow photo access to set a base image.'); return }
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.9 })
    if (r.canceled) return
    const a = r.assets?.[0]
    if (!a) return
    setUploading(true)
    setError(null)
    const up = await uploadTvImage(
      { uri: a.uri, name: a.fileName || 'template.jpg', mimeType: a.mimeType || 'image/jpeg' },
      activeLocation?.id,
      'template',
    )
    setUploading(false)
    if (!up.success) { setError(up.error || 'Upload failed'); return }
    setBasePath(up.path)
  }

  async function save() {
    if (busy) return
    setBusy(true)
    setError(null)
    const r = await saveTvTemplate({
      id: isNew ? undefined : id,
      locationId: activeLocation?.id,
      name,
      base_image_path: basePath,
      zones,
      createdBy: profile?.id,
    })
    setBusy(false)
    if (!r.success) { setError(r.error || 'Could not save'); return }
    router.back()
  }

  function confirmDelete() {
    Alert.alert('Delete template', `Delete "${name || 'this template'}"? Any TV showing it falls back to idle.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        const r = await deleteTvTemplate(id)
        if (!r.success) { Alert.alert('Couldn’t delete', r.error || 'Unknown error'); return }
        router.back()
      } },
    ])
  }

  if (!allowed) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center p-6">
        <Text className="text-sm text-un1t-subtle text-center">TV displays aren&apos;t enabled for your role here.</Text>
      </View>
    )
  }
  if (!loaded) {
    return <View className="flex-1 bg-un1t-bg items-center justify-center"><ActivityIndicator color="#94A3B8" /></View>
  }

  return (
    <ScrollView className="flex-1 bg-un1t-bg" contentContainerStyle={{ padding: 16, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
      <Text className="text-xs text-un1t-subtle mb-1">Template name</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="e.g. Class winner"
        placeholderTextColor="#94A3B8"
        className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-2.5 text-base text-un1t-text mb-4"
      />

      {/* Canvas */}
      <TvTemplateCanvas
        imageUri={tvImageUrl(basePath)}
        zones={zones}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onZoneChange={patchZone}
        editable
      />

      <View className="flex-row gap-2 mt-3">
        <Pressable onPress={pickBaseImage} disabled={uploading} className="flex-1 flex-row items-center justify-center py-2.5 rounded-lg border border-un1t-border active:opacity-70">
          {uploading ? <ActivityIndicator /> : <Ionicons name="image-outline" size={16} color="#111827" />}
          <Text className="text-sm text-un1t-text ml-1.5">{basePath ? 'Change base image' : 'Set base image'}</Text>
        </Pressable>
        <Pressable onPress={addZone} className="flex-row items-center justify-center px-4 py-2.5 rounded-lg bg-un1t-text active:opacity-80">
          <Ionicons name="add" size={16} color="#FFFFFF" />
          <Text className="text-sm text-un1t-bg font-semibold ml-1">Zone</Text>
        </Pressable>
      </View>
      <Text className="text-[11px] text-un1t-muted mt-1.5">Drag a zone to move it; drag the blue corner to resize. Tap a zone to edit its text + style.</Text>

      {/* Selected-zone editor */}
      {selected ? (
        <ZoneEditor zone={selected} onChange={(patch) => patchZone(selected.id, patch)} onRemove={() => removeZone(selected.id)} />
      ) : zones.length > 0 ? (
        <Text className="text-xs text-un1t-subtle mt-4">Tap a zone on the preview to edit it.</Text>
      ) : null}

      {/* Save / delete */}
      <Pressable onPress={save} disabled={busy} className={`mt-6 py-3 rounded-xl items-center ${busy ? 'bg-un1t-border' : 'bg-un1t-text'}`}>
        {busy ? <ActivityIndicator /> : <Text className="text-un1t-bg font-semibold">{isNew ? 'Create template' : 'Save changes'}</Text>}
      </Pressable>
      {!isNew && (
        <Pressable onPress={confirmDelete} className="mt-2 py-3 rounded-xl items-center border border-red-500/40 active:opacity-70">
          <Text className="text-red-700 font-semibold">Delete template</Text>
        </Pressable>
      )}
      {!!error && <Text className="text-xs text-red-500 mt-2">{error}</Text>}
    </ScrollView>
  )
}

function Chip({ active, onPress, children }) {
  return (
    <Pressable onPress={onPress} className={`px-3 py-1.5 rounded-lg border ${active ? 'bg-un1t-text border-un1t-text' : 'border-un1t-border'}`}>
      <Text className={`text-xs ${active ? 'text-un1t-bg font-semibold' : 'text-un1t-subtle'}`}>{children}</Text>
    </Pressable>
  )
}

function ZoneEditor({ zone, onChange, onRemove }) {
  return (
    <View className="mt-4 bg-un1t-surface border border-un1t-border rounded-2xl p-4 gap-3">
      <View className="flex-row items-center justify-between">
        <Text className="text-xs font-bold uppercase tracking-wider text-un1t-text">Zone</Text>
        <Pressable onPress={onRemove} hitSlop={8}><Ionicons name="trash-outline" size={16} color="#EF4444" /></Pressable>
      </View>

      <View>
        <Text className="text-[11px] text-un1t-subtle mb-1">Zone label (admin only)</Text>
        <TextInput value={zone.label} onChangeText={(t) => onChange({ label: t })} placeholder="Heading" placeholderTextColor="#94A3B8" className="bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm text-un1t-text" />
      </View>
      <View>
        <Text className="text-[11px] text-un1t-subtle mb-1">Default text</Text>
        <TextInput value={zone.defaultText} onChangeText={(t) => onChange({ defaultText: t })} multiline placeholder="Optional starting text" placeholderTextColor="#94A3B8" className="bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm text-un1t-text min-h-[40px]" textAlignVertical="top" />
      </View>

      <View>
        <Text className="text-[11px] text-un1t-subtle mb-1">Size (% of height): {zone.fontSize ?? 8}</Text>
        <View className="flex-row gap-2">
          <Chip onPress={() => onChange({ fontSize: Math.max(2, (zone.fontSize ?? 8) - 1) })}>−</Chip>
          <Chip onPress={() => onChange({ fontSize: Math.min(40, (zone.fontSize ?? 8) + 1) })}>＋</Chip>
        </View>
      </View>

      <View>
        <Text className="text-[11px] text-un1t-subtle mb-1">Weight</Text>
        <View className="flex-row gap-2 flex-wrap">
          {WEIGHTS.map((w) => <Chip key={w.value} active={(zone.fontWeight ?? 700) === w.value} onPress={() => onChange({ fontWeight: w.value })}>{w.label}</Chip>)}
        </View>
      </View>

      <View>
        <Text className="text-[11px] text-un1t-subtle mb-1">Colour</Text>
        <View className="flex-row gap-2 flex-wrap">
          {COLORS.map((c) => (
            <Pressable key={c} onPress={() => onChange({ color: c })} style={{ backgroundColor: c, borderColor: (zone.color || '#FFFFFF') === c ? '#0EA5E9' : '#E2E5E9', borderWidth: 2, width: 28, height: 28, borderRadius: 14 }} />
          ))}
        </View>
      </View>

      <View className="flex-row gap-4">
        <View className="flex-1">
          <Text className="text-[11px] text-un1t-subtle mb-1">Align</Text>
          <View className="flex-row gap-2">
            {ALIGNS.map((a) => <Chip key={a.value} active={(zone.align || 'center') === a.value} onPress={() => onChange({ align: a.value })}>{a.value[0].toUpperCase()}</Chip>)}
          </View>
        </View>
        <View className="flex-1">
          <Text className="text-[11px] text-un1t-subtle mb-1">Vertical</Text>
          <View className="flex-row gap-2">
            {VALIGNS.map((v) => <Chip key={v} active={(zone.vAlign || 'middle') === v} onPress={() => onChange({ vAlign: v })}>{v[0].toUpperCase()}</Chip>)}
          </View>
        </View>
      </View>

      <Pressable onPress={() => onChange({ uppercase: !zone.uppercase })} className="flex-row items-center">
        <Ionicons name={zone.uppercase ? 'checkbox' : 'square-outline'} size={18} color={zone.uppercase ? '#0EA5E9' : '#94A3B8'} />
        <Text className="text-sm text-un1t-text ml-2">UPPERCASE</Text>
      </Pressable>
    </View>
  )
}
