// Bottom-sheet picker of coaches: "Add coach" for a manager's block (the default), or "Ask a coach to cover" for a coach's targeted swap (title / emptyText props). Pure-presentational:
// receives the already-fetched staff array and, CANDIDATES.1, the ranked
// answer for the block; every decision is candidatePickerView's
// (mobile/lib/candidates-view.js, tested). Every row stays pickable.
import { View, Text, Pressable, Modal, ScrollView, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { initials } from '../../lib/schedule-team'
import { candidatePickerView, CANDIDATE_TONE_CLASS } from '../../lib/candidates-view'

const EMPTY_VIEW = { ranked: false, note: null, waiting: false, error: null, rows: [] }

// onDismiss (optional, iOS only — Android never fires it): called once the
// sheet has FINISHED animating out. A caller that opens another Modal after a
// pick must wait for it; iOS refuses a present while this one is dismissing.
//
// error / onRetry (optional) — MANAGEMODE.1: the coach list failed to load.
// Shown instead of emptyText, which would tell the manager there are no
// coaches when the truth is the list never arrived. A ranked answer
// (CANDIDATES.1) replaces the list, so it also replaces that error.
//
// candidates / candidatesPending (optional) — CANDIDATES.1: the parsed
// answer of GET /api/schedule/blocks/[id]/candidates for THIS block, and
// whether it is still in flight (candidatesFor in lib/candidates-view.js).
export default function CoachPickerSheet({
  visible, block, locationId, staff, loading, error, onRetry, candidates = null, candidatesPending = false,
  onPick, onClose, onDismiss, title = 'Add coach', emptyText = 'No available coaches to add.',
}) {
  const view = block
    ? candidatePickerView({ answer: candidates, pending: candidatesPending, staff, block, locationId, loading, error })
    : EMPTY_VIEW
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} onDismiss={onDismiss}>
      <View className="flex-1 justify-end bg-black/50">
        <Pressable className="flex-1" onPress={onClose} />
        <View className="bg-un1t-bg border-t border-un1t-border rounded-t-3xl p-5" style={{ maxHeight: '70%' }}>
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-lg font-bold text-un1t-text">{title}{block?.shift_templates?.name ? ` · ${block.shift_templates.name}` : ''}</Text>
            <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={22} color="#94A3B8" /></Pressable>
          </View>
          {view.waiting ? (
            <View className="py-8 items-center"><ActivityIndicator /></View>
          ) : view.error ? (
            <View className="py-6 items-center">
              <Text className="text-sm text-red-500 text-center">{view.error}</Text>
              {onRetry ? (
                <Pressable onPress={onRetry} hitSlop={8} className="mt-3 active:opacity-60">
                  <Text className="text-sm font-semibold text-un1t-text">Try again</Text>
                </Pressable>
              ) : null}
            </View>
          ) : view.rows.length === 0 ? (
            <Text className="text-sm text-un1t-subtle py-6 text-center">{emptyText}</Text>
          ) : (
            <>
              {view.note ? <Text className="text-[11px] text-un1t-subtle mb-2">{view.note}</Text> : null}
              <ScrollView>
                {view.rows.map((c) => (
                  <Pressable key={c.id} onPress={() => onPick(c)}
                    className="flex-row items-center py-3 border-b border-un1t-border active:opacity-60">
                    <View className="w-9 h-9 rounded-full bg-un1t-border items-center justify-center mr-3">
                      <Text className="text-sm font-semibold text-un1t-text">{initials(c.full_name)}</Text>
                    </View>
                    <View className="flex-1 mr-2">
                      <Text className="text-base text-un1t-text" numberOfLines={1}>{c.full_name}</Text>
                      {c.reason ? (
                        <Text className={`text-xs mt-0.5 ${CANDIDATE_TONE_CLASS[c.tone] || CANDIDATE_TONE_CLASS.muted}`} numberOfLines={2}>{c.reason}</Text>
                      ) : null}
                    </View>
                    {c.role ? <Text className="text-[11px] uppercase text-un1t-subtle">{String(c.role).replace(/_/g, ' ')}</Text> : null}
                  </Pressable>
                ))}
              </ScrollView>
            </>
          )}
        </View>
      </View>
    </Modal>
  )
}
