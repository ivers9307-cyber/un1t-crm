// MOB-UI.3 — Form primitive (RN). Holds values + errors in context;
// validates against a Zod schema on submit via collectZodErrors. Child
// FormFields read/write by `name`. Validation messages match web
// (same Zod schemas from shared/schemas → same strings).
import { createContext, useContext, useState, useCallback } from 'react'
import { collectZodErrors } from '../../lib/form-validation.js'

const FormContext = createContext(null)

export function useForm() {
  const ctx = useContext(FormContext)
  if (!ctx) throw new Error('useForm must be used inside <Form>')
  return ctx
}

/**
 * @param {object} props
 * @param {object} props.initialValues
 * @param {import('zod').ZodType} props.schema
 * @param {(values:object)=>void|Promise<void>} props.onSubmit  called only when valid
 * @param {(form:{ values, errors, setValue, submit })=>React.ReactNode} props.children
 *   render-prop so the caller can wire its own submit button.
 */
export default function Form({ initialValues, schema, onSubmit, children }) {
  const [values, setValues] = useState(initialValues || {})
  const [errors, setErrors] = useState({})

  const setValue = useCallback((name, value) => {
    setValues(prev => ({ ...prev, [name]: value }))
  }, [])

  const submit = useCallback(async () => {
    const errs = collectZodErrors(schema, values)
    setErrors(errs)
    if (Object.keys(errs).length === 0) await onSubmit?.(values)
  }, [schema, values, onSubmit])

  return (
    <FormContext.Provider value={{ values, errors, setValue, submit }}>
      {typeof children === 'function' ? children({ values, errors, setValue, submit }) : children}
    </FormContext.Provider>
  )
}
