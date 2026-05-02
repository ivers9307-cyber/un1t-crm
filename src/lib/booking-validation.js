// Booking custom-fields validation. Calendly tier 2.
//
// /api/public/book accepted any custom_responses shape because
// the Zod wrapper only typed it as `Record<string, unknown>`. A
// customer's request payload could omit required fields or send
// nonsense values for dropdowns. This helper validates the
// responses against the event_type's declared custom_fields
// shape server-side.
//
// custom_fields shape (per EventForm + mig 002):
//   [{ id, label, type, options?: string[], required?: boolean }]
// type ∈ {'text', 'textarea', 'dropdown', 'radio', 'checkbox'}

/**
 * @returns {string|null} error message on failure, null on success
 */
export function validateCustomResponses(customFields, responses) {
  if (!Array.isArray(customFields) || customFields.length === 0) return null
  const r = responses || {}

  for (const field of customFields) {
    if (!field || !field.id) continue
    const value = r[field.id]
    const isEmpty = value === undefined || value === null || value === '' ||
                    (Array.isArray(value) && value.length === 0)

    if (field.required && isEmpty) {
      return `Required field missing: ${field.label || field.id}`
    }
    if (isEmpty) continue   // optional + empty is fine

    if ((field.type === 'dropdown' || field.type === 'radio') && Array.isArray(field.options)) {
      if (!field.options.includes(value)) {
        return `Invalid choice for "${field.label || field.id}"`
      }
    }
    if (field.type === 'checkbox') {
      // Accept boolean or 'true' / 'false' string (HTML checkbox
      // serialisation may give either).
      const ok = typeof value === 'boolean' || value === 'true' || value === 'false'
      if (!ok) {
        return `Invalid value for "${field.label || field.id}" (expected true/false)`
      }
    }
    if ((field.type === 'text' || field.type === 'textarea') && typeof value !== 'string') {
      return `Invalid value for "${field.label || field.id}" (expected text)`
    }
  }

  return null
}
