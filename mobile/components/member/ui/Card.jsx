import { View } from 'react-native'
export default function Card({ children, className = '' }) {
  return <View className={`rounded-[20px] border border-iron-hairline bg-iron-surface p-5 ${className}`}>{children}</View>
}
