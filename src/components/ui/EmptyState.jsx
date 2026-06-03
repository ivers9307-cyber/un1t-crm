// UI-FOUND.3 — EmptyState primitive.
//
// Standard "nothing here yet" block: optional icon, a title, optional
// supporting description, and an optional action slot (e.g. a Button to
// create the first item). Replaces the bespoke centred-div empty states
// scattered across the modules. Presentational only — RSC-compatible,
// no directive (an interactive `action` child can still be a client
// component passed in).
import { emptyStateClasses } from './styles.js'

/**
 * @param {object} props
 * @param {React.ReactNode} [props.icon]         glyph above the title (e.g. a lucide icon)
 * @param {React.ReactNode} [props.title]        primary line
 * @param {React.ReactNode} [props.description]  supporting line
 * @param {React.ReactNode} [props.action]       right-/centre-aligned control(s) below the copy
 * @param {'none'|'sm'|'md'|'lg'} [props.padding]
 */
export default function EmptyState({ icon, title, description, action, padding = 'lg', className, ...rest }) {
  return (
    <div className={emptyStateClasses({ padding, className })} {...rest}>
      {icon != null && <div className="text-un1t-muted mb-1">{icon}</div>}
      {title != null && <p className="text-sm font-medium text-un1t-text">{title}</p>}
      {description != null && <p className="text-xs text-un1t-muted max-w-sm">{description}</p>}
      {action != null && <div className="mt-3">{action}</div>}
    </div>
  )
}
