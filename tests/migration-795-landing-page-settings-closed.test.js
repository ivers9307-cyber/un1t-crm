// PAGES.1 (Task 26) — mig 795 re-syncs the deprecated landing_page_settings
// table into the studio pages one last time, fills the all-studios rows that are
// missing, closes the old table to every client role and dates it for drop.
// Text assertions on the file (comments stripped by sqlCode); the replay engines
// behind check:select-columns / check:rpc-names and the ACL guards read it too.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { sqlCode } from './helpers/sql-code.js'

const FILE = path.resolve(import.meta.dirname, '../supabase/migrations/795_landing_page_settings_resync_and_closed.sql')
const SQL = sqlCode(readFileSync(FILE, 'utf8'))
const HELPERS = [
  'private.landing_page_block_page_half',
  'private.landing_page_block_studio_half',
  'private.landing_page_first_block',
  'private.landing_page_studio_blocks',
  'private.landing_page_content_blocks',
  'private.landing_page_backfill_chrome',
]
const esc = (s) => s.replace(/\./g, '\\.')
const stmts = (re) => [...SQL.matchAll(re)].map((m) => m[0])

describe('mig 795 landing_page_settings re-sync, closed and dated', () => {
  it('wraps itself in a transaction with a lock_timeout', () => {
    expect(SQL).toMatch(/begin;\s*set local lock_timeout = '5s';/i)
    expect(SQL).toMatch(/commit;\s*$/i)
  })

  it('revokes every privilege from anon, authenticated and PUBLIC, keeps RLS on, grants nothing', () => {
    expect(SQL).toMatch(/revoke all on public\.landing_page_settings from anon, authenticated, public;/i)
    expect(SQL).not.toMatch(/\bgrant\b/i)
    expect(SQL).not.toMatch(/disable row level security/i)
    expect(SQL).not.toMatch(/create policy/i)
  })

  it('drops the four policies and keeps the touch trigger', () => {
    for (const p of ['landing_page_settings_del', 'landing_page_settings_ins', 'landing_page_settings_upd', 'landing_page_settings_public_read']) {
      expect(SQL, p).toMatch(new RegExp(`drop policy if exists ${p} on public\\.landing_page_settings;`, 'i'))
    }
    expect(SQL).not.toMatch(/drop trigger[^;]*landing_page_settings_touch_updated_at/i)
  })

  it('dates the table for drop', () => {
    expect(SQL).toMatch(
      /comment on table public\.landing_page_settings is 'DEPRECATED \(mig 792\): unread since PR3 \(mig 795, 2026-10-31\); drop in a later migration after 2026-12-01\.';/i,
    )
    expect(SQL).not.toMatch(/drop table[^;]*landing_page_settings/i)
  })

  it('re-syncs only a studio page the legacy editor changed after it, never a retired page, never offer_type/kind/scope/slug/primary_location_id', () => {
    const updates = stmts(/update public\.landing_pages as p\s+set[\s\S]*?;/gi)
    expect(updates.length).toBe(1)
    const u = updates[0]
    expect(u).toMatch(/s\.updated_at > p\.updated_at/i)
    expect(u).toMatch(/p\.kind = 'studio'/i)
    expect(u).toMatch(/p\.primary_location_id = s\.location_id/i)
    expect(u).toMatch(/p\.organization_id = l\.organization_id/i)
    // a retired page keeps its state
    expect(u).toMatch(/publish_state = case when p\.publish_state = 'retired' then 'retired'/i)
    // the page's own offer type picks the block it keeps
    expect(u).toMatch(/private\.landing_page_studio_blocks\(s\.blocks, p\.offer_type\)/i)
    // the chrome is merged over the page's own, its noindex and tone passed through
    expect(u).toMatch(/chrome = [\s\S]*\|\| private\.landing_page_backfill_chrome\([\s\S]*\(p\.chrome->>'noindex'\)::boolean, p\.chrome->>'tone'\)/i)
    // un1t_terms is rebuilt only off a class_funnel block, else left alone
    expect(u).toMatch(/case when cf\.b is null then '\{\}'::jsonb else jsonb_build_object\('un1t_terms'/i)
    const setClause = u.slice(u.search(/\sset\s/i), u.search(/\sfrom\s/i))
    expect(setClause.length).toBeGreaterThan(50)
    // updated_at is the trigger's (now(), the apply time), never assigned here
    expect(setClause).not.toMatch(/\bupdated_at =/i)
    for (const col of ['offer_type', 'kind', 'scope', 'slug', 'primary_location_id', 'organization_id', 'redirect_to']) {
      expect(setClause, col).not.toMatch(new RegExp(`\\b${col} =`, 'i'))
    }
  })

  it('re-syncs the studio row (offer, attribution) before the page row, only when the offer-type block exists, enabled and sort_order untouched', () => {
    const updates = stmts(/update public\.landing_page_studios as ps\s+set[\s\S]*?;/gi)
    expect(updates.length).toBe(1)
    const u = updates[0]
    expect(u).toMatch(/s\.updated_at > p\.updated_at/i)
    expect(u).toMatch(/private\.landing_page_first_block\(s\.blocks, p\.offer_type\) is not null/i)
    expect(u).toMatch(/offer = sh\.h->'offer'/i)
    expect(u).toMatch(/attribution = sh\.h->'attribution'/i)
    const setClause = u.slice(u.search(/\sset\s/i), u.search(/\sfrom\s/i))
    expect(setClause.length).toBeGreaterThan(20)
    expect(setClause).not.toMatch(/\benabled =/i)
    expect(setClause).not.toMatch(/\bsort_order =/i)
    // the page row's updated_at moves (the trigger sets now()) once the page UPDATE runs, so the studio row goes first
    expect(SQL.search(/update public\.landing_page_studios as ps/i)).toBeLessThan(SQL.search(/update public\.landing_pages as p/i))
  })

  it('inserts a studio page for a legacy row with none (ON CONFLICT DO NOTHING, no second studio page for one location)', () => {
    expect(SQL).toMatch(/insert into public\.landing_pages[\s\S]*?on conflict \(organization_id, slug\) do nothing;/i)
    expect(SQL).toMatch(/not exists \(\s*select 1 from public\.landing_pages as p2\s+where p2\.kind = 'studio' and p2\.primary_location_id = s\.location_id/i)
    expect(SQL).toMatch(/insert into public\.landing_page_studios[\s\S]*?on conflict \(page_id, location_id\) do nothing;/i)
  })

  it('fills the missing all-studios rows switched OFF, never overwriting one', () => {
    const at = SQL.search(/p\.scope = 'all'/i)
    expect(at).toBeGreaterThan(0)
    const from = SQL.slice(0, at).toLowerCase().lastIndexOf('insert into public.landing_page_studios')
    const i = SQL.slice(from, SQL.indexOf(';', at) + 1)
    expect([...i.matchAll(/insert into/gi)].length).toBe(1)
    expect(i).toMatch(/\bfalse\b,\s*'\{\}'::jsonb,\s*'\{\}'::jsonb/i)
    expect(i).toMatch(/l\.active/i)
    // a host-event anchor location is not a studio: no row for it
    expect(i).toMatch(/and not coalesce\(l\.is_host_anchor, false\)/i)
    expect(i).toMatch(/l\.organization_id = p\.organization_id/i)
    expect(i).toMatch(/not exists/i)
    expect(i).toMatch(/on conflict \(page_id, location_id\) do nothing;$/i)
    expect(i).not.toMatch(/\btrue\b/i)
  })

  it('creates the six backfill helpers and drops all six again in the same file, with their EXECUTE revoked', () => {
    const created = [...SQL.matchAll(/create or replace function (private\.landing_page_[a-z_]+)\(/gi)].map((m) => m[1].toLowerCase())
    expect(created.sort()).toEqual([...HELPERS].sort())
    for (const fn of HELPERS) {
      expect(SQL, `revoke ${fn}`).toMatch(new RegExp(`revoke execute on function ${esc(fn)}\\([^)]*\\) from public, anon, authenticated;`, 'i'))
      expect(SQL, `drop ${fn}`).toMatch(new RegExp(`drop function if exists ${esc(fn)}\\(`, 'i'))
    }
    // no function the file does not drop: it adds none to public
    expect(SQL).not.toMatch(/create (or replace )?function public\./i)
  })

  it('copies mig 792 section 5 helper bodies verbatim', () => {
    const body = (text, fn) => text.match(new RegExp(`create or replace function ${esc(fn)}\\([\\s\\S]*?\\$\\$;`, 'i'))?.[0]
    const old = sqlCode(readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/792_landing_pages.sql'), 'utf8'))
    for (const fn of HELPERS) {
      const a = body(old, fn)
      expect(a, fn).toBeTruthy()
      expect(body(SQL, fn), fn).toBe(a)
    }
  })
})
