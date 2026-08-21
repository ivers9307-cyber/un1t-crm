// BAREWRITE.1 — a SOURCE-level guard for the member auto-link probe.
//
// The defect: contact-context.jsx read the member's contacts row with
// `let { data } = await supabase.from('contacts')…maybeSingle()`, discarding
// `error`, and then passed a HARD-CODED `memberState: NO_MEMBER` into
// shouldAttemptLinkContact. So a transient failure — offline, a 5xx, an RLS
// blip — read as "CONFIRMED this user has no contacts row" and fired the
// silent self-link, defeating identity.js's load-bearing tri-state rule that
// ANY unknown leg means no self-link. probeMember() already folds
// error → UNKNOWN correctly (mobile/lib/identity.test.js covers that); the fix
// was to USE it here instead of re-deriving the state.
//
// Why a source scan rather than a behavioural test: this is a React provider
// in the Expo tree, and the repo's vitest suite is pure-lib with no renderer.
// It is also outside `npm run check:guardrails` entirely — that config ignores
// mobile/** — so the new no-unchecked-supabase-write rule cannot protect this
// file. Same precedent as src/public-compliance-paths.test.jsx: assert the
// property that actually matters, at the only level available.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'contact-context.jsx'),
  'utf8',
)

describe('member contact-context identity probe', () => {
  it('resolves the member leg through probeMember, not a raw discarded-error read', () => {
    expect(source).toMatch(/probeMember\(\{/)
  })

  it('never hard-codes a CONFIRMED-empty member leg into the link policy', () => {
    // The exact shape of the defect: an assumed NO_MEMBER handed to the policy.
    expect(source).not.toMatch(/memberState:\s*NO_MEMBER/)
    // …and it must pass a state that came from a probe.
    expect(source).toMatch(/memberState:\s*(probe|reread)\.state/)
  })

  it('treats an UNKNOWN member leg as a reason to do nothing at all', () => {
    // An unreadable leg must neither self-link nor blank an established
    // contact — both are `return` paths guarded on UNKNOWN.
    const unknownGuards = source.match(/\.state === UNKNOWN\)\s*(\{[^}]*)?\s*return/g) || []
    expect(unknownGuards.length).toBeGreaterThanOrEqual(2)
  })
})
