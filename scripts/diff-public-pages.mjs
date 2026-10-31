#!/usr/bin/env node
/**
 * Before/after diff of the public marketing pages (PAGES.1).
 *
 *   node scripts/diff-public-pages.mjs --before <origin> --after <origin> <path> [<path> …]
 *
 * Example (production old code vs the branch on a dev server, same database):
 *   node scripts/diff-public-pages.mjs --before https://crm.un1tdublin.com \
 *     --after http://localhost:3000 /trial /50plus /corp "/trial?studio=hatch" \
 *     "/start?utm_campaign=x" /free-class
 *
 * For each path both origins are fetched (GET only, redirects NOT followed, so
 * a 3xx is reported as status + location) and the script compares:
 *   - the final status and the `location` header (path + query; the origin is
 *     ignored),
 *   - the visible text (scripts/styles/tags stripped, whitespace folded),
 *   - every `src`, `poster` and `href` attribute value (own origins stripped,
 *     `/_next/` assets, `data:` URIs and `?edit=` / `?_rsc=` noise dropped).
 *
 * Exit code 1 when any path differs (a network error counts as a difference),
 * else 0. Nothing is written anywhere.
 */

import { pathToFileURL } from 'node:url'

const OWN_HOST_RE =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|(?:[a-z0-9-]+\.)*(?:un1tdublin\.com|ccfautos\.com))(?::\d+)?(?=[/?#]|$)/i

const NOISE_PARAMS = new Set(['edit', '_rsc'])

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Visible text of an HTML document: no scripts/styles/tags, entities decoded, whitespace folded. */
export function visibleText(html) {
  const stripped = String(html ?? '')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim()
}

/** Normalise one attribute value; returns null when it should be ignored. */
function normaliseRef(raw, ownOrigins) {
  let v = decodeEntities(raw).trim()
  if (!v || /^data:/i.test(v)) return null
  for (const o of ownOrigins) {
    const origin = o.replace(/\/+$/, '')
    if (origin && v.toLowerCase().startsWith(origin.toLowerCase()) && /^([/?#]|$)/.test(v.slice(origin.length))) {
      v = v.slice(origin.length) || '/'
      break
    }
  }
  v = v.replace(OWN_HOST_RE, '') || '/'
  // next/image proxies the real media path through a query parameter; compare that.
  if (v.startsWith('/_next/image')) {
    const target = new URL(v, 'http://x').searchParams.get('url')
    if (!target) return null
    return normaliseRef(target, ownOrigins)
  }
  if (v.startsWith('/_next/')) return null
  const hashAt = v.indexOf('#')
  const hash = hashAt === -1 ? '' : v.slice(hashAt)
  const noHash = hashAt === -1 ? v : v.slice(0, hashAt)
  const qAt = noHash.indexOf('?')
  if (qAt === -1) return v
  const path = noHash.slice(0, qAt)
  const kept = noHash
    .slice(qAt + 1)
    .split('&')
    .filter((p) => p && !NOISE_PARAMS.has(p.split('=')[0]))
  return path + (kept.length ? `?${kept.join('&')}` : '') + hash
}

/** Sorted, de-duplicated src/poster/href values with origin and framework noise removed. */
export function mediaRefs(html, ownOrigins = []) {
  const re = /(?<![\w-])(?:src|poster|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
  const out = new Set()
  let m
  while ((m = re.exec(String(html ?? '')))) {
    const ref = normaliseRef(m[1] ?? m[2] ?? '', ownOrigins)
    if (ref) out.add(ref)
  }
  return [...out].sort()
}

/**
 * Sequence diff (LCS) of two line lists. `onlyBefore` / `onlyAfter` keep order
 * and multiplicity, so a dropped duplicate or a reordered pair is reported.
 */
export function diffLines(a, b) {
  const n = a.length
  const m = b.length
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const onlyBefore = []
  const onlyAfter = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      onlyBefore.push(a[i++])
    } else {
      onlyAfter.push(b[j++])
    }
  }
  while (i < n) onlyBefore.push(a[i++])
  while (j < m) onlyAfter.push(b[j++])
  return { onlyBefore, onlyAfter }
}

const sentences = (text) =>
  String(text ?? '')
    .split(/(?<=[.!?])\s+|\n/)
    .map((s) => s.trim())
    .filter(Boolean)

/** Human-read line diff of two texts: `- ` lines only before, `+ ` lines only after. */
export function diffText(a, b) {
  const { onlyBefore, onlyAfter } = diffLines(sentences(a), sentences(b))
  return [...onlyBefore.map((l) => `- ${l}`), ...onlyAfter.map((l) => `+ ${l}`)]
}

function locationKey(location) {
  if (!location) return null
  const u = new URL(location, 'http://placeholder.invalid')
  return u.pathname + u.search
}

function sideLabel(side, loc) {
  return loc ? `${side.status} ${loc}` : String(side.status)
}

/** Compare two fetched sides `{ status, location, html }`. */
export function compare(before, after, { origins = [] } = {}) {
  const locB = locationKey(before.location)
  const locA = locationKey(after.location)
  const statusLine = `${sideLabel(before, locB)} → ${sideLabel(after, locA)}`
  const textDiff = diffText(visibleText(before.html), visibleText(after.html))
  const media = diffLines(mediaRefs(before.html, origins), mediaRefs(after.html, origins))
  const same =
    before.status === after.status &&
    locB === locA &&
    textDiff.length === 0 &&
    media.onlyBefore.length === 0 &&
    media.onlyAfter.length === 0
  return { same, statusLine, textDiff, media }
}

async function fetchSide(origin, path) {
  const url = new URL(path, origin.endsWith('/') ? origin : `${origin}/`)
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: { 'User-Agent': 'un1t-crm diff-public-pages', Accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  })
  const html = res.status >= 300 && res.status < 400 ? '' : await res.text()
  return { status: res.status, location: res.headers.get('location'), html }
}

function parseArgs(argv) {
  const opts = { before: null, after: null, paths: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--before') opts.before = argv[++i]
    else if (a === '--after') opts.after = argv[++i]
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else opts.paths.push(a)
  }
  if (!opts.before || !opts.after || opts.paths.length === 0) {
    throw new Error(
      'usage: node scripts/diff-public-pages.mjs --before <origin> --after <origin> <path> [<path> …]',
    )
  }
  return opts
}

export async function main(argv = process.argv.slice(2), write = (s) => process.stdout.write(s)) {
  const { before, after, paths } = parseArgs(argv)
  const origins = [before, after]
  let differ = 0
  for (const path of paths) {
    write(`=== ${path}\n`)
    let result
    try {
      const [b, a] = await Promise.all([fetchSide(before, path), fetchSide(after, path)])
      result = compare(b, a, { origins })
    } catch (err) {
      write(`!! ${path}: ${err?.cause?.message ?? err?.message ?? err}\n`)
      differ++
      continue
    }
    write(`${result.statusLine}\n`)
    if (result.textDiff.length) write(`${result.textDiff.join('\n')}\n`)
    const { onlyBefore, onlyAfter } = result.media
    if (onlyBefore.length || onlyAfter.length) {
      write(
        `${[...onlyBefore.map((l) => `- ${l}`), ...onlyAfter.map((l) => `+ ${l}`)].join('\n')}\n`,
      )
    }
    if (!result.same) differ++
  }
  write(`${paths.length} paths, ${differ} differ\n`)
  return differ ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err.message}\n`)
      process.exit(2)
    },
  )
}
