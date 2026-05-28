// MOB-UI.2 — Field primitive (RN). Label + control + optional error/hint.
// Passes an accessibilityLabel + invalid state down to the control via a
// render-prop so inputs are announced correctly.
import { View, Text } from 'react-native'

/**
 * @param {object} props
 * @param {string} props.label
 * @param {string} [props.hint]
 * @param {string} [props.error]
 * @param {boolean} [props.required]
 * @param {(controlProps: object) => React.ReactNode | React.ReactNode} props.children
 *   render-prop receiving { accessibilityLabel, accessibilityState } to spread
 *   onto the control, or a plain node.
 */
export default function Field({ label, hint, error, required = false, className = '', children }) {
  const hasError = Boolean(error)
  const controlProps = {
    accessibilityLabel: label,
    accessibilityState: { invalid: hasError },
  }
  return (
    <View className={className}>
      {label != null && (
        <Text className="mb-1 text-sm font-medium text-un1t-text">
          {label}{required ? <Text className="text-red-500"> *</Text> : null}
        </Text>
      )}
      {typeof children === 'function' ? children(controlProps) : children}
      {hint != null && !hasError && <Text className="mt-1 text-xs text-un1t-subtle">{hint}</Text>}
      {hasError && <Text className="mt-1 text-xs text-red-500" accessibilityRole="alert">{error}</Text>}
    </View>
  )
}
