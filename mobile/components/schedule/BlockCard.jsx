// One shift block in Manage mode: header (name + capacity chip), the assigned
// coaches (tap a coach → parent opens an action sheet), and "+ Add coach".
import { View, Text, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { timeRange, dublinTodayIso } from '../../lib/dates'
import { effShiftStart, effShiftEnd, initials } from '../../lib/schedule-team'
import { blockFillState, liveBlockAssignments, assignmentWindow } from '../../lib/schedule-manage'

// MOBILESCHED.2 — empty and short are different chips, as on the web calendar:
// red "No coach", amber "1 of 2". Over capacity stays red. SHIFTTYPE.1 — an
// admin shift is slate "Admin", the web card's admin tone: never red or amber.
const CHIP_BG = { empty: 'bg-red-500/10', short: 'bg-amber-500/10', over: 'bg-red-500/10', admin: 'bg-slate-500/10', ok: 'bg-un1t-border' }
const CHIP_TX = { empty: 'text-red-700', short: 'text-amber-700', over: 'text-red-700', admin: 'text-slate-700', ok: 'text-un1t-subtle' }

export default function BlockCard({ block, busy, onAddCoach, onCoachPress }) {
  const tpl = block.shift_templates
  // Live coaches only: a cancelled row is a tombstone, not someone on the shift.
  const coaches = liveBlockAssignments(block)
  const fill = blockFillState(block, dublinTodayIso())
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2">
      <View className="flex-row items-center justify-between mb-2">
        <Text className="text-base font-semibold text-un1t-text flex-1 mr-2" numberOfLines={1}>{tpl?.name || 'Shift'}</Text>
        <View className={`px-2 py-0.5 rounded-full ${CHIP_BG[fill.state]}`}>
          <Text className={`text-[10px] font-bold ${CHIP_TX[fill.state]}`}>{fill.label}</Text>
        </View>
      </View>
      <View className="flex-row items-center mb-2">
        <Ionicons name="time-outline" size={13} color="#64748B" />
        <Text className="text-sm text-un1t-subtle ml-1">
          {timeRange(effShiftStart(block), effShiftEnd(block))}
        </Text>
      </View>

      {coaches.length === 0 ? (
        <Text className="text-[12px] text-un1t-muted italic mb-1">No one assigned yet.</Text>
      ) : coaches.map((a) => {
        const adj = !!(a.start_time_override || a.end_time_override)
        const win = adj ? assignmentWindow(block, a) : null
        return (
          <Pressable key={a.id} onPress={() => onCoachPress(a)} disabled={busy}
            className="flex-row items-center py-1.5 active:opacity-60">
            <View className="w-7 h-7 rounded-full bg-un1t-border items-center justify-center mr-2">
              <Text className="text-[11px] font-semibold text-un1t-text">{initials(a.profiles?.full_name)}</Text>
            </View>
            <Text className="text-sm text-un1t-text flex-1" numberOfLines={1}>{a.profiles?.full_name || 'Unknown'}</Text>
            {adj ? <Text className="text-[11px] text-amber-700 mr-1">{timeRange(win.start, win.end)}</Text> : null}
            <Ionicons name="ellipsis-horizontal" size={16} color="#94A3B8" />
          </Pressable>
        )
      })}

      <Pressable onPress={onAddCoach} disabled={busy}
        className="flex-row items-center justify-center mt-2 py-2 rounded-xl border border-dashed border-un1t-border active:opacity-60">
        <Ionicons name="add" size={16} color="#111827" />
        <Text className="text-sm font-medium text-un1t-text ml-1">Add coach</Text>
      </Pressable>
    </View>
  )
}
