import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const sql = readFileSync('supabase/migrations/827_black_friday_offers.sql', 'utf8');

describe('mig 827 black friday offers', () => {
  it('makes the slug unique per studio', () => {
    expect(sql).toContain('UNIQUE (location_id, slug)');
    expect(sql).toContain('sale_offers_slug_key');
  });
  it('lets an un1t.online purchase carry no Revolut order', () => {
    expect(sql).toMatch(/revolut_order_id\s+DROP NOT NULL/);
  });
  it('keeps every write-event origin and admits web_offer', () => {
    for (const k of ['staff', 'funnel', 'approval', 'mia', 'test_account', 'web_trial', 'fee_run', 'corp_promo', 'web_offer']) {
      expect(sql).toContain(`'${k}'`);
    }
  });
  it('makes a un1t transaction unique per studio', () => {
    expect(sql).toMatch(/UNIQUE \(location_id, un1t_transaction_id\)/);
  });
  it('grants nothing to anon', () => {
    expect(sql).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\banon\b/i);
  });
});
