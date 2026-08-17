// EQUIP-MAINT.2 — the inspection run itself: opens (or resumes) the
// draft for this asset's current cycle, walks the checklist snapshot
// item by item, and submits.
//
// Each Pass/Fail choice PATCHes the draft immediately (so a killed
// app loses at most one tick) — the PATCH response's `results` becomes
// the new local source of truth, mirroring the web InspectionRunner.
// Submit posts every result together as JSON, inside the same
// multipart request as the photos and the out-of-service flag.
//
// Photo picker lifted from mobile/app/issues/new.jsx — same
// expo-image-picker calls + permission prompts, staged client-side,
// sent all in one request at submit.

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, TextInput, Pressable, ScrollView, ActivityIndicator,
  KeyboardAvoidingView, Platform, Alert, Image,
} from 'react-native'
import { Stack, useRouter, useLocalSearchParams } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as ImagePicker from 'expo-image-picker'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import {
  openInspection, tickInspectionItem, submitInspection,
  orderedItems, hasAnyFail,
} from '../../../lib/maintenance-api'

const MAX_PHOTOS = 3

function ItemRow({ item, result, busy, editing, noteDraft, error, missing, onPass, onStartFail, onNoteChange, onSaveFail, onCancelFail }) {
  const isPass = result?.state === 'pass'
  const isFail = result?.state === 'fail'
  return (
    <View
      className={`bg-un1t-surface border rounded-2xl p-4 mb-2.5 ${
        missing ? 'border-amber-500/50' : 'border-un1t-border'
      }`}
    >
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-base text-un1t-text">{item.label}</Text>
        <View className="flex-row gap-2 shrink-0">
          <Pressable
            onPress={onPass}
            disabled={busy}
            className={`px-3.5 py-2 rounded-xl border ${
              isPass ? 'bg-green-600 border-green-600' : 'bg-un1t-bg/60 border-un1t-border'
            }`}
          >
            {busy && !editing ? (
              <ActivityIndicator size="small" color={isPass ? '#FFFFFF' : '#94A3B8'} />
            ) : (
              <Text className={`text-sm font-semibold ${isPass ? 'text-white' : 'text-un1t-text'}`}>Pass</Text>
            )}
          </Pressable>
          <Pressable
            onPress={onStartFail}
            className={`px-3.5 py-2 rounded-xl border ${
              isFail ? 'bg-red-600 border-red-600' : 'bg-un1t-bg/60 border-un1t-border'
            }`}
          >
            <Text className={`text-sm font-semibold ${isFail ? 'text-white' : 'text-un1t-text'}`}>Fail</Text>
          </Pressable>
        </View>
      </View>

      {missing && (
        <Text className="text-[11px] text-amber-300 mt-1.5">Mark this check before submitting.</Text>
      )}
      {error && (
        <Text className="text-[11px] text-red-300 mt-1.5">{error}</Text>
      )}

      {editing && (
        <View className="mt-2.5">
          <TextInput
            autoFocus
            multiline
            value={noteDraft}
            onChangeText={onNoteChange}
            placeholder="What's wrong? (required)"
            placeholderTextColor="#475569"
            className="bg-un1t-bg/60 border border-un1t-border rounded-lg px-3 py-2 text-sm text-un1t-text"
            style={{ minHeight: 60, textAlignVertical: 'top' }}
          />
          <View className="flex-row justify-end gap-2 mt-2">
            <Pressable onPress={onCancelFail} className="px-3 py-1.5">
              <Text className="text-sm text-un1t-subtle">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onSaveFail}
              disabled={!noteDraft?.trim() || busy}
              className="bg-red-600 disabled:opacity-50 px-3.5 py-1.5 rounded-lg"
            >
              {busy ? <ActivityIndicator size="small" color="#FFFFFF" /> : (
                <Text className="text-sm font-semibold text-white">Save fault</Text>
              )}
            </Pressable>
          </View>
        </View>
      )}

      {isFail && !editing && result?.note ? (
        <Text className="text-[12px] text-un1t-subtle mt-1.5">{result.note}</Text>
      ) : null}
    </View>
  )
}

export default function InspectionRunScreen() {
  const router = useRouter()
  const { id, name, type } = useLocalSearchParams()
  const { profile, activeLocation } = useAuth()
  const canRun = canMobile(profile, 'equipment_inspect', activeLocation)

  const [draft, setDraft] = useState(null)
  const [opening, setOpening] = useState(true)
  const [openError, setOpenError] = useState(null)

  const [editingNoteFor, setEditingNoteFor] = useState(null)
  const [noteDrafts, setNoteDrafts] = useState({})
  const [tickingId, setTickingId] = useState(null)
  const [tickErrors, setTickErrors] = useState({})
  const [missingIds, setMissingIds] = useState(new Set())

  const [overallNote, setOverallNote] = useState('')
  const [takeOutOfService, setTakeOutOfService] = useState(false)
  const [photos, setPhotos] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  useEffect(() => {
    if (!canRun) { setOpening(false); return }
    let alive = true
    async function open() {
      setOpening(true)
      setOpenError(null)
      try {
        const r = await openInspection(id)
        if (!alive) return
        if (r.success === false) setOpenError(r.error || 'Failed to open the inspection.')
        else setDraft(r.data)
      } catch (err) {
        if (alive) setOpenError(err.message || 'Failed to open the inspection.')
      } finally {
        if (alive) setOpening(false)
      }
    }
    open()
    return () => { alive = false }
  }, [id, canRun])

  const results = draft?.results || {}
  const anyFail = hasAnyFail(results)

  // A fail was undone (switched back to pass) — the out-of-service
  // flag no longer means anything, so don't leave a stale checked-
  // but-pointless toggle on.
  useEffect(() => {
    if (!anyFail) setTakeOutOfService(false)
  }, [anyFail])

  const tick = useCallback(async (itemId, state, note) => {
    setTickingId(itemId)
    setTickErrors((e) => ({ ...e, [itemId]: null }))
    try {
      const r = await tickInspectionItem(draft.id, { itemId, state, note })
      if (r.success === false) {
        setTickErrors((e) => ({ ...e, [itemId]: r.error || 'Failed to save.' }))
        return
      }
      setDraft((d) => ({ ...d, results: r.data.results }))
      setMissingIds((s) => {
        if (!s.has(itemId)) return s
        const next = new Set(s)
        next.delete(itemId)
        return next
      })
      if (editingNoteFor === itemId) setEditingNoteFor(null)
    } catch (err) {
      setTickErrors((e) => ({ ...e, [itemId]: err.message || 'Network error.' }))
    } finally {
      setTickingId(null)
    }
  }, [draft?.id, editingNoteFor])

  function markPass(itemId) { tick(itemId, 'pass') }
  function startFail(itemId) {
    setNoteDrafts((d) => ({ ...d, [itemId]: d[itemId] ?? results[itemId]?.note ?? '' }))
    setEditingNoteFor(itemId)
  }
  function saveFail(itemId) {
    const note = (noteDrafts[itemId] || '').trim()
    if (!note) return
    tick(itemId, 'fail', note)
  }

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
    for (const a of r.assets.slice(0, MAX_PHOTOS - photos.length)) addPhoto(a)
  }

  function addPhoto(asset) {
    setPhotos((prev) => [
      ...prev,
      {
        uri: asset.uri,
        name: asset.fileName || `photo-${prev.length + 1}.jpg`,
        mimeType: asset.mimeType || 'image/jpeg',
      },
    ])
  }
  function removePhoto(idx) {
    setPhotos((prev) => prev.filter((_, i) => i !== idx))
  }

  async function onSubmit() {
    setSubmitError(null)
    setMissingIds(new Set())
    setSubmitting(true)
    try {
      const r = await submitInspection(draft.id, {
        results: draft.results || {},
        note: overallNote.trim(),
        takeOutOfService,
        photos,
      })
      if (r.success === false) {
        setSubmitError(r.error || 'Failed to submit the inspection.')
        if (Array.isArray(r.missing)) setMissingIds(new Set(r.missing))
        return
      }
      // Replace so back-swipe lands on the due list, not on the
      // now-submitted run screen.
      router.replace('/maintenance')
    } catch (err) {
      setSubmitError(err.message || 'Network error.')
    } finally {
      setSubmitting(false)
    }
  }

  const items = orderedItems(draft)
  const ready = !opening && !openError && draft
  const title = name ? `Inspect ${name}` : 'Inspection'

  if (!canRun) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center px-6">
        <Stack.Screen options={{ title: 'Inspection' }} />
        <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
        <Text className="text-xs text-un1t-subtle text-center mt-1">
          Equipment inspections aren&apos;t enabled for your account.
        </Text>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-un1t-bg"
    >
      <Stack.Screen options={{ title }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        {type ? (
          <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-4">
            {type}
          </Text>
        ) : null}

        {opening && (
          <View className="py-16 items-center">
            <ActivityIndicator color="#94A3B8" />
          </View>
        )}

        {openError && (
          <View className="bg-red-500/10 border border-red-500/30 rounded-md p-3 mb-3 flex-row items-start">
            <Ionicons name="alert-circle-outline" size={14} color="#EF4444" style={{ marginTop: 2 }} />
            <Text className="text-[12px] text-red-300 ml-2 flex-1">{openError}</Text>
          </View>
        )}

        {ready && (
          <>
            {items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                result={results[item.id]}
                busy={tickingId === item.id}
                editing={editingNoteFor === item.id}
                noteDraft={noteDrafts[item.id] || ''}
                error={tickErrors[item.id]}
                missing={missingIds.has(item.id)}
                onPass={() => markPass(item.id)}
                onStartFail={() => startFail(item.id)}
                onNoteChange={(v) => setNoteDrafts((d) => ({ ...d, [item.id]: v }))}
                onSaveFail={() => saveFail(item.id)}
                onCancelFail={() => setEditingNoteFor(null)}
              />
            ))}

            <View className="mt-4 pt-4 border-t border-un1t-border">
              <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">
                Photos {anyFail ? `(${photos.length} / ${MAX_PHOTOS})` : '(optional)'}
              </Text>
              <Text className="text-[11px] text-un1t-subtle mb-2">
                {anyFail ? `Up to ${MAX_PHOTOS} photos of the fault.` : 'Only used when a check fails above.'}
              </Text>

              {photos.length > 0 && (
                <View className="flex-row flex-wrap gap-3 mb-3">
                  {photos.map((p, i) => (
                    <View key={i} className="relative">
                      <Image source={{ uri: p.uri }} style={{ width: 88, height: 88, borderRadius: 12 }} />
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

              {photos.length < MAX_PHOTOS && anyFail && (
                <View className="flex-row gap-2 mb-4">
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

              <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">
                Overall note (optional)
              </Text>
              <TextInput
                value={overallNote}
                onChangeText={setOverallNote}
                placeholder="Included on the fault report, if any."
                placeholderTextColor="#475569"
                multiline
                maxLength={1000}
                className="bg-un1t-surface border border-un1t-border rounded-xl px-4 py-3 text-sm text-un1t-text mb-4"
                style={{ minHeight: 70, textAlignVertical: 'top' }}
              />

              <Pressable
                onPress={() => anyFail && setTakeOutOfService((v) => !v)}
                disabled={!anyFail}
                className="flex-row items-center mb-4 disabled:opacity-50"
              >
                <View
                  className={`w-6 h-6 rounded-md mr-2.5 items-center justify-center border-2 ${
                    takeOutOfService ? 'bg-red-600 border-red-600' : 'border-un1t-border bg-un1t-bg/60'
                  }`}
                >
                  {takeOutOfService && <Ionicons name="checkmark" size={16} color="#FFFFFF" />}
                </View>
                <Text className="text-sm text-un1t-text flex-1">
                  Take out of service
                  {!anyFail ? <Text className="text-[11px] text-un1t-subtle"> (only available once a check has failed)</Text> : null}
                </Text>
              </Pressable>

              {submitError && (
                <View className="bg-red-500/10 border border-red-500/30 rounded-md p-3 mb-4 flex-row items-start">
                  <Ionicons name="alert-circle-outline" size={14} color="#EF4444" style={{ marginTop: 2 }} />
                  <Text className="text-[12px] text-red-300 ml-2 flex-1">{submitError}</Text>
                </View>
              )}

              <Pressable
                onPress={onSubmit}
                disabled={submitting}
                className="bg-blue-600 active:opacity-80 disabled:opacity-50 px-4 py-3.5 rounded-xl flex-row items-center justify-center"
              >
                {submitting ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Ionicons name="checkmark-done-outline" size={18} color="#FFFFFF" />
                )}
                <Text className="text-base font-bold text-white ml-2">
                  {submitting ? 'Submitting…' : 'Submit inspection'}
                </Text>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
