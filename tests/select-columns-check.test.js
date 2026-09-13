// Tests for the pure functions behind check:select-columns
// (scripts/check-select-columns.mjs, SELECTCOLS.1). The script is the CI
// gate; these pin the parts a refactor could quietly loosen — the migration
// replay (including the DROP/RENAME cases a grep for CREATE TABLE gets
// wrong), the PostgREST select grammar, what counts as a readable string
// literal, and the allowlist's expiry semantics.
//
// The shape of every fixture is the ENROLFIX.1 incident (#1685): a select
// naming `created_at` on a table whose timestamp is `enrolled_at`.

import { describe, it, expect } from 'vitest'
import {
  applyMigrationSql,
  splitSqlStatements,
  parseCreateTableBody,
  cleanSelectString,
  parseSelect,
  firstStringArg,
  extractChainLinks,
  collectFileRefs,
  maskComments,
  lineOf,
  validateAllowlist,
  classifyHits,
} from '../scripts/check-select-columns.mjs'

/** Replay migration texts in order into a schema map. */
function schemaOf(...sqls) {
  const schema = new Map()
  const skippedViews = new Set()
  for (const sql of sqls) applyMigrationSql(sql, schema, skippedViews)
  return { schema, skippedViews }
}

const ENROLMENTS_SQL = `
  -- mig 005, the real shape: the row's timestamp is enrolled_at.
  CREATE TABLE IF NOT EXISTS public.sequence_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_id UUID NOT NULL REFERENCES email_sequences(id),
    contact_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT sequence_enrollments_uniq UNIQUE (sequence_id, contact_id)
  );
`

const CONTACTS_SQL = `
  CREATE TABLE contacts (
    id uuid PRIMARY KEY,
    name text,
    email text,
    metadata jsonb
  );
`

describe('schema replay', () => {
  it('reads CREATE TABLE columns and skips table constraints', () => {
    const { schema } = schemaOf(ENROLMENTS_SQL)
    expect([...schema.get('sequence_enrollments')]).toEqual([
      'id', 'sequence_id', 'contact_id', 'status', 'enrolled_at',
    ])
  })

  it('ignores non-public schemas', () => {
    const { schema } = schemaOf('CREATE TABLE private.app_config (id uuid, secret text);')
    expect(schema.has('app_config')).toBe(false)
  })

  it('applies ADD COLUMN IF NOT EXISTS, including multi-action ALTERs', () => {
    const { schema } = schemaOf(CONTACTS_SQL, `
      ALTER TABLE public.contacts
        ADD COLUMN IF NOT EXISTS lead_source text,
        ADD COLUMN IF NOT EXISTS joined_at timestamptz;
    `)
    expect(schema.get('contacts').has('lead_source')).toBe(true)
    expect(schema.get('contacts').has('joined_at')).toBe(true)
  })

  it('applies DROP COLUMN — a later select of it is a hit', () => {
    const { schema } = schemaOf(CONTACTS_SQL, 'ALTER TABLE contacts DROP COLUMN IF EXISTS email;')
    expect(schema.get('contacts').has('email')).toBe(false)
    const refs = collectFileRefs(`db.from('contacts').select('id, email')`, schema)
    const missing = refs.filter((r) => !schema.get(r.table).has(r.column))
    expect(missing).toEqual([{ table: 'contacts', column: 'email', offset: expect.any(Number), via: 'select' }])
  })

  it('applies RENAME COLUMN — old name gone, new name present', () => {
    const { schema } = schemaOf(`
      CREATE TABLE contact_devices (id uuid, strap_mac text);
    `, 'ALTER TABLE contact_devices RENAME COLUMN strap_mac TO strap_identifier;')
    expect([...schema.get('contact_devices')]).toEqual(['id', 'strap_identifier'])
  })

  it('applies a table RENAME TO, carrying the columns across', () => {
    const { schema } = schemaOf(
      'CREATE TABLE inbound_invoices (id uuid, status text);',
      'ALTER TABLE public.inbound_invoices RENAME TO invoices_queue;'
    )
    expect(schema.has('inbound_invoices')).toBe(false)
    expect([...schema.get('invoices_queue')]).toEqual(['id', 'status'])
  })

  it('applies DROP TABLE', () => {
    const { schema } = schemaOf(CONTACTS_SQL, 'DROP TABLE IF EXISTS public.contacts CASCADE;')
    expect(schema.has('contacts')).toBe(false)
  })

  it('does not let a $$ block body shred the statements after it', () => {
    const stmts = splitSqlStatements(`
      DO $$ BEGIN RAISE NOTICE 'a; b; c'; END $$;
      CREATE TABLE after_block (id uuid);
    `)
    expect(stmts.some((s) => /CREATE TABLE after_block/.test(s))).toBe(true)
  })

  it('ignores DDL that only lives in a comment', () => {
    const { schema } = schemaOf('-- CREATE TABLE ghosts (id uuid);\n/* ALTER TABLE contacts ADD COLUMN nope text; */')
    expect(schema.size).toBe(0)
  })
})

describe('parseCreateTableBody', () => {
  it('keeps a generated column and drops CHECK/UNIQUE lines', () => {
    expect(parseCreateTableBody(
      `id uuid, search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED, ` +
      `CHECK (bpm BETWEEN 30 AND 240), UNIQUE (id)`
    )).toEqual(['id', 'search_tsv'])
  })
})

describe('views', () => {
  it('takes a simple view\'s aliases and bare columns as its columns', () => {
    const { schema, skippedViews } = schemaOf(`
      CREATE TABLE cron_heartbeats (name text, last_ok_at timestamptz, grace_seconds int);
    `, `
      CREATE OR REPLACE VIEW public.cron_health AS
      SELECT name, last_ok_at,
        EXTRACT(EPOCH FROM (NOW() - last_ok_at))::INTEGER AS stale_seconds
      FROM public.cron_heartbeats;
    `)
    expect([...schema.get('cron_health')]).toEqual(['name', 'last_ok_at', 'stale_seconds'])
    expect([...skippedViews]).toEqual([])
  })

  it('expands `c.*` against the view\'s own FROM alias', () => {
    const { schema } = schemaOf(CONTACTS_SQL, `
      CREATE TABLE contact_location_preferences (contact_id uuid, location_id uuid);
    `, `
      create view contact_location_audience with (security_invoker = on) as
      select c.*, clp.location_id as audience_location_id
      from contacts c join contact_location_preferences clp on clp.contact_id = c.id;
    `)
    expect([...schema.get('contact_location_audience')])
      .toEqual(['id', 'name', 'email', 'metadata', 'audience_location_id'])
  })

  it('skips a view whose select list it cannot resolve, and names it', () => {
    const { schema, skippedViews } = schemaOf(
      'CREATE VIEW public.weird AS SELECT count(*) FROM contacts;'
    )
    expect(schema.has('weird')).toBe(false)
    expect([...skippedViews]).toEqual(['weird'])
  })
})

describe('PostgREST select parsing', () => {
  const { schema } = schemaOf(ENROLMENTS_SQL, CONTACTS_SQL)
  const cols = (sel, table = 'sequence_enrollments') =>
    parseSelect(sel, table, schema).map((r) => `${r.table}.${r.column}`)

  it('THE INCIDENT: created_at on sequence_enrollments is a hit, enrolled_at is not', () => {
    const refs = parseSelect('id, status, created_at, enrolled_at', 'sequence_enrollments', schema)
    const missing = refs.filter((r) => !schema.get(r.table).has(r.column)).map((r) => r.column)
    expect(missing).toEqual(['created_at'])
  })

  it('reads alias:column as the underlying column', () => {
    expect(cols('startedAt:enrolled_at')).toEqual(['sequence_enrollments.enrolled_at'])
  })

  it('descends into an embed when the relation is a known table', () => {
    expect(cols('id, contacts!contact_id(name, email)'))
      .toEqual(['sequence_enrollments.id', 'contacts.name', 'contacts.email'])
  })

  it('skips an embed whose relation is not a known table', () => {
    expect(cols('id, some_fk_constraint(anything, at_all)'))
      .toEqual(['sequence_enrollments.id'])
  })

  it('uses the ROOT column of a JSON path', () => {
    expect(cols("id, metadata->>'utm', metadata->'a'->>'b'", 'contacts'))
      .toEqual(['contacts.id', 'contacts.metadata', 'contacts.metadata'])
  })

  it('ignores *, count and aggregates, and strips casts and hints', () => {
    expect(cols('*, count, id::text, enrolled_at.max(), contact_id!inner'))
      .toEqual([
        'sequence_enrollments.id',
        'sequence_enrollments.enrolled_at',
        'sequence_enrollments.contact_id',
      ])
  })

  it('strips the whitespace supabase-js strips, so a multi-line select still parses', () => {
    expect(cleanSelectString('\n  id,\n  enrolled_at\n')).toBe('id,enrolled_at')
    expect(cols('\n      id,\n      created_at\n    ')).toEqual([
      'sequence_enrollments.id', 'sequence_enrollments.created_at',
    ])
  })
})

describe('source scanning', () => {
  const { schema } = schemaOf(ENROLMENTS_SQL, CONTACTS_SQL)
  const hits = (src) =>
    collectFileRefs(src, schema)
      .filter((r) => !schema.get(r.table).has(r.column))
      .map((r) => `${r.table}.${r.column}`)

  it('flags the incident as written in enrol.js', () => {
    expect(hits(`
      const { data } = await db
        .from('sequence_enrollments')
        .select('id, status, created_at, enrolled_at')
        .eq('contact_id', contactId)
    `)).toEqual(['sequence_enrollments.created_at'])
  })

  it('checks filter-method column names too', () => {
    expect(hits(`db.from('contacts').select('id').eq('nope', 1).order('created_at')`))
      .toEqual(['contacts.nope', 'contacts.created_at'])
  })

  it('checks a .select() chained onto .update()/.insert() on the same table', () => {
    expect(hits(`await db.from('contacts').update(patch).eq('id', id).select('id, created_at')`))
      .toEqual(['contacts.created_at'])
  })

  it('ignores a non-literal select string', () => {
    expect(hits(`db.from('sequence_enrollments').select(COLUMNS)`)).toEqual([])
    expect(hits('db.from(\'sequence_enrollments\').select(`id, ${extra}`)')).toEqual([])
  })

  it('ignores an unknown table entirely', () => {
    expect(hits(`db.from('not_a_table').select('anything, at_all')`)).toEqual([])
    expect(hits(`Array.from('abc')`)).toEqual([])
  })

  it('ignores an embedded-resource filter and a foreignTable order', () => {
    expect(hits(`db.from('contacts').select('id').eq('parent.created_at', 1)`)).toEqual([])
    expect(hits(`db.from('contacts').select('id').order('created_at', { foreignTable: 'deals' })`)).toEqual([])
  })

  it('does not read a chain out of a comment', () => {
    expect(hits(`// db.from('contacts').select('created_at')\nconst x = 1`)).toEqual([])
    expect(hits(`/* db.from('contacts').select('created_at') */\nconst x = 1`)).toEqual([])
  })

  it('masks comments WITHOUT moving any offset, so file:line stays true', () => {
    const src = `/* two\n   lines */\ndb.from('contacts').select('created_at')`
    expect(maskComments(src)).toHaveLength(src.length)
    const [ref] = collectFileRefs(src, schema)
    expect(lineOf(src, ref.offset)).toBe(3)
  })

  it('ends a chain that is broken across statements rather than guessing', () => {
    const links = extractChainLinks(`let q = db.from('contacts')\nq = q.select('created_at')`)
    expect(links).toEqual([])
  })
})

describe('firstStringArg', () => {
  it('reads single, double and interpolation-free template literals', () => {
    expect(firstStringArg(`'id, name'`)).toBe('id, name')
    expect(firstStringArg(`"id", { count: 'exact' }`)).toBe('id')
    expect(firstStringArg('`id, name`')).toBe('id, name')
    expect(firstStringArg(`'a', 'b'`)).toBe('a')
  })

  it('refuses anything it cannot read', () => {
    expect(firstStringArg('COLUMNS')).toBeNull()
    expect(firstStringArg('`id, ${x}`')).toBeNull()
    expect(firstStringArg('cols.join(",")')).toBeNull()
  })
})

describe('allowlist', () => {
  const hit = { file: 'src/lib/x.js', table: 'contacts', column: 'source', line: 3 }
  const entry = {
    file: 'src/lib/x.js', table: 'contacts', column: 'source',
    reason: 'verified against information_schema on the live project',
    expires: '2026-10-13',
  }

  it('rejects an entry missing a field or with a malformed expiry', () => {
    expect(validateAllowlist([{ file: 'a', table: 'b', column: 'c', reason: 'd' }]))
      .toEqual([expect.stringContaining('missing "expires"')])
    expect(validateAllowlist([{ ...entry, expires: 'next quarter' }]))
      .toEqual([expect.stringContaining('want YYYY-MM-DD')])
  })

  it('suppresses a hit while the entry is live', () => {
    const { failures, allowed } = classifyHits([hit], [entry], '2026-09-13')
    expect(failures).toEqual([])
    expect(allowed).toHaveLength(1)
  })

  it('does NOT suppress once the entry has expired — entries cannot rot', () => {
    const { failures, expired, allowed } = classifyHits([hit], [entry], '2026-10-14')
    expect(failures).toEqual([hit])
    expect(allowed).toEqual([])
    expect(expired).toHaveLength(1)
  })

  it('matches on file+table+column, not on any one of them', () => {
    const { failures } = classifyHits([hit], [{ ...entry, file: 'src/lib/other.js' }], '2026-09-13')
    expect(failures).toEqual([hit])
  })

  it('reports an entry that no longer matches a hit as stale', () => {
    const { stale } = classifyHits([], [entry], '2026-09-13')
    expect(stale).toEqual([entry])
  })
})
