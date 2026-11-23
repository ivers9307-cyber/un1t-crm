// CLAIMNAME.1 — fill a matched contact's blank first or last name from what the
// person just typed on a public form.
//
// The Glofox register refuses a contact without both names. The forms used to
// stamp both names only when first_name was null, so an older contact holding a
// first name and no surname (a race sign-up, an import) kept its blank surname
// and the claim stopped at "missing first_name or last_name".
//
// Each field is judged on its own, and a name the contact already has is never
// replaced. Each write is guarded on the value that was read, so a name set in
// between is kept. Returns { error }: callers treat it as best-effort.

const blank = (v) => v == null || String(v).trim() === ''

export async function fillMissingContactNames(db, contactId, { first_name, last_name } = {}) {
  const typed = { first_name, last_name }
  const { data: row, error: readError } = await db.from('contacts')
    .select('id, first_name, last_name').eq('id', contactId).maybeSingle()
  if (readError) return { error: readError }
  if (!row) return { error: null }

  for (const field of ['first_name', 'last_name']) {
    if (!blank(row[field]) || blank(typed[field])) continue
    const write = db.from('contacts').update({ [field]: String(typed[field]).trim() }).eq('id', contactId)
    const { error } = await (row[field] == null ? write.is(field, null) : write.eq(field, row[field]))
    if (error) return { error }
  }
  return { error: null }
}
