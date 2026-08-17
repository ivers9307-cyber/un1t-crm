import { Pressable, Text, ActivityIndicator } from 'react-native'

function variantStyles(variant, off) {
  switch (variant) {
    case 'primary':
      return {
        container: off ? 'bg-iron-raised' : 'bg-chalk',
        text: 'text-iron-bg',
        indicatorColor: '#131316',
      }
    case 'secondary':
    case 'outline':
      return {
        container: 'border border-iron-hairline bg-transparent',
        text: 'text-chalk',
        indicatorColor: '#F1EEE7',
      }
    case 'ghost':
    default:
      return {
        container: 'bg-transparent',
        text: 'text-chalk-2',
        indicatorColor: '#B3B2AC',
      }
  }
}

export default function Button({ title, onPress, variant = 'primary', busy = false, disabled = false }) {
  const off = disabled || busy
  const { container, text, indicatorColor } = variantStyles(variant, off)
  return (
    <Pressable onPress={onPress} disabled={off} className={`rounded-xl py-3.5 px-5 items-center ${container}`}>
      {busy ? <ActivityIndicator color={indicatorColor} /> : <Text className={`font-body-semibold ${text}`}>{title}</Text>}
    </Pressable>
  )
}
