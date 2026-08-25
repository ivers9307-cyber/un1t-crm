// Compact error + retry affordance. Matches the dark iron card style.
// Props:
//   message  — short human label (optional, has a default)
//   onPress  — called when the user taps Retry

import { View, Text } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import Card from './ui/Card'
import Button from './ui/Button'

export default function ErrorRetry({
  message = "Couldn't load — check your connection.",
  onPress,
}) {
  return (
    <Card>
      <View className="items-center py-4 gap-3">
        <Ionicons name="cloud-offline-outline" size={28} color="#727170" />
        <Text
          className="font-body"
          style={{ fontSize: 13, color: '#B3B2AC', textAlign: 'center', maxWidth: 260 }}
        >
          {message}
        </Text>
        <Button title="Retry" onPress={onPress} variant="outline" />
      </View>
    </Card>
  )
}
