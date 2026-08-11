// EMAILREP.3 — the reputation reset moves into the database (mig 528).
//
// contacts.email_status is reputation for a specific MAILBOX, and every send
// path refuses a 'bounced'/'complained' contact. EMAILREP.1 made the reset fire
// when the ADDRESS changes, but wired it into TWO of the five write paths that
// change contacts.email. The other three are silent:
//
//   3. mergeContacts (src/lib/contact-merge.js) — pickMergedFields copies the
//      loser's email onto a survivor whose own is empty.
//   4. import rollback (POST /api/contacts/imports/[id]/rollback) — replays
//      before_snapshot, which can carry an email and never carries an
//      email_status.
//   5. the agent's fill-when-empty tools — save_lead_details
//      (booking-tools.js) and register_for_event (event-tools.js).
//
// A BEFORE UPDATE OF email trigger covers all five at once and cannot be
// bypassed by a sixth, which is the shape mig 330's derive_wa_phone_trigger and
// the pipeline_stage_slug denormalisation already use for exactly this reason.
//
// A trigger cannot be exercised by vitest, so these tests pin the properties
// that make it correct and keep it from drifting away from the JS rule it
// mirrors. The live behaviour is the migration's own responsibility.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { ADDRESS_BOUND_EMAIL_STATUSES } from './email-reputation.js'

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/528_reset_email_status_on_address_change.sql'),
  'utf8',
)

// The EXECUTABLE trigger body, with `--` comments stripped. The what-it-does
// assertions run against this, not the whole file: the file's prose names the
// consent columns precisely to say it does not touch them, and a naive
// substring search over the comments would read that as a violation.
const BODY = (SQL.match(/AS\s+\$\$([\s\S]*?)\$\$/i)?.[1] || '')
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')

describe('mig 528 — the trigger fires on exactly the right writes', () => {
  it('is a BEFORE UPDATE OF email trigger on contacts', () => {
    // BEFORE, so the reset rides in the same row write and no send path can
    // observe the stale flag in between.
    expect(SQL).toMatch(/BEFORE\s+UPDATE\s+OF\s+email\s+ON\s+(public\.)?contacts/i)
  })

  it('does not fire on INSERT — a new row has no previous address to void', () => {
    expect(SQL).not.toMatch(/BEFORE\s+INSERT/i)
  })

  it('scopes the trigger to the email column so unrelated updates never run it', () => {
    // `UPDATE OF email` is what keeps this off the ~280 other contacts writes
    // in the repo (glofox sync, pipeline reclassify, counters, wa stats).
    expect(SQL).not.toMatch(/BEFORE\s+UPDATE\s+ON/i)
  })
})

describe('mig 528 — it only resets when the ADDRESS actually changed', () => {
  it('compares the two addresses case-insensitively and trimmed', () => {
    // Contacts are stored mixed-case (the .ilike invariant in CLAUDE.md), so
    // re-saving 'Ann@x.com' as 'ann@x.com' is the SAME mailbox and must not
    // clear a genuine bounce. Mirrors normalise() in email-reputation.js.
    expect(BODY).toMatch(/lower\s*\(\s*btrim/i)
  })

  it('compares NULL-safely, so a clear counts as a change and NULL-to-NULL does not', () => {
    expect(BODY).toMatch(/IS\s+DISTINCT\s+FROM/i)
    expect(BODY).toMatch(/coalesce/i)
  })

  it('guards the comparison at all — `UPDATE OF email` alone is not enough', () => {
    // mergeContacts writes { ...pickMergedFields(...) }, which ALWAYS carries
    // an `email` key even when the value is unchanged, so the trigger fires on
    // every merge. Without the value comparison that would clear a genuine
    // bounce on every survivor.
    expect(BODY).toMatch(/OLD\.email/)
    expect(BODY).toMatch(/NEW\.email/)
  })
})

describe('mig 528 — it only ever clears an ADDRESS-BOUND reputation', () => {
  it('names exactly the statuses the JS rule calls address-bound', () => {
    // One rule, two implementations, and this is what stops them drifting: add
    // a status to ADDRESS_BOUND_EMAIL_STATUSES without adding it here and the
    // reset silently covers fewer rows in the DB than in the app.
    for (const status of ADDRESS_BOUND_EMAIL_STATUSES) {
      expect(BODY, `the trigger body never mentions '${status}'`).toContain(`'${status}'`)
    }
  })

  it("writes 'active' and nothing else", () => {
    const assignments = BODY.match(/NEW\.email_status\s*:=\s*'[a-z_]+'/gi) || []
    expect(assignments.length).toBeGreaterThan(0)
    for (const a of assignments) expect(a).toMatch(/'active'/)
  })

  it('never touches consent', () => {
    // Reputation is restored; consent is not. The hard-bounce handler revokes
    // email_marketing at the same moment it stamps 'bounced', and a corrected
    // address still needs a fresh opt-in before any marketing reaches it.
    for (const col of [
      'email_marketing',
      'email_administrative',
      'email_suppressed_at',
      'contact_location_audience',
      'contact_location_preferences',
      'contact_preferences',
      'consent_log',
    ]) {
      expect(BODY, `the trigger body touches ${col}`).not.toContain(col)
    }
  })

  it('writes no column other than email_status', () => {
    const writes = new Set((BODY.match(/NEW\.[a-z_]+\s*:=/gi) || []).map((m) => m.split(/\s*:=/)[0].trim()))
    expect([...writes]).toEqual(['NEW.email_status'])
  })
})

describe('mig 528 — schema hygiene', () => {
  it('pins search_path on the function (advisor function_search_path_mutable)', () => {
    // mig 526 existed only to add this to normalize_ie_wa_phone after the
    // advisor flagged it. Ship it right the first time.
    expect(SQL).toMatch(/SET\s+search_path\s*=\s*public/i)
  })

  it('is re-runnable — forward-only migrations still get replayed on a rebuild', () => {
    expect(SQL).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i)
    expect(SQL).toMatch(/DROP\s+TRIGGER\s+IF\s+EXISTS/i)
  })

  it('backfills nothing', () => {
    // There is no record of which historical rows changed address while
    // carrying a stamp, so any backfill would be a guess that silently
    // un-suppresses genuinely dead mailboxes. mig 524 already restamped from
    // evidence; this one changes the future only.
    expect(SQL).not.toMatch(/^\s*UPDATE\s+(public\.)?contacts/im)
  })
})
