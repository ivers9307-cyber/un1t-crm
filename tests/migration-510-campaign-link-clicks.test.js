// COMMSFIX.F.1 — shape guard for migration 510 (campaign_link_clicks).
//
// Migrations are forward-only and applied by hand against prod, so the only
// review this file ever gets is a human reading it. That is exactly how the
// mig 483/485 class shipped: a policy block that LOOKED right, silently
// folded SELECT away, and nothing in CI had an opinion. `check:rls-restrictive`
// now catches that one specific shape; nothing checks the rest.
//
// These assertions pin the properties that are load-bearing for COMMSFIX.F and
// cheap to get wrong on a rebase or a copy-paste from another migration:
//   • location_id is NOT NULL — check:location-scoping derives the tenant-table
//     set from migrations, and the report route filters on it.
//   • RLS is on, with ONE permissive SELECT policy TO authenticated scoped by
//     private.auth_is_in_location(), and NO restrictive FOR ALL USING(false).
//   • the stats RPC is SECURITY DEFINER with EXECUTE revoked from
//     authenticated/anon (mig 398's rule — an RPC granted to authenticated is
//     an IDOR by uuid, since it does its own location check nowhere).
//   • clicked_links is COMMENTed as deprecated rather than dropped, per the
//     repo's deprecated-column convention (roll back code, not the DB).

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const FILE = path.resolve(
  import.meta.dirname,
  '../supabase/migrations/510_campaign_link_clicks.sql',
)

describe('migration 510 — campaign_link_clicks', () => {
  it('exists', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  // Structural assertions run against the STATEMENTS, not the prose: this file
// discusses the `FOR ALL ... USING (false)` anti-pattern in its header, and a
// naive match cannot tell a warning about a shape from the shape itself.
// `COMMENT ON` is a statement, not a `--` comment, so it survives stripping.
const sql = existsSync(FILE)
  ? readFileSync(FILE, 'utf8').replace(/--[^\n]*/g, '').toLowerCase()
  : ''

  it('creates the table with a NOT NULL location_id (the tenant boundary)', () => {
    expect(sql).toMatch(/create table (public\.)?campaign_link_clicks/)
    expect(sql).toMatch(/location_id\s+uuid\s+not null\s+references locations\(id\)/)
    expect(sql).toMatch(/campaign_id\s+uuid\s+not null\s+references campaigns\(id\) on delete cascade/)
    expect(sql).toMatch(/contact_id\s+uuid\s+references contacts\(id\) on delete set null/)
    expect(sql).toMatch(/url\s+text\s+not null/)
    expect(sql).toMatch(/clicked_at\s+timestamptz\s+not null/)
  })

  it('indexes the report GROUP BY, the unique-clicker count and per-contact history', () => {
    expect(sql).toMatch(/create index \S+ on campaign_link_clicks \(campaign_id, url\)/)
    expect(sql).toMatch(/create index \S+ on campaign_link_clicks \(campaign_id, contact_id\)/)
    expect(sql).toMatch(/create index \S+ on campaign_link_clicks \(contact_id\)/)
  })

  it('enables RLS with exactly one permissive location-scoped SELECT policy', () => {
    expect(sql).toMatch(/alter table campaign_link_clicks enable row level security/)
    const policies = sql.match(/create policy [\s\S]*?;/g) || []
    expect(policies).toHaveLength(1)
    expect(policies[0]).toMatch(/for select\s+to authenticated/)
    expect(policies[0]).toMatch(/private\.auth_is_in_location\(location_id\)/)
  })

  it('never uses the restrictive FOR ALL USING (false) shape (migs 483/485)', () => {
    expect(sql).not.toMatch(/as restrictive/)
    expect(sql).not.toMatch(/using\s*\(\s*false\s*\)/)
  })

  it('adds a SECURITY DEFINER stats RPC that authenticated/anon cannot execute', () => {
    expect(sql).toMatch(
      /create or replace function public\.campaign_link_click_stats\(p_campaign_id uuid\)/,
    )
    expect(sql).toMatch(/returns table\s*\(\s*url text,\s*clicks bigint,\s*unique_clickers bigint\s*\)/)
    expect(sql).toMatch(/security definer/)
    expect(sql).toMatch(/set search_path = public/)
    expect(sql).toMatch(/count\(distinct .*contact_id\)/)
    expect(sql).toMatch(
      /revoke execute on function public\.campaign_link_click_stats\(uuid\)\s*from public, authenticated, anon/,
    )
    expect(sql).toMatch(
      /grant execute on function public\.campaign_link_click_stats\(uuid\)\s*to service_role/,
    )
  })

  it('backfills from the existing clicked_links arrays', () => {
    expect(sql).toMatch(/insert into public\.campaign_link_clicks/)
    expect(sql).toMatch(/jsonb_array_elements\(r\.clicked_links\)/)
    expect(sql).toMatch(/jsonb_typeof\(r\.clicked_links\) = 'array'/)
  })

  it('deprecates clicked_links by COMMENT rather than dropping it', () => {
    expect(sql).toMatch(
      /comment on column campaign_recipients\.clicked_links is\s*'deprecated \(mig 510\)/,
    )
    expect(sql).not.toMatch(/drop column .*clicked_links/)
  })
})
