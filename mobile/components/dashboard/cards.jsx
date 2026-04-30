// Reusable building blocks for the three dashboards.
//
// KpiCard: a single number with a label, optionally with a tap target.
// KpiRow:  two KpiCards side-by-side (the iOS-native 2-up grid pattern).
// SectionHeader: small uppercase tracking-wider header above a list.
// PendingRow: a row in a "needs action" list with a leading icon, body
//             text, optional time, and a chevron.

import { View, Text, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

export function KpiCard({ label, value, sublabel, onPress, accent }) {
  const Wrap = onPress ? Pressable : View
  return (
    <Wrap
      onPress={onPress}
      className="flex-1 bg-un1t-dark border border-un1t-gray rounded-2xl p-4 active:opacity-70"
    >
      <Text className="text-xs uppercase tracking-wider text-un1t-light">
        {label}
      </Text>
      <Text className={`text-2xl font-bold mt-1 ${accent || 'text-un1t-white'}`}>
        {value ?? '—'}
      </Text>
      {sublabel ? (
        <Text className="text-xs text-un1t-light mt-0.5">{sublabel}</Text>
      ) : null}
    </Wrap>
  )
}

export function KpiRow({ children }) {
  // Renders children with a small horizontal gap. Pass exactly two
  // KpiCards or a KpiCard + a placeholder <View />.
  return (
    <View className="flex-row mb-3" style={{ columnGap: 12 }}>
      {children}
    </View>
  )
}

export function SectionHeader({ title, action, count }) {
  return (
    <View className="flex-row items-center justify-between mt-4 mb-2 px-1">
      <View className="flex-row items-center">
        <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-light">
          {title}
        </Text>
        {count != null && count > 0 ? (
          <View className="ml-2 min-w-[18px] h-4 px-1.5 rounded-full bg-un1t-white items-center justify-center">
            <Text className="text-[10px] font-semibold text-un1t-black">{count}</Text>
          </View>
        ) : null}
      </View>
      {action}
    </View>
  )
}

export function PendingRow({ icon, title, subtitle, time, onPress, isLast }) {
  return (
    <Pressable
      onPress={onPress}
      className={`flex-row items-center px-4 py-3 ${
        !isLast ? 'border-b border-un1t-gray' : ''
      } active:bg-un1t-gray/40`}
    >
      {icon ? (
        <View className="w-8 h-8 rounded-full bg-un1t-gray/40 items-center justify-center mr-3">
          <Ionicons name={icon} size={16} color="#111827" />
        </View>
      ) : null}
      <View className="flex-1">
        <Text className="text-sm font-medium text-un1t-white" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text className="text-xs text-un1t-light" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {time ? (
        <Text className="text-xs text-un1t-light mr-1">{time}</Text>
      ) : null}
      {onPress ? (
        <Ionicons name="chevron-forward" size={14} color="#94A3B8" />
      ) : null}
    </Pressable>
  )
}

export function ListCard({ children, empty, emptyText }) {
  if (empty) {
    return (
      <View className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4 items-center">
        <Text className="text-sm text-un1t-light">{emptyText || 'Nothing pending.'}</Text>
      </View>
    )
  }
  return (
    <View className="bg-un1t-dark border border-un1t-gray rounded-2xl overflow-hidden">
      {children}
    </View>
  )
}

export function formatCurrency(n) {
  if (n == null) return '—'
  if (n >= 1000) return `€${(n / 1000).toFixed(1)}k`
  return `€${Math.round(n)}`
}

export function formatPercent(n) {
  if (n == null) return '—'
  return `${n}%`
}
