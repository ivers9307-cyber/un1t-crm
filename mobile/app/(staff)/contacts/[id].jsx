// CC-M.1 — mobile contact command-centre (was the W1 lookup card).
// Phone-sized mirror of the web /contacts/[id] command-centre page:
//
//   1. Header: name, funnel stage, live Glofox state chip (Overdue =
//      the arrears signal) + the original quick actions.
//   2. Contact fields (unchanged from W1).
//   3. Glofox membership card — plan, billing, tenure, engagement,
//      class bookings — from the denormalised contact columns.
//   4. CRM event bookings (upcoming/past), when the caller can read
//      the bookings table (RLS gates on the mobile `bookings` key).
//   5. WhatsApp thread deep-link, when one exists and the caller has
//      the whatsapp permission.
//   6. Note-first composer + merged notes+activities timeline with
//      Glofox provenance chips (the drawer bundle route).
//   7. Send kudos (web-consultations-gated, same as the web card).
//
// Editing contact fields stays on the web — this screen adds read
// surfaces plus the note + kudos writes only.
import { useState, useCallback, useMemo } from 'react'
import { View, Text, ScrollView, ActivityIndicator, Pressable, Linking } from 'react-native'
import { useLocalSearchParams, useFocusEffect, useRouter, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import {
  getContact, getContactCommandCentre, listBookingsForContact,
  getWhatsAppThreadForContact, prettyStage, contactDisplayName,
} from '../../../lib/contacts-api'
import { useAuth } from '../../../lib/auth-context'
import { canMobile, canDashboard } from '../../../lib/permissions'
import { colors } from '../../../lib/colors'
import { isoDate } from '../../../lib/dates'
import {
  glofoxStateMeta, glofoxPauseResumeLabel, splitCrmBookings, crmBookingStatusMeta, relativeTime,
} from '../../../lib/contact-command-centre'
import { formatBookingTime } from '../../../lib/bookings-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'
import ContactComposeModal from '../../../components/ContactComposeModal'
import ContactGlofoxCard from '../../../components/ContactGlofoxCard'
import ContactTimelineSection from '../../../components/ContactTimelineSection'
import SendKudosCard from '../../../components/SendKudosCard'

const PAST_BOOKINGS_SHOWN = 8

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

// booking_date is a Dublin wall-clock DATE — parse local (never `…Z`).
function fmtBookingDate(dateStr) {
  if (!dateStr) return ''
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' })
}

function BookingRow({ b, isLast }) {
  const meta = crmBookingStatusMeta(b.status)
  return (
    <View className={`flex-row items-center justify-between gap-2 px-4 py-3 ${isLast ? '' : 'border-b border-un1t-border'}`}>
      <View className="flex-1 min-w-0">
        <Text className="text-sm font-medium text-un1t-text" numberOfLines={1}>
          {b.event_type?.name || 'Event'}
        </Text>
        <Text className="text-xs text-un1t-subtle mt-0.5">
          {fmtBookingDate(b.booking_date)}
          {b.start_time ? ` · ${formatBookingTime(b.start_time)}` : ''}
        </Text>
      </View>
      {meta && (
        <View className={`rounded-full px-2 py-0.5 ${meta.cls}`}>
          <Text className={`text-[10px] font-medium ${meta.text}`}>{meta.label}</Text>
        </View>
      )}
    </View>
  )
}

function BookingsSection({ bookings }) {
  const todayStr = isoDate(new Date())
  const { upcoming, past } = splitCrmBookings(bookings, todayStr)
  if (upcoming.length === 0 && past.length === 0) return null
  const pastShown = past.slice(0, PAST_BOOKINGS_SHOWN)
  return (
    <View className="mt-5">
      <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle px-1 mb-2" accessibilityRole="header">
        Event bookings
      </Text>
      {upcoming.length > 0 && (
        <View className="bg-white border border-un1t-border rounded-2xl overflow-hidden">
          <Text className="text-[10px] uppercase tracking-wider text-un1t-muted px-4 pt-3 pb-1">Upcoming</Text>
          {upcoming.map((b, i) => (
            <BookingRow key={b.id} b={b} isLast={i === upcoming.length - 1} />
          ))}
        </View>
      )}
      {pastShown.length > 0 && (
        <View className={`bg-white border border-un1t-border rounded-2xl overflow-hidden ${upcoming.length > 0 ? 'mt-2' : ''}`}>
          <Text className="text-[10px] uppercase tracking-wider text-un1t-muted px-4 pt-3 pb-1">Past</Text>
          {pastShown.map((b, i) => (
            <BookingRow key={b.id} b={b} isLast={i === pastShown.length - 1} />
          ))}
        </View>
      )}
    </View>
  )
}

function WhatsAppThreadRow({ conversation, onPress }) {
  return (
    <View className="mt-5">
      <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle px-1 mb-2" accessibilityRole="header">
        WhatsApp
      </Text>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="Open WhatsApp conversation"
        className="bg-white border border-un1t-border rounded-2xl px-4 py-3 flex-row items-center gap-3 active:opacity-70"
      >
        <Ionicons name="logo-whatsapp" size={20} color="#15803D" />
        <View className="flex-1 min-w-0">
          <Text className="text-sm text-un1t-text" numberOfLines={1}>
            {conversation.last_message_direction === 'outbound' ? 'You: ' : ''}
            {conversation.last_message_preview || 'No messages yet'}
          </Text>
          <Text className="text-[11px] text-un1t-muted mt-0.5">
            {conversation.last_message_at ? relativeTime(conversation.last_message_at) : ''}
          </Text>
        </View>
        {conversation.unread_count > 0 && (
          <View className="bg-green-600 rounded-full w-5 h-5 items-center justify-center">
            <Text className="text-[10px] font-bold text-white">{conversation.unread_count}</Text>
          </View>
        )}
        <Ionicons name="chevron-forward" size={16} color={colors.muted} />
      </Pressable>
    </View>
  )
}

export default function ContactDetail() {
  const params = useLocalSearchParams()
  const id = Array.isArray(params.id) ? params.id[0] : params.id
  const router = useRouter()

  const { profile, activeLocation } = useAuth()
  const [contact, setContact] = useState(null)
  const [error, setError] = useState(null)
  // CC-M.1 — drawer bundle (notes + activities); null = still loading.
  const [notes, setNotes] = useState(null)
  const [activities, setActivities] = useState(null)
  const [bundleError, setBundleError] = useState(null)
  const [bookings, setBookings] = useState([])
  const [waConversation, setWaConversation] = useState(null)
  // MOBILE-CONTACT-SEND.1 — which channel composer (if any) is open.
  const [composeChannel, setComposeChannel] = useState(null)

  const canBookings = canMobile(profile, 'bookings', activeLocation)
  const canWhatsApp = canMobile(profile, 'whatsapp', activeLocation)
  // Kudos visibility mirrors the web SendKudosCard gate: the top-level
  // web `consultations` permission (canDashboard resolves top-level keys
  // against the web defaults — same resolution as web hasPermission).
  const canKudos = canDashboard(profile, 'consultations', activeLocation)

  // Timeline bundle — the web drawer's one-round-trip route. Separate
  // from load() so the note composer can refresh just this slice.
  const loadTimeline = useCallback(async () => {
    try {
      const res = await getContactCommandCentre(id)
      if (res?.success) {
        setNotes(Array.isArray(res.notes) ? res.notes : [])
        setActivities(Array.isArray(res.activities) ? res.activities : [])
        setBundleError(null)
      } else {
        setBundleError(res?.error || 'Could not load the timeline')
      }
    } catch {
      setBundleError('Could not load the timeline')
    }
  }, [id])

  const load = useCallback(async () => {
    const res = await getContact(id)
    if (!res.success) { setError(res.error || 'Could not load contact'); setContact(null); return }
    setError(null)
    setContact(res.data)
    // Secondary sections — best-effort, never block the card.
    loadTimeline()
    if (canBookings) {
      listBookingsForContact(id).then(r => setBookings(Array.isArray(r?.data) ? r.data : [])).catch(() => {})
    }
    if (canWhatsApp) {
      getWhatsAppThreadForContact(id).then(r => setWaConversation(r?.data || null)).catch(() => {})
    }
  }, [id, loadTimeline, canBookings, canWhatsApp])

  useFocusEffect(useCallback(() => { load().catch(() => {}) }, [load]))

  const openUrl = (url) => Linking.openURL(url).catch(() => {})

  const stateChip = useMemo(() => glofoxStateMeta(contact?.glofox_membership_state), [contact])
  // GLOFOX-REACTIVE — "· resumes {date}" suffix on the paused state chip.
  const pauseResume = useMemo(() => glofoxPauseResumeLabel(contact), [contact])

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
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          <Text className="text-2xl font-bold text-un1t-text">{contactDisplayName(contact)}</Text>
          <View className="flex-row items-center flex-wrap gap-2 mt-2">
            {contact.pipeline_stage_slug && (
              <View className="rounded-full bg-un1t-surface border border-un1t-border px-3 py-1">
                <Text className="text-xs font-medium text-un1t-subtle">{prettyStage(contact.pipeline_stage_slug)}</Text>
              </View>
            )}
            {/* Live Glofox state — 'locked' renders as Overdue, the same
                arrears signal the web header + churn radar surface. */}
            {stateChip && (
              <View className={`rounded-full px-3 py-1 ${stateChip.cls}`}>
                <Text className={`text-xs font-medium ${stateChip.text}`}>
                  {stateChip.label}{pauseResume ? ` · resumes ${pauseResume}` : ''}
                </Text>
              </View>
            )}
          </View>

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
            <Field label="Added" value={fmtDate(contact.created_at)} />
          </View>

          {/* Glofox membership (plan, billing, engagement, classes) */}
          <ContactGlofoxCard contact={contact} />

          {/* CRM event bookings — only when the caller can read the
              bookings table at all (RLS gates on the mobile `bookings`
              permission; rendering an always-empty section would read
              as "no bookings" for permission reasons). */}
          {canBookings && <BookingsSection bookings={bookings} />}

          {/* WhatsApp thread deep-link */}
          {canWhatsApp && waConversation && (
            <WhatsAppThreadRow
              conversation={waConversation}
              onPress={() => router.push(`/whatsapp/${waConversation.id}`)}
            />
          )}

          {/* Note composer + merged timeline */}
          <ContactTimelineSection
            contactId={id}
            syncsToGlofox={Boolean(contact.glofox_member_id)}
            notes={notes}
            activities={activities}
            loadError={bundleError}
            onRefresh={loadTimeline}
          />

          {/* Coach kudos (web consultations gate) */}
          {canKudos && <SendKudosCard contactId={id} />}

          <Text className="text-[11px] text-un1t-muted text-center mt-6 px-4">Editing contacts stays on the web for now.</Text>
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
