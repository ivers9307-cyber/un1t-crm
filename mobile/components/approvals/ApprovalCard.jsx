// One pending approval, rendered from the uniform ApprovalItem shape returned
// by /api/approvals/pending — works for every category. Approve = one tap;
// Decline defers to the parent (which opens a reason sheet).
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

function formatAmount(amount, currency) {
  if (amount == null) return null
  const sym = currency === 'EUR' ? '€' : (currency ? `${currency} ` : '')
  return `${sym}${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export default function ApprovalCard({ item, busy, onApprove, onDecline }) {
  const amount = formatAmount(item.amount, item.currency)
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-3.5 mb-2">
      <View className="flex-row items-start justify-between">
        <Text className="text-sm font-semibold text-un1t-text flex-1 mr-2" numberOfLines={1}>{item.title}</Text>
        {amount ? <Text className="text-sm font-semibold text-un1t-text">{amount}</Text> : null}
      </View>
      {item.subtitle ? <Text className="text-[12px] text-un1t-subtle mt-0.5" numberOfLines={2}>{item.subtitle}</Text> : null}
      {item.meta ? (
        <View className="flex-row items-center mt-1">
          <Ionicons name="location-outline" size={11} color="#94A3B8" />
          <Text className="text-[11px] text-un1t-subtle ml-1" numberOfLines={1}>{item.meta}</Text>
        </View>
      ) : null}
      <View className="flex-row gap-2 mt-2.5">
        <Pressable onPress={onApprove} disabled={busy}
          className="flex-1 flex-row items-center justify-center py-2 rounded-xl bg-emerald-600 active:opacity-80 disabled:opacity-50">
          {busy
            ? <ActivityIndicator color="#FFFFFF" />
            : <><Ionicons name="checkmark" size={15} color="#FFFFFF" /><Text className="text-sm font-semibold text-white ml-1">Approve</Text></>}
        </Pressable>
        <Pressable onPress={onDecline} disabled={busy}
          className="flex-1 flex-row items-center justify-center py-2 rounded-xl border border-un1t-border active:opacity-60 disabled:opacity-50">
          <Ionicons name="close" size={15} color="#DC2626" />
          <Text className="text-sm font-semibold text-red-600 ml-1">Decline</Text>
        </Pressable>
      </View>
    </View>
  )
}
