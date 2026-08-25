// APPROVALS-STUDIO.1 — one customer approval in the hub's Customers tab.
// Says what the customer wants, why it needs a human, and how urgent it is;
// Approve executes through the same atomic PATCH as web (Glofox booking +
// in-thread confirmation), Decline defers to the parent's reason sheet.
// Distinct from ThreadApprovalCard (the in-conversation render) — this one
// works from the /api/approvals/pending item shape and adds the urgency chip
// and an Open chat jump.
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { APPROVAL_KIND_LABELS } from 'shared/approval-cards'
import { urgencyChip } from '../../lib/approvals'

const CHIP_TONES = {
  danger: { box: 'bg-red-500/10', text: 'text-red-700' },
  warn: { box: 'bg-amber-500/10', text: 'text-amber-700' },
  muted: { box: 'bg-un1t-bg', text: 'text-un1t-subtle' },
}

export default function CustomerApprovalCard({ item, busy, onApprove, onDecline, highlight }) {
  const chip = urgencyChip(item)
  const tone = CHIP_TONES[chip.tone] || CHIP_TONES.muted
  const kindLabel = APPROVAL_KIND_LABELS[item.kind] || 'Customer request'
  // AGENT-RETRY.2 — a failed execution renders in fix-&-retry mode: the
  // operator fixes the problem in Glofox first, then the button re-runs the
  // action through the same PATCH (decline on a failed row would 409, so
  // retry is the only decision offered).
  const isFailed = !!item.failed
  const summary = item.details?.summary || item.subtitle || null
  const threadHref = item.conversationId && item.channel === 'whatsapp'
    ? `/whatsapp/${item.conversationId}`
    : item.conversationId && item.channel === 'instagram'
      ? `/instagram/${item.conversationId}`
      : null

  return (
    <View className={`bg-un1t-surface border rounded-2xl p-3.5 mb-2 ${highlight ? 'border-amber-400' : 'border-un1t-border'}`}>
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-semibold text-un1t-text flex-1 mr-2" numberOfLines={1}>
          {item.contactName || 'Customer'}
        </Text>
        {chip.label ? (
          <View className={`${tone.box} rounded-full px-2 py-0.5`}>
            <Text className={`text-[10px] font-semibold ${tone.text}`}>{chip.label}</Text>
          </View>
        ) : null}
      </View>
      {summary ? <Text className="text-[12px] text-un1t-subtle mt-1" numberOfLines={3}>{summary}</Text> : null}
      {isFailed && item.failedWhy ? (
        <Text className="text-[12px] text-red-700 mt-1" numberOfLines={4}>{item.failedWhy}</Text>
      ) : null}
      {/* AGENT-FUNNEL-CREDITS.1 — why it was flagged + what the account can
          book with, so the decision needs no Glofox lookup. */}
      {!isFailed && item.why ? (
        <Text className="text-[12px] text-un1t-subtle mt-1" numberOfLines={4}>{item.why}</Text>
      ) : null}
      {item.accountLine ? (
        <Text className="text-[12px] font-medium text-un1t-text mt-1" numberOfLines={2}>{item.accountLine}</Text>
      ) : null}
      {item.customerNote ? (
        <Text className="text-[12px] italic text-un1t-subtle mt-1" numberOfLines={2}>“{item.customerNote}”</Text>
      ) : null}
      <View className="flex-row items-center mt-1.5 gap-2">
        <View className="bg-blue-500/10 rounded-full px-2 py-0.5">
          <Text className="text-[10px] font-semibold text-blue-700">{kindLabel}</Text>
        </View>
        {isFailed ? (
          <View className="bg-red-500/10 rounded-full px-2 py-0.5">
            <Text className="text-[10px] font-semibold text-red-700">Failed</Text>
          </View>
        ) : null}
        {threadHref ? (
          <Pressable onPress={() => router.push(threadHref)} className="flex-row items-center active:opacity-60">
            <Ionicons name="chatbubble-outline" size={11} color="#64748B" />
            <Text className="text-[11px] text-un1t-subtle ml-1">Open chat</Text>
          </Pressable>
        ) : null}
      </View>
      <View className="flex-row gap-2 mt-2.5">
        <Pressable onPress={onApprove} disabled={busy}
          className="flex-1 flex-row items-center justify-center py-2 rounded-xl bg-emerald-600 active:opacity-80 disabled:opacity-50">
          {busy
            ? <ActivityIndicator color="#FFFFFF" />
            : <><Ionicons name={isFailed ? 'refresh' : 'checkmark'} size={15} color="#FFFFFF" /><Text className="text-sm font-semibold text-white ml-1">{isFailed ? 'Fixed it — retry' : 'Approve'}</Text></>}
        </Pressable>
        {!isFailed ? (
          <Pressable onPress={onDecline} disabled={busy}
            className="flex-1 flex-row items-center justify-center py-2 rounded-xl border border-un1t-border active:opacity-60 disabled:opacity-50">
            <Ionicons name="close" size={15} color="#DC2626" />
            <Text className="text-sm font-semibold text-red-600 ml-1">Decline</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}
