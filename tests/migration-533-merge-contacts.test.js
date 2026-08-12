// MERGE-TX.1 — shape guard for migration 533 (public.merge_contacts).
//
// WHY THIS FILE EXISTS
// ────────────────────
// The contact merge moved out of JS and into a Postgres function so it runs in
// one transaction. That function deletes contacts and rewrites every table
// referencing them, and this repo has NO way to execute it before it reaches
// prod: supabase/ has no config.toml, so there is no local stack; there is no
// pgTAP; migrations are applied by hand. The only review the SQL gets is a
// human reading it — the same reason migrations 510-512 carry files like this.
//
// So these assertions pin the properties that make the function safe rather
// than its formatting, and they run against the STATEMENTS, not the prose: the
// header has to discuss the deletes and the old hand-maintained table list in
// order to explain itself, so comments are stripped before matching.
//
// The behavioural counterpart is src/lib/contact-merge.test.js, which proves
// the JS wrapper issues no writes of its own.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { pickMergedFields } from '../src/lib/contact-merge.js'

const FILE = path.resolve(
  import.meta.dirname,
  '../supabase/migrations/533_merge_contacts_transaction.sql',
)

const raw = existsSync(FILE) ? readFileSync(FILE, 'utf8') : ''
const sql = raw.replace(/--[^\n]*/g, '').toLowerCase()

describe('migration 533 — merge_contacts exists and is callable only by service_role', () => {
  it('exists', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  it('defines the function with the signature the JS wrapper calls', () => {
    expect(sql).toMatch(/create or replace function public\.merge_contacts\(/)
    expect(sql).toMatch(/p_survivor_id\s+uuid/)
    expect(sql).toMatch(/p_loser_id\s+uuid/)
    expect(sql).toMatch(/p_merged_fields\s+jsonb/)
    expect(sql).toMatch(/p_merged_tags\s+text\[\]/)
    expect(sql).toMatch(/language plpgsql/)
  })

  it('is SECURITY INVOKER with a pinned search_path (the 513/515/517/521 house pattern)', () => {
    // DEFINER on a function that deletes contacts would turn a future
    // accidental grant into the worst primitive in the database.
    expect(sql).toMatch(/security invoker/)
    expect(sql).not.toMatch(/security definer/)
    // Dynamic SQL runs in here, so an unpinned search_path is not cosmetic.
    expect(sql).toMatch(/set search_path = public/)
  })

  it('revokes execute from everyone and grants it to service_role only', () => {
    expect(sql).toMatch(/revoke execute on function public\.merge_contacts\(uuid, uuid, jsonb, text\[\]\)\s*from public, anon, authenticated/)
    expect(sql).toMatch(/grant execute on function public\.merge_contacts\(uuid, uuid, jsonb, text\[\]\)\s*to service_role/)
  })
})

describe('migration 533 — the FK list is derived, never copied', () => {
  it('reads the referencing tables out of the catalog', () => {
    expect(sql).toMatch(/pg_constraint/)
    expect(sql).toMatch(/confrelid = 'public\.contacts'::regclass/)
    expect(sql).toMatch(/contype = 'f'/)
  })

  it('hard-codes none of the table names the JS lists used to carry', () => {
    // This is the whole point of the derivation. If any of these appears in a
    // STATEMENT (prose is stripped), someone has pasted the list back in and
    // it will drift again.
    const jsListTables = [
      'activities', 'campaign_recipients', 'consent_log', 'contact_preferences',
      'contact_tags', 'deals', 'email_sends', 'notes', 'sequence_enrollments',
      'sms_broadcast_recipients', 'bookings', 'contact_events', 'orders',
      'race_payments', 'race_registrations', 'team_members', 'teams',
      'whatsapp_broadcast_recipients', 'whatsapp_conversations', 'whatsapp_messages',
    ]
    for (const t of jsListTables) {
      expect(sql, `${t} must not be hard-coded`).not.toMatch(new RegExp(`\\b${t}\\b`))
    }
  })

  it('derives the dedupe from the unique indexes, predicates included', () => {
    // A partial unique index (contact_tags' WHERE removed_at IS NULL) is only
    // reproduced correctly if the predicate is applied to BOTH sides.
    expect(sql).toMatch(/pg_index/)
    expect(sql).toMatch(/indisunique/)
    expect(sql).toMatch(/pg_get_expr\(ix\.indpred/)
    // An expression index cannot be reasoned about column-wise; it must be
    // skipped rather than mis-deduped.
    expect(sql).toMatch(/indexprs is null/)
  })

  it('builds every dynamic identifier with %I, never string concatenation', () => {
    // Catalog-sourced names are not user input, but a bare %s here would be one
    // schema change away from being one.
    expect(sql).toMatch(/format\(/)
    expect(sql).not.toMatch(/execute\s+'update public\.'\s*\|\|/)
    expect(sql).not.toMatch(/execute\s+'delete from public\.'\s*\|\|/)
  })

  it('refuses rather than guesses when the catalog grows a shape it cannot handle', () => {
    // A composite FK breaks the single-column re-point; a self-referencing FK
    // would make the passes rewrite contacts rows themselves. Both must stop
    // the merge, not be silently skipped.
    expect(sql).toMatch(/array_length\(con\.conkey, 1\) > 1/)
    expect(sql).toMatch(/composite foreign key/)
    expect(sql).toMatch(/references itself/)
  })
})

describe('migration 533 — the merge semantics the JS had are preserved', () => {
  it('keeps the same-location guard, NULL-safe on both edges', () => {
    expect(sql).toMatch(/is distinct from/)
    expect(sql).toMatch(/contacts must be at the same location/)
  })

  it('keeps the argument guards', () => {
    expect(sql).toMatch(/survivorid and loserid required/)
    expect(sql).toMatch(/cannot merge a contact with itself/)
  })

  it('stamps the survivor AFTER the re-point loop, and deletes the loser after that', () => {
    const repoint = sql.lastIndexOf('get diagnostics v_count = row_count')
    const stamp = sql.indexOf('update public.contacts c')
    const del = sql.indexOf('delete from public.contacts where id = p_loser_id')
    expect(stamp).toBeGreaterThan(-1)
    expect(del).toBeGreaterThan(stamp)
    // The re-point loop's row_count read must precede the stamp.
    expect(sql.indexOf('get diagnostics v_count = row_count')).toBeLessThan(stamp)
    expect(repoint).toBeGreaterThan(-1)
  })

  it('treats a zero-row survivor stamp as a failure', () => {
    expect(sql).toMatch(/if v_count = 0 then/)
    expect(sql).toMatch(/failed to stamp survivor/)
  })

  it('tells the operator the merge was rolled back, not left half-done', () => {
    // The JS said the fold had already happened and a re-run was safe. That was
    // true of an unprotected sequence and is the opposite of true here.
    expect(sql).toMatch(/rolled back/)
  })

  it('returns folded counts keyed "<table>.<column>", zero-count entries omitted', () => {
    expect(sql).toMatch(/v_fk\.tbl \|\| '\.' \|\| v_fk\.col/)
    expect(sql).toMatch(/if v_count > 0 then/)
    expect(sql).toMatch(/jsonb_build_object\('survivor', v_survivor, 'folded', v_folded\)/)
  })

  it('locks both contacts in a deterministic order so concurrent merges queue, not deadlock', () => {
    expect(sql).toMatch(/least\(p_survivor_id, p_loser_id\).*for update/s)
    expect(sql).toMatch(/greatest\(p_survivor_id, p_loser_id\).*for update/s)
  })
})

describe('migration 533 — the stamp payload is whitelisted and matches the JS', () => {
  // pickMergedFields always assigns every key in its FIELDS list, so calling it
  // with two empty objects yields exactly that list.
  const jsFields = Object.keys(pickMergedFields({}, {}))

  it('whitelists exactly the fields pickMergedFields emits (plus created_at)', () => {
    for (const f of jsFields) {
      expect(sql, `${f} must be in the SQL whitelist`).toMatch(new RegExp(`'${f}'`))
      expect(sql, `${f} must be assigned by the stamp`).toMatch(new RegExp(`${f}\\s*=\\s*m\\.${f}`))
    }
    // created_at is conditional in JS (only when the loser's is older) but must
    // still be stampable.
    expect(sql).toMatch(/'created_at'/)
  })

  it('raises on an unknown key rather than dropping it silently', () => {
    // This is what makes adding a field to the JS list without adding it here
    // a loud failure instead of a field that quietly stops merging.
    expect(sql).toMatch(/is not a mergeable contact field/)
  })

  it('never names last_active_at — public.contacts has no such column', () => {
    // It sat in pickMergedFields from commit 36e49302 and PGRST204'd every
    // merge at the stamp, after the destructive steps had already landed.
    expect(jsFields).not.toContain('last_active_at')
    expect(raw.toLowerCase()).not.toMatch(/last_active_at\s*=/)
  })

  it('can never write id or location_id — a merge does not move a contact', () => {
    expect(sql).not.toMatch(/\bid\s*=\s*m\.id\b/)
    expect(sql).not.toMatch(/location_id\s*=\s*m\.location_id/)
  })

  it('seeds the stamp from the survivor’s current row so absent keys are left alone', () => {
    // jsonb_populate_record(base, json) is what makes "omit created_at unless
    // the loser's is older" work — with a NULL base it would null the column.
    expect(sql).toMatch(/jsonb_populate_record\(/)
    expect(sql).toMatch(/select cc from public\.contacts cc where cc\.id = p_survivor_id/)
  })
})
