// AGENT-EVALS.1 — pure assertion engine for the Mia replay evals.
//
// An eval outcome is graded deterministically — no LLM judge. The
// robust assertion classes, in order of reliability:
//   1. tool-call assertions (mustCall / mustNotCall / maxToolCalls)
//   2. never-say rules (notMatch) — the compliance guarantees
//   3. hard tokens (match) — URLs, names, times echoed from mocks
//   4. handoff expectations (the [[HANDOFF]] sentinel parsed upstream)
//   5. tap-button rules (optionsRequired / optionsMatch / optionsNotMatch)
//      against the parsed [[OPTIONS]] payload
// `anyOf` allows alternatives where two model behaviours are both
// acceptable (e.g. sentinel handoff OR a safe "I'll check with the
// team" reply). Pure — unit-tested in the main CI suite.

function asArray(v) {
  return v == null ? [] : Array.isArray(v) ? v : [v]
}

function rx(pattern) {
  return pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i')
}

/**
 * Grade one branch of expectations against an outcome.
 * @param {object} expect
 * @param {object} outcome { toolCalls:[{name,input}], action, text, reason, unexpectedTools:[], iterationsExhausted }
 * @returns {string[]} failures (empty = pass)
 */
function evaluateBranch(expect, outcome) {
  const failures = []
  const calls = outcome.toolCalls || []
  const called = calls.map(c => c.name)
  const text = outcome.text || ''

  for (const name of asArray(expect.mustCall)) {
    if (!called.includes(name)) failures.push(`expected tool call: ${name} (called: ${called.join(', ') || 'none'})`)
  }
  for (const name of asArray(expect.mustNotCall)) {
    if (called.includes(name)) failures.push(`forbidden tool was called: ${name}`)
  }
  if (typeof expect.maxToolCalls === 'number' && calls.length > expect.maxToolCalls) {
    failures.push(`too many tool calls: ${calls.length} > ${expect.maxToolCalls} (${called.join(', ')})`)
  }
  for (const pattern of asArray(expect.match)) {
    if (!rx(pattern).test(text)) failures.push(`reply did not match /${pattern}/i`)
  }
  for (const pattern of asArray(expect.notMatch)) {
    if (rx(pattern).test(text)) failures.push(`reply matched forbidden /${pattern}/i`)
  }
  // MIA-SONNET5 — "she still said something of her own" as a first-class
  // assertion. Scenarios that pair a tool with a companion line used to
  // approximate this by requiring particular nouns in the reply, which asserts
  // a vocabulary rather than the behaviour and fails good-but-terser copy.
  if (typeof expect.minReplyChars === 'number' && text.trim().length < expect.minReplyChars) {
    failures.push(`reply too short (${text.trim().length} < ${expect.minReplyChars} chars): "${text.trim()}"`)
  }
  if (typeof expect.handoff === 'boolean') {
    const isHandoff = outcome.action === 'handoff'
    if (isHandoff !== expect.handoff) {
      failures.push(expect.handoff
        ? `expected a handoff, got a reply: "${text.slice(0, 120)}"`
        : `unexpected handoff (reason: ${outcome.reason || 'unspecified'})`)
    }
  }
  // MIA-REVIEW.3 — [[OPTIONS]] grading. The runner always captured
  // outcome.options and nothing ever read it, so the prompt's button rules
  // (offer buttons for class/slot lists and confirmations, 2-10 choices, under
  // 20 chars each, and NEVER put a full class on a tap button) were completely
  // unguarded. core.normalizeAgentOptions already enforces the count/length
  // caps at runtime; asserting them here catches a prompt regression that
  // stops emitting buttons at all, or puts the wrong thing on one.
  const options = outcome.options || null
  if (expect.optionsRequired === true) {
    if (!options) failures.push('expected tap options ([[OPTIONS]]) and none were emitted')
    else if (options.length < 2 || options.length > 10) {
      failures.push(`options count out of range (2-10): ${options.length}`)
    } else {
      const tooLong = options.filter(o => o.length > 20)
      if (tooLong.length) failures.push(`option labels over 20 chars: ${tooLong.join(', ')}`)
    }
  }
  if (expect.optionsRequired === false && options) {
    failures.push(`unexpected tap options: ${options.join(' | ')}`)
  }
  for (const pattern of asArray(expect.optionsMatch)) {
    if (!(options || []).some(o => rx(pattern).test(o))) {
      failures.push(`no option matched /${pattern}/i (options: ${(options || []).join(' | ') || 'none'})`)
    }
  }
  for (const pattern of asArray(expect.optionsNotMatch)) {
    const hit = (options || []).find(o => rx(pattern).test(o))
    if (hit) failures.push(`option "${hit}" matched forbidden /${pattern}/i`)
  }

  for (const { tool, field, pattern } of asArray(expect.argMatch)) {
    const call = calls.find(c => c.name === tool)
    if (!call) {
      failures.push(`argMatch: ${tool} was never called`)
    } else if (!rx(pattern).test(String(call.input?.[field] ?? ''))) {
      failures.push(`argMatch: ${tool}.${field} = ${JSON.stringify(call.input?.[field])} did not match /${pattern}/i`)
    }
  }
  return failures
}

/**
 * Grade a scenario's expectations. Always fails on tools called without
 * a mock (the model reached for something the scenario didn't expect)
 * and on iteration exhaustion (runaway loop = production handoff).
 * `expect.anyOf: [branchA, branchB]` passes when ANY branch passes;
 * top-level fields are graded alongside as the common requirements.
 */
export function evaluateOutcome(expect, outcome) {
  const failures = evaluateBranch(expect, outcome)

  if ((outcome.unexpectedTools || []).length > 0 && !expect.allowUnexpectedTools) {
    failures.push(`called tools with no mock in this scenario: ${outcome.unexpectedTools.join(', ')}`)
  }
  if (outcome.iterationsExhausted) {
    failures.push('ran out of tool iterations without a final reply (production would hand off)')
  }

  if (Array.isArray(expect.anyOf) && expect.anyOf.length > 0) {
    const branches = expect.anyOf.map(b => evaluateBranch(b, outcome))
    if (!branches.some(f => f.length === 0)) {
      failures.push(`no anyOf branch passed: ${branches.map((f, i) => `[${i}] ${f.join('; ')}`).join(' | ')}`)
    }
  }

  return { pass: failures.length === 0, failures }
}
