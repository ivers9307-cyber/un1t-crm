import { View, Text, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

export default function ProfileNudgeCard({ onPress }) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 rounded-2xl border border-iron-hairline bg-iron-surface px-4 py-3 active:opacity-70"
    >
      <Ionicons name="person-circle-outline" size={22} color="#F1EEE7" />
      <View className="flex-1">
        <Text className="text-sm font-body-medium text-chalk">Complete your profile</Text>
        <Text className="text-xs font-body text-chalk-2">Add your details to track calories accurately.</Text>
      </View>
      <Ionicons name="chevron-forward" size={14} color="#727170" />
    </Pressable>
  )
}
