// INBOXFOLLOW.4 — the follow-up strip under a thread's header, shared by the
// WhatsApp and Instagram thread screens: who has the thread ("Handled by …"),
// a Snooze action, and the snooze state ("Snoozed until … · Unsnooze", or
// "Snooze ended · Dismiss" once a snooze has run out but is still set).
//
// Every rule and word is shared with the web (shared/inbox-queues,
// shared/inbox-row-text, shared/inbox-snooze) or pure and tested
// (lib/inbox-followup.js); this file only draws it. Times are the studio's
// (`zone`), never the phone's. The screen passes `snooze(body)` (its channel's
// route) and `onChanged()` (refetch the thread).

import { useRef, useState } from 'react'
import { View, Text, TextInput, Pressable, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Button, Modal } from './ui'
import { snoozePresets, SNOOZE_NOTE_MAX } from 'shared/inbox-snooze'
import { snoozeUntilLabel } from 'shared/inbox-row-text'
import { snoozeStripMode, handledByLine, snoozeBody, snoozeOutcome } from '../lib/inbox-followup'

export default function ThreadFollowupBar({ conv, channel, zone, snooze, onChanged }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // The press guard: state is read from a stale closure, so two presses in one
  // frame would both pass a `busy` check. A ref is set before the await.
  const inFlight = useRef(false)
  const mode = snoozeStripMode(conv)
  if (!conv) return null

  // One request: a snooze (until = an ISO instant) or a clear (until = null).
  async function send(until) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    let res
    try {
      res = await snooze(snoozeBody({ until, note, seenLastMessageAt: conv.last_message_at ?? null }))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
    const outcome = snoozeOutcome(res)
    if (outcome.ok) {
      setOpen(false)
      setNote('')
      onChanged?.()
      return
    }
    setError(outcome.message)
    // A 409: a newer message arrived. Show the route's words and reload, so the
    // next try carries the fresh last_message_at.
    if (outcome.refetch) onChanged?.()
  }

  const presets = open ? snoozePresets(Date.now(), zone) : []
  const noteText = conv.snooze_note ? ` · ${conv.snooze_note}` : ''

  return (
    <View className="bg-un1t-bg border-b border-un1t-border px-4 py-2">
      <View className="flex-row items-center">
        <Text className="text-xs text-un1t-subtle flex-1" testID="handled-by-line">{handledByLine(conv, channel)}</Text>
        {mode !== 'snoozed' && !conv.resolved_at && (
          <Pressable
            onPress={() => { setError(null); setOpen(true) }}
            accessibilityRole="button"
            accessibilityLabel="Snooze"
            hitSlop={8}
            className="flex-row items-center"
          >
            <Ionicons name="time-outline" size={14} color="#2563EB" />
            <Text className="text-xs text-blue-600 font-semibold ml-1">Snooze</Text>
          </Pressable>
        )}
      </View>

      {mode === 'snoozed' && (
        <View className="flex-row items-center mt-1">
          <Ionicons name="time-outline" size={13} color="#64748B" />
          <Text className="text-xs text-un1t-subtle flex-1 ml-1.5">
            {`Snoozed until ${snoozeUntilLabel(conv.snoozed_until, zone)}${noteText}`}
          </Text>
          <Pressable onPress={() => send(null)} disabled={busy} accessibilityRole="button" accessibilityLabel="Unsnooze" hitSlop={8}>
            {busy ? <ActivityIndicator size="small" /> : <Text className="text-xs text-blue-600 font-semibold">Unsnooze</Text>}
          </Pressable>
        </View>
      )}

      {mode === 'ended' && (
        <View className="flex-row items-center mt-1">
          <Ionicons name="alarm-outline" size={13} color="#B45309" />
          <Text className="text-xs text-amber-700 flex-1 ml-1.5">{`Snooze ended${noteText}`}</Text>
          <Pressable onPress={() => send(null)} disabled={busy} accessibilityRole="button" accessibilityLabel="Dismiss" hitSlop={8}>
            {busy ? <ActivityIndicator size="small" /> : <Text className="text-xs text-blue-600 font-semibold">Dismiss</Text>}
          </Pressable>
        </View>
      )}

      {!open && error && <Text className="text-xs text-red-600 mt-1">{error}</Text>}

      <Modal open={open} onClose={() => setOpen(false)} title="Snooze this conversation">
        <Text className="text-xs text-un1t-subtle mb-1">Note (optional)</Text>
        <TextInput
          value={note}
          onChangeText={setNote}
          maxLength={SNOOZE_NOTE_MAX}
          placeholder="e.g. waiting on the quote"
          placeholderTextColor="#94A3B8"
          className="bg-un1t-surface border border-un1t-border rounded-lg px-3 py-2 text-sm text-un1t-text mb-3"
        />
        {presets.map(p => (
          <Button
            key={p.key}
            label={p.label}
            variant="secondary"
            disabled={busy}
            onPress={() => send(p.untilIso)}
            className="mb-2"
          />
        ))}
        {error && <Text className="text-xs text-red-600 mt-1">{error}</Text>}
      </Modal>
    </View>
  )
}
