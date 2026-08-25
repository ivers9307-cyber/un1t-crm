// STUDIO-HUB.1 — mobile TV displays screen.
//
// Phase A (TV-MOBILE.A) adds management — register a TV, delete a TV,
// set its orientation — alongside the original list + current-content +
// cast URL + "Clear to idle". All writes are RLS-direct (tv_displays /
// tv_content are authenticated-in-location CRUD), no API routes. The
// cast URL stays selectable text (a copy button would need a native
// clipboard module → a full App Store build, not an OTA). Content
// authoring (templates / uploads) is later phases.

import { useState, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, RefreshControl, Alert,
  Modal, TextInput, KeyboardAvoidingView, Platform, Image,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import {
  listTvDisplays, clearTvContent, castUrlForToken,
  registerTvDisplay, deleteTvDisplay, setTvRotation,
  TV_ORIENTATIONS, orientationLabel,
  listTvTemplates, tvImageUrl, deleteTvTemplate,
} from '../../../lib/tv-api'
import TvPushModal from '../../../components/TvPushModal'
import TvTemplateCanvas from '../../../components/TvTemplateCanvas'

export default function TvScreen() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()

  const allowed = canMobile(profile, 'tv_displays', activeLocation)

  const [tvs, setTvs] = useState(null)
  const [templates, setTemplates] = useState([])
  const [error, setError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [registerOpen, setRegisterOpen] = useState(false)
  const [pushTv, setPushTv] = useState(null) // the TV being pushed to (TV-MOBILE.B)

  const load = useCallback(async () => {
    if (!activeLocation?.id) { setTvs([]); setTemplates([]); return }
    const [tvRes, tplRes] = await Promise.all([
      listTvDisplays(activeLocation.id),
      listTvTemplates(activeLocation.id),
    ])
    if (!tvRes.success) { setError(tvRes.error || 'Failed to load TVs'); setTvs([]) }
    else { setError(null); setTvs(tvRes.data) }
    setTemplates(tplRes.success ? tplRes.data : [])
  }, [activeLocation?.id])

  useFocusEffect(useCallback(() => {
    if (allowed) load().catch(() => {})
  }, [allowed, load]))

  async function onRefresh() {
    setRefreshing(true)
    await load().catch(() => {})
    setRefreshing(false)
  }

  function confirmClear(tv) {
    Alert.alert('Clear TV', `Clear "${tv.label}"? It will fall back to the idle screen.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: async () => {
        const r = await clearTvContent(tv.id)
        if (!r.success) Alert.alert('Couldn’t clear', r.error || 'Unknown error')
        load().catch(() => {})
      } },
    ])
  }

  function confirmDelete(tv) {
    Alert.alert(
      'Delete TV',
      `Delete "${tv.label}"? Its cast URL stops working — you'll need to update UC Cast Pro if it's using this URL.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: async () => {
          const r = await deleteTvDisplay(tv.id)
          if (!r.success) Alert.alert('Couldn’t delete', r.error || 'Unknown error')
          load().catch(() => {})
        } },
      ],
    )
  }

  function chooseOrientation(tv) {
    const current = tv.rotation ?? 0
    Alert.alert(
      'Orientation',
      `How is "${tv.label}" hung?`,
      [
        ...TV_ORIENTATIONS.map((o) => ({
          text: current === o.value ? `✓ ${o.label}` : o.label,
          onPress: async () => {
            if (current === o.value) return
            const r = await setTvRotation(tv.id, o.value)
            if (!r.success) Alert.alert('Couldn’t update', r.error || 'Unknown error')
            load().catch(() => {})
          },
        })),
        { text: 'Cancel', style: 'cancel' },
      ],
    )
  }

  function confirmDeleteTemplate(t) {
    Alert.alert('Delete template', `Delete "${t.name}"? Any TV showing it falls back to the idle screen.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        const r = await deleteTvTemplate(t.id)
        if (!r.success) Alert.alert('Couldn’t delete', r.error || 'Unknown error')
        load().catch(() => {})
      } },
    ])
  }

  if (!allowed) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center p-6">
        <Text className="text-sm text-un1t-subtle text-center">
          TV displays aren&apos;t enabled for your role at this location.
        </Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-blue-600">Back</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <ScrollView
      className="flex-1 bg-un1t-bg"
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
    >
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-sm text-un1t-subtle flex-1 mr-3">
          TVs at {activeLocation?.name || 'your active location'}. Design content on the web.
        </Text>
        <Pressable
          onPress={() => setRegisterOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Register a TV"
          className="flex-row items-center bg-un1t-text px-3 py-1.5 rounded-lg active:opacity-80"
        >
          <Ionicons name="add" size={16} color="#FFFFFF" />
          <Text className="text-un1t-bg font-semibold text-sm ml-1">Register</Text>
        </Pressable>
      </View>

      {tvs === null ? (
        <ActivityIndicator color="#94A3B8" />
      ) : error ? (
        <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3">
          <Text className="text-sm text-red-700">{error}</Text>
        </View>
      ) : tvs.length === 0 ? (
        <Text className="text-sm text-un1t-subtle">No TVs registered yet. Tap Register to add one and get a cast URL for UC Cast Pro.</Text>
      ) : (
        <View className="gap-3">
          {tvs.map((tv) => (
            <TvCard
              key={tv.id}
              tv={tv}
              templates={templates}
              onPush={() => setPushTv(tv)}
              onClear={() => confirmClear(tv)}
              onDelete={() => confirmDelete(tv)}
              onOrientation={() => chooseOrientation(tv)}
            />
          ))}
        </View>
      )}

      <TemplatesSection
        templates={templates}
        onNew={() => router.push('/tv/template-edit')}
        onEdit={(t) => router.push({ pathname: '/tv/template-edit', params: { id: t.id } })}
        onDelete={confirmDeleteTemplate}
      />

      <TvPushModal
        visible={!!pushTv}
        tv={pushTv}
        locationId={activeLocation?.id}
        userId={profile?.id}
        onClose={() => setPushTv(null)}
        onPushed={() => { setPushTv(null); load().catch(() => {}) }}
      />

      <RegisterModal
        visible={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onRegister={async (label) => {
          const r = await registerTvDisplay(activeLocation?.id, label)
          if (!r.success) return r
          setRegisterOpen(false)
          load().catch(() => {})
          return r
        }}
      />
    </ScrollView>
  )
}

// TV-REMEMBER.2 — compact preview of the live content: an <Image> for
// storage/url pushes, or the read-only TvTemplateCanvas for a
// template push so the text/styling renders as it does on the TV.
// Renders nothing (falls back to the text row alone) when there's no
// content, or the template behind a template push has been deleted.
function NowShowingThumb({ content, templates }) {
  if (!content) return null

  if (content.source_type === 'storage') {
    return (
      <Image
        source={{ uri: tvImageUrl(content.source_ref) }}
        resizeMode="cover"
        className="w-full h-28 rounded-xl bg-black mt-3"
      />
    )
  }

  if (content.source_type === 'url') {
    return (
      <Image
        source={{ uri: content.source_ref }}
        resizeMode="cover"
        className="w-full h-28 rounded-xl bg-black mt-3"
      />
    )
  }

  if (content.source_type === 'template') {
    const tpl = templates?.find((t) => t.id === content.source_ref)
    if (!tpl) return null
    return (
      <View className="mt-3">
        <TvTemplateCanvas
          imageUri={tvImageUrl(tpl.base_image_path)}
          zones={tpl.zones}
          values={content.template_values || {}}
          editable={false}
        />
      </View>
    )
  }

  return null
}

function TvCard({ tv, templates, onPush, onClear, onDelete, onOrientation }) {
  const content = tv.content
  const showing = !!content
  const castUrl = castUrlForToken(tv.token)
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
      <View className="flex-row items-center">
        <Ionicons name="tv-outline" size={18} color="#0EA5E9" />
        <Text className="text-base font-semibold text-un1t-text ml-2 flex-1" numberOfLines={1}>{tv.label}</Text>
        {!tv.active && (
          <View className="bg-gray-500/15 rounded-full px-2 py-0.5">
            <Text className="text-[10px] uppercase tracking-wider text-gray-600">inactive</Text>
          </View>
        )}
        <Pressable onPress={onDelete} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Delete ${tv.label}`} className="ml-2 p-1">
          <Ionicons name="trash-outline" size={17} color="#EF4444" />
        </Pressable>
      </View>

      {/* TV-REMEMBER.2 — a small visual preview of what's actually on
          the TV right now, alongside the text summary below. */}
      <NowShowingThumb content={content} templates={templates} />

      <View className="flex-row items-center mt-3">
        <View className={`w-2 h-2 rounded-full mr-2 ${showing ? 'bg-emerald-500' : 'bg-un1t-border'}`} />
        <Text className="text-sm text-un1t-text">
          {showing ? (content.label || `Showing ${content.source_type}`) : 'Idle screen'}
        </Text>
      </View>

      <Pressable onPress={onOrientation} accessibilityRole="button" className="flex-row items-center mt-2 active:opacity-70">
        <Ionicons name="phone-landscape-outline" size={14} color="#94A3B8" />
        <Text className="text-xs text-un1t-subtle ml-1.5 mr-1">Orientation: <Text className="text-un1t-text">{orientationLabel(tv.rotation)}</Text></Text>
        <Ionicons name="chevron-down" size={12} color="#94A3B8" />
      </Pressable>

      {castUrl ? (
        <View className="mt-3 bg-un1t-bg border border-un1t-border rounded-xl p-2.5">
          <Text className="text-[10px] uppercase tracking-wider text-un1t-subtle mb-0.5">Cast URL (long-press to copy)</Text>
          <Text selectable className="text-[11px] text-un1t-subtle" numberOfLines={1}>{castUrl}</Text>
        </View>
      ) : null}

      <View className="flex-row gap-2 mt-3">
        <Pressable
          onPress={onPush}
          accessibilityRole="button"
          accessibilityLabel={`Push content to ${tv.label}`}
          className="flex-1 py-2 rounded-lg items-center bg-un1t-text active:opacity-80"
        >
          <Text className="text-sm font-semibold text-un1t-bg">Push content</Text>
        </Pressable>
        {showing && (
          <Pressable
            onPress={onClear}
            accessibilityRole="button"
            accessibilityLabel={`Clear ${tv.label}`}
            className="py-2 px-4 rounded-lg items-center border border-red-500/40 active:opacity-70"
          >
            <Text className="text-sm font-semibold text-red-700">Clear</Text>
          </Pressable>
        )}
      </View>
    </View>
  )
}

function RegisterModal({ visible, onClose, onRegister }) {
  const insets = useSafeAreaInsets()
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit() {
    if (!label.trim() || busy) return
    setBusy(true)
    setError(null)
    const r = await onRegister(label.trim())
    setBusy(false)
    if (r && !r.success) { setError(r.error || 'Could not register'); return }
    setLabel('')
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View className="flex-1 bg-black/40 justify-end">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View className="bg-un1t-bg rounded-t-3xl p-5" style={{ paddingBottom: insets.bottom + 20 }}>
            <View className="flex-row items-center justify-between mb-3">
              <Text className="text-lg font-bold text-un1t-text">Register a TV</Text>
              <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={24} color="#111827" /></Pressable>
            </View>
            <Text className="text-xs text-un1t-subtle mb-1">Label</Text>
            <TextInput
              value={label}
              onChangeText={setLabel}
              autoFocus
              placeholder="e.g. Lobby TV"
              placeholderTextColor="#94A3B8"
              className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-2.5 text-base text-un1t-text"
            />
            <Text className="text-[11px] text-un1t-muted mt-2">A unique cast URL is generated — paste it into UC Cast Pro on the device.</Text>
            <Pressable
              onPress={submit}
              disabled={!label.trim() || busy}
              className={`mt-3 py-3 rounded-xl items-center ${label.trim() && !busy ? 'bg-un1t-text' : 'bg-un1t-border'}`}
            >
              {busy ? <ActivityIndicator /> : <Text className="text-un1t-bg font-semibold">Register</Text>}
            </Pressable>
            {!!error && <Text className="text-xs text-red-500 mt-2">{error}</Text>}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  )
}

// TV-MOBILE.C — templates list (create / edit / delete). A template is a
// branded base image + text zones; the editor lives at /tv/template-edit.
function TemplatesSection({ templates, onNew, onEdit, onDelete }) {
  return (
    <View className="mt-7">
      <View className="flex-row items-center justify-between mb-1">
        <Text className="text-sm font-bold text-un1t-text">Templates</Text>
        <Pressable onPress={onNew} accessibilityRole="button" accessibilityLabel="New template" className="flex-row items-center bg-un1t-text px-3 py-1.5 rounded-lg active:opacity-80">
          <Ionicons name="add" size={15} color="#FFFFFF" />
          <Text className="text-un1t-bg font-semibold text-xs ml-1">New</Text>
        </Pressable>
      </View>
      <Text className="text-xs text-un1t-subtle mb-2">A branded base image with text zones — push it to a TV and fill in the text.</Text>
      {templates.length === 0 ? (
        <Text className="text-sm text-un1t-subtle">No templates yet. Tap New to design one.</Text>
      ) : (
        <View className="gap-2">
          {templates.map((t) => (
            <View key={t.id} className="flex-row items-center bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden">
              <Image source={{ uri: tvImageUrl(t.base_image_path) }} resizeMode="cover" className="w-20 h-14 bg-un1t-bg" />
              <Pressable onPress={() => onEdit(t)} className="flex-1 px-3 py-2 active:opacity-70">
                <Text className="text-sm font-medium text-un1t-text" numberOfLines={1}>{t.name}</Text>
                <Text className="text-[11px] text-un1t-subtle mt-0.5">
                  {(t.zones?.length || 0)} text {t.zones?.length === 1 ? 'zone' : 'zones'} · tap to edit
                </Text>
              </Pressable>
              <Pressable onPress={() => onDelete(t)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Delete ${t.name}`} className="px-3 py-3">
                <Ionicons name="trash-outline" size={16} color="#EF4444" />
              </Pressable>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}
