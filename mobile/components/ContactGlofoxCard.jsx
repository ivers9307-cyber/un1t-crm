// CC-M.1 — mobile Glofox membership card, the phone-sized mirror of the
// web command-centre's GlofoxProfileCard: status + live-state chips (the
// state chip carries the arrears signal — Glofox 'locked' renders as
// "Overdue"), plan + billing + renewal, tenure/engagement strip, and the
// Glofox class bookings (upcoming/recent) from the denormalised
// contacts.recent_bookings JSONB. Read-only: linking a contact to Glofox
// stays a web action, so the unlinked state is just a hint here.
import { View, Text } from 'react-native'
import {
  glofoxStatusMeta, glofoxStateMeta, formatTenure, relativeTime,
  formatMoney, formatShortDate, billingLine,
  splitGlofoxBookings, glofoxBookingBadge, formatGlofoxBookingTime,
} from '../lib/contact-command-centre'

function Chip({ meta }) {
  if (!meta) return null
  return (
    <View className={`rounded-full px-2 py-0.5 ${meta.cls}`}>
      <Text className={`text-xs font-medium ${meta.text}`}>{meta.label}</Text>
    </View>
  )
}

function GlofoxBookingRow({ b, when }) {
  const badge = glofoxBookingBadge(b, when)
  const cancelled = badge?.label === 'Cancelled'
  return (
    <View className="flex-row items-start justify-between gap-2 py-1">
      <View className="flex-1 min-w-0">
        <Text
          className={`text-sm font-medium ${cancelled ? 'line-through text-un1t-muted' : 'text-un1t-text'}`}
          numberOfLines={1}
        >
          {b.event_name || b.model_name || 'Class'}
        </Text>
        <Text className="text-xs text-un1t-muted">{formatGlofoxBookingTime(b.time_start)}</Text>
      </View>
      {badge && (
        <View className={`rounded px-1.5 py-0.5 ${badge.cls}`}>
          <Text className={`text-[10px] font-medium ${badge.text}`}>{badge.label}</Text>
        </View>
      )}
    </View>
  )
}

export default function ContactGlofoxCard({ contact }) {
  const linked = Boolean(contact?.glofox_member_id)
  const statusMeta = glofoxStatusMeta(contact?.glofox_membership_status)
  const stateMeta = glofoxStateMeta(contact?.glofox_membership_state)
  const tenure = formatTenure(contact?.joined_at)
  const lastAttended = relativeTime(contact?.last_attended_at)
  const lastPayment = relativeTime(contact?.last_payment_at)
  const ltv = Number.isFinite(contact?.lifetime_value_cents) && contact.lifetime_value_cents > 0
    ? formatMoney(contact.lifetime_value_cents, contact.lifetime_currency)
    : null
  const credits = contact?.trial_credits_remaining
  const billing = billingLine(contact)
  const expiryDate = formatShortDate(contact?.glofox_membership_expiry)
  const expiryRel = relativeTime(contact?.glofox_membership_expiry)
  const expiryPast = contact?.glofox_membership_expiry
    ? new Date(contact.glofox_membership_expiry).getTime() < Date.now()
    : false
  const { upcoming, past } = splitGlofoxBookings(contact?.recent_bookings, Math.floor(Date.now() / 1000))

  return (
    <View className="bg-white border border-un1t-border rounded-2xl p-4 mt-5">
      <View className="flex-row items-center justify-between mb-2">
        <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle" accessibilityRole="header">
          Glofox membership
        </Text>
        {linked && (
          <Text className="text-[10px] text-un1t-muted">
            Synced {contact.glofox_synced_at ? relativeTime(contact.glofox_synced_at) : 'never'}
          </Text>
        )}
      </View>

      {!linked ? (
        <Text className="text-sm text-un1t-muted py-2 text-center">
          Not linked to Glofox yet. Link this contact from the web CRM.
        </Text>
      ) : (
        <View>
          {/* Status row — lead status + live membership state (Overdue =
              the arrears signal) + headline numbers */}
          <View className="flex-row items-center flex-wrap gap-2">
            <Chip meta={statusMeta || { label: 'Unknown', cls: 'bg-gray-500/10', text: 'text-gray-700' }} />
            <Chip meta={stateMeta} />
            {credits != null && (
              <Text className="text-xs text-un1t-subtle">{credits} credit{credits === 1 ? '' : 's'}</Text>
            )}
            {ltv && <Text className="text-xs text-un1t-subtle">{ltv} LTV</Text>}
          </View>

          {/* Plan */}
          {contact.glofox_membership_plan && (
            <View className="mt-3">
              <Text className="text-sm font-medium text-un1t-text">{contact.glofox_membership_plan}</Text>
              {contact.glofox_membership_plan_full
                && contact.glofox_membership_plan_full !== contact.glofox_membership_plan && (
                <Text className="text-xs text-un1t-subtle mt-0.5">{contact.glofox_membership_plan_full}</Text>
              )}
            </View>
          )}

          {/* Billing + renewal */}
          {!!billing && <Text className="text-xs text-un1t-subtle mt-1.5">{billing}</Text>}
          {expiryDate && (
            <Text className={`text-xs mt-1 ${expiryPast ? 'text-red-700' : 'text-un1t-subtle'}`}>
              {expiryPast ? 'Expired' : 'Renews'} {expiryDate}
              {expiryRel ? ` (${expiryRel})` : ''}
            </Text>
          )}

          {/* Tenure + engagement strip */}
          {(tenure || lastAttended || Number(contact.total_attended_30d) > 0 || lastPayment) && (
            <View className="mt-2 pt-2 border-t border-un1t-border">
              {tenure && <Text className="text-xs text-un1t-subtle">{tenure}</Text>}
              {lastAttended && <Text className="text-xs text-un1t-subtle mt-0.5">Last attended {lastAttended}</Text>}
              {Number(contact.total_attended_30d) > 0 && (
                <Text className="text-xs text-un1t-subtle mt-0.5">
                  {contact.total_attended_30d} attended in last 30d
                  {Number(contact.total_noshow_30d) > 0
                    ? ` (${contact.total_noshow_30d} no-show${contact.total_noshow_30d === 1 ? '' : 's'})`
                    : ''}
                </Text>
              )}
              {lastPayment && contact.lifetime_transaction_count > 0 && (
                <Text className="text-xs text-un1t-subtle mt-0.5">
                  Last paid {lastPayment} · {contact.lifetime_transaction_count} payment{contact.lifetime_transaction_count === 1 ? '' : 's'} total
                </Text>
              )}
            </View>
          )}

          {/* Glofox class bookings (denormalised recent_bookings) */}
          {upcoming.length > 0 && (
            <View className="mt-2 pt-2 border-t border-un1t-border">
              <Text className="text-[10px] uppercase tracking-wider text-un1t-muted mb-1">Upcoming classes</Text>
              {upcoming.map((b) => (
                <GlofoxBookingRow key={b.glofox_id || String(b.time_start)} b={b} when="future" />
              ))}
            </View>
          )}
          {past.length > 0 && (
            <View className="mt-2 pt-2 border-t border-un1t-border">
              <Text className="text-[10px] uppercase tracking-wider text-un1t-muted mb-1">Recent classes</Text>
              {past.map((b) => (
                <GlofoxBookingRow key={b.glofox_id || String(b.time_start)} b={b} when="past" />
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  )
}
