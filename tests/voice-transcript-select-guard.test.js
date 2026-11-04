// VOICENOTE.1 — the transcript columns exist on whatsapp_messages ONLY (mig
// 808). A select naming them against instagram_messages, or against a table
// chosen at run time (adapter.messagesTable, MESSAGES_TABLE_BY_CHANNEL[...]),
// fails that whole Instagram read with 42703. So every select literal that
// names `transcript` must sit in a chain whose .from() is the literal
// 'whatsapp_messages', and the per-channel column lists keep Instagram clean.
import { test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { instagramAdapter } from '../src/lib/agent/instagram.js'
import { whatsappAdapter, BASE_HISTORY_COLUMNS } from '../src/lib/agent/auto-reply.js'
import { HISTORY_COLUMNS_BY_CHANNEL } from '../src/lib/agent/approval-suggest.js'

const ROOT = path.join(__dirname, '..')
const AGENT_DIR = path.join(ROOT, 'src', 'lib', 'agent')

function sourceFiles(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(js|jsx|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p)
  }
  return out
}

// The argument text of the call whose '(' is at `open`, balancing parens.
function callArg(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i)
  }
  return ''
}

export function transcriptSelectViolations(src) {
  const bad = []
  const re = /\.select\(/g
  let m
  while ((m = re.exec(src))) {
    const arg = callArg(src, m.index + '.select'.length)
    if (!/transcript/.test(arg)) continue
    const before = src.slice(Math.max(0, m.index - 600), m.index)
    const froms = [...before.matchAll(/\.from\(([^)]*)\)/g)]
    const from = froms.length ? froms[froms.length - 1][1].trim() : null
    if (from !== "'whatsapp_messages'") bad.push({ select: arg.trim().slice(0, 80), from })
  }
  return bad
}

test('the guard catches a transcript select aimed at a run-time table', () => {
  expect(transcriptSelectViolations("db.from(adapter.messagesTable).select('body, transcript')")).toHaveLength(1)
  expect(transcriptSelectViolations("db.from('instagram_messages')\n  .select('transcript_status')")).toHaveLength(1)
  expect(transcriptSelectViolations("db.from('whatsapp_messages')\n  .select('body, transcript, transcript_status')")).toHaveLength(0)
})

test('no agent file selects transcript columns from anything but whatsapp_messages', () => {
  const found = []
  for (const f of sourceFiles(AGENT_DIR)) {
    for (const v of transcriptSelectViolations(fs.readFileSync(f, 'utf8'))) found.push({ file: path.relative(ROOT, f), ...v })
  }
  expect(found).toEqual([])
})

test('the per-channel column lists keep the transcript on WhatsApp only', () => {
  expect(BASE_HISTORY_COLUMNS).not.toMatch(/transcript/)
  expect(instagramAdapter.historyColumns).not.toMatch(/transcript/)
  expect(HISTORY_COLUMNS_BY_CHANNEL.instagram).not.toMatch(/transcript/)
  expect(whatsappAdapter.historyColumns).toMatch(/transcript, transcript_status/)
  expect(HISTORY_COLUMNS_BY_CHANNEL.whatsapp).toMatch(/transcript, transcript_status/)
})
