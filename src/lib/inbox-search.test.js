import { describe, it, expect } from 'vitest';
import { matchesSearch } from '@/lib/inbox-search';

describe('matchesSearch', () => {
  it('matches case-insensitively on the haystack', () => {
    expect(matchesSearch('Aoife Nolan pause my membership', 'aoife')).toBe(true);
    expect(matchesSearch('Aoife Nolan', 'NOLAN')).toBe(true);
    expect(matchesSearch('Aoife Nolan pause my membership', 'membership')).toBe(true);
  });
  it('empty/whitespace query matches everything', () => {
    expect(matchesSearch('anything', '')).toBe(true);
    expect(matchesSearch('anything', '   ')).toBe(true);
  });
  it('no match returns false', () => {
    expect(matchesSearch('Aoife Nolan', 'zzz')).toBe(false);
  });
  it('handles null/undefined haystack', () => {
    expect(matchesSearch(null, 'x')).toBe(false);
    expect(matchesSearch(undefined, '')).toBe(true);
  });
});
