// Hyrox session detail — the leaner coach card + the native board preview, with
// full control: approve / send back, regenerate, and push to the studio TV.
import { useState, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useLocalSearchParams, useFocusEffect, Stack } from 'expo-router'
import { getSession, setSessionStatus, regenerateSession, pushSessionToTv } from '../../../lib/hyrox-api'
import HyroxBoardRN from '../../../components/HyroxBoardRN'

const STATUS = {
  draft: { text: 'Draft', bg: 'bg-amber-500/15', fg: 'text-amber-700' },
  approved: { text: 'Approved', bg: 'bg-emerald-500/15', fg: 'text-emerald-700' },
  published: { text: 'Published', bg: 'bg-blue-500/15', fg: 'text-blue-700' },
}

function Field({ label, value }) {
  if (!value) return null
  return (
    <View className="mb-2.5">
      <Text className="text-[11px] uppercase tracking-wider text-un1t-muted mb-0.5">{label}</Text>
      <Text className="text-sm text-un1t-text leading-5">{value}</Text>
    </View>
  )
}

export default function HyroxSessionDetail() {
  const { id } = useLocalSearchParams()
  const [session, setSession] = useState(undefined) // undefined = loading
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)

  const load = useCallback(async () => {
    const res = await getSession(id)
    if (res.success) setSession(res.data)
    else { setError(res.error || 'Failed to load'); setSession(null) }
  }, [id])

  useFocusEffect(useCallback(() => { load() }, [load]))

  async function run(key, fn, okNote) {
    setBusy(key); setError(null); setNote(null)
    try {
      const res = await fn()
      if (!res.success) throw new Error(res.error || 'Something went wrong')
      if (okNote) setNote(okNote)
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  if (session === undefined) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <Stack.Screen options={{ title: 'Session' }} />
        <ActivityIndicator />
      </View>
    )
  }
  if (!session) {
    return (
      <View className="flex-1 bg-un1t-bg p-6">
        <Stack.Screen options={{ title: 'Session' }} />
        <Text className="text-sm text-red-700">{error || 'Session not found.'}</Text>
      </View>
    )
  }

  const fs = session.full_session || {}
  const badge = STATUS[session.status] || { text: session.status, bg: 'bg-un1t-border', fg: 'text-un1t-subtle' }
  const isPublished = session.status === 'published'
  const isApproved = session.status === 'approved'
  const canPush = session.board && (isApproved || isPublished)
  const title = `Week ${session.week_no} · Session ${session.slot}`

  const ActionBtn = ({ label, icon, on, disabled, primary }) => (
    <Pressable
      onPress={on}
      disabled={disabled || busy != null}
      className={`flex-row items-center justify-center gap-2 rounded-xl px-4 py-3 mb-2 ${primary ? 'bg-un1t-text active:opacity-80' : 'bg-un1t-surface border border-un1t-border active:bg-un1t-border/40'} ${disabled ? 'opacity-40' : ''}`}
    >
      <Ionicons name={icon} size={16} color={primary ? '#FFFFFF' : '#111827'} />
      <Text className={`text-sm font-semibold ${primary ? 'text-white' : 'text-un1t-text'}`}>{label}</Text>
    </Pressable>
  )

  return (
    <>
      <Stack.Screen options={{ title }} />
      <ScrollView className="flex-1 bg-un1t-bg" contentContainerClassName="p-4 pb-10">
        <View className="flex-row items-center gap-2 mb-3">
          <View className={`px-2 py-0.5 rounded-full ${badge.bg}`}>
            <Text className={`text-[10px] uppercase tracking-wider font-semibold ${badge.fg}`}>{badge.text}</Text>
          </View>
          <Text className="text-xs text-un1t-muted capitalize">{session.phase} phase</Text>
        </View>

        {session.focus ? <Text className="text-lg font-semibold text-un1t-text mb-3">{session.focus}</Text> : null}

        {note ? (
          <View className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-3 py-2 mb-3 flex-row items-center gap-2">
            <Ionicons name="checkmark-circle" size={14} color="#047857" />
            <Text className="text-xs text-emerald-700">{note}</Text>
          </View>
        ) : null}
        {error ? (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2 mb-3">
            <Text className="text-xs text-red-700">{error}</Text>
          </View>
        ) : null}

        {/* Actions */}
        <View className="mb-4">
          {!isPublished && !isApproved && (
            <ActionBtn label="Approve" icon="checkmark" primary on={() => run('approve', () => setSessionStatus(id, 'approved'), 'Approved')} />
          )}
          {isApproved && (
            <ActionBtn label="Send back to draft" icon="arrow-undo" on={() => run('draft', () => setSessionStatus(id, 'draft'), 'Sent back to draft')} />
          )}
          {canPush && (
            <ActionBtn label={busy === 'push' ? 'Pushing…' : 'Push to TV'} icon="tv" on={() => run('push', () => pushSessionToTv(id), 'Live on the TV')} />
          )}
          {!isPublished && (
            <ActionBtn label={busy === 'regen' ? 'Regenerating…' : 'Regenerate'} icon="refresh" disabled={busy === 'regen'} on={() => run('regen', () => regenerateSession(id))} />
          )}
        </View>

        {/* TV board preview */}
        {session.board ? (
          <View className="mb-4">
            <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">TV board</Text>
            <HyroxBoardRN board={session.board} />
          </View>
        ) : null}

        {/* Coach session (leaner — no warmup, single level) */}
        <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">Coach session</Text>
        <View className="bg-un1t-surface border border-un1t-border rounded-xl p-4">
          <Field label="Strength" value={fs.strength} />
          <Field label="Main" value={fs.main} />
          <Field label="Finisher" value={fs.finisher} />
          {Array.isArray(fs.cues) && fs.cues.length > 0 ? (
            <View className="mb-2.5">
              <Text className="text-[11px] uppercase tracking-wider text-un1t-muted mb-0.5">Cues</Text>
              {fs.cues.map((c, i) => (
                <Text key={i} className="text-sm text-un1t-text leading-5">• {c}</Text>
              ))}
            </View>
          ) : null}
          <Field label="Why" value={fs.why} />
        </View>
      </ScrollView>
    </>
  )
}
