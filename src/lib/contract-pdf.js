// CONTRACTS-PDF.1 — the signed-contract PDF artifact.
//
// Two exports, deliberately split so the risky half is isolated:
//
//   parseContractBlocks(markdown) — a PURE function. No React, no
//     renderer, no IO. It turns the contract's frozen `body_rendered`
//     markdown into a small array of typed blocks. Unit-tested
//     exhaustively in contract-pdf.test.js.
//
//   renderContractPdf({...}) — maps those blocks onto @react-pdf/renderer
//     primitives and returns a Buffer. Runs server-side in a nodejs
//     route (react-pdf is pure JS + a wasm yoga layout engine; there is
//     no DOM, no headless browser, no native binary).
//
// WHY A HAND-ROLLED MARKDOWN SPLIT rather than reusing react-markdown
// (which src/components/ContractBody.jsx uses for the web view):
// react-markdown emits DOM elements (h1/p/ul/strong) that @react-pdf
// cannot render — its renderer only understands its own Document /
// Page / View / Text primitives. A mdast to react-pdf bridge would be a
// lot of surface area for a document format that only uses headings,
// paragraphs, bullet lists, horizontal rules and bold. So we parse the
// handful of constructs we support and treat EVERYTHING ELSE as literal
// paragraph text.
//
// THE GOVERNING RULE: a legal document must never silently lose
// content. Ugly beats missing. An unrecognised construct renders as its
// literal source characters in the PDF (an operator sees a stray `>` or
// `|` and fixes the template); it is never dropped.
//
// Two documented deviations from "only #/##/### are headings":
//   - `####`+ clamps to level 3 rather than falling back to literal.
//     ContractBody renders h4-h6 as real headings on the web, so a
//     literal `#### Notice period` in the PDF would be a visual
//     divergence from the document the recipient actually signed, and
//     no content is lost by clamping.
//   - An ordered-list line (`1. foo`) is not a list block (we only
//     support bullets), but it DOES flush the running paragraph so each
//     numbered clause stays on its own line instead of being glued into
//     one run-on paragraph. It is still a `paragraph` block carrying its
//     literal `1. ` marker.

import React from 'react'
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import { formatFullDateTimeInTZ } from './dates.js'

const el = React.createElement

// ─── Block parsing (pure) ────────────────────────────────────────

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/
const BULLET_RE = /^\s*[-*]\s+(.*)$/
const ORDERED_RE = /^\s*\d+[.)]\s+/
const BOLD_RE = /\*\*(.+?)\*\*/g

/**
 * Split `**bold**` spans out of a line into typed runs.
 *
 * Always returns at least one run so a caller can map over the result
 * without a length check. An unterminated `**` is left as literal text
 * (the never-lose-content rule) rather than swallowing the rest of the
 * line.
 *
 * @param {string} text
 * @returns {Array<{ text: string, bold: boolean }>}
 */
export function parseInlineRuns(text) {
  const src = String(text ?? '')
  if (!src) return [{ text: '', bold: false }]
  const runs = []
  let cursor = 0
  for (const match of src.matchAll(BOLD_RE)) {
    if (match.index > cursor) runs.push({ text: src.slice(cursor, match.index), bold: false })
    runs.push({ text: match[1], bold: true })
    cursor = match.index + match[0].length
  }
  if (cursor < src.length) runs.push({ text: src.slice(cursor), bold: false })
  return runs.length ? runs : [{ text: src, bold: false }]
}

/**
 * Parse a contract's frozen `body_rendered` markdown into typed blocks.
 *
 * Block shapes:
 *   { type: 'heading',   level: 1|2|3, text: string }
 *   { type: 'list',      items: Array<Array<{text,bold}>> }
 *   { type: 'hr' }
 *   { type: 'paragraph', runs: Array<{text,bold}> }
 *
 * Paragraphs are blank-line separated: consecutive plain lines are
 * joined with a single space (normal markdown soft-wrap behaviour).
 *
 * @param {string|null|undefined} markdown
 * @returns {Array<object>}
 */
export function parseContractBlocks(markdown) {
  const blocks = []
  if (!markdown || typeof markdown !== 'string') return blocks

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')

  // Two accumulators: the running paragraph (joined with spaces) and
  // the running bullet list (consecutive `-`/`*` lines). Any other
  // block type flushes both before emitting.
  let paraLines = []
  let listItems = []

  const flushPara = () => {
    if (!paraLines.length) return
    const text = paraLines.join(' ').trim()
    paraLines = []
    if (text) blocks.push({ type: 'paragraph', runs: parseInlineRuns(text) })
  }
  const flushList = () => {
    if (!listItems.length) return
    blocks.push({ type: 'list', items: listItems })
    listItems = []
  }
  const flushAll = () => { flushPara(); flushList() }

  for (const raw of lines) {
    const line = raw.trimEnd()

    // Blank line — paragraph/list separator.
    if (!line.trim()) { flushAll(); continue }

    // Horizontal rule. Checked BEFORE the bullet rule: `---` would not
    // match BULLET_RE anyway (no space after the dash), but ordering it
    // first keeps the intent explicit.
    if (HR_RE.test(line)) {
      flushAll()
      blocks.push({ type: 'hr' })
      continue
    }

    const heading = line.match(HEADING_RE)
    if (heading) {
      flushAll()
      // Clamp h4-h6 to level 3 (see the header comment).
      const level = Math.min(heading[1].length, 3)
      blocks.push({ type: 'heading', level, text: heading[2].trim() })
      continue
    }

    const bullet = line.match(BULLET_RE)
    if (bullet) {
      flushPara() // a list interrupts a paragraph, but not another list
      listItems.push(parseInlineRuns(bullet[1].trim()))
      continue
    }

    // Anything else is paragraph text. An ordered-list marker gets its
    // own paragraph so numbered clauses do not run together.
    flushList()
    if (ORDERED_RE.test(line)) flushPara()
    paraLines.push(line.trim())
  }

  flushAll()
  return blocks
}

// ─── PDF rendering ───────────────────────────────────────────────

// Times is one of the PDF standard-14 fonts, built into @react-pdf —
// no Font.register(), no font file to ship in the serverless bundle,
// and it matches the `font-serif` web render in ContractBody.
const styles = StyleSheet.create({
  page: {
    paddingTop: 48,
    paddingBottom: 56,
    paddingHorizontal: 56,
    fontFamily: 'Times-Roman',
    fontSize: 10.5,
    color: '#111827',
    lineHeight: 1.5,
  },
  header: {
    marginBottom: 20,
    paddingBottom: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: '#d1d5db',
  },
  headerCompany: { fontFamily: 'Times-Bold', fontSize: 10, letterSpacing: 0.6 },
  headerTemplate: { fontSize: 8.5, color: '#6b7280', marginTop: 2 },
  h1: { fontFamily: 'Times-Bold', fontSize: 16, marginTop: 16, marginBottom: 8 },
  h2: { fontFamily: 'Times-Bold', fontSize: 13, marginTop: 14, marginBottom: 6 },
  h3: { fontFamily: 'Times-Bold', fontSize: 11.5, marginTop: 12, marginBottom: 4 },
  paragraph: { marginBottom: 8 },
  list: { marginBottom: 8 },
  listRow: { flexDirection: 'row', marginBottom: 3 },
  listBullet: { width: 14, paddingLeft: 4 },
  listText: { flex: 1 },
  bold: { fontFamily: 'Times-Bold' },
  hr: { borderBottomWidth: 0.5, borderBottomColor: '#d1d5db', marginTop: 10, marginBottom: 12 },
  sigWrap: {
    marginTop: 32,
    paddingTop: 16,
    borderTopWidth: 0.5,
    borderTopColor: '#9ca3af',
    flexDirection: 'row',
  },
  sigCol: { width: '50%', paddingRight: 16 },
  sigLabel: { fontSize: 7, color: '#6b7280', letterSpacing: 0.8, textTransform: 'uppercase' },
  sigName: { fontFamily: 'Times-Italic', fontSize: 17, marginTop: 6 },
  sigMeta: { fontSize: 7, color: '#6b7280', marginTop: 4 },
  pageNumber: {
    position: 'absolute',
    bottom: 28,
    left: 56,
    right: 56,
    textAlign: 'center',
    fontSize: 7,
    color: '#9ca3af',
  },
})

const HEADING_STYLE = { 1: styles.h1, 2: styles.h2, 3: styles.h3 }

// Runs -> <Text> children. A bold run becomes a nested <Text> with the
// bold face; react-pdf inherits the surrounding size/lineHeight.
function runNodes(runs, keyPrefix) {
  return (runs || []).map((run, i) =>
    run.bold
      ? el(Text, { key: `${keyPrefix}-${i}`, style: styles.bold }, run.text)
      : el(React.Fragment, { key: `${keyPrefix}-${i}` }, run.text)
  )
}

function blockNode(block, i) {
  const key = `b${i}`
  if (block.type === 'hr') return el(View, { key, style: styles.hr })
  if (block.type === 'heading') {
    return el(Text, { key, style: HEADING_STYLE[block.level] || styles.h3 }, block.text)
  }
  if (block.type === 'list') {
    return el(
      View,
      { key, style: styles.list },
      block.items.map((item, j) =>
        el(
          View,
          { key: `${key}-${j}`, style: styles.listRow, wrap: false },
          el(Text, { style: styles.listBullet }, '•'),
          el(Text, { style: styles.listText }, runNodes(item, `${key}-${j}`))
        )
      )
    )
  }
  // paragraph
  return el(Text, { key, style: styles.paragraph }, runNodes(block.runs, key))
}

function signatureColumn({ label, name, timestamp, ip }) {
  const when = formatFullDateTimeInTZ(timestamp, 'Europe/Dublin')
  return el(
    View,
    { style: styles.sigCol },
    el(Text, { style: styles.sigLabel }, label),
    el(Text, { style: styles.sigName }, name || ''),
    when ? el(Text, { style: styles.sigMeta }, `Signed ${when}`) : null,
    ip ? el(Text, { style: styles.sigMeta }, `IP ${ip}`) : null
  )
}

/**
 * Render a dual-signed contract to a PDF Buffer.
 *
 * Visually approximates the web render (ContractBody + the dual
 * signature block on /admin/contracts/[id] and /account/contracts/[id]):
 * serif body, two signature columns, italic typed names, Dublin
 * timestamps, the recipient's IP under their signature.
 *
 * Never called for an unsigned contract in practice, but every field is
 * optional so a partially-populated row degrades to a blank cell rather
 * than throwing.
 *
 * @param {object} args
 * @param {string} args.bodyRendered       frozen contract markdown
 * @param {string} args.issuerSignature    issuer's typed name
 * @param {string} args.issuedAt           ISO timestamp
 * @param {string} args.recipientSignature recipient's typed name
 * @param {string} args.signedAt           ISO timestamp
 * @param {string} args.signedIp           recipient's IP at signing
 * @param {string} args.templateName
 * @param {string} args.companyName        the BRAND — running header wordmark
 *                                         and PDF author metadata only
 * @param {string} [args.contractingEntity] LEGALENT.1 — the CONTRACTING
 *   COMPANY, for the "For …" countersignature label. It is a legal-entity
 *   claim and must not be the brand: this PDF is uploaded to the private
 *   `contracts` bucket AND attached to the signature-confirmation emails, so
 *   it is the archived binding artifact the member keeps. It used to reuse
 *   `companyName`, which meant that the moment an operator configured
 *   org_settings.legal_entity_name the screen would say one company and the
 *   stored PDF another — two counterparties on one executed document.
 *   Callers pass contractCountersignatureLabel(contract) (the contract's own
 *   frozen entity), which is exactly what the web pages and the mobile screen
 *   render, so the four can never diverge. Omitted -> falls back to the brand,
 *   i.e. the pre-LEGALENT.1 behaviour.
 * @returns {Promise<Buffer>}
 */
export async function renderContractPdf({
  bodyRendered,
  issuerSignature,
  issuedAt,
  recipientSignature,
  signedAt,
  signedIp,
  templateName,
  companyName,
  contractingEntity,
} = {}) {
  const blocks = parseContractBlocks(bodyRendered)
  const company = companyName || 'UN1T'
  const entity = String(contractingEntity ?? '').trim() || company

  const doc = el(
    Document,
    { title: templateName || 'Contract', author: company },
    el(
      Page,
      { size: 'A4', style: styles.page },
      el(
        View,
        { style: styles.header, fixed: true },
        el(Text, { style: styles.headerCompany }, company),
        templateName ? el(Text, { style: styles.headerTemplate }, templateName) : null
      ),
      blocks.map(blockNode),
      el(
        View,
        { style: styles.sigWrap, wrap: false },
        signatureColumn({ label: `For ${entity}`, name: issuerSignature, timestamp: issuedAt }),
        signatureColumn({
          label: 'Employee / Contractor',
          name: recipientSignature,
          timestamp: signedAt,
          ip: signedIp,
        })
      ),
      el(Text, {
        style: styles.pageNumber,
        fixed: true,
        render: ({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`,
      })
    )
  )

  return renderToBuffer(doc)
}
