// MCPEMAIL.1 — the blocks an agent supplies for a marketing email, and the
// server-side renderer that turns them into the HTML stored on the campaign.
// The agent never supplies HTML: everything is escaped, then only four inline
// patterns are interpreted (**bold**, *italic*, ~~red strikethrough~~,
// [label](https://…)).
// Merge tags pass through untouched; applyMergeTags() fills them at send time.
// No footer, unsubscribe link or preheader is added here (the send path owns them).
import { z } from 'zod'
import { OFFERED_MERGE_TAGS, MERGE_CONDITIONS } from '@/lib/merge-tags'

const TEXT_MAX = 5000
const URL_MAX = 2000

const text = z.string().min(1).max(TEXT_MAX)
const url = z.string().min(1).max(URL_MAX)

const block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text, level: z.union([z.literal(1), z.literal(2)]) }),
  z.object({ type: z.literal('paragraph'), text }),
  z.object({
    type: z.literal('list'),
    items: z.array(text).min(1).max(30),
    ordered: z.boolean().optional(),
  }),
  z.object({ type: z.literal('button'), label: z.string().min(1).max(60), url }),
  z.object({ type: z.literal('image'), url, alt: z.string().max(200) }),
  z.object({ type: z.literal('divider') }),
])

export const EmailBlocksSchema = z.array(block).min(1).max(60)

// ── merge tags ──────────────────────────────────────────────────────────
// applyMergeTags() substitutes the exact literal `{{name}}` (no inner
// whitespace), so only that exact form counts as a tag here.
const OFFERED_NAMES = new Set(OFFERED_MERGE_TAGS.map((t) => t.tag.replace(/^\{\{|\}\}$/g, '')))
const TAG_RE = /\{\{([^{}]*)\}\}/g
const TAG_ONLY_RE = /^\{\{([^{}]*)\}\}$/

// Contact-sourced tag values are substituted UNESCAPED at send time, so a URL
// position takes only tags whose value is a URL we build (decision F2).
const URL_ONLY_TAGS = Object.freeze(new Set(['unsubscribe_url', 'preference_url']))
const URL_INNER_TAGS = Object.freeze(new Set(['booking_token']))

// MERGEFALLBACK.2 — `{{name|fallback}}` (MERGEFALLBACK.1, applyMergeTags):
// an offered tag, no spaces before the bar, and a plain-text fallback with no
// braces. The fallback is the agent's text, so it may not carry another tag.
const FALLBACK_RE = /^([a-z_]+)\|([^{}|]*)$/
function isOfferedWithFallback(inner) {
  const m = FALLBACK_RE.exec(inner)
  return !!m && OFFERED_NAMES.has(m[1])
}

// CONDBLOCKS.2 — conditional blocks (CONDBLOCKS.1, applyConditionalBlocks):
// `{{#if member}}…{{else}}…{{/if}}`, `{{#unless first_name}}…{{/unless}}`,
// `{{#if stage=dormant}}…{{/if}}`. The send path leaves a block it cannot read
// as literal braces, so an agent's block must be exactly well formed: a known
// condition, one space after #if / #unless, opened and closed inside the same
// text, no nesting, at most one {{else}}.
const CONDITIONS = new Map(MERGE_CONDITIONS.map((c) => [c.name, c]))
const COND_OPEN_RE = /^#(if|unless) ([a-z_]+)(?:=([a-z0-9_-]+))?$/
const CONDITION_EXAMPLE = 'Write it like {{#if member}}, {{#unless first_name}} or {{#if stage=dormant}}.'

function isConditionToken(inner) {
  return inner.startsWith('#') || inner.startsWith('/') || inner === 'else'
}

function isWellFormedConditionToken(inner) {
  if (inner === 'else' || inner === '/if' || inner === '/unless') return true
  const m = COND_OPEN_RE.exec(inner)
  const c = m && CONDITIONS.get(m[2])
  return !!c && c.takesValue === (m[3] !== undefined)
}

/**
 * The first problem with the conditional blocks in one text, as a plain
 * sentence, or null. Plain merge tags are not judged here (unknownMergeTags).
 */
export function conditionalBlockProblem(value) {
  const text = String(value ?? '')
  let open = null
  let sawElse = false
  for (const m of text.matchAll(TAG_RE)) {
    const inner = m[1]
    if (!isConditionToken(inner)) continue
    if (inner.startsWith('#')) {
      const o = COND_OPEN_RE.exec(inner)
      if (!o) return `The condition {{${inner}}} is not written correctly. ${CONDITION_EXAMPLE}`
      const c = CONDITIONS.get(o[2])
      if (!c) {
        return `The condition "${o[2]}" in {{${inner}}} is not one emails understand. `
          + 'Use member, first_name or stage=<stage slug>.'
      }
      if (c.takesValue && o[3] === undefined) return `The condition {{${inner}}} needs a value, e.g. {{#${o[1]} ${c.name}=dormant}}.`
      if (!c.takesValue && o[3] !== undefined) return `The condition {{${inner}}} takes no value; write {{#${o[1]} ${c.name}}}.`
      if (open) return `Conditional blocks cannot be nested: close {{/${open}}} before opening {{${inner}}}.`
      open = o[1]
      sawElse = false
    } else if (inner === 'else') {
      if (!open) return '{{else}} must sit inside an {{#if …}} or {{#unless …}} block.'
      if (sawElse) return 'A conditional block can have only one {{else}}.'
      sawElse = true
    } else {
      const kind = inner.slice(1)
      if (kind !== 'if' && kind !== 'unless') return `{{${inner}}} is not a block ending; close a block with {{/if}} or {{/unless}}.`
      if (!open) return `{{${inner}}} has no {{#${kind} …}} to close.`
      if (kind !== open) return `A {{#${open} …}} block must be closed with {{/${open}}}, not {{${inner}}}.`
      open = null
    }
  }
  if (open) {
    return `A {{#${open} …}} block is never closed. Add {{/${open}}} in the same text `
      + '(the same paragraph, heading, list item, button label or subject).'
  }
  return null
}

/** Raw inner text of every tag in `value` that is not an exact offered tag (unique, in order). */
export function unknownMergeTags(value) {
  const out = []
  const text = String(value ?? '')
  // A tag inside a fallback ({{first_name|{{last_name}}}}) would be half
  // filled and leave a literal {{…}} in the email, so it is refused.
  const nested = /\{\{[^{}]*\|[^{}]*\{\{/.exec(text)
  if (nested) out.push(nested[0].slice(2))
  for (const m of text.matchAll(TAG_RE)) {
    if (isWellFormedConditionToken(m[1])) continue
    if (!OFFERED_NAMES.has(m[1]) && !isOfferedWithFallback(m[1]) && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

/**
 * The first merge-tag problem in one text (a subject, a paragraph, a label):
 * a badly formed conditional block, then an unknown tag. Null when clean.
 */
export function mergeTagProblem(value) {
  const cond = conditionalBlockProblem(value)
  if (cond) return cond
  const unknown = unknownMergeTags(value)
  return unknown.length ? tagSentence(unknown[0]) : null
}

function tagSentence(inner) {
  const name = inner.trim()
  if (name !== inner && OFFERED_NAMES.has(name)) {
    return `The merge tag {{ ${name} }} must be written with no spaces inside the braces, e.g. {{${name}}}.`
  }
  return `The merge tag {{${inner}}} is not available in emails.`
}

// ── validation ──────────────────────────────────────────────────────────
const RAW_LINK_RE = /\[([^\]]*)\]\(([^)\s]*)\)/g

// kind: 'link' (button / inline link target) or 'image'.
function urlProblem(value, kind = 'link') {
  const only = TAG_ONLY_RE.exec(value)
  if (only) {
    if (kind === 'link' && URL_ONLY_TAGS.has(only[1])) return null
    return `The merge tag {{${only[1]}}} cannot be used as a link address; only {{unsubscribe_url}} and {{preference_url}} can.`
  }
  for (const m of value.matchAll(TAG_RE)) {
    if (kind === 'image') return `The image address ${value} may not contain merge tags.`
    if (!URL_INNER_TAGS.has(m[1])) {
      return `The merge tag {{${m[1]}}} cannot be used inside a link address; only {{booking_token}} can.`
    }
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return `The link "${value}" is not a valid https:// address.`
  }
  if (parsed.protocol !== 'https:') return `The link "${value}" must start with https://.`
  return null
}

function textsOf(b) {
  switch (b.type) {
    case 'heading':
    case 'paragraph': return [b.text]
    case 'list': return b.items
    case 'button': return [b.label, b.url]
    case 'image': return [b.url, b.alt]
    default: return []
  }
}

/** The first problem as a plain sentence, or null. `blocks` is already schema-valid. */
export function validateBlocks(blocks, { allowedImageUrls } = {}) {
  const allowed = allowedImageUrls ?? new Set()
  for (const b of blocks) {
    for (const t of textsOf(b)) {
      const tagProblem = mergeTagProblem(t)
      if (tagProblem) return tagProblem
    }
    if (b.type === 'button') {
      const p = urlProblem(b.url)
      if (p) return p
    }
    if (b.type === 'image') {
      const p = urlProblem(b.url, 'image')
      if (p) return p
      if (!allowed.has(b.url)) return `The image ${b.url} is not in this studio's image library.`
    }
    if (b.type === 'paragraph' || b.type === 'list') {
      for (const t of b.type === 'list' ? b.items : [b.text]) {
        for (const m of t.matchAll(RAW_LINK_RE)) {
          const p = urlProblem(m[2])
          if (p) return p
        }
      }
    }
  }
  return null
}

// ── rendering ───────────────────────────────────────────────────────────
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const ESC_LINK_RE = /\[([^\]]+)\]\((https:\/\/[^)\s]+|\{\{(?:unsubscribe_url|preference_url)\}\})\)/g
const LINK_COLOUR = '#1a1a1a'
// EMAILSTRIKE.1 — the outer colour paints the line and the inner one keeps the
// words readable, which works in mail clients without text-decoration-color.
const STRIKE_COLOUR = '#d11a2a'
const FONT = "'Helvetica Neue', Arial, sans-serif"

function emphasis(escaped) {
  return escaped
    .replace(/~~([^~]+?)~~/g, `<span style="color:${STRIKE_COLOUR}; text-decoration:line-through;"><span style="color:${LINK_COLOUR};">$1</span></span>`)
    .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\s][^*]*?)\*/g, '<em>$1</em>')
}

function inline(raw) {
  const s = esc(raw)
  let out = ''
  let last = 0
  for (const m of s.matchAll(ESC_LINK_RE)) {
    out += emphasis(s.slice(last, m.index))
    out += `<a href="${m[2]}" style="color:${LINK_COLOUR}; text-decoration:underline;">${emphasis(m[1])}</a>`
    last = m.index + m[0].length
  }
  return out + emphasis(s.slice(last))
}

function renderBlock(b) {
  switch (b.type) {
    case 'heading': {
      const [tag, size] = b.level === 1 ? ['h1', 26] : ['h2', 20]
      return `<tr><td class="px" style="padding:24px 40px 0 40px;"><${tag} style="margin:0; font-family:${FONT}; font-size:${size}px; line-height:1.25; color:#111111;">${esc(b.text)}</${tag}></td></tr>`
    }
    case 'paragraph':
      return `<tr><td class="px" style="padding:16px 40px 0 40px; font-family:${FONT}; font-size:16px; line-height:1.6; color:#1a1a1a;">${inline(b.text).replace(/\n/g, '<br>')}</td></tr>`
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul'
      const items = b.items.map((i) => `<li style="margin:0 0 6px 0;">${inline(i)}</li>`).join('')
      return `<tr><td class="px" style="padding:16px 40px 0 40px; font-family:${FONT}; font-size:16px; line-height:1.6; color:#1a1a1a;"><${tag} style="margin:0; padding-left:22px;">${items}</${tag}></td></tr>`
    }
    case 'button':
      return `<tr><td class="px" style="padding:24px 40px 0 40px;"><table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#111111" style="background-color:#111111; border-radius:4px;"><a href="${esc(b.url)}" style="display:inline-block; padding:14px 28px; font-family:${FONT}; font-size:16px; font-weight:bold; color:#ffffff; text-decoration:none;">${esc(b.label)}</a></td></tr></table></td></tr>`
    case 'image':
      return `<tr><td class="px" style="padding:24px 40px 0 40px;"><img src="${esc(b.url)}" alt="${esc(b.alt)}" width="520" style="display:block; width:100%; max-width:520px; height:auto; border:0;"></td></tr>`
    case 'divider':
      return `<tr><td class="px" style="padding:24px 40px 0 40px;"><div style="border-top:1px solid #dddddd; font-size:0; line-height:0; height:0;">&nbsp;</div></td></tr>`
    default:
      return ''
  }
}

/** A full HTML document. Pure: the same inputs give byte-identical output. */
export function renderAgentEmail({ blocks, branding }) {
  const name = esc(branding?.companyName ?? '')
  const logo = branding?.logoUrl && /^https:\/\//i.test(branding.logoUrl)
    ? `<img src="${esc(branding.logoUrl)}" alt="${name}" height="48" style="display:block; margin:0 auto 8px auto; height:48px; width:auto; border:0;">`
    : ''
  // EMAILBAR.1: with an email logo (light artwork, company_settings.email_logo_url)
  // the header is a black bar. A dark-mode inbox darkens a white header behind
  // the everyday dark logo until it cannot be read; a black bar with a light
  // logo looks the same in both modes. Without one, the plain header stays.
  const barLogo = branding?.emailLogoUrl && /^https:\/\//i.test(branding.emailLogoUrl) ? branding.emailLogoUrl : null
  const header = barLogo
    ? `<tr><td align="center" bgcolor="#000000" style="background-color:#000000; padding:26px 24px 22px 24px; font-family:${FONT}; font-size:14px; font-weight:bold; letter-spacing:1px; color:#ffffff;"><img src="${esc(barLogo)}" alt="${name}" height="56" style="display:block; margin:0 auto 10px auto; height:56px; width:auto; border:0;">${name}</td></tr>`
    : `<tr><td align="center" style="padding:28px 24px 20px 24px; border-bottom:1px solid #eeeeee; font-family:${FONT}; font-size:18px; font-weight:bold; color:#111111;">${logo}${name}</td></tr>`
  const body = blocks.map(renderBlock).join('\n')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>
  @media only screen and (max-width: 620px) {
    .container { width: 100% !important; }
    .px { padding-left: 20px !important; padding-right: 20px !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background-color:#f5f5f5;">
<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="container" width="600" border="0" cellpadding="0" cellspacing="0" style="width:600px; max-width:600px; background-color:#ffffff;">
${header}
${body}
<tr><td style="padding:0 0 40px 0; font-size:0; line-height:0;">&nbsp;</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`
}
