// MOB-UI.2 — Button primitive (React Native / NativeWind).
//
// Accessibility is baked in (MOB-UI.3): accessibilityRole="button", a
// label (explicit prop or the visible label), and accessibilityState
// for disabled/busy — so icon-only buttons are no longer invisible to
// VoiceOver / TalkBack. Variant/size classes come from the tested pure
// helper in lib/ui-styles.js.
import { Pressable, Text, ActivityIndicator } from 'react-native'
import { buttonClasses, buttonTextClasses } from '../../lib/ui-styles'

/**
 * @param {object} props
 * @param {string} [props.label]                visible label (also the default a11y label)
 * @param {() => void} props.onPress
 * @param {'primary'|'secondary'|'ghost'|'danger'} [props.variant]
 * @param {'sm'|'md'|'lg'|'icon'} [props.size]   use 'icon' for icon-only buttons
 * @param {boolean} [props.loading]
 * @param {boolean} [props.disabled]
 * @param {React.ReactNode} [props.icon]         rendered before the label
 * @param {string} [props.accessibilityLabel]    REQUIRED for icon-only buttons
 */
export default function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  icon = null,
  accessibilityLabel,
  className = '',
  ...rest
}) {
  const isDisabled = disabled || loading
  const spinnerColor = variant === 'secondary' || variant === 'ghost' ? '#111827' : '#FFFFFF'
  return (
    <Pressable
      onPress={isDisabled ? undefined : onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      className={`${buttonClasses({ variant, size, disabled: isDisabled })} ${className}`.trim()}
      {...rest}
    >
      {loading ? <ActivityIndicator size="small" color={spinnerColor} /> : icon}
      {label ? <Text className={buttonTextClasses({ variant, size })}>{label}</Text> : null}
    </Pressable>
  )
}
