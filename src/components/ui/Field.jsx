// UI-FOUND.2 — Field primitive.
//
// Wraps any control (input/select/textarea/custom) with a label, an
// optional hint, and an error message, wiring aria-describedby /
// aria-invalid correctly. Replaces the ad-hoc label+input+error markup
// repeated across forms. The aria wiring is unit-tested in styles.js
// (fieldIds / fieldDescribedBy).
//
// Usage:
//   <Field id="email" label="Email" error={errors.email} hint="We never share it.">
//     {(props) => <input {...props} type="email" className="..." />}
//   </Field>
// `children` may be a render-prop (receives { id, aria-describedby,
// aria-invalid }) or a plain node (caller wires its own ids).
import { fieldIds, fieldDescribedBy } from './styles.js'

/**
 * @param {object} props
 * @param {string} props.id          base id for the control
 * @param {React.ReactNode} [props.label]
 * @param {string} [props.hint]
 * @param {string} [props.error]
 * @param {boolean} [props.required]
 * @param {(controlProps:object)=>React.ReactNode | React.ReactNode} props.children
 */
export default function Field({ id, label, hint, error, required = false, className, children }) {
  const ids = fieldIds(id)
  const hasError = Boolean(error)
  const hasHint = Boolean(hint)
  const describedBy = fieldDescribedBy({ baseId: id, hasError, hasHint })

  const controlProps = {
    id: ids.control,
    'aria-describedby': describedBy,
    'aria-invalid': hasError || undefined,
    'aria-required': required || undefined,
  }

  return (
    <div className={className}>
      {label != null && (
        <label htmlFor={ids.control} className="mb-1 block text-sm font-medium text-un1t-text">
          {label}
          {required && <span className="ml-0.5 text-stage-lost" aria-hidden="true">*</span>}
        </label>
      )}
      {typeof children === 'function' ? children(controlProps) : children}
      {hasHint && (
        <p id={ids.hint} className="mt-1 text-xs text-un1t-subtle">{hint}</p>
      )}
      {hasError && (
        <p id={ids.error} className="mt-1 text-xs text-stage-lost" role="alert">{error}</p>
      )}
    </div>
  )
}
