// Deal detail screen. iOS-feeling sectioned layout:
//   1. Contact card (avatar, name, lead status, contact actions)
//   2. Stage selector — tap to move to a different stage
//   3. Won / Lost actions
//   4. Activity timeline (notes + activities, newest first)
//   5. Quick add: log call / log note
//
// Actions hit Supabase directly via lib/pipeline-api.js — RLS at the
// DB layer enforces multi-tenancy. The mobile JWT carries the user's
// auth.uid() so private.auth_is_in_location() works as it does on web.

import { useEffect, useState, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, TextInput, Linking,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useLocalSearchParams, useRouter, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'

// Explicit headerLeft so the back chevron is visible even when this is
// the only screen in the pipeline/ sub-stack. iOS's auto back-button
// only appears when the *current* navigator has a previous screen, but
// here the previous screen lives in the (tabs) navigator one level up.
function BackHeaderLeft({ router, label = 'Back' }) {
  return (
    <Pressable
      onPress={() => router.back()}
      hitSlop={12}
      className="flex-row items-center -ml-1"
    >
      <Ionicons name="chevron-back" size={26} color="#111827" />
      <Text className="text-base text-un1t-white">{label}</Text>
    </Pressable>
  )
}
import { useAuth } from '../../lib/auth-context'
import {
  getDeal, listStages, moveDeal, setDealStatus,
  listActivitiesForContact, listNotesForContact,
  logActivity, createNote,
} from '../../lib/pipeline-api'

function ContactActions({ contact }) {
  const items = []
  if (contact?.phone) items.push({ icon: 'call-outline', label: 'Call', url: `tel:${contact.phone}` })
  if (contact?.wa_phone) items.push({ icon: 'logo-whatsapp', label: 'WhatsApp', url: `https://wa.me/${contact.wa_phone.replace(/[^0-9]/g, '')}` })
  if (contact?.email) items.push({ icon: 'mail-outline', label: 'Email', url: `mailto:${contact.email}` })
  if (!items.length) return null
  return (
    <View className="flex-row mt-3">
      {items.map(it => (
        <Pressable
          key={it.label}
          onPress={() => Linking.openURL(it.url).catch(() => {})}
          className="flex-1 mr-2 py-2.5 rounded-xl bg-un1t-gray/40 flex-row items-center justify-center active:opacity-70"
        >
          <Ionicons name={it.icon} size={16} color="#111827" />
          <Text className="text-sm font-medium text-un1t-white ml-1.5">{it.label}</Text>
        </Pressable>
      ))}
    </View>
  )
}

function Section({ title, children, action }) {
  return (
    <View className="mb-5">
      <View className="flex-row items-center justify-between mb-2 px-1">
        <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-light">
          {title}
        </Text>
        {action}
      </View>
      {children}
    </View>
  )
}

export default function DealDetail() {
  const { dealId } = useLocalSearchParams()
  const { activeLocation } = useAuth()
  const router = useRouter()
  const [deal, setDeal] = useState(null)
  const [stages, setStages] = useState([])
  const [activities, setActivities] = useState([])
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [logText, setLogText] = useState('')
  const [logKind, setLogKind] = useState('note')   // 'note' | 'call' | 'email' | 'meeting'
  const [submittingLog, setSubmittingLog] = useState(false)

  const refresh = useCallback(async () => {
    const [dealRes, stagesRes] = await Promise.all([
      getDeal(dealId),
      listStages(activeLocation?.id),
    ])
    if (dealRes.success) setDeal(dealRes.data)
    if (stagesRes.success) setStages(stagesRes.data || [])

    if (dealRes.success && dealRes.data?.contact_id) {
      const [actRes, noteRes] = await Promise.all([
        listActivitiesForContact(dealRes.data.contact_id),
        listNotesForContact(dealRes.data.contact_id),
      ])
      setActivities(actRes.success ? actRes.data || [] : [])
      setNotes(noteRes.success ? noteRes.data || [] : [])
    }
  }, [dealId, activeLocation])

  useEffect(() => {
    setLoading(true)
    refresh().finally(() => setLoading(false))
  }, [refresh])

  async function moveToStage(stageId) {
    const res = await moveDeal(dealId, stageId)
    if (!res.success) Alert.alert('Couldn’t move deal', res.error)
    else refresh()
  }

  async function markStatus(status) {
    Alert.alert(
      `Mark as ${status}?`,
      status === 'won' ? 'This will close the deal as won.' : 'This will close the deal as lost.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: status === 'won' ? 'Mark won' : 'Mark lost',
          style: status === 'lost' ? 'destructive' : 'default',
          onPress: async () => {
            const res = await setDealStatus(dealId, status)
            if (!res.success) Alert.alert('Couldn’t update', res.error)
            else router.back()
          },
        },
      ]
    )
  }

  // Save the typed log entry as either a Note (free-form) or an
  // Activity (call/email/meeting with the typed text as the body).
  // The user picks the kind via the segmented buttons above the
  // input — the row no longer fires-and-forgets, so they get a
  // chance to write what was discussed before saving.
  async function saveLog() {
    if (!logText.trim()) return
    setSubmittingLog(true)

    let res
    if (logKind === 'note') {
      res = await createNote({
        contactId: deal.contact_id,
        dealId: deal.id,
        content: logText.trim(),
        locationId: activeLocation?.id,
      })
    } else {
      // First line (or first 100 chars) of the body becomes the
      // activity subject so the timeline preview is meaningful;
      // full body lives on `note`.
      const trimmed = logText.trim()
      const subject = trimmed.split('\n')[0].slice(0, 120)
      res = await logActivity({
        contactId: deal.contact_id,
        dealId: deal.id,
        type: logKind,
        subject,
        note: trimmed,
        locationId: activeLocation?.id,
      })
    }

    setSubmittingLog(false)
    if (!res.success) {
      Alert.alert('Couldn’t save', res.error)
      return
    }
    setLogText('')
    setLogKind('note')
    refresh()
  }

  if (loading || !deal) {
    return (
      <View className="flex-1 bg-un1t-black items-center justify-center">
        <Stack.Screen
          options={{
            title: 'Deal',
            headerLeft: () => <BackHeaderLeft router={router} label="Pipeline" />,
          }}
        />
        <ActivityIndicator />
      </View>
    )
  }

  const contact = deal.contacts
  const name = contact?.name
    || [contact?.first_name, contact?.last_name].filter(Boolean).join(' ')
    || 'Unknown'

  // Merge & sort activities + notes for the timeline.
  const timeline = [
    ...activities.map(a => ({ kind: 'activity', ...a })),
    ...notes.map(n => ({ kind: 'note', subject: 'Note', note: n.content, ...n })),
  ].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-un1t-black"
    >
      <Stack.Screen
        options={{
          title: deal.title || 'Deal',
          headerLeft: () => <BackHeaderLeft router={router} label="Pipeline" />,
        }}
      />

      <ScrollView
        contentContainerClassName="p-4"
        keyboardShouldPersistTaps="handled"
      >
        {/* Contact */}
        <Section title="Contact">
          <View className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4">
            <View className="flex-row items-center">
              <View className="w-12 h-12 rounded-full bg-un1t-gray/40 items-center justify-center mr-3">
                <Text className="text-lg font-semibold text-un1t-white">
                  {(name[0] || '?').toUpperCase()}
                </Text>
              </View>
              <View className="flex-1">
                <Text className="text-base font-semibold text-un1t-white">{name}</Text>
                {contact?.lead_status && (
                  <Text className="text-xs text-un1t-light capitalize">
                    {contact.lead_status.replace(/_/g, ' ')}
                    {contact.lead_source ? ` · ${contact.lead_source}` : ''}
                  </Text>
                )}
              </View>
            </View>
            <ContactActions contact={contact} />
          </View>
        </Section>

        {/* Stage selector */}
        <Section title="Stage">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="pr-4">
            {stages.map(s => {
              const sel = s.id === deal.stage_id
              return (
                <Pressable
                  key={s.id}
                  onPress={() => moveToStage(s.id)}
                  className={`mr-2 px-4 py-2 rounded-full flex-row items-center ${
                    sel ? 'bg-un1t-white' : 'bg-un1t-dark border border-un1t-gray'
                  }`}
                >
                  <View className="w-2 h-2 rounded-full mr-2" style={{ backgroundColor: s.color || '#94A3B8' }} />
                  <Text className={`text-sm ${sel ? 'text-un1t-black font-semibold' : 'text-un1t-white'}`}>
                    {s.name}
                  </Text>
                </Pressable>
              )
            })}
          </ScrollView>
        </Section>

        {/* Close actions */}
        <Section title="Close">
          <View className="flex-row">
            <Pressable
              onPress={() => markStatus('won')}
              className="flex-1 mr-2 py-3 rounded-xl bg-green-500/10 border border-green-500/30 items-center active:opacity-70"
            >
              <Text className="text-sm font-semibold text-green-700">Mark won</Text>
            </Pressable>
            <Pressable
              onPress={() => markStatus('lost')}
              className="flex-1 py-3 rounded-xl bg-red-500/10 border border-red-500/30 items-center active:opacity-70"
            >
              <Text className="text-sm font-semibold text-red-600">Mark lost</Text>
            </Pressable>
          </View>
        </Section>

        {/* Log activity — type picker + composer. The 4 buttons act
            as a segmented control: tapping one selects that kind, but
            nothing saves until the user taps the Save button below.
            The placeholder text + save-button label both reflect the
            current selection so it's obvious what's about to happen. */}
        <Section title="Log activity">
          <View className="flex-row mb-2">
            {[
              { kind: 'note',    icon: 'document-text-outline', label: 'Note' },
              { kind: 'call',    icon: 'call-outline',          label: 'Call' },
              { kind: 'email',   icon: 'mail-outline',          label: 'Email' },
              { kind: 'meeting', icon: 'people-outline',        label: 'Meeting' },
            ].map(t => {
              const sel = logKind === t.kind
              return (
                <Pressable
                  key={t.kind}
                  onPress={() => setLogKind(t.kind)}
                  className={`flex-1 mr-2 py-2.5 rounded-xl flex-row items-center justify-center border active:opacity-70 ${
                    sel ? 'bg-un1t-white border-un1t-white' : 'bg-un1t-dark border-un1t-gray'
                  }`}
                >
                  <Ionicons name={t.icon} size={14} color={sel ? '#FFFFFF' : '#111827'} />
                  <Text className={`text-xs font-medium ml-1 ${sel ? 'text-un1t-black' : 'text-un1t-white'}`}>
                    {t.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
          <View className="bg-un1t-dark border border-un1t-gray rounded-xl">
            <TextInput
              value={logText}
              onChangeText={setLogText}
              multiline
              placeholder={
                logKind === 'note'    ? 'Add a note…' :
                logKind === 'call'    ? 'What was discussed on the call?' :
                logKind === 'email'   ? 'Summary of the email…' :
                                        'Summary of the meeting…'
              }
              placeholderTextColor="#94A3B8"
              className="px-4 py-3 text-base text-un1t-white min-h-[80px]"
              textAlignVertical="top"
            />
            <Pressable
              onPress={saveLog}
              disabled={!logText.trim() || submittingLog}
              className={`m-2 py-2.5 rounded-lg items-center ${
                logText.trim() && !submittingLog ? 'bg-un1t-white' : 'bg-un1t-gray'
              }`}
            >
              {submittingLog ? (
                <ActivityIndicator />
              ) : (
                <Text className="text-un1t-black font-semibold text-sm">
                  Save {logKind === 'note' ? 'note' : logKind}
                </Text>
              )}
            </Pressable>
          </View>
        </Section>

        {/* Timeline */}
        <Section title="History">
          {timeline.length === 0 && (
            <Text className="text-sm text-un1t-light text-center py-4">
              No activity yet.
            </Text>
          )}
          {timeline.map(t => (
            <View key={`${t.kind}-${t.id}`} className="bg-un1t-dark border border-un1t-gray rounded-xl p-3 mb-2">
              <View className="flex-row items-center mb-1">
                <Ionicons
                  name={
                    t.kind === 'note' ? 'document-text-outline'
                    : t.type === 'call' ? 'call-outline'
                    : t.type === 'email' ? 'mail-outline'
                    : t.type === 'meeting' ? 'people-outline'
                    : 'ellipse-outline'
                  }
                  size={14}
                  color="#64748B"
                />
                <Text className="text-xs text-un1t-light ml-1.5 capitalize">
                  {t.kind === 'note' ? 'Note' : t.type || 'activity'}
                </Text>
                <Text className="text-xs text-un1t-mid ml-auto">
                  {t.created_at ? new Date(t.created_at).toLocaleDateString() : ''}
                </Text>
              </View>
              <Text className="text-sm text-un1t-white">
                {t.subject || t.note || ''}
              </Text>
              {t.note && t.subject !== t.note && (
                <Text className="text-sm text-un1t-light mt-1">{t.note}</Text>
              )}
            </View>
          ))}
        </Section>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
