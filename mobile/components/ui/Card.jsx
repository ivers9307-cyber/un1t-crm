// MOB-UI.2 — Card primitive (RN/NativeWind). Surface container with an
// optional title row. Padding/classes from the tested pure helper.
import { View, Text } from 'react-native'
import { cardClasses } from '../../lib/ui-styles'

/**
 * @param {object} props
 * @param {string} [props.title]
 * @param {'none'|'sm'|'md'|'lg'} [props.padding]
 * @param {React.ReactNode} [props.right]   right-aligned header slot
 */
export default function Card({ title, padding = 'md', right = null, className = '', children, ...rest }) {
  const hasHeader = title != null || right != null
  return (
    <View className={cardClasses({ padding, className })} {...rest}>
      {hasHeader && (
        <View className="flex-row items-center justify-between mb-3">
          {title != null ? (
            <Text className="text-sm font-semibold text-un1t-text" accessibilityRole="header">{title}</Text>
          ) : <View />}
          {right}
        </View>
      )}
      {children}
    </View>
  )
}
