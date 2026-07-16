// CC-M.1 — merged notes + activities timeline for the mobile contact
// command-centre, with the web drawer's Note-first composer on top.
//
// The composer POSTs /api/contacts/[id]/notes (createContactNote) — the
// session route that also copies the note into Glofox as a front-desk
// interaction (GLOFOX-NOTES). Inbound Glofox interactions arrive as
// activities rows with source='glofox' and get the same provenance chip
// the web timeline shows, so staff can tell a front-desk Glofox note
// from a CRM one at a glance.
import { useState } from 'react'
import { View, Text, TextInput, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Button, Tabs } from './ui'
import { colors } from '../lib/colors'
import { createContactNote } from '../lib/contacts-api'
import {
  mergeTimeline, timelineFilterGroup, TIMELINE_FILTERS,
  isGlofoxSynced, timelineIconMeta,
} from '../lib/contact-command-centre'

function fmtItemDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IE', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

function NoteComposer({ contactId, syncsToGlofox, onCreated }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [flash, setFlash] = useState(null)

  const trimmed = text.trim()

  async function submit() {
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    setFlash(null)
    const res = await createContactNote(contactId, trimmed)
    setBusy(false)
    if (!res?.success) {
      setError(res?.error || 'Could not save the note')
      return
    }
    setText('')
    setFlash('Note added')
    onCreated?.()
  }

  return (
    <View className="bg-white border border-un1t-border rounded-2xl p-4">
      <TextInput
        value={text}
        onChangeText={(v) => { setText(v); setFlash(null) }}
        multiline
        placeholder="Add a note…"
        placeholderTextColor={colors.muted}
        className="text-base text-un1t-text min-h-[64px]"
        textAlignVertical="top"
        accessibilityLabel="Note text"
      />
      <View className="flex-row items-center justify-between mt-2">
        <Text className="text-[11px] text-un1t-muted flex-1 mr-2">
          {syncsToGlofox ? 'Also posts to the member’s Glofox timeline.' : 'Visible to staff on web and mobile.'}
        </Text>
        <Button
          label="Add note"
          size="sm"
          onPress={submit}
          loading={busy}
          disabled={!trimmed}
        />
      </View>
      {!!flash && !error && <Text className="text-xs text-green-700 mt-2">{flash}</Text>}
      {!!error && <Text className="text-xs text-red-700 mt-2">{error}</Text>}
    </View>
  )
}

function TimelineItem({ item, isLast }) {
  const meta = timelineIconMeta(item.activityType)
  const body = item.content || item.note || item.description || ''
  const showSubject = item.kind === 'activity' && item.activityType !== 'note' && item.subject
  return (
    <View className={`flex-row gap-3 px-4 py-3 ${isLast ? '' : 'border-b border-un1t-border'}`}>
      <View className={`mt-0.5 w-7 h-7 rounded-full items-center justify-center ${meta.bg}`}>
        <Ionicons name={meta.icon} size={14} color={meta.color} />
      </View>
      <View className="flex-1 min-w-0">
        <View className="flex-row items-center justify-between gap-2">
          <View className="flex-row items-center gap-2 flex-1 min-w-0">
            <Text className="text-xs font-medium text-un1t-subtle uppercase">{meta.label}</Text>
            {isGlofoxSynced(item) && (
              <View className="rounded-full px-1.5 py-0.5 bg-slate-500/10">
                <Text className="text-[10px] font-medium text-slate-700">Glofox</Text>
              </View>
            )}
          </View>
          <Text className="text-xs text-un1t-muted">{fmtItemDate(item.date)}</Text>
        </View>
        {showSubject ? (
          <Text className="text-sm font-medium text-un1t-text mt-1">{item.subject}</Text>
        ) : null}
        {body ? (
          <Text className="text-sm text-un1t-subtle mt-1">{body}</Text>
        ) : null}
        {item.kind === 'activity' && item.done
          && item.activityType !== 'pipeline' && item.activityType !== 'booking' && (
          <Text className="text-xs text-green-700 mt-1">Completed</Text>
        )}
      </View>
    </View>
  )
}

/**
 * @param {object} props
 * @param {string}  props.contactId
 * @param {boolean} props.syncsToGlofox  contact is Glofox-linked (composer hint)
 * @param {Array|null} props.notes       null while the bundle is loading
 * @param {Array|null} props.activities
 * @param {string|null} props.loadError
 * @param {() => void} props.onRefresh   re-fetch the bundle after a note post
 */
export default function ContactTimelineSection({
  contactId, syncsToGlofox, notes, activities, loadError, onRefresh,
}) {
  const [filter, setFilter] = useState('all')
  const loading = notes == null && activities == null && !loadError
  const timeline = mergeTimeline(notes, activities)
  const items = filter === 'all'
    ? timeline
    : timeline.filter((i) => timelineFilterGroup(i) === filter)

  return (
    <View className="mt-5">
      <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle px-1 mb-2" accessibilityRole="header">
        Notes & activity
      </Text>

      <NoteComposer contactId={contactId} syncsToGlofox={syncsToGlofox} onCreated={onRefresh} />

      <View className="mt-3 mb-2">
        <Tabs tabs={TIMELINE_FILTERS} value={filter} onChange={setFilter} />
      </View>

      <View className="bg-white border border-un1t-border rounded-2xl overflow-hidden">
        {loading ? (
          <View className="py-8 items-center"><ActivityIndicator color={colors.muted} /></View>
        ) : loadError ? (
          <Text className="text-sm text-un1t-muted text-center py-8 px-4">{loadError}</Text>
        ) : items.length === 0 ? (
          <Text className="text-sm text-un1t-muted text-center py-8">No activity yet</Text>
        ) : (
          items.map((item, i) => (
            <TimelineItem
              key={`${item.kind}-${item.id ?? i}`}
              item={item}
              isLast={i === items.length - 1}
            />
          ))
        )}
      </View>
    </View>
  )
}
