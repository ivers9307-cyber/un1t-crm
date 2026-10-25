#!/usr/bin/env node
// MAIL-READER.M2 — does the phone's block renderer actually cope with REAL mail?
//
// MAIL-READER.M1 shipped an HTML→block-tree renderer for the mobile Mail
// thread, tested against fixtures I wrote. Fixtures I wrote cannot tell me
// whether real marketing email, real receipts and real notifications survive
// the walk — and the answer decides whether a "View original" escape hatch is
// worth a new public route (which needs four separate allowlists, a bug class
// this repo has hit five times).
//
// So: run every stored html_body through the REAL pipeline and report shape.
//
// 🔴 IT PRINTS NO MESSAGE CONTENT. Every line of output is a count, a ratio or
// a block-type name. The bodies are customers' mail; this reads them to judge
// a renderer, and nothing else. The one exception is `--sample`, which prints
// the opening characters of a body the walk produced nothing for, because a
// shape that renders empty cannot be diagnosed from a count — use it
// deliberately, and do not paste the output anywhere.
//
// Reads SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL from process.env,
// then the repo root, then the main checkout (a worktree has none of its own).
//
// 🔴 THE CHECKED-IN .env.local WILL NOT WORK. Local dev in this estate has no
// database — its NEXT_PUBLIC_SUPABASE_URL is `placeholder.supabase.co` on
// purpose. Export real credentials for the run, or run it somewhere that has
// them. The census in the commit that added this was taken through the
// Supabase MCP instead, in SQL, for the same reason.
//
// Run it with vite-node, not node: this repo's modules use extensionless
// imports and the `@shared` alias, which bare node cannot resolve.
//
//   npx vite-node --config vitest.config.js scripts/audit-block-renderer.mjs

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { emailBlocks } from '../src/lib/email-blocks.js'
import { htmlToPlainText } from '../src/lib/email-content.js'

const SHOW_SAMPLE = process.argv.includes('--sample')
const ENV_LINE = /^([A-Z0-9_]+)=(.*)$/

function loadEnv() {
  // process.env first, so CI or a shell export beats any file. Then the repo
  // root (`scripts/..`), then the MAIN CHECKOUT four levels up — a worktree
  // under .claude/worktrees/<name>/ has no .env.local of its own, and this
  // script is most useful from one.
  if (process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return process.env
  }
  for (const path of ['../.env.local', '../../../../.env.local']) {
    try {
      const text = readFileSync(new URL(path, import.meta.url), 'utf8')
      const env = {}
      for (const line of text.split('\n')) {
        const m = line.trim().match(ENV_LINE)
        if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
      if (env.SUPABASE_SERVICE_ROLE_KEY) return env
    } catch { /* try the next candidate */ }
  }
  throw new Error('No .env.local with SUPABASE_SERVICE_ROLE_KEY found')
}

const env = loadEnv()
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const { data, error } = await db
  .from('email_inbox_messages')
  .select('id, html_body')
  .not('html_body', 'is', null)
  .limit(1000)

if (error) {
  console.error('query failed:', error.message)
  process.exitCode = 1
} else {
  report(data.filter(r => (r.html_body || '').trim().length > 0))
}

function report(rows) {
  const stats = {
    total: rows.length,
    failed: 0,
    noBlocks: 0,
    truncated: 0,
    withImages: 0,
    withTable: 0,
    withLinkBlock: 0,
    thinText: 0,
  }
  const types = new Map()
  const empties = []
  let textRatioSum = 0
  let textRatioCount = 0

  for (const row of rows) {
    const result = emailBlocks(row.html_body)
    if (result.failed) { stats.failed += 1; continue }
    if (!result.blocks || result.blocks.length === 0) {
      stats.noBlocks += 1
      empties.push(row)
      continue
    }
    if (result.truncated) stats.truncated += 1
    if (result.blockedImages > 0) stats.withImages += 1
    walkTypes(result.blocks, types)
    const top = result.blocks.map(b => b.type)
    if (top.includes('table')) stats.withTable += 1
    if (top.includes('link')) stats.withLinkBlock += 1

    // How much of what a plain-text conversion would show does the tree keep?
    // A ratio near 1 means the walk lost nothing a reader would miss; a low
    // one means the renderer is dropping words, which is the failure that
    // would justify an escape hatch.
    const plain = htmlToPlainText(row.html_body).replace(/\s+/g, '')
    const rendered = textOf(result.blocks).replace(/\s+/g, '')
    if (plain.length > 200) {
      const ratio = rendered.length / plain.length
      textRatioSum += ratio
      textRatioCount += 1
      if (ratio < 0.6) stats.thinText += 1
    }
  }

  const pct = (n) => `${((n / stats.total) * 100).toFixed(1)}%`
  console.log(`\nmessages with html_body: ${stats.total}\n`)
  console.log(`  sanitiser/parse failed : ${stats.failed} (${pct(stats.failed)})`)
  console.log(`  produced NO blocks     : ${stats.noBlocks} (${pct(stats.noBlocks)})`)
  console.log(`  hit a cap (truncated)  : ${stats.truncated} (${pct(stats.truncated)})`)
  console.log(`  kept <60% of the text  : ${stats.thinText} (${pct(stats.thinText)})`)
  console.log(`  carried blocked images : ${stats.withImages} (${pct(stats.withImages)})`)
  console.log(`  produced a data table  : ${stats.withTable} (${pct(stats.withTable)})`)
  console.log(`  produced a link block  : ${stats.withLinkBlock} (${pct(stats.withLinkBlock)})`)
  if (textRatioCount > 0) {
    console.log(`\n  mean text kept vs htmlToPlainText: ${(textRatioSum / textRatioCount * 100).toFixed(1)}%`)
    console.log(`  (over the ${textRatioCount} bodies with >200 chars of text)`)
  }
  console.log('\nblock types produced, by count:')
  for (const [type, n] of [...types].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(8)} ${n}`)
  }
  if (empties.length > 0 && SHOW_SAMPLE) {
    console.log('\nbodies that produced nothing — opening characters of each:')
    for (const row of empties.slice(0, 5)) {
      console.log(`  ${row.id}: ${row.html_body.replace(/\s+/g, ' ').slice(0, 120)}`)
    }
  }
}

function walkTypes(blocks, types) {
  for (const b of blocks || []) {
    types.set(b.type, (types.get(b.type) || 0) + 1)
    if (b.type === 'quote') walkTypes(b.blocks, types)
  }
}

/** Every character of visible text the tree would put on screen. */
function textOf(blocks) {
  let out = ''
  for (const b of blocks || []) {
    if (Array.isArray(b.runs)) out += b.runs.map(r => r.text).join('')
    if (b.type === 'list') for (const item of b.items) out += item.map(r => r.text).join('')
    if (b.type === 'quote') out += textOf(b.blocks)
    if (b.type === 'pre') out += b.text
    if (b.type === 'table') {
      for (const cell of b.head || []) out += cell.map(r => r.text).join('')
      for (const row of b.rows) for (const cell of row) out += cell.map(r => r.text).join('')
    }
  }
  return out
}
