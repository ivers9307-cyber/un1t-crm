// UN1TWRITE.8 fix 1 — the phone's ThreadApprovalCard cannot be rendered in the
// node suite (React Native), so pin the one line that matters from source: a
// decline hands the composer a draft only when there is one. buildDeclineDraft
// returns '' for a refund_request (Mia already answered), and an empty string
// must never reach onPrefillComposer and overwrite what staff are typing.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildDeclineDraft } from 'shared/approvals-next-steps'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

describe('decline prefill is guarded on an empty draft', () => {
  it('the shared draft for a refund_request is empty', () => {
    expect(buildDeclineDraft('refund_request', 'other', { firstName: 'Aoife' })).toBe('')
  })

  for (const file of ['mobile/components/ThreadApprovalCard.jsx', 'src/components/ApprovalActionCard.jsx']) {
    it(`${file} never passes buildDeclineDraft straight into onPrefillComposer`, () => {
      const text = read(file)
      expect(text).not.toMatch(/onPrefillComposer\?*\.?\(\s*buildDeclineDraft/)
      expect(text).toMatch(/const draft = buildDeclineDraft\(/)
      expect(text).toMatch(/if \(draft\) onPrefillComposer/)
    })
  }
})
