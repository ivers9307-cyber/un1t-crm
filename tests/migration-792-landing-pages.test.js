import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { sqlCode } from './helpers/sql-code.js'
import { STUDIO_OFFER_KEYS, ATTRIBUTION_KEYS, DROPPED_BLOCK_KEYS } from '../src/lib/landing-page-offers.js'
import { UN1T_FUNNEL_COPY_KEYS } from '../src/lib/un1t-online-funnel-copy.js'

const SQL = sqlCode(readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/792_landing_pages.sql'), 'utf8'))

describe('mig 792 landing_pages', () => {
  it('creates both tables closed to clients, RLS on, audited', () => {
    for (const t of ['landing_pages', 'landing_page_studios']) {
      expect(SQL).toMatch(new RegExp(`create table if not exists public\\.${t}\\b`, 'i'))
      expect(SQL).toMatch(new RegExp(`alter table public\\.${t} enable row level security`, 'i'))
      expect(SQL).toMatch(new RegExp(`revoke all on public\\.${t} from anon, authenticated`, 'i'))
      expect(SQL).toMatch(new RegExp(`audit_mutation after insert or update or delete on public\\.${t}`, 'i'))
    }
    expect(SQL).not.toMatch(/create policy/i)
  })
  it('strips exactly the studio half the JS module names, per block type', () => {
    for (const [type, keys] of Object.entries(STUDIO_OFFER_KEYS)) {
      for (const k of [...keys, ...ATTRIBUTION_KEYS, ...(DROPPED_BLOCK_KEYS[type] || [])]) {
        expect(SQL, `${type}.${k}`).toMatch(new RegExp(`'${type}'[\\s\\S]{0,1200}- '${k}'`))
      }
    }
  })
  it('collects the same studio keys into the studio half', () => {
    const fn = SQL.match(/function private\.landing_page_block_studio_half[\s\S]*?\$\$;/i)?.[0] || ''
    expect(fn).not.toBe('')
    for (const [type, keys] of Object.entries(STUDIO_OFFER_KEYS)) {
      for (const k of keys) expect(fn, `${type}.${k}`).toContain(`'${k}'`)
    }
    for (const k of ATTRIBUTION_KEYS) expect(fn, k).toContain(`'${k}'`)
  })
  it('backfills the five campaign slugs and deprecates the old table', () => {
    for (const slug of ['trial', '50plus', 'corp', 'start', 'free-class']) expect(SQL).toMatch(new RegExp(`'${slug}'`))
    expect(SQL).toMatch(/on conflict \(organization_id, slug\) do nothing/i)
    expect(SQL).toMatch(/redirect_to[\s\S]{0,200}'\/trial\?studio=stillorgan'/)
    expect(SQL).toMatch(/comment on table public\.landing_page_settings is 'DEPRECATED \(mig 792\)/i)
  })
  it('creates /50plus and /corp whether or not the source block exists (no IS NOT NULL gate; type defaults)', () => {
    // sqlCode drops comments, so the two sections are cut on their titles.
    const fifty = SQL.slice(SQL.indexOf("'The 50+ Club'"), SQL.indexOf("'Corporate promo'"))
    const corp = SQL.slice(SQL.indexOf("'Corporate promo'"), SQL.indexOf("'Start (retired)'"))
    expect(fifty).not.toBe('')
    expect(corp).not.toBe('')
    expect(fifty).not.toMatch(/cf\.b is not null/i)
    expect(corp).not.toMatch(/cp\.b is not null/i)
    expect(fifty).toMatch(/coalesce\(\s*private\.landing_page_block_page_half\(cf\.b\),\s*'\{"id": "campaign-50plus", "type": "campaign_funnel"\}'::jsonb/i)
    expect(fifty).toMatch(/when cf\.b is null then '\{"class_keywords": "50\+"\}'::jsonb/i)
    expect(corp).toMatch(/coalesce\(\s*private\.landing_page_block_page_half\(cp\.b\),\s*'\{"id": "corp-promo", "type": "corp_promo"\}'::jsonb/i)
    expect(corp).toMatch(/'hatch-3-free'/)
  })
  it('copies every un1t.online terms key off the class_funnel block into the studio page chrome (un1t_terms)', () => {
    const terms = SQL.match(/jsonb_build_object\('un1t_terms',[\s\S]*?\)\)\) END/)?.[0] || ''
    expect(terms).not.toBe('')
    for (const k of UN1T_FUNNEL_COPY_KEYS) {
      expect(terms, k).toContain(`'${k}', NULLIF(cf.b->>'${k}', '')`)
    }
    expect(SQL).toMatch(/landing_page_first_block\(s\.blocks, 'class_funnel'\) AS b\) AS cf/)
  })
  it('adds page_id to the request tables', () => {
    for (const t of ['class_booking_requests', 'trial_purchases', 'corp_promo_claims', 'funnel_events']) {
      expect(SQL).toMatch(new RegExp(`alter table public\\.${t} add column if not exists page_id uuid references public\\.landing_pages\\(id\\) on delete set null`, 'i'))
    }
  })
  it('sets a lock_timeout right after BEGIN and builds no page_id index in the transaction', () => {
    expect(SQL).toMatch(/begin;\s*set local lock_timeout = '5s';/i)
    expect(SQL).not.toMatch(/create index[^;]*\(page_id\)/i)
  })
  it('refuses a studio row outside the page organisation', () => {
    expect(SQL).toMatch(/create trigger landing_page_studios_same_org\s+before insert or update on public\.landing_page_studios/i)
    expect(SQL).toMatch(/revoke execute on function public\.landing_page_studios_same_org\(\) from public, anon, authenticated/i)
  })
})
