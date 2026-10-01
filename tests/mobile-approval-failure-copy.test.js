// C85 (c) — the phone never shows a failed approval's raw code as the message.
// approvals.jsx alerted `res.executed.message_code` and ThreadApprovalCard
// printed `(message_code)`; both go through mobile/lib/approval-outcome.js
// (tested there). No RN component runner, so this pins the wiring.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { stripComments } from '../scripts/lib/strip-comments.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (rel) => stripComments(readFileSync(path.join(ROOT, rel), 'utf8'))

describe('failed approvals read as operator copy on the phone (C85 c)', () => {
  it('the Approvals screen alerts approveFailureAlert, not the code', () => {
    const code = read('mobile/app/(staff)/approvals.jsx')
    expect(code).not.toMatch(/message_code/)
    expect(code).toMatch(/approveFailureAlert\(res\)/)
  })

  it('the thread\'s approval card shows failedCardExplanation, not "(CODE)"', () => {
    const code = read('mobile/components/ThreadApprovalCard.jsx')
    expect(code).not.toMatch(/message_code/)
    expect(code).toMatch(/failedCardExplanation\(request\)/)
  })
})
