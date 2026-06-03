// UI-FOUND.3 — Loading primitive.
//
// Standard spinner + label. Two layouts: a centred block (default, for
// a panel/list that's fetching) and `inline` (spinner + label on one
// row, e.g. inside a button or a status line). Replaces the ad-hoc
// "Loading…" text + bespoke animate-spin blocks across the modules.
// Presentational only — RSC-compatible, no directive.
import { Loader2 } from 'lucide-react'
import { loadingClasses, spinnerSizeClass } from './styles.js'

/**
 * @param {object} props
 * @param {React.ReactNode} [props.label]   text beside/below the spinner ('' / null hides it)
 * @param {'sm'|'md'|'lg'} [props.size]      spinner size
 * @param {boolean} [props.inline]           horizontal layout instead of centred block
 */
export default function Loading({ label = 'Loading…', size = 'md', inline = false, className, ...rest }) {
  return (
    <div className={loadingClasses({ inline, className })} role="status" aria-live="polite" {...rest}>
      <Loader2 className={`${spinnerSizeClass(size)} animate-spin`} aria-hidden="true" />
      {label != null && label !== '' && <span className="text-sm">{label}</span>}
    </div>
  )
}
