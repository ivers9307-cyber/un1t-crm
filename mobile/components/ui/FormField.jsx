// MOB-UI.3 — FormField primitive (RN). Binds the Field primitive to the
// Form context by `name`: renders the label/error from context and a
// TextInput wired to values[name]. For non-text controls, pass a
// render-prop child receiving { value, onChange, controlProps }.
import { TextInput } from 'react-native'
import Field from './Field.jsx'
import { useForm } from './Form.jsx'

/**
 * @param {object} props
 * @param {string} props.name
 * @param {string} props.label
 * @param {string} [props.hint]
 * @param {boolean} [props.required]
 * @param {object} [props.inputProps]  extra TextInput props (keyboardType, etc.)
 * @param {(api:{ value:any, onChange:(v:any)=>void, controlProps:object })=>React.ReactNode} [props.children]
 *   optional custom control; defaults to a TextInput.
 */
export default function FormField({ name, label, hint, required = false, inputProps, children }) {
  const { values, errors, setValue } = useForm()
  const value = values[name]
  const error = errors[name]
  const onChange = (v) => setValue(name, v)

  return (
    <Field label={label} hint={hint} error={error} required={required} className="mb-3">
      {(controlProps) =>
        typeof children === 'function'
          ? children({ value, onChange, controlProps })
          : (
            <TextInput
              {...controlProps}
              {...inputProps}
              value={value != null ? String(value) : ''}
              onChangeText={onChange}
              className="rounded-xl border border-un1t-border bg-white px-3 py-2 text-un1t-text"
            />
          )
      }
    </Field>
  )
}
