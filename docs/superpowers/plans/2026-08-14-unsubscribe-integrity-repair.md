# Unsubscribe Integrity Repair — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a customer's unsubscribe click actually stop the mail, make the fact that they did it visible, and repair the 161 people whose opt-out we have already dropped.

**Architecture:** Three independent PRs. PR 1 fixes the consent *write path* (the page that silently does nothing, the missing audit stamp, duplicate contact records). PR 2 fixes a trigger-ordering defect that leaves new ClassPass contacts mailable despite a logged opt-out, and backfills the 11 affected rows. PR 3 is a read-only recovery report over `campaign_link_clicks` + Postmark's suppression list, gated on Richard's review, then applied.

**Tech Stack:** Next.js 16 App Router, Supabase Postgres (service-role routes, no RLS), Postmark broadcast stream, Vitest + @testing-library/react.

---

## Why this exists (findings, 14 Aug 2026)

Verified against prod (`iyvtbjjxdggiadzwwvdj`):

| # | Defect | Evidence | Blast radius |
|---|---|---|---|
| 1 | The footer "Unsubscribe" link **does not unsubscribe**. It's a GET onto a page with a confirm button. Click link → close tab → nothing recorded. | `src/components/UnsubscribePage.jsx` requires `handleUnsubscribe()` | **161 contacts clicked an unsubscribe link and are still mailable. 96 clicked 2+ times. Worst case 6 clicks.** 15 of them are post-11-Aug, so this is live now. |
| 2 | `contact_location_preferences.unsubscribed_at` is never stamped by either consent route — only by `marketing-consent.js:111`. | Eoin Murphy's row: `email_marketing=false`, `unsubscribed_at=NULL` | Every unsubscribe made via the link/header is invisible to any report reading that column. This is why the complaint looked unfounded. |
| 3 | An opt-out on one contact record does not touch that person's duplicate records. | Eoin has 4 records / 2 phones; `murphyp.eoin@` opted out 10 Aug, `eoin02@hotmail.com` (same phone) untouched | Unknown, ≥1 confirmed |
| 4 | ClassPass trigger ordering: `auto_unsubscribe_classpass_trigger` fires **before** `contact_location_preferences_create_trigger` (alphabetical), so the opt-out fans out to a row that does not exist yet; the row is then created with `email_marketing DEFAULT true`. | `pg_trigger` order + 11 rows with `cp.email_marketing=false AND clp.email_marketing=true` | **11 contacts; 5 pass the sender's consent gate today.** Grows with every new ClassPass member. |

**Not a defect (do not "fix"):** David Twomey and Emily Wilson Green show global-false / Hatch-true. That is the intended LEADCAP.1 shape — they signed the Hatch Street waitlist form in July while opted out at Stillorgan. Task 2.3's backfill is deliberately scoped to exclude them.

---

## File Structure

**PR 1 — consent write path**
- Modify: `src/components/UnsubscribePage.jsx` — auto-submit on mount, undo control, manual fallback on failure
- Modify: `src/components/UnsubscribePage.test.jsx` — existing click-driven tests must move to mount-driven
- Create: `src/lib/consent-propagation.js` — find sibling contacts by email/`wa_phone`, apply the same opt-out
- Create: `src/lib/consent-propagation.test.js`
- Modify: `src/app/api/unsubscribe/[token]/route.js` — stamp `unsubscribed_at` on the scoped write, call propagation
- Modify: `src/app/api/preferences/[token]/route.js` — same two changes
- Modify: `src/lib/consent-sources.js` — register `duplicate_propagation`
- Modify: `src/lib/consent-sources.test.js` — the registry test is exhaustive; a new key fails it until listed
- Create: `supabase/migrations/543_sync_prefs_stamp_unsubscribed_at.sql` — trigger stamps the column for every writer

**PR 2 — ClassPass trigger order**
- Create: `supabase/migrations/544_classpass_optout_owns_location_row.sql` — function fix + backfill
- Create: `src/app/api/cron/consent-drift-check/route.js` — daily drift detector
- Create: `src/app/api/cron/consent-drift-check/route.test.js`
- Modify: `vercel.json` — cron entry

**PR 3 — historical recovery**
- Create: `src/lib/unsub-recovery.js` — candidate query + scanner-noise classifier
- Create: `src/lib/unsub-recovery.test.js`
- Create: `scripts/unsub-recovery-report.mjs` — read-only report, writes CSV
- Modify: `src/lib/consent-sources.js` — register `unsub_click_recovery`, `postmark_suppression_reconcile`

---

# PR 1 — Make the unsubscribe link actually unsubscribe

Branch: `unsub-integrity-write-path`

### Task 1.1: Auto-submit the unsubscribe page on arrival

**Decision (override if you disagree):** the auto-submit opts out of **`email_marketing` only** — the channel whose link they clicked — and offers WhatsApp/SMS as extra opt-outs on the confirmation screen. Auto-opting someone out of WhatsApp class reminders because they clicked an email footer is over-reach, and `email_marketing` is already the route's no-body default for the RFC 8058 path.

**Safety property that must hold:** a failed auto-submit falls back to the visible manual button. It must never render "You've been unsubscribed" unless the API returned success. A silent auto-submit that fails is worse than today's behaviour.

**Files:**
- Modify: `src/components/UnsubscribePage.jsx:44-95`
- Test: `src/components/UnsubscribePage.test.jsx`

- [ ] **Step 1: Write the failing tests**

Append to `src/components/UnsubscribePage.test.jsx`:

```jsx
describe('UnsubscribePage — auto-submit on arrival (UNSUBAUTO.1)', () => {
  it('POSTs the opt-out on mount without any click', async () => {
    render(<UnsubscribePage token="tok-1" locationId="loc-1" />)
    await screen.findByText(/You've been unsubscribed/i)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('/api/unsubscribe/tok-1?l=loc-1')
    expect(JSON.parse(opts.body)).toEqual({ channels: ['email_marketing'] })
  })

  it('POSTs exactly once even if the effect is invoked twice (StrictMode)', async () => {
    const { rerender } = render(<UnsubscribePage token="tok-1" locationId={null} />)
    rerender(<UnsubscribePage token="tok-1" locationId={null} />)
    await screen.findByText(/You've been unsubscribed/i)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('falls back to the manual button and does NOT claim success when the POST fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ json: async () => ({ success: false, error: 'Invalid token' }) })
    ))
    render(<UnsubscribePage token="bad" locationId={null} />)
    expect(await screen.findByRole('button', { name: /Unsubscribe from/i })).toBeTruthy()
    expect(screen.queryByText(/You've been unsubscribed/i)).toBeNull()
  })

  it('falls back to the manual button when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    render(<UnsubscribePage token="tok-1" locationId={null} />)
    expect(await screen.findByRole('button', { name: /Unsubscribe from/i })).toBeTruthy()
    expect(screen.queryByText(/You've been unsubscribed/i)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/components/UnsubscribePage.test.jsx
```

Expected: FAIL — the new tests time out waiting for "You've been unsubscribed" because nothing POSTs until the button is clicked.

- [ ] **Step 3: Rework the component**

In `src/components/UnsubscribePage.jsx`, change the import line and the state block:

```jsx
import { useState, useEffect, useRef } from 'react'
```

Replace the `useState` block (currently lines ~45-51) with:

```jsx
  // UNSUBAUTO.1 — the opt-out fires on ARRIVAL, not on a button press.
  //
  // The previous flow was a GET landing on a confirm button. Measured live on
  // 2026-08-14: 161 contacts had clicked an unsubscribe link and were still
  // mailable, 96 of them more than once, one six times across four days. They
  // clicked "Unsubscribe", saw a page, and closed the tab — which is what
  // "unsubscribe" means to everyone who is not an email engineer.
  //
  // Auto-submitting on GET server-side was rejected: Outlook Safe Links and
  // antivirus scanners issue GETs and would opt people out who never clicked.
  // Firing from a useEffect means it only runs in a real browser that executes
  // JS, which no link scanner does.
  //
  // email_marketing ONLY. They clicked a link in an EMAIL; silently ending
  // their WhatsApp class reminders is not what they asked for. The other two
  // channels are offered on the confirmation screen.
  const [selected, setSelected] = useState(
    () => new Set(CHANNEL_OPTIONS.map(c => c.key))
  )
  const [status, setStatus] = useState('working')
  const [errorMsg, setErrorMsg] = useState(null)
  const [unsubChannels, setUnsubChannels] = useState([])
  const [resubStatus, setResubStatus] = useState('idle')
  const autoSubmitted = useRef(false)

  useEffect(() => {
    // React 18/19 StrictMode double-invokes effects in dev. The route is
    // idempotent (a repeat opt-out is a 200 no-op) so a second POST is
    // harmless, but the ref keeps the network log honest.
    if (autoSubmitted.current) return
    autoSubmitted.current = true
    submitOptOut(['email_marketing'], { auto: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
```

Replace `handleUnsubscribe` with the extracted `submitOptOut` plus a thin click handler:

```jsx
  async function submitOptOut(channels, { auto = false } = {}) {
    if (channels.length === 0) {
      setErrorMsg('Pick at least one channel to unsubscribe from.')
      return
    }
    setStatus('working')
    setErrorMsg(null)
    try {
      // COMMSFIX.A.2 (LOCCOMMS.4) — forward the location scope the email
      // link carried (?l=). Unchanged from the click-driven version.
      const scope = locationId ? `?l=${encodeURIComponent(locationId)}` : ''
      const res = await fetch(`/api/unsubscribe/${token}${scope}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels }),
      })
      const data = await res.json()
      if (data.success) {
        setUnsubChannels(prev => [...new Set([...prev, ...(data.unsubscribed_channels || channels)])])
        setStatus('done')
      } else {
        // UNSUBAUTO.1 — a failed AUTO submit must drop the person into the
        // manual flow, never into a success screen. Claiming "you've been
        // unsubscribed" when the write failed is the exact harm this fixes.
        setErrorMsg(data.error || 'Could not process your request.')
        setStatus(auto ? 'idle' : 'error')
      }
    } catch {
      setErrorMsg('Network error — please try again.')
      setStatus(auto ? 'idle' : 'error')
    }
  }

  function handleUnsubscribe() {
    return submitOptOut([...selected])
  }
```

- [ ] **Step 4: Update the two pre-existing tests**

The COMMSFIX.A.2 tests click the button. With auto-submit the POST already happened on mount, so `fetch.mock.calls[0]` is the auto one. Change each to assert on the mount call and drop the `fireEvent.click`. Read each test and rewrite its body to:

```jsx
    render(<UnsubscribePage token="tok-abc" locationId="loc-xyz" />)
    await screen.findByText(/You've been unsubscribed/i)
    expect(fetch.mock.calls[0][0]).toBe('/api/unsubscribe/tok-abc?l=loc-xyz')
```

(and the no-location variant asserting `'/api/unsubscribe/tok-abc'`).

- [ ] **Step 5: Rename the `status === 'loading'` branch**

The JSX still checks `status === 'loading'`. Change that one comparison to `status === 'working'` so the spinner shows during the auto-submit.

- [ ] **Step 6: Run the tests**

```bash
npx vitest run src/components/UnsubscribePage.test.jsx
```

Expected: PASS, all tests.

- [ ] **Step 7: Commit**

```bash
git add src/components/UnsubscribePage.jsx src/components/UnsubscribePage.test.jsx
git commit -m "UNSUBAUTO.1 — unsubscribe page opts out on arrival, not on a button press"
```

---

### Task 1.2: Add the undo control and the extra-channel offer

**Files:**
- Modify: `src/components/UnsubscribePage.jsx` (the `status === 'done'` block)
- Test: `src/components/UnsubscribePage.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
describe('UnsubscribePage — undo (UNSUBAUTO.2)', () => {
  it('offers Resubscribe and PUTs the opt-in when pressed', async () => {
    render(<UnsubscribePage token="tok-1" locationId="loc-1" />)
    await screen.findByText(/You've been unsubscribed/i)
    fireEvent.click(screen.getByRole('button', { name: /Resubscribe/i }))
    await screen.findByText(/You're back on the list/i)
    const put = fetch.mock.calls.find(([, o]) => o?.method === 'PUT')
    expect(put[0]).toBe('/api/preferences/tok-1')
    expect(JSON.parse(put[1].body)).toEqual({ locationId: 'loc-1', email_marketing: true })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run src/components/UnsubscribePage.test.jsx -t "Resubscribe"
```

Expected: FAIL — no button named Resubscribe.

- [ ] **Step 3: Add the handler**

```jsx
  // UNSUBAUTO.2 — because the opt-out now happens without a confirmation,
  // undo has to be one press away on the same screen. PUT /api/preferences
  // is the existing opt-in writer; it runs emailStatusNormaliseForOptIn so a
  // bounced address cannot be resurrected by this click.
  async function handleResubscribe() {
    setResubStatus('working')
    try {
      const res = await fetch(`/api/preferences/${token}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationId, email_marketing: true }),
      })
      const data = await res.json()
      setResubStatus(data.success ? 'done' : 'error')
    } catch {
      setResubStatus('error')
    }
  }
```

- [ ] **Step 4: Add the UI inside the `status === 'done'` block**

Insert before the existing preference-centre `<Link>`:

```jsx
            {resubStatus === 'done' ? (
              <p className="text-sm text-un1t-text mb-3">You're back on the list.</p>
            ) : (
              <button
                type="button"
                onClick={handleResubscribe}
                disabled={resubStatus === 'working'}
                className="text-xs text-un1t-subtle underline hover:text-un1t-text transition-colors mb-3 disabled:opacity-50"
              >
                {resubStatus === 'working' ? 'Working…' : 'Unsubscribed by mistake? Resubscribe'}
              </button>
            )}
            {resubStatus === 'error' && (
              <p className="text-xs text-red-400 mb-3">Could not resubscribe — use the preference centre below.</p>
            )}
```

Note `type="button"`: CLAUDE.md's `no-untyped-button-in-form` rule. There is no `<form>` here, but the convention is repo-wide.

- [ ] **Step 5: Run the tests**

```bash
npx vitest run src/components/UnsubscribePage.test.jsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/UnsubscribePage.jsx src/components/UnsubscribePage.test.jsx
git commit -m "UNSUBAUTO.2 — one-press undo on the unsubscribe confirmation"
```

---

### Task 1.3: Stamp `unsubscribed_at` for every writer

Doing this in the trigger rather than in each route means every current and future writer gets it, including the `auto_classpass` path in PR 2.

**Files:**
- Create: `supabase/migrations/543_sync_prefs_stamp_unsubscribed_at.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 543 — sync_contact_location_preferences() stamps unsubscribed_at.
--
-- THE DEFECT
-- ──────────
-- contact_location_preferences.unsubscribed_at had exactly one writer in the
-- whole codebase: applyFormMarketingConsent (src/lib/marketing-consent.js:111).
-- Neither /api/unsubscribe/[token] nor /api/preferences/[token] ever set it —
-- they write email_marketing=false and updated_at and stop.
--
-- Live proof (2026-08-14): contact 89baf468-7998-4cc7-a26e-017f05dccff1
-- unsubscribed via Postmark one-click on 2026-08-10 23:00:49. consent_log has
-- the row. contact_location_preferences.email_marketing is false. And
-- unsubscribed_at is NULL — so every screen that answers "did this person
-- unsubscribe, and when?" from that column said no. A real customer complaint
-- was investigated as unfounded on the strength of it.
--
-- WHY THE TRIGGER AND NOT THE ROUTES
-- ──────────────────────────────────
-- Three writers reach this table today (the two consent routes via the mig 489
-- fan-out, marketing-consent.js directly, and from mig 544 the ClassPass
-- trigger). Stamping in each is three chances to forget. The sync trigger is
-- already the single choke point every global change flows through.
--
-- SEMANTICS, pinned deliberately
-- ──────────────────────────────
-- One column, three marketing channels — so it needs a rule. It tracks
-- EMAIL: stamped when email_marketing goes true→false, cleared when it goes
-- false→true. That matches its only existing reader (list-health / "when did
-- they leave") and the question it exists to answer. A pre-existing stamp is
-- never overwritten by a later opt-out, so the column means FIRST left, not
-- most recently touched.

create or replace function public.sync_contact_location_preferences()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  own_location uuid;
begin
  select location_id into own_location from contacts where id = new.contact_id;

  if coalesce(new.email_marketing, true) = false then
    update contact_location_preferences
       set email_marketing = false,
           unsubscribed_at = coalesce(unsubscribed_at, now()),
           updated_at = now()
     where contact_id = new.contact_id and email_marketing is distinct from false;
  end if;

  if coalesce(new.sms_marketing, true) = false then
    update contact_location_preferences
       set sms_marketing = false, updated_at = now()
     where contact_id = new.contact_id and sms_marketing is distinct from false;
  end if;

  if coalesce(new.whatsapp_marketing, true) = false then
    update contact_location_preferences
       set whatsapp_marketing = false, updated_at = now()
     where contact_id = new.contact_id and whatsapp_marketing is distinct from false;
  end if;

  if own_location is not null then
    update contact_location_preferences
       set email_marketing    = coalesce(new.email_marketing, true),
           sms_marketing      = coalesce(new.sms_marketing, true),
           whatsapp_marketing = coalesce(new.whatsapp_marketing, true),
           unsubscribed_at    = case
                                  when coalesce(new.email_marketing, true) = false
                                    then coalesce(unsubscribed_at, now())
                                  else null
                                end,
           updated_at         = now()
     where contact_id = new.contact_id
       and location_id = own_location
       and (email_marketing    is distinct from coalesce(new.email_marketing, true)
         or sms_marketing      is distinct from coalesce(new.sms_marketing, true)
         or whatsapp_marketing is distinct from coalesce(new.whatsapp_marketing, true));
  end if;

  return new;
end;
$function$;

comment on function public.sync_contact_location_preferences() is
  'Fans a global contact_preferences marketing change out to contact_location_preferences. mig 543 added the unsubscribed_at stamp: set when email_marketing goes false (coalesced, so it records when they FIRST left), cleared on re-subscribe.';

-- Backfill the rows that already went false with no stamp. updated_at is the
-- best available proxy for when it happened; consent_log carries the exact
-- moment where a row exists, so prefer that when it does.
update contact_location_preferences clp
   set unsubscribed_at = coalesce(
         (select max(l.created_at) from consent_log l
           where l.contact_id = clp.contact_id
             and l.channel = 'email_marketing'
             and l.action = 'opt_out'),
         clp.updated_at)
 where clp.email_marketing = false
   and clp.unsubscribed_at is null;
```

- [ ] **Step 2: Apply it**

Use the Supabase MCP `apply_migration` against project `iyvtbjjxdggiadzwwvdj`. Confirm with `list_projects` first — NOT the sentinel project `tpttqakxmyxrwnqjepfm`.

- [ ] **Step 3: Verify the backfill and the invariant**

```sql
select count(*) filter (where email_marketing = false and unsubscribed_at is null) as unstamped,
       count(*) filter (where email_marketing = true  and unsubscribed_at is not null) as stale_stamp
from contact_location_preferences;
```

Expected: `unstamped = 0`. `stale_stamp` may be non-zero for people who left and rejoined before this migration; that is acceptable residue, and the trigger clears it on their next opt-in.

Then re-check Eoin specifically:

```sql
select unsubscribed_at from contact_location_preferences
where contact_id = '89baf468-7998-4cc7-a26e-017f05dccff1';
```

Expected: `2026-08-10 23:00:49` (from consent_log, not `updated_at`).

- [ ] **Step 4: Run the security advisors**

Run `get_advisors` (type=security) per CLAUDE.md's post-DDL rule. `search_path` is pinned on the function, so expect no new findings.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/543_sync_prefs_stamp_unsubscribed_at.sql
git commit -m "UNSUBSTAMP.1 — sync trigger stamps contact_location_preferences.unsubscribed_at (mig 543)"
```

---

### Task 1.4: Propagate an opt-out across duplicate contact records

**Matching axis:** exact email (case-insensitive) OR exact `wa_phone`. Deliberately **not** `person_group_id` — that group is name-matched and Eoin's binds two different phone numbers, so it may hold two different people. `wa_phone` is the trigger-normalised form; raw `phone` is not (`+353…` / `353…` / `08…` all appear live).

**Files:**
- Create: `src/lib/consent-propagation.js`
- Test: `src/lib/consent-propagation.test.js`
- Modify: `src/lib/consent-sources.js`, `src/lib/consent-sources.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi } from 'vitest'
import { findConsentSiblings } from './consent-propagation.js'

function dbReturning(rows) {
  const q = {
    select: vi.fn(() => q),
    or: vi.fn(() => q),
    neq: vi.fn(() => q),
    limit: vi.fn(() => Promise.resolve({ data: rows, error: null })),
  }
  return { from: vi.fn(() => q), _q: q }
}

describe('findConsentSiblings', () => {
  it('matches on email and wa_phone, excluding the origin contact', async () => {
    const db = dbReturning([{ id: 'sib-1' }, { id: 'sib-2' }])
    const ids = await findConsentSiblings(db, {
      contactId: 'origin', email: 'A_B@x.com', waPhone: '353862111105',
    })
    expect(ids).toEqual(['sib-1', 'sib-2'])
    expect(db._q.neq).toHaveBeenCalledWith('id', 'origin')
    // CLAUDE.md: `_` is a LIKE wildcard AND a legal email character.
    // It must be escaped or a_b@x.com also matches axb@x.com.
    expect(db._q.or.mock.calls[0][0]).toContain('a\\_b@x.com')
  })

  it('returns [] when the contact has neither an email nor a phone', async () => {
    const db = dbReturning([])
    expect(await findConsentSiblings(db, { contactId: 'origin', email: null, waPhone: null })).toEqual([])
    expect(db.from).not.toHaveBeenCalled()
  })

  it('returns [] and does not throw when the query errors', async () => {
    const q = { select: () => q, or: () => q, neq: () => q, limit: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }
    const ids = await findConsentSiblings({ from: () => q }, { contactId: 'o', email: 'a@x.com', waPhone: null })
    expect(ids).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run src/lib/consent-propagation.test.js
```

Expected: FAIL — "Failed to resolve import ./consent-propagation.js".

- [ ] **Step 3: Write the implementation**

Create `src/lib/consent-propagation.js`:

```js
import { escapeLikePattern } from '@/lib/like-escape'

// DUPEUNSUB.1 — an opt-out on one contact record must reach that person's
// other records.
//
// Eoin Murphy (the 2026-08-14 complaint) holds four contact rows. He opted out
// of murphyp.eoin@gmail.com via Postmark one-click on 10 Aug; eoin02@hotmail.com
// carries the SAME phone number and was untouched. Nothing was sent to it in
// the gap, so no harm landed — but only because no campaign ran that week.
//
// MATCHING AXIS, and what is deliberately excluded:
//   • email     — exact, case-insensitive. contacts are stored mixed-case, so
//                 .eq() is wrong; .ilike() with an ESCAPED pattern is the
//                 repo's equality idiom (CLAUDE.md). Unescaped, the `_` in
//                 a_b@x.com is a LIKE wildcard and would also match axb@x.com.
//   • wa_phone  — the derive_wa_phone trigger normalises this. Raw `phone` is
//                 not normalised (+353…, 353…, 08… all live) so it is useless
//                 as a join key.
//   • person_group_id is NOT used. It is name-matched: Eoin's group binds two
//                 different phone numbers, so it may well hold two different
//                 people. Suppressing a stranger because they share a name is
//                 a worse failure than missing a duplicate.
const SIBLING_CAP = 20

export async function findConsentSiblings(db, { contactId, email, waPhone }) {
  const clauses = []
  if (email) clauses.push(`email.ilike.${escapeLikePattern(email.toLowerCase())}`)
  if (waPhone) clauses.push(`wa_phone.eq.${waPhone}`)
  if (clauses.length === 0) return []

  // Not .single()/.maybeSingle(): several rows is the expected answer here.
  const { data, error } = await db
    .from('contacts')
    .select('id')
    .or(clauses.join(','))
    .neq('id', contactId)
    .limit(SIBLING_CAP)

  if (error) {
    console.error('[consent-propagation] sibling lookup failed:', error.message)
    return []
  }
  return (data || []).map(r => r.id)
}

/**
 * Apply `channels: false` to every sibling of `contactId`, at `locationId`
 * when scoped or globally when not, and audit each one.
 *
 * Best-effort by contract: this runs AFTER the origin contact's own opt-out has
 * been written and must never fail it. The person's own request is honoured
 * whatever happens here.
 */
export async function propagateOptOut(db, { contactId, email, waPhone, channels, locationId = null }) {
  const siblings = await findConsentSiblings(db, { contactId, email, waPhone })
  if (siblings.length === 0) return { propagated: 0 }

  // CORRECTED AFTER DRAFTING — the first version of this function wrote
  // contact_location_preferences on BOTH paths. That is the same global-vs-
  // location desync that CLASSPASS-CONSENT.1 exists to fix: on a global opt-out
  // it would leave each sibling's contact_preferences row still saying
  // "subscribed", so the very next writer to touch that row would fan
  // "subscribed" back out over the opt-out.
  //
  // The write target must mirror what the origin route does:
  //   scoped (locationId) -> contact_location_preferences at THAT location only
  //   global  (no scope)  -> contact_preferences, and let the mig 489/543
  //                          trigger fan it out and stamp unsubscribed_at
  const patch = { updated_at: new Date().toISOString() }
  for (const ch of channels) patch[ch] = false

  try {
    let q
    if (locationId) {
      // The trigger does not run on a direct location write, so stamp here.
      if (channels.includes('email_marketing')) patch.unsubscribed_at = new Date().toISOString()
      q = db.from('contact_location_preferences').update(patch)
        .in('contact_id', siblings).eq('location_id', locationId)
    } else {
      q = db.from('contact_preferences').update(patch).in('contact_id', siblings)
    }
    const { error } = await q
    if (error) {
      console.error('[consent-propagation] sibling write failed:', error.message)
      return { propagated: 0 }
    }
    await db.from('consent_log').insert(
      siblings.flatMap(id => channels.map(channel => ({
        contact_id: id,
        channel,
        action: 'opt_out',
        source: 'duplicate_propagation',
        location_id: locationId,
      }))),
    )
    return { propagated: siblings.length }
  } catch (err) {
    // supabase-js builders are thenables with no .catch (CLAUDE.md) — this
    // try/catch is the only way to keep a failure here off the origin path.
    console.error('[consent-propagation] threw:', err?.message || err)
    return { propagated: 0 }
  }
}
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run src/lib/consent-propagation.test.js
```

Expected: PASS.

- [ ] **Step 5: Register the consent source**

In `src/lib/consent-sources.js`, in the POLICY block next to `auto_classpass`:

```js
  // DUPEUNSUB.1 — mirrored from a sibling contact record that shares this
  // person's email or phone. POLICY, not VOLUNTARY: the person made one
  // decision, and counting it once per duplicate record would inflate the
  // NET LIST CHANGE headline by however many duplicates we happen to hold.
  duplicate_propagation:          POLICY,
```

In `src/lib/consent-sources.test.js`, add `['duplicate_propagation', 0, 'policy']` to the table (the registry test is exhaustive and fails on an unlisted key).

- [ ] **Step 6: Wire it into both consent routes**

In `src/app/api/unsubscribe/[token]/route.js`, the `.select()` at line ~151 must also fetch the matching fields:

```js
    .select('*, contacts(id, name, email, location_id, wa_phone)')
```

Then immediately after the `if (logEntries.length)` consent_log insert inside `if (hasChanges) {`:

```js
    // DUPEUNSUB.1 — best-effort, after the person's own opt-out is durable.
    await propagateOptOut(db, {
      contactId: pref.contact_id,
      email: pref.contacts?.email,
      waPhone: pref.contacts?.wa_phone,
      channels: Object.keys(channelPatch),
      locationId: scopeLocationId,
    })
```

with `import { propagateOptOut } from '@/lib/consent-propagation'` at the top.

Apply the same two edits to `src/app/api/preferences/[token]/route.js`: extend its select to `'*, contacts(id, name, email, email_status, wa_phone)'`, and after its `consent_log` insert call `propagateOptOut` with `channels: Object.keys(updates).filter(k => k !== 'updated_at' && updates[k] === false)` and `locationId: body.locationId || null`. Guard it so it only runs when that array is non-empty — an opt-IN must never propagate.

- [ ] **Step 7: Run the full CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails
```

Expected: all nine pass.

- [ ] **Step 8: Run the build**

```bash
npm run build
```

Expected: exit 0. Two new imports were added, and CLAUDE.md is explicit that vitest and eslint do not catch import-resolution failures.

- [ ] **Step 9: Commit and open the PR**

```bash
git add src/lib/consent-propagation.js src/lib/consent-propagation.test.js src/lib/consent-sources.js src/lib/consent-sources.test.js 'src/app/api/unsubscribe/[token]/route.js' 'src/app/api/preferences/[token]/route.js'
git commit -m "DUPEUNSUB.1 — an opt-out reaches the person's duplicate contact records"
git push -u origin HEAD
gh pr create --base main --fill
```

Single-quote the bracketed paths — zsh treats `[token]` as a glob and staging silently empties without them.

---

# PR 2 — ClassPass trigger ordering

Branch: `classpass-optout-location-row` (branch fresh off `origin/main` after PR 1 merges)

### Task 2.1: Make the ClassPass opt-out own its location row

**Files:**
- Create: `supabase/migrations/544_classpass_optout_owns_location_row.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 544 — auto_unsubscribe_classpass() writes the location row itself.
--
-- THE DEFECT (live, 11 contacts, 5 currently mailable)
-- ───────────────────────────────────────────────────
-- Three AFTER INSERT triggers sit on contacts. Postgres fires them in
-- ALPHABETICAL ORDER BY TRIGGER NAME:
--
--   1. auto_unsubscribe_classpass_trigger
--   2. contact_location_preferences_create_trigger
--   3. contact_preferences_trigger
--
-- For a contact INSERTED already at glofox_membership_status='classpass_payg':
--
--   (1) upserts contact_preferences all-false. Its own sync trigger
--       (mig 489/543) then runs `UPDATE contact_location_preferences … WHERE
--       contact_id = …` — which matches ZERO ROWS, because the location row
--       does not exist yet.
--   (2) creates the location row, with email_marketing DEFAULT TRUE.
--
-- Net result: consent_log says opted out of all six channels,
-- contact_preferences says false, and contact_location_preferences —
-- the ONLY column the sender reads (campaign-sender.js:190,
-- `.eq('loc_email_marketing', true)`) — says TRUE.
--
-- Verified live 2026-08-14: 11 contacts, all ClassPass relay addresses created
-- 7–14 Aug, contact_created == prefs_created == subscribed_at == opt_out to the
-- microsecond. Five of them pass the sender's full consent gate right now. The
-- population grows with every new ClassPass member.
--
-- Only INSERT is affected. An existing contact TRANSITIONING into classpass_payg
-- already has a location row, so the sync fan-out lands and the state is
-- correct — which is why the May backfill cohort looks fine and this stayed
-- invisible for months.
--
-- THE FIX
-- ───────
-- Stop depending on another trigger having already run. The function upserts
-- the location row itself, so it is correct whichever order the triggers fire
-- in. Renaming a trigger to force alphabetical order was rejected: it encodes
-- a load-bearing invariant in a name, where the next person to add a trigger
-- cannot see it.
--
-- Everything else in the function is preserved verbatim from mig 512.

create or replace function public.auto_unsubscribe_classpass()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
DECLARE
  channels TEXT[] := ARRAY[
    'email_marketing', 'email_administrative',
    'sms_marketing',   'sms_administrative',
    'whatsapp_marketing', 'whatsapp_administrative'
  ];
BEGIN
  IF NEW.glofox_membership_status IS DISTINCT FROM 'classpass_payg' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.glofox_membership_status IS NOT DISTINCT FROM NEW.glofox_membership_status THEN
    RETURN NEW;
  END IF;

  INSERT INTO contact_preferences (
    contact_id,
    email_marketing, email_administrative,
    sms_marketing,   sms_administrative,
    whatsapp_marketing, whatsapp_administrative
  )
  VALUES (NEW.id, false, false, false, false, false, false)
  ON CONFLICT (contact_id) DO UPDATE SET
    email_marketing         = false,
    email_administrative    = false,
    sms_marketing           = false,
    sms_administrative      = false,
    whatsapp_marketing      = false,
    whatsapp_administrative = false,
    updated_at              = NOW();

  -- mig 544 — own the location row rather than assuming it exists. On INSERT
  -- it does not yet; on UPDATE it does and this is a harmless no-op rewrite.
  IF NEW.location_id IS NOT NULL THEN
    INSERT INTO contact_location_preferences (
      contact_id, location_id, source,
      email_marketing, sms_marketing, whatsapp_marketing,
      unsubscribed_at
    )
    VALUES (NEW.id, NEW.location_id, 'auto_classpass', false, false, false, NOW())
    ON CONFLICT (contact_id, location_id) DO UPDATE SET
      email_marketing    = false,
      sms_marketing      = false,
      whatsapp_marketing = false,
      unsubscribed_at    = COALESCE(contact_location_preferences.unsubscribed_at, NOW()),
      updated_at         = NOW();
  END IF;

  INSERT INTO consent_log (contact_id, channel, action, source)
  SELECT NEW.id, ch, 'opt_out', 'auto_classpass'
  FROM unnest(channels) AS ch;

  RETURN NEW;
END;
$function$;

comment on function public.auto_unsubscribe_classpass() is
  'Opts a contact out of all six channels on transition into classpass_payg, and audits one consent_log row per channel (source=auto_classpass). mig 512 removed the contacts.email_status mirror. mig 544 made the function write contact_location_preferences itself: on INSERT it fires before contact_location_preferences_create_trigger (alphabetical trigger order), so the mig 489 fan-out updated zero rows and the location row was then created DEFAULT true — leaving 11 opted-out contacts mailable.';

-- ── Backfill the 11 ─────────────────────────────────────────────────────────
-- Scoped by the auto_classpass consent_log row, NOT by the raw
-- global-false/location-true shape. That shape is also produced legitimately by
-- LEADCAP.1: David Twomey and Emily Wilson Green are opted out at Stillorgan
-- and opted IN at Hatch Street off a July waitlist form, which is correct and
-- must not be reverted.
update contact_location_preferences clp
   set email_marketing    = false,
       sms_marketing      = false,
       whatsapp_marketing = false,
       unsubscribed_at    = coalesce(clp.unsubscribed_at, now()),
       updated_at         = now()
  from contact_preferences cp
 where cp.contact_id = clp.contact_id
   and cp.email_marketing = false
   and clp.email_marketing = true
   and exists (
     select 1 from consent_log l
      where l.contact_id = clp.contact_id
        and l.source = 'auto_classpass'
        and l.action = 'opt_out'
        and l.channel = 'email_marketing'
   );
```

- [ ] **Step 2: Capture the before-state**

Before applying, record the exact affected ids so the backfill can be audited:

```sql
select clp.contact_id, c.email
from contact_location_preferences clp
join contact_preferences cp on cp.contact_id = clp.contact_id
join contacts c on c.id = clp.contact_id
where cp.email_marketing = false and clp.email_marketing = true;
```

Expected: 13 rows — 11 ClassPass plus the two Hatch waitlist rows.

- [ ] **Step 3: Apply the migration**

Via Supabase MCP `apply_migration` against `iyvtbjjxdggiadzwwvdj`.

- [ ] **Step 4: Verify**

```sql
select count(*) as remaining
from contact_location_preferences clp
join contact_preferences cp on cp.contact_id = clp.contact_id
where cp.email_marketing = false and clp.email_marketing = true;
```

Expected: `remaining = 2` — exactly the two Hatch Street waitlist rows, untouched. Confirm they are David Twomey and Emily Wilson Green and that their `location_id` is `28c78d6b-f7b3-4edf-8c7c-840bd047b3f4`.

- [ ] **Step 5: Confirm the sender gate is now clean**

```sql
select count(*) as still_mailable
from contact_location_audience a
where a.audience_location_id = 'a0000000-0000-0000-0000-000000000001'
  and a.loc_email_marketing = true
  and a.id in (select contact_id from consent_log
               where source = 'auto_classpass' and action = 'opt_out' and channel = 'email_marketing');
```

Expected: `0` (was 5).

- [ ] **Step 6: Run `get_advisors`, then commit**

```bash
git add supabase/migrations/544_classpass_optout_owns_location_row.sql
git commit -m "CLASSPASS-CONSENT.1 — ClassPass opt-out writes its own location row (mig 544)"
```

---

### Task 2.2: Daily drift detector

This class of bug hid for a week and would have hidden indefinitely — the consent tables disagreed and nothing looked. A cheap daily check closes that.

**Files:**
- Create: `src/app/api/cron/consent-drift-check/route.js`
- Test: `src/app/api/cron/consent-drift-check/route.test.js`
- Modify: `vercel.json`, and a `cron_heartbeats` row in migration 544

- [ ] **Step 1: Add the heartbeat row to migration 544**

Append to `supabase/migrations/544_classpass_optout_owns_location_row.sql`:

```sql
insert into cron_heartbeats (name) values ('consent-drift-check')
on conflict (name) do nothing;
```

- [ ] **Step 2: Write the failing test**

```js
import { describe, it, expect, vi } from 'vitest'
import { findConsentDrift } from './route.js'

describe('findConsentDrift', () => {
  it('reports rows where the global row says opted out but the location row is mailable', async () => {
    const rows = [{ contact_id: 'a', location_id: 'loc-1' }]
    const db = { rpc: vi.fn(() => Promise.resolve({ data: rows, error: null })) }
    expect(await findConsentDrift(db)).toEqual(rows)
  })

  it('returns [] and does not throw on a query error', async () => {
    const db = { rpc: vi.fn(() => Promise.resolve({ data: null, error: { message: 'boom' } })) }
    expect(await findConsentDrift(db)).toEqual([])
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

```bash
npx vitest run src/app/api/cron/consent-drift-check/route.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 4: Add the SQL function to migration 544**

```sql
create or replace function public.consent_drift_rows()
returns table (contact_id uuid, location_id uuid, email text)
language sql
security invoker
set search_path to 'pg_catalog', 'public'
as $$
  select clp.contact_id, clp.location_id, c.email
    from contact_location_preferences clp
    join contact_preferences cp on cp.contact_id = clp.contact_id
    join contacts c on c.id = clp.contact_id
   where cp.email_marketing = false
     and clp.email_marketing = true
     -- LEADCAP.1: a location the person explicitly joined outranks the global
     -- flag. Excluded by source, so only accidental drift is reported.
     and clp.source is distinct from 'waitlist_form';
$$;
```

- [ ] **Step 5: Write the route**

```js
import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'

// CLASSPASS-CONSENT.2 — the consent tables can disagree silently, and the one
// the sender reads is not the one an operator looks at. mig 544 fixed the
// trigger-ordering cause; this catches the next cause, whatever it turns out
// to be, within a day instead of within a customer complaint.
export async function findConsentDrift(db) {
  const { data, error } = await db.rpc('consent_drift_rows')
  if (error) {
    console.error('[consent-drift-check] query failed:', error.message)
    return []
  }
  return data || []
}

export async function GET(request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServerClient()
  const drift = await findConsentDrift(db)
  if (drift.length > 0) {
    console.error(`[consent-drift-check] ${drift.length} contact(s) opted out globally but mailable at a location:`,
      drift.map(r => r.email).join(', '))
  }
  await stampHeartbeat('consent-drift-check')
  return NextResponse.json({ success: true, data: { drift: drift.length, contacts: drift } })
}
```

Verified: `src/lib/cron-heartbeat.js` exports `stampHeartbeat(name, outcome)`, so the import above is correct as written.

- [ ] **Step 6: Add the vercel.json entry**

```json
{ "path": "/api/cron/consent-drift-check", "schedule": "0 6 * * *" }
```

- [ ] **Step 7: Run the tests and the guard scripts**

```bash
npx vitest run src/app/api/cron/consent-drift-check/route.test.js && npm run check:route-guards
```

Expected: PASS. `check:route-guards` must see the `CRON_SECRET` Bearer check and be satisfied.

- [ ] **Step 8: Commit and open the PR**

```bash
git add src/app/api/cron/consent-drift-check vercel.json supabase/migrations/544_classpass_optout_owns_location_row.sql
git commit -m "CLASSPASS-CONSENT.2 — daily consent drift detector"
git push -u origin HEAD
gh pr create --base main --fill
```

---

# PR 3 — Recover the 161

Branch: `unsub-click-recovery` (fresh off `origin/main`)

**Do not skip the review gate.** Some of the 378 recorded unsubscribe-link clicks are machine noise: six different contacts registered clicks between 18:45 and 18:51 on 17 May 2026, which is a mailbox security scanner re-walking old mail, not six people deciding at once. Contacts whose clicks are spread across months (Erica Duffy May→Aug, Ken Dixon Jun→Aug, Kerry Dwyer Jun→Aug) are the unambiguous humans.

### Task 3.1: Candidate query with a scanner-noise classifier

**Files:**
- Create: `src/lib/unsub-recovery.js`
- Test: `src/lib/unsub-recovery.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import { classifyClickEvidence } from './unsub-recovery.js'

const at = (s) => new Date(s).toISOString()

describe('classifyClickEvidence', () => {
  it('flags a lone click inside a multi-contact burst as scanner noise', () => {
    // Key shape is burstBucketKey's output: ISO to the hour + zero-padded
    // 2-minute bucket. 18:46 floors to 18:46. Six distinct contacts in it.
    const burst = { '2026-05-17T18:46': 6 }
    const r = classifyClickEvidence({
      clicks: [{ clicked_at: at('2026-05-17T18:46:00Z') }],
      burstIndex: burst,
    })
    expect(r.verdict).toBe('scanner')
  })

  it('treats clicks spread over more than a day as human intent', () => {
    const r = classifyClickEvidence({
      clicks: [{ clicked_at: at('2026-06-08T19:52:00Z') }, { clicked_at: at('2026-08-08T21:45:00Z') }],
      burstIndex: {},
    })
    expect(r.verdict).toBe('human')
    expect(r.spanDays).toBeGreaterThan(60)
  })

  it('treats a single isolated click as human — one click is a request', () => {
    const r = classifyClickEvidence({
      clicks: [{ clicked_at: at('2026-07-02T11:00:00Z') }],
      burstIndex: {},
    })
    expect(r.verdict).toBe('human')
  })

  it('is human when repeat clicks are hours apart even on one day', () => {
    const r = classifyClickEvidence({
      clicks: [{ clicked_at: at('2026-07-02T09:00:00Z') }, { clicked_at: at('2026-07-02T20:00:00Z') }],
      burstIndex: {},
    })
    expect(r.verdict).toBe('human')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run src/lib/unsub-recovery.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// UNSUBRECOVER.1 — reconstruct the opt-outs the old rate limiters dropped.
//
// Until 2026-08-11 both consent routes carried flat per-IP limiters spent
// BEFORE the token was read (unsubscribe 10/15min, preferences 20/15min shared
// between GET and PUT). Gmail POSTs one-click unsubscribes from a shared proxy
// pool, so recipients of one campaign share a source IP and the overflow got a
// 429 with NOTHING written anywhere. Separately, the footer link only opened a
// confirm page, so anyone who clicked and closed the tab left no record either.
//
// Neither leaves a consent_log row — by construction. The one durable trace is
// Postmark's click tracking on the unsubscribe URL itself, in
// campaign_link_clicks (mig 510).
//
// THE NOISE PROBLEM: Postmark records a click whether a human or a link
// scanner issued the GET. Live signature of a scanner sweep — six distinct
// contacts clicking between 18:45 and 18:51 on 2026-05-17, days after their
// own first clicks. A per-minute burst index across CONTACTS separates that
// from intent: humans do not synchronise.

const BURST_BUCKET_MINUTES = 2
const BURST_CONTACT_THRESHOLD = 3

export function burstBucketKey(iso) {
  const d = new Date(iso)
  const mins = Math.floor(d.getUTCMinutes() / BURST_BUCKET_MINUTES) * BURST_BUCKET_MINUTES
  return `${d.toISOString().slice(0, 14)}${String(mins).padStart(2, '0')}`
}

/** Build { bucketKey: distinctContactCount } across ALL click rows. */
export function buildBurstIndex(rows) {
  const buckets = new Map()
  for (const r of rows) {
    const k = burstBucketKey(r.clicked_at)
    if (!buckets.has(k)) buckets.set(k, new Set())
    buckets.get(k).add(r.contact_id)
  }
  return Object.fromEntries([...buckets].map(([k, set]) => [k, set.size]))
}

export function classifyClickEvidence({ clicks, burstIndex }) {
  const times = clicks.map(c => new Date(c.clicked_at).getTime()).sort((a, b) => a - b)
  const spanDays = times.length > 1 ? (times[times.length - 1] - times[0]) / 86_400_000 : 0

  const humanClicks = clicks.filter(c => (burstIndex[burstBucketKey(c.clicked_at)] || 1) < BURST_CONTACT_THRESHOLD)

  // Every click sat inside a multi-contact burst — a machine walked the mail.
  if (humanClicks.length === 0) {
    return { verdict: 'scanner', clickCount: clicks.length, humanClickCount: 0, spanDays }
  }
  return { verdict: 'human', clickCount: clicks.length, humanClickCount: humanClicks.length, spanDays }
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/lib/unsub-recovery.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/unsub-recovery.js src/lib/unsub-recovery.test.js
git commit -m "UNSUBRECOVER.1 — click-evidence classifier for dropped opt-outs"
```

---

### Task 3.2: Produce the review report (read-only)

**Files:**
- Create: `scripts/unsub-recovery-report.mjs`

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
// UNSUBRECOVER.2 — READ ONLY. Writes a CSV for human review. Writes nothing
// to the database. Task 3.3 applies the reviewed list.
//
//   node scripts/unsub-recovery-report.mjs > unsub-recovery-2026-08-14.csv

import { createClient } from '@supabase/supabase-js'
import { buildBurstIndex, classifyClickEvidence } from '../src/lib/unsub-recovery.js'

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// The 1,000-row cap applies to every select (CLAUDE.md) — paginate explicitly.
async function loadAll(table, select, filter) {
  const out = []
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(select).order('id', { ascending: true }).range(from, from + 999)
    if (filter) q = filter(q)
    const { data, error } = await q
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...data)
    if (data.length < 1000) return out
  }
}

const clicks = await loadAll('campaign_link_clicks', 'id, contact_id, clicked_at, url',
  q => q.ilike('url', '%/unsubscribe/%'))
const burstIndex = buildBurstIndex(clicks)

const byContact = new Map()
for (const c of clicks) {
  if (!byContact.has(c.contact_id)) byContact.set(c.contact_id, [])
  byContact.get(c.contact_id).push(c)
}

const { data: mailable } = await db
  .from('contact_location_audience')
  .select('id, name, email, audience_location_id')
  .eq('loc_email_marketing', true)
  .in('id', [...byContact.keys()])

console.log('contact_id,email,name,verdict,click_count,human_clicks,span_days,first_click,last_click')
for (const m of mailable || []) {
  const rows = byContact.get(m.id)
  const v = classifyClickEvidence({ clicks: rows, burstIndex })
  const times = rows.map(r => r.clicked_at).sort()
  console.log([m.id, m.email, JSON.stringify(m.name), v.verdict, v.clickCount,
    v.humanClickCount, v.spanDays.toFixed(1), times[0], times[times.length - 1]].join(','))
}
```

- [ ] **Step 2: Run it**

```bash
node scripts/unsub-recovery-report.mjs > unsub-recovery-2026-08-14.csv
```

Expected: ~161 data rows. Confirm the total matches the live count before trusting the file:

```sql
with clicks as (select contact_id from campaign_link_clicks where url ilike '%/unsubscribe/%' group by contact_id)
select count(*) from clicks c join contact_location_audience a on a.id = c.contact_id
where a.loc_email_marketing = true;
```

- [ ] **Step 3: Hand the CSV to Richard**

Report the split: how many `human` vs `scanner`, and the distribution of `span_days`. **Stop here.** Do not apply anything until Richard has approved the list.

- [ ] **Step 4: Commit**

```bash
git add scripts/unsub-recovery-report.mjs
git commit -m "UNSUBRECOVER.2 — read-only recovery report for dropped opt-outs"
```

---

### Task 3.3: Apply the approved list

**Files:**
- Modify: `src/lib/consent-sources.js`, `src/lib/consent-sources.test.js`
- Create: `supabase/migrations/545_unsub_click_recovery.sql` (generated from the approved CSV)

- [ ] **Step 1: Register the sources**

In the BULK block of `src/lib/consent-sources.js`:

```js
  // UNSUBRECOVER.1 — reconstructed from campaign_link_clicks evidence that the
  // person clicked an unsubscribe link during the window when the per-IP
  // limiters were dropping opt-outs with nothing written (to 2026-08-11).
  unsub_click_recovery:           BULK,
  // UNSUBRECOVER.3 — Postmark's broadcast suppression list said suppressed
  // while our own tables said mailable.
  postmark_suppression_reconcile: BULK,
```

Add both to the `consent-sources.test.js` table with the counts the migration actually writes.

- [ ] **Step 2: Generate the migration from the approved rows**

Write `supabase/migrations/545_unsub_click_recovery.sql` with the approved contact ids inlined (no dynamic lookup — the list is a reviewed artefact and must not drift between review and apply):

```sql
-- 545 — honour the opt-outs dropped before mig 522 / PR #1353.
--
-- Source list: unsub-recovery-2026-08-14.csv, verdict='human', reviewed and
-- approved by Richard on <DATE>. <N> contacts.
--
-- Each of these clicked an unsubscribe link in a marketing email and is still
-- on the list. The evidence is campaign_link_clicks (mig 510) — the only trace
-- the dropped opt-outs left, because both the 429 path and the
-- clicked-the-link-then-closed-the-tab path wrote nothing.
--
-- Direction of error: we are opting people OUT on click evidence alone. A
-- false positive costs one marketing email that a person who wanted it stops
-- receiving, and they can resubscribe from any later transactional mail or the
-- preference centre. A false negative is continuing to mail somebody who has
-- asked us to stop, up to six times. Not symmetric.

with recovered(contact_id) as (values
  ('<uuid>'::uuid)
  -- … one row per approved contact
)
update contact_location_preferences clp
   set email_marketing = false,
       unsubscribed_at = coalesce(clp.unsubscribed_at, now()),
       updated_at = now()
  from recovered r
 where clp.contact_id = r.contact_id
   and clp.email_marketing = true;

insert into consent_log (contact_id, channel, action, source)
select contact_id, 'email_marketing', 'opt_out', 'unsub_click_recovery'
from (values ('<uuid>'::uuid)) as t(contact_id);
```

- [ ] **Step 3: Apply and verify**

```sql
with clicks as (select contact_id from campaign_link_clicks where url ilike '%/unsubscribe/%' group by contact_id)
select count(*) as still_mailable
from clicks c join contact_location_audience a on a.id = c.contact_id
where a.loc_email_marketing = true;
```

Expected: down from 161 to only the `scanner`-verdict contacts.

- [ ] **Step 4: Commit and open the PR**

```bash
git add supabase/migrations/545_unsub_click_recovery.sql src/lib/consent-sources.js src/lib/consent-sources.test.js
git commit -m "UNSUBRECOVER.3 — honour the opt-outs dropped before mig 522 (mig 545)"
git push -u origin HEAD
gh pr create --base main --fill
```

---

### Task 3.4: Postmark suppression reconciliation

Postmark's own list is the second, independent source. Note its limit up front: **it only catches people whose click reached Postmark**, and Postmark then stopped mailing them anyway — so this closes a data-integrity gap and un-inflates audience counts rather than stopping live mail. The people it cannot recover are exactly the footer-link tab-closers, which is why Task 1.1 is the load-bearing fix.

**Files:**
- Modify: `scripts/unsub-recovery-report.mjs`

- [ ] **Step 1: Add the fetch**

```js
// GET /message-streams/{stream}/suppressions/dump
//   headers: Accept: application/json, X-Postmark-Server-Token: <token>
//   → { Suppressions: [{ EmailAddress, SuppressionReason, Origin, CreatedAt }] }
//
// SuppressionReason: HardBounce | SpamComplaint | ManualSuppression
// Origin:            Recipient  | Customer      | Admin
//
// We want ManualSuppression + Recipient: the person unsubscribed themselves.
// HardBounce/SpamComplaint are deliverability and already handled by the
// Postmark webhook; Customer/Admin are our own suppressions.
const res = await fetch('https://api.postmarkapp.com/message-streams/broadcast/suppressions/dump', {
  headers: {
    Accept: 'application/json',
    'X-Postmark-Server-Token': process.env.POSTMARK_SERVER_TOKEN,
  },
})
const { Suppressions = [] } = await res.json()
const selfUnsubscribed = Suppressions
  .filter(s => s.SuppressionReason === 'ManualSuppression' && s.Origin === 'Recipient')
  .map(s => s.EmailAddress.toLowerCase())
```

- [ ] **Step 2: Diff against mailable contacts and append to the CSV**

Emit rows with `verdict = 'postmark_suppressed'` for any mailable contact whose lowercased email appears in `selfUnsubscribed`.

- [ ] **Step 3: Run and report**

```bash
node scripts/unsub-recovery-report.mjs > unsub-recovery-2026-08-14.csv
```

Report the count to Richard, then fold approved rows into migration 545 under source `postmark_suppression_reconcile`.

- [ ] **Step 4: Commit**

```bash
git add scripts/unsub-recovery-report.mjs
git commit -m "UNSUBRECOVER.4 — reconcile against Postmark broadcast suppressions"
```

---

## Decisions taken, flag if you disagree

1. **Auto-submit opts out of `email_marketing` only**, not all three channels. They clicked a link in an email. WhatsApp and SMS are offered on the confirmation screen.
2. **Duplicate matching is email + `wa_phone`, never `person_group_id`.** That group is name-matched and currently binds two different phone numbers under "Eoin Murphy".
3. **The ClassPass fix makes the function own its location row** rather than renaming a trigger to force alphabetical order. A load-bearing invariant should not live in a name.
4. **`unsubscribed_at` records when they FIRST left** (coalesced, never overwritten), and tracks the email channel.
5. **Recovery errs toward opting out.** A false positive costs one email; a false negative is mailing someone who asked six times to stop.
6. **The two Hatch Street waitlist rows are left alone** — correct LEADCAP.1 behaviour, not drift.

## Not in scope

- Whether `eoinmurphy68@gmail.com` and `murphyp.eoin@gmail.com` are the same human. Different phones, different Glofox ids. Needs Richard's knowledge of the customer, not a query. Both are opted out either way.
- Anything Glofox sends directly. Our unsubscribe does not reach it. If Eoin reports still receiving after this ships, that is the next place to look.
- The dark-ramp Tailwind classes on `UnsubscribePage.jsx` (`text-amber-200`, `text-red-400`, `text-green-400`) against CLAUDE.md's chip-contrast rule. Pre-existing, unrelated, and the page is not in the armed lint path.
