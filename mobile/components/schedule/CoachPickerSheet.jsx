// Bottom-sheet picker of coaches assignable to a block. Pure-presentational:
// receives the already-fetched staff array; filters with the shared helper.
import { View, Text, Pressable, Modal, ScrollView, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { initials } from '../../lib/schedule-team'
import { filterAssignableCoaches } from '../../lib/schedule-manage'

export default function CoachPickerSheet({ visible, block, locationId, staff, loading, onPick, onClose }) {
  const coaches = block ? filterAssignableCoaches(staff || [], block, locationId) : []
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/50">
        <Pressable className="flex-1" onPress={onClose} />
        <View className="bg-un1t-bg border-t border-un1t-border rounded-t-3xl p-5" style={{ maxHeight: '70%' }}>
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-lg font-bold text-un1t-text">Add coach{block?.shift_templates?.name ? ` · ${block.shift_templates.name}` : ''}</Text>
            <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={22} color="#94A3B8" /></Pressable>
          </View>
          {loading && staff === null ? (
            <View className="py-8 items-center"><ActivityIndicator /></View>
          ) : coaches.length === 0 ? (
            <Text className="text-sm text-un1t-subtle py-6 text-center">No available coaches to add.</Text>
          ) : (
            <ScrollView>
              {coaches.map((c) => (
                <Pressable key={c.id} onPress={() => onPick(c)}
                  className="flex-row items-center py-3 border-b border-un1t-border active:opacity-60">
                  <View className="w-9 h-9 rounded-full bg-un1t-border items-center justify-center mr-3">
                    <Text className="text-sm font-semibold text-un1t-text">{initials(c.full_name)}</Text>
                  </View>
                  <Text className="text-base text-un1t-text flex-1" numberOfLines={1}>{c.full_name}</Text>
                  {c.role ? <Text className="text-[11px] uppercase text-un1t-subtle">{String(c.role).replace(/_/g, ' ')}</Text> : null}
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  )
}
