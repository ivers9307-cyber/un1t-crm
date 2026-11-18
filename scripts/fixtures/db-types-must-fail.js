// @ts-check
// DBTYPES.1 — mistakes `npm run check:types` must keep catching. Never imported
// or run. The first is the bug that stopped every sequence enrolment for 24 days.

/** @param {import('../../src/lib/supabase').Db} db */
export async function mustFail(db) {
  await db.from('sequence_enrollments').select('id, created_at')
  await db.from('deals').select('id, contacts!contact_id(name, nope)')
  await db.from('not_a_table').select('id')
  await db.rpc('increment_step_sent')
  await db.from('contacts').update({ not_a_column: 1 }).eq('id', 'x')
  const { data } = await db.from('contacts').select('id, email').limit(1)
  return data[0].email
}
