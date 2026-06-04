// One pending approval row (time-off OR swap) with Approve / Reject.
// Read-only data; the parent (ManageMode) owns the mutation + refetch.
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

export default function ApprovalCard({ kind, item, busy, onApprove, onReject }) {
  let who, summary
  if (kind === 'timeoff') {
    who = item.profiles?.full_name || 'Someone'
    const label = item.type === 'holiday' ? 'Holiday' : item.type === 'sick' ? 'Sick' : 'Time off'
    const range = item.end_date && item.end_date !== item.start_date
      ? `${item.start_date} → ${item.end_date}` : item.start_date
    summary = `${label} · ${range}`
  } else {
    who = item.requester?.full_name || 'Someone'
    const sh = item.requester_shift
    summary = `Swap · ${sh?.shift_templates?.name || 'shift'}${sh?.shift_date ? ` · ${sh.shift_date}` : ''}`
  }
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-3.5 mb-2">
      <Text className="text-sm font-semibold text-un1t-text" numberOfLines={1}>{who}</Text>
      <Text className="text-[12px] text-un1t-subtle mt-0.5" numberOfLines={1}>{summary}</Text>
      {item.reason ? (
        <Text className="text-[12px] text-un1t-subtle mt-1 italic" numberOfLines={2}>“{item.reason}”</Text>
      ) : null}
      <View className="flex-row gap-2 mt-2.5">
        <Pressable onPress={onApprove} disabled={busy}
          className="flex-1 flex-row items-center justify-center py-2 rounded-xl bg-emerald-600 active:opacity-80 disabled:opacity-50">
          {busy
            ? <ActivityIndicator color="#FFFFFF" />
            : <><Ionicons name="checkmark" size={15} color="#FFFFFF" /><Text className="text-sm font-semibold text-white ml-1">Approve</Text></>}
        </Pressable>
        <Pressable onPress={onReject} disabled={busy}
          className="flex-1 flex-row items-center justify-center py-2 rounded-xl border border-un1t-border active:opacity-60 disabled:opacity-50">
          <Ionicons name="close" size={15} color="#DC2626" />
          <Text className="text-sm font-semibold text-red-600 ml-1">Reject</Text>
        </Pressable>
      </View>
    </View>
  )
}
