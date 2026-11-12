// MCPEMAIL.1 — the blocks an agent supplies for a marketing email, and the
// server-side renderer that turns them into the HTML stored on the campaign.
// The agent never supplies HTML: everything is escaped, then only three inline
// patterns are interpreted (**bold**, *italic*, [label](https://…)).
// Merge tags pass through untouched; applyMergeTags() fills them at send time.
// No footer, unsubscribe link or preheader is added here (the send path owns them).
import { z } from 'zod'
import { OFFERED_MERGE_TAGS } from '@/lib/merge-tags'

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
const OFFERED_NAMES = new Set(OFFERED_MERGE_TAGS.map((t) => t.tag.replace(/^\{\{\s*|\s*\}\}$/g, '')))
const TAG_RE = /\{\{\s*([^{}]*?)\s*\}\}/g
const TAG_ONLY_RE = /^\{\{\s*[^{}]*?\s*\}\}$/

/** Tag names used in `text` that are not offered tags (unique, in order). */
export function unknownMergeTags(value) {
  const out = []
  for (const m of String(value ?? '').matchAll(TAG_RE)) {
    if (!OFFERED_NAMES.has(m[1]) && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

// ── validation ──────────────────────────────────────────────────────────
const RAW_LINK_RE = /\[([^\]]*)\]\(([^)\s]*)\)/g

function urlProblem(value) {
  if (TAG_ONLY_RE.test(value)) return null // an offered-tag check runs on every text field
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
      const unknown = unknownMergeTags(t)
      if (unknown.length) return `The merge tag {{${unknown[0]}}} is not available in emails.`
    }
    if (b.type === 'button') {
      const p = urlProblem(b.url)
      if (p) return p
    }
    if (b.type === 'image') {
      const p = urlProblem(b.url)
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

const ESC_LINK_RE = /\[([^\]]+)\]\((https:\/\/[^)\s]+|\{\{[^{}]*\}\})\)/g
const LINK_COLOUR = '#1a1a1a'
const FONT = "'Helvetica Neue', Arial, sans-serif"

function emphasis(escaped) {
  return escaped
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
  const header = `<tr><td align="center" style="padding:28px 24px 20px 24px; border-bottom:1px solid #eeeeee; font-family:${FONT}; font-size:18px; font-weight:bold; color:#111111;">${logo}${name}</td></tr>`
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
