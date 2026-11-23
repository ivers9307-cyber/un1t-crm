// CLAIMNAME.1 — a matched contact gets the typed first and last name wherever
// its own is blank, one field at a time. The Glofox register needs both.
import { describe, it, expect } from 'vitest'
import { createFakeDb } from '../../tests/helpers/fake-db.js'
import { fillMissingContactNames } from './contact-name-fill'

const ID = '11111111-1111-4111-8111-111111111111'
const TYPED = { first_name: 'Ava', last_name: 'Byrne' }
const run = async (row) => {
  const db = createFakeDb({ tables: { contacts: [{ id: ID, ...row }] } })
  const out = await fillMissingContactNames(db, ID, TYPED)
  return { out, row: db.tables.contacts[0] }
}

describe('fillMissingContactNames', () => {
  it('a first name and no surname: the surname is filled, the first name kept', async () => {
    const { out, row } = await run({ first_name: 'Avie', last_name: null })
    expect(out.error).toBeNull()
    expect(row).toMatchObject({ first_name: 'Avie', last_name: 'Byrne' })
  })

  it('a surname and no first name: the first name is filled, the surname kept', async () => {
    const { row } = await run({ first_name: null, last_name: 'Smith' })
    expect(row).toMatchObject({ first_name: 'Ava', last_name: 'Smith' })
  })

  it('neither: both are filled', async () => {
    const { row } = await run({ first_name: null, last_name: null })
    expect(row).toMatchObject(TYPED)
  })

  it('an empty or blank string counts as missing', async () => {
    const { row } = await run({ first_name: '', last_name: '  ' })
    expect(row).toMatchObject(TYPED)
  })

  it('both present: nothing is written', async () => {
    const db = createFakeDb({ tables: { contacts: [{ id: ID, first_name: 'Avie', last_name: 'Smith' }] } })
    await fillMissingContactNames(db, ID, TYPED)
    expect(db.tables.contacts[0]).toMatchObject({ first_name: 'Avie', last_name: 'Smith' })
    expect(db.calls.filter((c) => c.op === 'update')).toHaveLength(0)
  })

  it('a blank typed name fills nothing', async () => {
    const db = createFakeDb({ tables: { contacts: [{ id: ID, first_name: 'Avie', last_name: null }] } })
    await fillMissingContactNames(db, ID, { first_name: 'Ava', last_name: ' ' })
    expect(db.tables.contacts[0].last_name).toBeNull()
  })

  it('a failed read or write comes back as an error, never a throw', async () => {
    const readDown = createFakeDb({ tables: { contacts: [] }, errors: { contacts: { select: { message: 'down' } } } })
    expect((await fillMissingContactNames(readDown, ID, TYPED)).error).toBeTruthy()
    const writeDown = createFakeDb({ tables: { contacts: [{ id: ID, first_name: null, last_name: null }] }, errors: { contacts: { update: { message: 'down' } } } })
    expect((await fillMissingContactNames(writeDown, ID, TYPED)).error).toBeTruthy()
  })
})
