// EVENT-MOVE.7 — behavioural test for migration 711.
//
// Boots PGlite with agent_membership_requests reduced to the columns that
// matter and the kind CHECK exactly as mig 369 left it, runs the REAL 711
// file, then proves: 'event_move' is accepted after (and refused before),
// every kind 369 allowed is still accepted, an unknown kind is still
// refused, and the file re-applies cleanly.
//
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_711 = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/711_agent_requests_event_move.sql'), 'utf8')

const KINDS_369 = [
  'pause', 'cancellation', 'class_booking', 'consultation',
  'class_cancellation', 'event_booking', 'event_cancellation', 'membership_purchase',
]

const SCHEMA = `
  CREATE TABLE public.agent_membership_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    details jsonb
  );
  ALTER TABLE public.agent_membership_requests
    ADD CONSTRAINT agent_membership_requests_kind_check
    CHECK (kind = any (array[${KINDS_369.map((k) => `'${k}'::text`).join(', ')}]));
`

let db
beforeEach(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
})
afterEach(async () => { await db.close() })

const insert = (kind) => db.query('INSERT INTO public.agent_membership_requests (kind) VALUES ($1)', [kind])

describe('migration 711 — agent request kind event_move', () => {
  it('event_move is refused before the migration', async () => {
    await expect(insert('event_move')).rejects.toThrow(/agent_membership_requests_kind_check/)
  })

  it('event_move is accepted after it', async () => {
    await db.exec(MIG_711)
    await insert('event_move')
    const { rows } = await db.query("SELECT count(*)::int AS n FROM public.agent_membership_requests WHERE kind = 'event_move'")
    expect(rows[0].n).toBe(1)
  })

  it('every kind mig 369 allowed is still accepted', async () => {
    await db.exec(MIG_711)
    for (const k of KINDS_369) await insert(k)
    const { rows } = await db.query('SELECT count(*)::int AS n FROM public.agent_membership_requests')
    expect(rows[0].n).toBe(KINDS_369.length)
  })

  it('an unknown kind is still refused', async () => {
    await db.exec(MIG_711)
    await expect(insert('event_teleport')).rejects.toThrow(/agent_membership_requests_kind_check/)
  })

  it('re-applies cleanly', async () => {
    await db.exec(MIG_711)
    await db.exec(MIG_711)
    await insert('event_move')
  })
})
