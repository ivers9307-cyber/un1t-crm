// mobile/components/ThreadApprovalCard.jsx — INBOX-APPROVALS Wave 2.
// (Named ThreadApprovalCard to avoid colliding with the pre-existing
// mobile/components/approvals/ApprovalCard.jsx hub card.)
//
// An agent approval request rendered inline in a WA/IG thread (RN
// mirror of src/components/ApprovalActionCard.jsx). Pending: summary +
// customer note + decide buttons. Decided: status pill + decision note
// + rule-based next steps (shared/approvals-next-steps). Decisions go
// through the same PATCH route as web, via lib/inbox-approvals-api.js,
// so behaviour (Glofox execution, Mia's in-thread confirmation) is
// identical everywhere.
//
// Deliberately thinner than the web card: no book-tab / sequence-picker
// steps (mobile has no Command Centre rail or sequence surface) — next
// steps are filtered to type === 'composer' only.
import { useState } from 'react'
import { View, Text, Pressable, TextInput, ActivityIndicator } from 'react-native'
import { getNextSteps, buildDeclineDraft, DECLINE_REASONS, BOOKING_KINDS } from 'shared/approvals-next-steps'
import { approvalCardSummary, APPROVAL_KIND_LABELS } from 'shared/approval-cards'
import { decideApproval } from '../lib/inbox-approvals-api'

// House tone-object idiom (see ISSUE_STATUS_TONE in mobile/lib/issues-api.js):
// bg on the chip View, fg on the Text.
const STATUS_TONE = {
  pending:  { bg: 'bg-amber-500/10', fg: 'text-amber-700' },
  approved: { bg: 'bg-green-500/10', fg: 'text-green-700' },
  actioned: { bg: 'bg-green-500/10', fg: 'text-green-700' },
  saved:    { bg: 'bg-blue-500/10',  fg: 'text-blue-700' },
  declined: { bg: 'bg-red-500/10',   fg: 'text-red-700' },
  failed:   { bg: 'bg-red-500/10',   fg: 'text-red-700' },
}
const STATUS_LABELS = {
  pending: 'Needs approval', approved: 'Approved', actioned: 'Done',
  saved: 'Saved', declined: 'Declined', failed: 'Failed',
}

/**
 * @param {object} props
 * @param {object} props.request              agent_membership_requests row
 * @param {string} [props.contactFirstName]
 * @param {(merged: object) => void} [props.onDecided]
 * @param {(draft: string) => void} [props.onPrefillComposer]
 */
export default function ThreadApprovalCard({ request, contactFirstName, onDecided, onPrefillComposer }) {
  const [busy, setBusy] = useState(null)          // 'approved' | 'declined' | 'saved' | null
  const [declineOpen, setDeclineOpen] = useState(false)
  const [reason, setReason] = useState(BOOKING_KINDS.has(request.kind) ? 'class_full' : 'other')
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)

  // reason reflects local state; after a remount the decline reason resets
  // to the default — accepted tradeoff (mirrors web), don't re-parse decision_note.
  const ctx = { firstName: contactFirstName, details: request.details, reason }

  const [notified, setNotified] = useState(null)

  async function decide(status) {
    if (busy) return
    setBusy(status)
    setError(null)
    try {
      const reasonLabel = (DECLINE_REASONS.find(([k]) => k === reason) || [])[1]
      const decision_note = status === 'declined'
        ? [reasonLabel, note.trim() || null].filter(Boolean).join(' — ')
        : (note.trim() || null)
      const res = await decideApproval(request.id, status, decision_note)
      if (!res.success) {
        setError(res.error || 'Decision failed')
        return
      }
      onDecided?.({ ...request, ...res.request })
      // CANCEL-FORM.6 — whether the member heard about a pause/cancellation decision.
      if (res.customer_notified) setNotified(res.customer_notified)
      if (status === 'declined') {
        onPrefillComposer?.(buildDeclineDraft(request.kind, reason, ctx))
      }
    } catch {
      setError('Network error — try again')
    } finally {
      setBusy(null)
    }
  }

  const status = request.status
  const decided = status !== 'pending'
  const steps = decided
    ? getNextSteps(request.kind, status, ctx).filter(s => s.type === 'composer')
    : []
  const kindLabel = APPROVAL_KIND_LABELS[request.kind] || 'Agent request'
  // class_full / already_booked only make sense for booking-shaped requests.
  const reasonOptions = BOOKING_KINDS.has(request.kind)
    ? DECLINE_REASONS
    : DECLINE_REASONS.filter(([k]) => k === 'not_eligible' || k === 'other')
  const tone = STATUS_TONE[status] || STATUS_TONE.pending

  return (
    <View className="items-center my-2">
      <View className="w-full max-w-md bg-un1t-surface border border-un1t-border rounded-2xl px-3 py-2.5">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="text-sm font-medium text-un1t-text">{kindLabel}</Text>
          <View className={`${tone.bg} rounded-full px-1.5 py-0.5`}>
            <Text className={`${tone.fg} text-[10px] font-semibold`}>
              {STATUS_LABELS[status] || status}
            </Text>
          </View>
        </View>
        <Text className="text-sm text-un1t-text mt-1">{approvalCardSummary(request)}</Text>
        {request.customer_note ? (
          <Text className="text-xs text-un1t-subtle mt-1 border-l-2 border-un1t-border pl-2">
            "{request.customer_note}"
          </Text>
        ) : null}

        {!decided && !declineOpen && (
          <View className="flex-row items-center gap-2 mt-2.5">
            <Pressable
              disabled={!!busy}
              onPress={() => decide('approved')}
              accessibilityRole="button"
              accessibilityLabel="Approve"
              accessibilityState={{ disabled: !!busy, busy: busy === 'approved' }}
              className="px-3 py-1.5 rounded-lg bg-green-600 disabled:opacity-50 flex-row items-center"
            >
              {busy === 'approved'
                ? <ActivityIndicator size="small" color="#FFFFFF" />
                : <Text className="text-xs font-semibold text-white">Approve</Text>}
            </Pressable>
            <Pressable
              disabled={!!busy}
              onPress={() => { setDeclineOpen(true); setError(null) }}
              accessibilityRole="button"
              accessibilityLabel="Decline"
              accessibilityState={{ disabled: !!busy }}
              className="px-3 py-1.5 rounded-lg border border-un1t-border disabled:opacity-50"
            >
              <Text className="text-xs font-semibold text-un1t-text">Decline</Text>
            </Pressable>
            {request.retention_flagged && request.kind === 'cancellation' && (
              <Pressable
                disabled={!!busy}
                onPress={() => decide('saved')}
                accessibilityRole="button"
                accessibilityLabel="Saved the member"
                accessibilityState={{ disabled: !!busy, busy: busy === 'saved' }}
                className="px-3 py-1.5 rounded-lg bg-blue-500/10 disabled:opacity-50 flex-row items-center"
              >
                {busy === 'saved'
                  ? <ActivityIndicator size="small" color="#1D4ED8" />
                  : <Text className="text-xs font-semibold text-blue-700">Saved the member</Text>}
              </Pressable>
            )}
          </View>
        )}

        {!decided && declineOpen && (
          <View className="mt-2.5 gap-2">
            <View className="flex-row flex-wrap gap-1.5">
              {reasonOptions.map(([key, label]) => {
                const active = reason === key
                return (
                  <Pressable
                    key={key}
                    onPress={() => setReason(key)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    className={`px-2.5 py-1 rounded-full border ${active ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-bg border-un1t-border'}`}
                  >
                    <Text className={`text-xs font-medium ${active ? 'text-un1t-bg' : 'text-un1t-text'}`}>{label}</Text>
                  </Pressable>
                )
              })}
            </View>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Note (optional)"
              placeholderTextColor="#94A3B8"
              className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-2 py-1.5 text-xs text-un1t-text"
            />
            <View className="flex-row items-center gap-2">
              <Pressable
                disabled={!!busy}
                onPress={() => decide('declined')}
                accessibilityRole="button"
                accessibilityLabel="Confirm decline"
                accessibilityState={{ disabled: !!busy, busy: busy === 'declined' }}
                className="px-3 py-1.5 rounded-lg bg-red-600 disabled:opacity-50 flex-row items-center"
              >
                {busy === 'declined'
                  ? <ActivityIndicator size="small" color="#FFFFFF" />
                  : <Text className="text-xs font-semibold text-white">Confirm decline</Text>}
              </Pressable>
              <Pressable
                onPress={() => { setDeclineOpen(false); setError(null) }}
                accessibilityRole="button"
                accessibilityLabel="Back"
              >
                <Text className="text-xs text-un1t-subtle">Back</Text>
              </Pressable>
            </View>
          </View>
        )}

        {decided && (request.decision_note || (request.details?.result?.message_code && status === 'failed')) && (
          <View className="mt-1.5">
            {request.decision_note ? (
              <Text className="text-xs text-un1t-subtle">{request.decision_note}</Text>
            ) : null}
            {request.details?.result?.message_code && status === 'failed' ? (
              <Text className="text-xs text-red-700"> ({request.details.result.message_code})</Text>
            ) : null}
          </View>
        )}

        {notified && notified.reason !== 'not_applicable' && notified.reason !== 'not_executed' ? (
          <Text className={`text-xs mt-1 ${notified.sent ? 'text-green-700' : 'text-amber-700'}`}>
            {notified.sent
              ? `Member ${notified.channel === 'email' ? 'emailed' : 'messaged'}.`
              : 'Member NOT told, please follow up.'}
          </Text>
        ) : null}

        {steps.length > 0 && (
          <View className="flex-row flex-wrap items-center gap-1.5 mt-2 pt-2 border-t border-un1t-border/50">
            <Text className="text-[10px] uppercase tracking-wide text-un1t-subtle w-full">Next steps</Text>
            {steps.map(step => (
              <Pressable
                key={step.id}
                onPress={() => onPrefillComposer?.(step.draft)}
                accessibilityRole="button"
                accessibilityLabel={step.label}
                className="px-2.5 py-1 rounded-full bg-un1t-bg border border-un1t-border"
              >
                <Text className="text-xs font-medium text-un1t-text">{step.label}</Text>
              </Pressable>
            ))}
          </View>
        )}

        {error ? <Text className="text-xs text-red-700 mt-1.5">{error}</Text> : null}
      </View>
    </View>
  )
}
