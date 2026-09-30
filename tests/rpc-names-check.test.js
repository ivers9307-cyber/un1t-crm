// Tests for check:rpc-names (scripts/check-rpc-names.mjs, STEPSENTRPC.1).
// The script is the CI gate; these pin the parts a refactor could quietly
// loosen: the function replay (overloads, DROP with and without an argument
// list, RENAME TO, SET SCHEMA, a create inside a DO block), what counts as a
// readable `.rpc()` name, the declared indirections, and the allowlist's
// expiry semantics.
//
// The shape of every fixture is the incident (C61/C71): `db.rpc(
// 'increment_step_sent')` naming a function no migration ever created.

import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyFunctionDdl,
  collectFunctions,
  normaliseArgType,
  signatureOf,
  parseFunctionName,
  isCallable,
  collectRpcCalls,
  collectIndirectNames,
  scanTree,
  validateAllowlist,
  classifyHits,
  walkSources,
  SOURCE_ROOTS,
  RPC_INDIRECT,
} from '../scripts/check-rpc-names.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')

/** Replay migration texts in order. */
function fnsOf(...sqls) {
  const functions = new Map()
  const notes = []
  for (const sql of sqls) applyFunctionDdl(sql, functions, notes)
  return { functions, notes }
}

const COUNTER_SQL = `
  -- the mig 314 family: a real atomic counter
  CREATE OR REPLACE FUNCTION public.increment_whatsapp_template_sent(p_template_id uuid, p_delta int DEFAULT 1)
  RETURNS void LANGUAGE sql AS $$
    update public.whatsapp_templates set total_sent = coalesce(total_sent,0) + p_delta where id = p_template_id;
  $$;
`

describe('function replay', () => {
  it('THE INCIDENT: a name no migration creates is not callable; a created one is', () => {
    const { functions } = fnsOf(COUNTER_SQL)
    expect(isCallable(functions, 'increment_whatsapp_template_sent')).toBe(true)
    expect(isCallable(functions, 'increment_step_sent')).toBe(false)
  })

  it('reads an unqualified, a lower-case and a quoted name', () => {
    const { functions } = fnsOf(`
      create function bump_a() returns void language sql as $$ select $$;
      CREATE OR REPLACE FUNCTION "public"."Bump_B"() RETURNS void LANGUAGE sql AS $$ select $$;`)
    expect(isCallable(functions, 'bump_a')).toBe(true)
    expect(isCallable(functions, 'Bump_B')).toBe(true)
    expect(isCallable(functions, 'bump_b')).toBe(false)
  })

  it('a function in another schema is not reachable through .rpc()', () => {
    const { functions } = fnsOf(`CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql AS $$ select true $$;`)
    expect(isCallable(functions, 'auth_is_master')).toBe(false)
    expect(functions.has('private.auth_is_master')).toBe(true)
  })

  it('CREATE OR REPLACE of the same signature keeps one overload', () => {
    const { functions } = fnsOf(COUNTER_SQL, COUNTER_SQL)
    expect([...functions.get('public.increment_whatsapp_template_sent')]).toEqual(['uuid,integer'])
  })

  it('DROP FUNCTION with no argument list removes every overload', () => {
    const { functions } = fnsOf(
      `CREATE FUNCTION public.f(a uuid) RETURNS void LANGUAGE sql AS $$ select $$;
       CREATE FUNCTION public.f(a uuid, b int) RETURNS void LANGUAGE sql AS $$ select $$;`,
      'DROP FUNCTION IF EXISTS public.f;')
    expect(isCallable(functions, 'f')).toBe(false)
  })

  it('DROP of ONE overload keeps the other (the merge_contacts shape: new signature, old one dropped)', () => {
    const { functions, notes } = fnsOf(
      `CREATE FUNCTION public.merge_contacts(p_survivor uuid, p_loser uuid) RETURNS void LANGUAGE sql AS $$ select $$;
       CREATE FUNCTION public.merge_contacts(p_survivor uuid, p_loser uuid, p_fields jsonb, p_tags text[]) RETURNS void LANGUAGE sql AS $$ select $$;`,
      'drop function if exists public.merge_contacts(uuid, uuid);')
    expect([...functions.get('public.merge_contacts')]).toEqual(['uuid,uuid,jsonb,text[]'])
    expect(notes).toEqual([])
  })

  it('DROP of the only overload, then a select of it is a hit', () => {
    const { functions } = fnsOf(
      'CREATE FUNCTION public.scan_straps() RETURNS void LANGUAGE sql AS $$ select $$;',
      'DROP FUNCTION IF EXISTS public.scan_straps();')
    expect(isCallable(functions, 'scan_straps')).toBe(false)
  })

  it('DROP FUNCTION of several names in one statement, with CASCADE', () => {
    const { functions } = fnsOf(
      `CREATE FUNCTION public.a() RETURNS trigger LANGUAGE plpgsql AS $$ begin return new; end $$;
       CREATE FUNCTION public.b(x int) RETURNS void LANGUAGE sql AS $$ select $$;
       CREATE FUNCTION public.c() RETURNS void LANGUAGE sql AS $$ select $$;`,
      'drop function if exists public.a(), public.b(integer) cascade;')
    expect(isCallable(functions, 'a')).toBe(false)
    expect(isCallable(functions, 'b')).toBe(false)
    expect(isCallable(functions, 'c')).toBe(true)
  })

  it('a DROP … IF EXISTS of something never created is silent', () => {
    const { notes } = fnsOf('DROP FUNCTION IF EXISTS public.never_made(uuid);')
    expect(notes).toEqual([])
  })

  it('a DROP whose signature matches no overload of a KNOWN name is a note, and deletes nothing', () => {
    const { functions, notes } = fnsOf(COUNTER_SQL, 'DROP FUNCTION public.increment_whatsapp_template_sent(text);')
    expect(isCallable(functions, 'increment_whatsapp_template_sent')).toBe(true)
    expect(notes.map((n) => n.kind)).toEqual(['unmatched-drop'])
  })

  it('ALTER FUNCTION … SET SCHEMA private takes it out of .rpc() reach (the mig 022/549 moves)', () => {
    const { functions } = fnsOf(
      'CREATE FUNCTION public.auth_role() RETURNS text LANGUAGE sql AS $$ select $$;',
      'ALTER FUNCTION public.auth_role() SET SCHEMA private;')
    expect(isCallable(functions, 'auth_role')).toBe(false)
    expect(functions.has('private.auth_role')).toBe(true)
  })

  it('ALTER FUNCTION … RENAME TO moves the name', () => {
    const { functions } = fnsOf(COUNTER_SQL,
      'ALTER FUNCTION public.increment_whatsapp_template_sent(uuid, integer) RENAME TO bump_template_sent;')
    expect(isCallable(functions, 'increment_whatsapp_template_sent')).toBe(false)
    expect(isCallable(functions, 'bump_template_sent')).toBe(true)
  })

  it('an ALTER of a function the replay never saw is a note (made outside the migrations)', () => {
    const { notes } = fnsOf('ALTER FUNCTION public.is_owner() SET SCHEMA private;')
    expect(notes.map((n) => n.kind)).toEqual(['alter-unknown'])
  })

  it('a CREATE FUNCTION inside a DO block is not replayed, and is noted (mig 667 probe)', () => {
    const { functions, notes } = fnsOf(`
      DO $$ BEGIN
        EXECUTE format('CREATE FUNCTION %I._probe() RETURNS integer LANGUAGE sql AS %L', 'public', 'SELECT 1');
      END $$;`)
    expect(isCallable(functions, '_probe')).toBe(false)
    expect(notes.map((n) => n.kind)).toEqual(['dynamic-create'])
  })

  it('a DROP FUNCTION inside a DO block is not replayed either, and is noted (review fix 4)', () => {
    const { functions, notes } = fnsOf(
      'CREATE FUNCTION public.merge_contacts(p_survivor uuid, p_loser uuid) RETURNS void LANGUAGE sql AS $$ select $$;',
      `DO $$ BEGIN EXECUTE 'DROP FUNCTION public.merge_contacts(uuid, uuid)'; END $$;`)
    expect(isCallable(functions, 'merge_contacts')).toBe(true)
    expect(notes.map((n) => n.kind)).toEqual(['dynamic-drop'])
  })

  it('an ALTER FUNCTION inside a DO block is noted, and one DO with several kinds notes each', () => {
    const { notes } = fnsOf(`
      DO $$ BEGIN
        EXECUTE 'ALTER FUNCTION public.f() SET SCHEMA private';
        EXECUTE 'CREATE FUNCTION public.g() RETURNS void LANGUAGE sql AS ''select''';
        EXECUTE 'DROP FUNCTION public.h()';
      END $$;`)
    expect(notes.map((n) => n.kind)).toEqual(['dynamic-create', 'dynamic-drop', 'dynamic-alter'])
  })

  it('a DO block with no function DDL is silent', () => {
    expect(fnsOf(`DO $$ BEGIN EXECUTE 'ALTER TABLE public.t ENABLE ROW LEVEL SECURITY'; END $$;`).notes).toEqual([])
  })

  it('a function body that mentions another CREATE FUNCTION does not shred the replay', () => {
    const { functions } = fnsOf(`
      CREATE FUNCTION public.outer_fn() RETURNS text LANGUAGE sql AS $$ select 'create function public.fake() ; drop function public.real_one' $$;
      CREATE FUNCTION public.real_one() RETURNS void LANGUAGE sql AS $$ select $$;`)
    expect(isCallable(functions, 'outer_fn')).toBe(true)
    expect(isCallable(functions, 'real_one')).toBe(true)
    expect(isCallable(functions, 'fake')).toBe(false)
  })

  it('ignores DDL that only lives in a comment', () => {
    const { functions } = fnsOf(`
      -- CREATE FUNCTION public.increment_step_sent(p_step_id uuid) RETURNS void …
      /* CREATE FUNCTION public.increment_sequence_enrolled() RETURNS void LANGUAGE sql AS $$ select $$; */
      --   DROP FUNCTION IF EXISTS public.claim_shift_offer(uuid, uuid);`)
    expect(functions.size).toBe(0)
  })
})

describe('signatures', () => {
  it('drops parameter names, modes, defaults and typmods, and folds type aliases', () => {
    expect(signatureOf('p_id uuid, p_n int4 DEFAULT 1, p_name varchar(20), p_at timestamptz = now()'))
      .toBe('uuid,integer,character varying,timestamp with time zone')
    expect(signatureOf('IN a bigint, OUT total integer, INOUT b bool, VARIADIC c text[]'))
      .toBe('bigint,boolean,text[]')
  })

  it('keeps a multi-word type that has no parameter name', () => {
    expect(normaliseArgType('timestamp with time zone')).toBe('timestamp with time zone')
    expect(normaliseArgType('double precision')).toBe('double precision')
    expect(normaliseArgType('p_x double precision')).toBe('double precision')
  })

  it('an empty list is the empty signature', () => {
    expect(signatureOf('')).toBe('')
    expect(signatureOf('  ')).toBe('')
  })

  it('parseFunctionName folds unquoted names and keeps quoted ones', () => {
    expect(parseFunctionName('Public.Foo')).toEqual({ schema: 'public', name: 'foo' })
    expect(parseFunctionName('"public"."Foo"')).toEqual({ schema: 'public', name: 'Foo' })
    expect(parseFunctionName('foo')).toEqual({ schema: 'public', name: 'foo' })
  })
})

describe('source scanning', () => {
  it('THE INCIDENT as written in steps.js is read, at the right line', () => {
    const src = [
      '  // Bump per-step metric.',
      "  try { await db.rpc('increment_step_sent', { p_step_id: step.id }) } catch {}",
    ].join('\n')
    const calls = collectRpcCalls(src)
    expect(calls.map((c) => c.name)).toEqual(['increment_step_sent'])
  })

  it('reads single, double and interpolation-free template literals, and odd spacing', () => {
    const src = `db.rpc('a', {}); db.rpc("b"); supabase . rpc ( \`c\` , {})`
    expect(collectRpcCalls(src).map((c) => c.name)).toEqual(['a', 'b', 'c'])
  })

  it('reads an optional call, db.rpc?.(\'x\') (review fix 3)', () => {
    const src = "await db.rpc?.('increment_step_sent', {}); await db.rpc ?. (name)"
    expect(collectRpcCalls(src).map((c) => c.name)).toEqual(['increment_step_sent', null])
  })

  it('anything else is null (unreadable), never guessed', () => {
    const src = 'db.rpc(fn, args); db.rpc(`inc_${kind}`); db.rpc(NAME); db.rpc(pick())'
    expect(collectRpcCalls(src).map((c) => c.name)).toEqual([null, null, null, null])
  })

  it('does not read a call out of a comment', () => {
    const src = "// await db.rpc('increment_step_sent')\n/* db.rpc('increment_sequence_enrolled') */\nconst x = 1"
    expect(collectRpcCalls(src)).toEqual([])
  })

  it('reads a wrapper call\'s name argument and skips the wrapper\'s declaration', () => {
    const src = [
      'async function reportRpc(db, fn, args) {',
      '  const { error } = await db.rpc(fn, args)',
      '}',
      "await reportRpc(db, 'increment_contact_opens', { p_contact_id: id })",
      'await reportRpc(db, NAME, {})',
    ].join('\n')
    const out = collectIndirectNames(src, { callee: 'reportRpc', arg: 1 })
    expect(out.map((n) => n.name)).toEqual(['increment_contact_opens', null])
  })

  it('a non-literal value in a table of names is null (unreadable), never skipped (review fix 2)', () => {
    const src = "return { fn: 'approve_drop_shift_swap' }\nreturn { fn: `approve_${kind}_phantom_swap` }\nreturn { fn: NAME }\nreturn { fn: 'approve_' + kind }"
    expect(collectIndirectNames(src, { property: 'fn' }).map((n) => n.name))
      .toEqual(['approve_drop_shift_swap', null, null, null])
  })

  it('reads a table of names by property', () => {
    const src = "return { fn: 'approve_drop_shift_swap', args }\nreturn { fn: \"approve_reassign_shift_swap\" }"
    expect(collectIndirectNames(src, { property: 'fn' }).map((n) => n.name))
      .toEqual(['approve_drop_shift_swap', 'approve_reassign_shift_swap'])
  })
})

describe('scanTree', () => {
  const { functions } = fnsOf(COUNTER_SQL, `
    CREATE FUNCTION public.increment_contact_opens(p_contact_id uuid) RETURNS void LANGUAGE sql AS $$ select $$;
    CREATE FUNCTION public.approve_drop_shift_swap(p uuid) RETURNS void LANGUAGE sql AS $$ select $$;`)
  const tree = (files) => ({ files: Object.keys(files), read: (f) => files[f] })
  const INDIRECT = [
    { site: 'src/w.js', source: { file: 'src/w.js', callee: 'reportRpc', arg: 1 } },
    { site: 'src/r.js', source: { file: 'src/t.js', property: 'fn' } },
  ]

  it('a phantom literal is a hit with file:line; a real one resolves', () => {
    const t = tree({ 'src/a.js': "\n\nawait db.rpc('increment_step_sent', {})\nawait db.rpc('increment_whatsapp_template_sent', {})" })
    const out = scanTree(t.files, t.read, functions, [])
    expect(out.hits).toEqual([{ file: 'src/a.js', line: 3, name: 'increment_step_sent', via: '.rpc()' }])
    expect(out.resolved).toBe(1)
  })

  it('a non-literal .rpc() nobody declared FAILS as unreadable', () => {
    const t = tree({ 'src/a.js': 'await db.rpc(name, {})' })
    expect(scanTree(t.files, t.read, functions, []).unreadable).toEqual([{ file: 'src/a.js', line: 1 }])
  })

  it('a declared indirection resolves its names, and reports a phantom among them', () => {
    const t = tree({
      'src/w.js': "async function reportRpc(db, fn, a) { await db.rpc(fn, a) }\nreportRpc(db, 'increment_contact_opens')\nreportRpc(db, 'increment_contact_openz')",
      'src/r.js': 'await db.rpc(rpc.fn, rpc.args)',
      'src/t.js': "return { fn: 'approve_drop_shift_swap' }",
    })
    const out = scanTree(t.files, t.read, functions, INDIRECT)
    expect(out.unreadable).toEqual([])
    expect(out.staleIndirect).toEqual([])
    expect(out.hits).toEqual([{ file: 'src/w.js', line: 3, name: 'increment_contact_openz', via: 'reportRpc()' }])
    expect(out.resolved).toBe(2)
  })

  it('an indirection whose call site became a literal (or vanished) is STALE', () => {
    const t = tree({
      'src/w.js': "reportRpc(db, 'increment_contact_opens')",
      'src/r.js': "await db.rpc('approve_drop_shift_swap')",
      'src/t.js': '',
    })
    const out = scanTree(t.files, t.read, functions, INDIRECT)
    expect(out.staleIndirect.map((e) => e.site)).toEqual(['src/w.js', 'src/r.js'])
  })
})

describe('allowlist', () => {
  const hit = { file: 'src/lib/sequences/enrol.js', line: 336, name: 'increment_sequence_enrolled', via: '.rpc()' }
  const entry = (over = {}) => ({
    file: hit.file, name: hit.name,
    reason: 'phantom; removed by C61', expires: '2026-10-31', ...over,
  })

  it('rejects an entry missing a field or with a malformed expiry', () => {
    expect(validateAllowlist([entry({ reason: '' })])).toHaveLength(1)
    expect(validateAllowlist([entry({ expires: '31/10/2026' })])).toHaveLength(1)
    expect(validateAllowlist([entry()])).toEqual([])
  })

  it('suppresses a hit while the entry is live', () => {
    const out = classifyHits([hit], [entry()], '2026-10-01')
    expect(out.failures).toEqual([])
    expect(out.allowed).toHaveLength(1)
  })

  it('does NOT suppress once the entry has expired: entries cannot rot', () => {
    const out = classifyHits([hit], [entry()], '2026-11-01')
    expect(out.failures).toEqual([hit])
    expect(out.expired).toHaveLength(1)
  })

  it('matches on file+name, not either alone', () => {
    expect(classifyHits([hit], [entry({ file: 'src/other.js' })], '2026-10-01').failures).toEqual([hit])
    expect(classifyHits([hit], [entry({ name: 'increment_step_sent' })], '2026-10-01').failures).toEqual([hit])
  })

  it('reports an entry that no longer matches a hit as stale', () => {
    expect(classifyHits([], [entry()], '2026-10-01').stale).toHaveLength(1)
  })
})

describe('which files the gate reads', () => {
  let tmp = null
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = null })
  function tree(files) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcnames-walk-'))
    for (const f of files) {
      fs.mkdirSync(path.join(tmp, path.dirname(f)), { recursive: true })
      fs.writeFileSync(path.join(tmp, f), '')
    }
    return tmp
  }
  const rel = (root, files) => files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort()

  it('scans src, mobile, shared and the edge functions', () => {
    expect(SOURCE_ROOTS).toEqual(['src', 'mobile', 'shared', 'supabase/functions'])
  })

  it('reads JS and TS at any depth, never a test file', () => {
    const root = tree(['a.js', 'b.jsx', 'c.mjs', 'd.ts', 'e.tsx', 'a.test.js', 'x/y.test.jsx', 'f.json'])
    expect(rel(root, walkSources(root))).toEqual(['a.js', 'b.jsx', 'c.mjs', 'd.ts', 'e.tsx'])
  })

  it('skips installed packages, native projects, build output and dot-directories', () => {
    const root = tree(['lib/keep.js', 'node_modules/p/i.js', 'ios/x.js', 'android/y.js', 'dist/z.js', 'web-build/w.js', '.expo/c.js'])
    expect(rel(root, walkSources(root))).toEqual(['lib/keep.js'])
  })
})

// ---------------------------------------------------------------------------
// The real tree. C61 (#1849, held for Richard) removes the two
// increment_sequence_* calls; until it merges they are the ONLY phantoms
// allowed, and only in the files C61 edits. After it merges this still holds
// (no hits at all).
// ---------------------------------------------------------------------------

describe('the repository', () => {
  const PENDING_C61 = new Set([
    'src/lib/sequences/enrol.js|increment_sequence_enrolled',
    'src/lib/sequences/scheduler.js|increment_sequence_completed',
  ])
  const { functions } = collectFunctions(path.join(ROOT, 'supabase/migrations'))
  const files = SOURCE_ROOTS.flatMap((r) => walkSources(path.join(ROOT, r))).map((f) => path.relative(ROOT, f))
  const out = scanTree(files, (f) => fs.readFileSync(path.join(ROOT, f), 'utf8'), functions)

  it('scans a real tree and resolves real names', () => {
    expect(files.length).toBeGreaterThan(1000)
    expect(out.resolved).toBeGreaterThan(50)
  })

  it('STEPSENTRPC.1: no code calls increment_step_sent (or any phantom but C61\'s two)', () => {
    const phantoms = out.hits.map((h) => `${h.file}|${h.name}`).filter((k) => !PENDING_C61.has(k))
    expect(phantoms).toEqual([])
  })

  it('every non-literal .rpc() is declared, and no declaration is stale', () => {
    expect(out.unreadable).toEqual([])
    expect(out.staleIndirect).toEqual([])
    expect(RPC_INDIRECT.length).toBe(2)
  })

  it('the replay agrees with prod on the names the code calls (checked 30 Sep 2026)', () => {
    // Every name below exists in prod's pg_proc (schema public); a replay
    // that loses one would fail the gate on a working call.
    for (const name of ['merge_contacts', 'list_health_monthly_stats', 'contact_delete_impact',
      'scan_straps_for_contact', 'approve_reciprocal_shift_swap', 'claim_shift_offer',
      'replace_staff_unavailability', 'increment_contact_opens', 'stamp_contact_email_click']) {
      expect(isCallable(functions, name), name).toBe(true)
    }
    for (const name of ['increment_step_sent', 'increment_sequence_enrolled', 'increment_sequence_completed']) {
      expect(isCallable(functions, name), name).toBe(false)
    }
  })
})
