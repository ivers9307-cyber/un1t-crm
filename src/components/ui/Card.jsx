// UI-FOUND.2 — Card primitive.
//
// Surface container with an optional title row and right-aligned
// actions slot. Replaces the bespoke *Card.jsx wrappers
// (XeroLocationCard, NotificationConfigCard, dashboard Cards).
// Presentational only — RSC-compatible, no directive.
import { cardClasses } from './styles.js'

/**
 * @param {object} props
 * @param {React.ReactNode} [props.title]
 * @param {React.ReactNode} [props.actions]  right-aligned controls in the header
 * @param {'none'|'sm'|'md'|'lg'} [props.padding]
 */
export default function Card({ title, actions, padding = 'md', className, children, ...rest }) {
  const hasHeader = title != null || actions != null
  return (
    <div className={cardClasses({ padding, className })} {...rest}>
      {hasHeader && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title != null && (
            <h3 className="text-sm font-semibold text-un1t-text">{title}</h3>
          )}
          {actions != null && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  )
}
