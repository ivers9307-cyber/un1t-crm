// MAIL-REFINE.1 §03 — related conversations + merge, the mobile lib half.
//
// Everything the nudge banner and the merge sheet decide lives in
// mail-relate.js where vitest reaches it; the screen reads verdicts. The
// server contract these tests build against (pinned in CONTRACTS-REFINE.md):
//
//   GET /api/email/mail/[id]/related →
//     { related: [{ id, subject, status, message_count, last_message_at,
//       requester_name }], open_count }   — newest first, self excluded.
//
// THE ONE RULE THAT MUST NOT BEND: an unknown count never renders as 0. A
// missing/garbage open_count means "we do not know", and the nudge shows
// NOTHING rather than quietly claiming there are no related conversations.

import { describe, it, expect, vi } from 'vitest'
import {
  relatedNudge,
  mergePickerRows,
  mergeButtonLabel,
  toggleId,
  runMerges,
  mergeUndoNotice,
} from './mail-relate'

const REL = (over = {}) => ({
  id: 'R-1',
  subject: 'RE: Meter reading — urgent',
  status: 'open',
  message_count: 2,
  last_message_at: '2026-08-28T10:00:00Z',
  requester_name: 'Caitlin Thornton',
  ...over,
})

describe('relatedNudge', () => {
  it('is null when there is nothing open — no banner, no claim', () => {
    expect(relatedNudge({ related: [], open_count: 0 })).toBeNull()
    expect(relatedNudge(null)).toBeNull()
    expect(relatedNudge(undefined)).toBeNull()
  })

  it('treats an unknown count as "say nothing", never as zero AND never as a banner', () => {
    // open_count missing or garbage: the endpoint contract always carries it,
    // so its absence means the answer is malformed — show nothing.
    expect(relatedNudge({ related: [REL()] })).toBeNull()
    expect(relatedNudge({ related: [REL()], open_count: null })).toBeNull()
    expect(relatedNudge({ related: [REL()], open_count: 'lots' })).toBeNull()
  })

  it('names the sender and counts, singular', () => {
    const n = relatedNudge({ related: [REL()], open_count: 1 })
    expect(n.text).toBe('Caitlin Thornton has 1 other open conversation')
    expect(n.count).toBe(1)
  })

  it('pluralises', () => {
    const n = relatedNudge({ related: [REL(), REL({ id: 'R-2' })], open_count: 2 })
    expect(n.text).toBe('Caitlin Thornton has 2 other open conversations')
  })

  it('falls back to a neutral name when the requester has none', () => {
    const n = relatedNudge({ related: [REL({ requester_name: null })], open_count: 1 })
    expect(n.text).toBe('This sender has 1 other open conversation')
  })

  it('View targets the NEWEST OPEN related thread (list is newest first; archived rows skipped)', () => {
    const n = relatedNudge({
      related: [
        REL({ id: 'R-arch', status: 'closed' }),
        REL({ id: 'R-open-newer' }),
        REL({ id: 'R-open-older' }),
      ],
      open_count: 2,
    })
    expect(n.viewId).toBe('R-open-newer')
  })

  it('legacy solved rows count as archived for the View target', () => {
    const n = relatedNudge({
      related: [REL({ id: 'R-solved', status: 'solved' }), REL({ id: 'R-live' })],
      open_count: 1,
    })
    expect(n.viewId).toBe('R-live')
  })

  it('viewId is null when the capped list holds no open row — banner may show, View may not', () => {
    const n = relatedNudge({ related: [REL({ status: 'closed' })], open_count: 1 })
    expect(n).not.toBeNull()
    expect(n.viewId).toBeNull()
  })
})

describe('mergePickerRows', () => {
  const now = new Date('2026-08-31T12:00:00Z')

  it('lists ALL related — open and archived both — per the contract', () => {
    const rows = mergePickerRows([REL(), REL({ id: 'R-2', status: 'closed' })], now)
    expect(rows.map(r => r.id)).toEqual(['R-1', 'R-2'])
    expect(rows[0].archived).toBe(false)
    expect(rows[1].archived).toBe(true)
  })

  it('builds the detail line: who · how many messages · state + when', () => {
    const rows = mergePickerRows([REL()], now)
    expect(rows[0].detail).toContain('Caitlin Thornton')
    expect(rows[0].detail).toContain('2 messages')
    expect(rows[0].detail).toContain('active')
  })

  it('says archived for archived rows, and singularises one message', () => {
    const rows = mergePickerRows([REL({ status: 'solved', message_count: 1 })], now)
    expect(rows[0].detail).toContain('1 message')
    expect(rows[0].detail).not.toContain('1 messages')
    expect(rows[0].detail).toContain('archived')
  })

  it('never renders a null subject — "(no subject)" stands in', () => {
    const rows = mergePickerRows([REL({ subject: null })], now)
    expect(rows[0].subject).toBe('(no subject)')
  })

  it('drops rows with no id (cannot be merged or keyed) and tolerates garbage', () => {
    expect(mergePickerRows([{ subject: 'x' }, null], now)).toEqual([])
    expect(mergePickerRows(null, now)).toEqual([])
    expect(mergePickerRows(undefined, now)).toEqual([])
  })

  it('omits the message count when the server sent none rather than claiming 0', () => {
    const rows = mergePickerRows([REL({ message_count: undefined })], now)
    expect(rows[0].detail).not.toContain('0 message')
    expect(rows[0].detail).not.toContain('undefined')
  })
})

describe('mergeButtonLabel', () => {
  it('is disabled with nothing selected', () => {
    expect(mergeButtonLabel(0)).toEqual({ label: 'Merge', disabled: true })
  })

  it('names the count, singular and plural — the mockup wording', () => {
    expect(mergeButtonLabel(1)).toEqual({ label: 'Merge 1 conversation', disabled: false })
    expect(mergeButtonLabel(3)).toEqual({ label: 'Merge 3 conversations', disabled: false })
  })

  it('treats garbage as nothing selected', () => {
    expect(mergeButtonLabel(NaN).disabled).toBe(true)
    expect(mergeButtonLabel(undefined).disabled).toBe(true)
  })
})

describe('toggleId', () => {
  it('adds when absent, removes when present, never mutates the input', () => {
    const start = new Set(['a'])
    const added = toggleId(start, 'b')
    expect([...added].sort()).toEqual(['a', 'b'])
    const removed = toggleId(added, 'a')
    expect([...removed]).toEqual(['b'])
    expect([...start]).toEqual(['a']) // untouched
  })
})

describe('runMerges', () => {
  it('merges sequentially, in order, and reports every id merged', async () => {
    const calls = []
    const mergeFn = vi.fn(async (id) => { calls.push(id); return { success: true } })
    const out = await runMerges(['a', 'b', 'c'], mergeFn)
    expect(calls).toEqual(['a', 'b', 'c'])
    expect(out).toEqual({ merged: ['a', 'b', 'c'], failed: null })
  })

  it('STOPS on the first failure and surfaces it — a failed merge must never look merged', async () => {
    const mergeFn = vi.fn(async (id) => (
      id === 'b' ? { success: false, error: 'nope' } : { success: true }
    ))
    const out = await runMerges(['a', 'b', 'c'], mergeFn)
    expect(out.merged).toEqual(['a'])
    expect(out.failed).toEqual({ id: 'b', error: 'nope' })
    // c was never attempted — stop means stop.
    expect(mergeFn).toHaveBeenCalledTimes(2)
  })

  it('a thrown mergeFn is a failure too, with its message', async () => {
    const mergeFn = vi.fn(async () => { throw new Error('network died') })
    const out = await runMerges(['a'], mergeFn)
    expect(out.merged).toEqual([])
    expect(out.failed.id).toBe('a')
    expect(out.failed.error).toContain('network died')
  })

  it('a failure with no error string still gets a sentence', async () => {
    const mergeFn = vi.fn(async () => ({ success: false }))
    const out = await runMerges(['a'], mergeFn)
    expect(out.failed.error).toBeTruthy()
  })

  it('an envelope with no success flag at all is a FAILURE — only success:true is a merge', async () => {
    const mergeFn = vi.fn(async () => ({}))
    const out = await runMerges(['a', 'b'], mergeFn)
    expect(out.merged).toEqual([])
    expect(out.failed?.id).toBe('a')
  })

  it('does nothing with an empty or garbage list', async () => {
    const mergeFn = vi.fn()
    expect(await runMerges([], mergeFn)).toEqual({ merged: [], failed: null })
    expect(await runMerges(null, mergeFn)).toEqual({ merged: [], failed: null })
    expect(mergeFn).not.toHaveBeenCalled()
  })

  it('runs strictly one at a time — the second merge starts only after the first resolved', async () => {
    let firstResolved = false
    let secondSawFirstDone = null
    const mergeFn = async (id) => {
      if (id === 'a') {
        await new Promise(r => setTimeout(r, 10))
        firstResolved = true
        return { success: true }
      }
      secondSawFirstDone = firstResolved
      return { success: true }
    }
    await runMerges(['a', 'b'], mergeFn)
    expect(secondSawFirstDone).toBe(true)
  })
})

describe('mergeUndoNotice', () => {
  it('counts what was merged, singular and plural', () => {
    expect(mergeUndoNotice(1).message).toBe('1 conversation was merged into this one.')
    expect(mergeUndoNotice(2).message).toBe('2 conversations were merged into this one.')
    expect(mergeUndoNotice(1).title).toBe('Merged')
  })
})
