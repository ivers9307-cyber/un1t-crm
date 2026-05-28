// UI-FOUND.2 — Button primitive.
//
// Thin presentational shell over buttonClasses() (see styles.js, where
// the variant/size logic is unit-tested). Replaces the per-feature
// *Button.jsx wrappers (CloneSequenceButton, DeleteTemplateButton, …)
// which each re-implemented spinner + disabled + colour handling.
//
// No 'use client' directive: this component has no hooks/state, so it
// works in both server and client components. Event handlers passed by
// a client parent work as normal.
import { Loader2 } from 'lucide-react'
import { buttonClasses } from './styles.js'

/**
 * @param {object} props
 * @param {'primary'|'secondary'|'ghost'|'danger'} [props.variant]
 * @param {'sm'|'md'|'lg'} [props.size]
 * @param {boolean} [props.loading]   shows a spinner and disables the button
 * @param {React.ComponentType} [props.icon]  lucide icon rendered before children
 * @param {React.ElementType} [props.as]  render as a different element (e.g. 'a', Link)
 */
export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon: Icon,
  as: Tag = 'button',
  className,
  disabled,
  children,
  ...rest
}) {
  const isButton = Tag === 'button'
  return (
    <Tag
      className={buttonClasses({ variant, size, className })}
      disabled={isButton ? disabled || loading : undefined}
      aria-busy={loading || undefined}
      aria-disabled={!isButton && (disabled || loading) ? true : undefined}
      {...(isButton ? { type: rest.type || 'button' } : {})}
      {...rest}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        Icon && <Icon className="h-4 w-4" aria-hidden="true" />
      )}
      {children}
    </Tag>
  )
}
