// MOB-UI.2 — Screen primitive (RN). Standardises the hand-rolled
// loading / error / empty / pull-to-refresh scaffolding that ~30 screens
// currently re-implement. Renders a centered spinner while `loading`, an
// error message for `error`, an empty-state for `empty`, else the
// children (optionally scrollable with pull-to-refresh).
import { View, Text, ActivityIndicator, ScrollView, RefreshControl } from 'react-native'

/**
 * @param {object} props
 * @param {boolean} [props.loading]
 * @param {string|null} [props.error]
 * @param {boolean} [props.empty]
 * @param {string} [props.emptyText]
 * @param {() => void} [props.onRefresh]   enables pull-to-refresh when set
 * @param {boolean} [props.refreshing]
 * @param {boolean} [props.scroll]         default true
 */
export default function Screen({
  loading = false,
  error = null,
  empty = false,
  emptyText = 'Nothing here yet.',
  onRefresh,
  refreshing = false,
  scroll = true,
  className = '',
  contentClassName = '',
  children,
}) {
  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-un1t-bg" accessibilityRole="progressbar" accessibilityLabel="Loading">
        <ActivityIndicator />
      </View>
    )
  }
  if (error) {
    return (
      <View className="flex-1 items-center justify-center bg-un1t-bg px-6">
        <Text className="text-un1t-subtle text-center" accessibilityRole="alert">{error}</Text>
      </View>
    )
  }
  if (empty) {
    return (
      <View className="flex-1 items-center justify-center bg-un1t-bg px-6">
        <Text className="text-un1t-subtle text-center">{emptyText}</Text>
      </View>
    )
  }
  if (!scroll) {
    return <View className={`flex-1 bg-un1t-bg ${className}`.trim()}>{children}</View>
  }
  return (
    <ScrollView
      className={`flex-1 bg-un1t-bg ${className}`.trim()}
      contentContainerClassName={contentClassName}
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined}
    >
      {children}
    </ScrollView>
  )
}
