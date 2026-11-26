// ADDCONTACTBLANK.1 — what the inbox's "Add to Contacts" form sends, and the
// line it shows when the route refuses. The form keeps empty fields as '';
// the route reads an optional field as "not given" only when it is absent or
// null, so a blank email used to be refused as an invalid address and no
// contact could be added without one.

const text = (v) => (typeof v === 'string' ? v.trim() : '')

export function addContactPayload(form = {}) {
  const name = text(form.name)
  return {
    name,
    first_name: text(form.first_name) || name.split(/\s+/)[0] || undefined,
    email: text(form.email) || null,
    pipeline_stage: form.pipeline_stage || undefined,
    add_to_pipeline: form.add_to_pipeline === true,
  }
}

const FALLBACK = 'Could not add the contact. Try again.'

// validateBody answers { success:false, error, issues:[{ path, message }] }.
export function addContactErrorText(data) {
  const issue = Array.isArray(data?.issues) ? data.issues[0] : null
  const field = issue ? String(Array.isArray(issue.path) ? issue.path[0] : issue.path || '') : ''
  if (field === 'email') return 'That email address does not look right. Fix it or leave it empty.'
  if (field === 'name') return 'Enter a name for the contact.'
  return (typeof data?.error === 'string' && data.error) || FALLBACK
}
