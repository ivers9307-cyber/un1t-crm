// W1 — contact detail (read). The lookup payoff: see a member's details
// and call / text / email / WhatsApp them in one tap, plus recent
// activity. Editing stays on web.
import { useState, useCallback } from 'react'
import { View, Text, ScrollView, ActivityIndicator, Pressable, Linking } from 'react-native'
import { useLocalSearchParams, useFocusEffect, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import {
  getContact, listActivitiesForContact, prettyStage, contactDisplayName,
} from '../../lib/contacts-api'
import { useAuth } from '../../lib/auth-context'
import { canMobile } from '../../lib/permissions'
import BackHeaderLeft from '../../components/BackHeaderLeft'
import ContactComposeModal from '../../components/ContactComposeModal'

function digits(s) { return (s || '').replace(/[^0-9+]/g, '') }

function ActionButton({ icon, label, onPress }) {
  return (
    <Pressable onPress={onPress} className="items-center px-3 py-2 rounded-xl bg-un1t-surface border border-un1t-border active:opacity-70" accessibilityRole="button" accessibilityLabel={label}>
      <Ionicons name={icon} size={20} color="#1E293B" />
      <Text className="text-[11px] text-un1t-subtle mt-1">{label}</Text>
    </Pressable>
  )
}

function Field({ label, value }) {
  if (!value) return null
  return (
    <View className="flex-row justify-between px-4 py-3 border-b border-un1t-border">
      <Text className="text-sm text-un1t-subtle">{label}</Text>
      <Text className="text-sm text-un1t-text flex-1 text-right ml-3" numberOfLines={1}>{value}</Text>
    </View>
  )
}

function fmtDate(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function ContactDetail() {
  const params = useLocalSearchParams()
  const id = Array.isArray(params.id) ? params.id[0] : params.id

  const { profile, activeLocation } = useAuth()
  const [contact, setContact] = useState(null)
  const [activities, setActivities] = useState([])
  const [error, setError] = useState(null)
  // MOBILE-CONTACT-SEND.1 — which channel composer (if any) is open.
  const [composeChannel, setComposeChannel] = useState(null)

  const load = useCallback(async () => {
    const res = await getContact(id)
    if (!res.success) { setError(res.error || 'Could not load contact'); setContact(null); return }
    setError(null)
    setContact(res.data)
    // Recent activity — best-effort, never blocks the card.
    listActivitiesForContact(id).then(r => setActivities(Array.isArray(r?.data) ? r.data : [])).catch(() => {})
  }, [id])

  useFocusEffect(useCallback(() => { load().catch(() => {}) }, [load]))

  const openUrl = (url) => Linking.openURL(url).catch(() => {})

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: contact ? contactDisplayName(contact) : 'Contact', headerLeft: () => <BackHeaderLeft label="Contacts" fallbackHref="/contacts" /> }} />

      {error ? (
        <View className="flex-1 items-center justify-center p-6">
          <Ionicons name="alert-circle-outline" size={40} color="#EF4444" />
          <Text className="text-sm text-un1t-subtle text-center mt-3 mb-4">{error}</Text>
          <Pressable onPress={load} className="bg-un1t-surface border border-un1t-border px-5 py-2.5 rounded-xl active:opacity-80">
            <Text className="text-un1t-text font-semibold">Try again</Text>
          </Pressable>
        </View>
      ) : !contact ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator color="#94A3B8" /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
          <Text className="text-2xl font-bold text-un1t-text">{contactDisplayName(contact)}</Text>
          {contact.pipeline_stage_slug && (
            <View className="self-start mt-2 rounded-full bg-un1t-surface border border-un1t-border px-3 py-1">
              <Text className="text-xs font-medium text-un1t-subtle">{prettyStage(contact.pipeline_stage_slug)}</Text>
            </View>
          )}

          {/* Quick actions. Call stays a phone dial; Text / WhatsApp /
              Email send through the platform's linked services (company
              sender), gated per-channel by the mobile messaging perms. */}
          <View className="flex-row gap-2 mt-4">
            {contact.phone && <ActionButton icon="call-outline" label="Call" onPress={() => openUrl(`tel:${digits(contact.phone)}`)} />}
            {contact.phone && canMobile(profile, 'sms', activeLocation) && <ActionButton icon="chatbubble-outline" label="Text" onPress={() => setComposeChannel('sms')} />}
            {(contact.wa_phone || contact.phone) && canMobile(profile, 'whatsapp', activeLocation) && <ActionButton icon="logo-whatsapp" label="WhatsApp" onPress={() => setComposeChannel('whatsapp')} />}
            {contact.email && canMobile(profile, 'email', activeLocation) && <ActionButton icon="mail-outline" label="Email" onPress={() => setComposeChannel('email')} />}
          </View>

          {/* Fields */}
          <View className="bg-white border border-un1t-border rounded-2xl overflow-hidden mt-5">
            <Field label="Phone" value={contact.phone} />
            <Field label="WhatsApp" value={contact.wa_phone} />
            <Field label="Email" value={contact.email} />
            <Field label="Lead source" value={contact.lead_source} />
            <Field label="Member since" value={fmtDate(contact.created_at)} />
          </View>

          {/* Recent activity */}
          {activities.length > 0 && (
            <View className="mt-5">
              <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle px-1 mb-2">Recent activity</Text>
              <View className="bg-white border border-un1t-border rounded-2xl overflow-hidden">
                {activities.slice(0, 6).map((a, i) => (
                  <View key={a.id} className={`px-4 py-3 ${i < Math.min(activities.length, 6) - 1 ? 'border-b border-un1t-border' : ''}`}>
                    <Text className="text-sm text-un1t-text" numberOfLines={2}>{a.subject || a.note || a.type || 'Activity'}</Text>
                    {(a.due_date || a.created_at) && (
                      <Text className="text-[11px] text-un1t-subtle mt-0.5">{fmtDate(a.due_date || a.created_at)}{a.done ? ' · done' : ''}</Text>
                    )}
                  </View>
                ))}
              </View>
            </View>
          )}

          <Text className="text-[11px] text-un1t-muted text-center mt-5 px-4">Editing contacts stays on the web for now.</Text>
        </ScrollView>
      )}

      {contact && (
        <ContactComposeModal
          visible={!!composeChannel}
          channel={composeChannel}
          contactId={id}
          contactName={contactDisplayName(contact)}
          onClose={() => { setComposeChannel(null); load().catch(() => {}) }}
        />
      )}
    </View>
  )
}
