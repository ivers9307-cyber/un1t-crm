// MOB-UI.3 — Tabs primitive (RN). Pill tabs; horizontally scrollable on
// phone (when they overflow), inline row on tablet. Controlled: parent
// owns `value` and `onChange`. Item/text classes are unit-tested in
// ../../lib/ui-styles.js.
import { View, Text, Pressable, ScrollView } from 'react-native'
import { useIsTablet } from '../../lib/use-is-tablet'
import { tabItemClasses, tabTextClasses } from '../../lib/ui-styles.js'

/**
 * @param {object} props
 * @param {{ key: string, label: string }[]} props.tabs
 * @param {string} props.value          active tab key
 * @param {(key:string)=>void} props.onChange
 */
export default function Tabs({ tabs, value, onChange }) {
  const isTablet = useIsTablet()
  const row = (
    <View className="flex-row gap-2">
      {tabs.map(tab => {
        const active = tab.key === value
        return (
          <Pressable
            key={tab.key}
            className={tabItemClasses({ active })}
            onPress={() => onChange?.(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <Text className={tabTextClasses({ active })}>{tab.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
  return isTablet ? row : (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>{row}</ScrollView>
  )
}
