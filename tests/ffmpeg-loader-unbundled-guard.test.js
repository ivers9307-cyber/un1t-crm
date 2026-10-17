// FFMPEGLOADER.1 guard. ffmpeg.wasm's loader (@ffmpeg/ffmpeg's FFmpeg class)
// is served from /public/ffmpeg and imported by URL at runtime, never bundled:
// Next 16.4's Turbopack resolves dist/esm/classes.js's
// `new Worker(new URL(<runtime value>, import.meta.url))` at build time and
// fails the build ("Module not found", #2029). Pinned here:
//
//  1. No src/, shared/ or mobile/ file imports '@ffmpeg/ffmpeg' (static,
//     dynamic, require, re-export) — one bundled import puts classes.js back
//     in the graph. Comments are blanked first (tests/helpers/js-code.js).
//  2. scripts/copy-ffmpeg-core.mjs copies every file the loader and the
//     worker import, transitively, so /ffmpeg/index.js never 404s a sibling.
//  3. src/lib/video-compress.js imports the loader by URL with both bundler
//     ignore hints, and the URL is /ffmpeg/index.js.
// A floor, not a proof: an import built from a variable is invisible to (1).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { stripCommentsOfFile, stripComments } from './helpers/js-code.js'
import { ffmpegLoaderURL } from '../src/lib/video-compress.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'node_modules/@ffmpeg/ffmpeg/dist/esm')
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full)
  }
  return out
}

const BUNDLED = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"`]@ffmpeg\/ffmpeg(?:\/[^'"`]*)?['"`]/g
/** Every bundled import of @ffmpeg/ffmpeg in already-stripped code. */
export const bundledFfmpegImports = (code) => [...code.matchAll(BUNDLED)].map((m) => m[0])

/** Relative imports of an ESM file in the installed dist. */
function relImports(file) {
  const src = readFileSync(path.join(DIST, file), 'utf8')
  return [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.\/[^'"]+)['"]/g)].map((m) => m[1].slice(2))
}
function closure(entries) {
  const seen = new Set()
  const stack = [...entries]
  while (stack.length) {
    const f = stack.pop()
    if (seen.has(f)) continue
    seen.add(f)
    stack.push(...relImports(f))
  }
  return [...seen].sort()
}

/** The dest filenames scripts/copy-ffmpeg-core.mjs copies from @ffmpeg/ffmpeg/dist/esm. */
function copiedLoaderFiles() {
  const src = readFileSync(path.join(ROOT, 'scripts/copy-ffmpeg-core.mjs'), 'utf8')
  return [...src.matchAll(/\[\s*'node_modules\/@ffmpeg\/ffmpeg\/dist\/esm\/([^']+)',\s*'([^']+)'\s*\]/g)]
    .map((m) => { expect(m[2], `copied ${m[1]} under another name`).toBe(m[1]); return m[1] })
    .sort()
}

describe('ffmpeg.wasm loader stays unbundled (FFMPEGLOADER.1)', () => {
  it('no src/, shared/ or mobile/ file imports @ffmpeg/ffmpeg through the bundler', () => {
    const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]
    expect(files.length).toBeGreaterThan(500) // not vacuous
    const offenders = []
    for (const f of files) for (const hit of bundledFfmpegImports(stripCommentsOfFile(f))) offenders.push(`${rel(f)}: ${hit}`)
    expect(offenders, "import the loader by URL (ffmpegLoaderURL in src/lib/video-compress.js); a bundled '@ffmpeg/ffmpeg' fails next build on Next 16.4+").toEqual([])
  })

  it('the detector catches every import shape and ignores comments, other packages and the URL import', () => {
    const bad = [
      "import { FFmpeg } from '@ffmpeg/ffmpeg'",
      'const { FFmpeg } = await import("@ffmpeg/ffmpeg")',
      "const m = await import( '@ffmpeg/ffmpeg' )",
      "const f = require('@ffmpeg/ffmpeg')",
      "export * from '@ffmpeg/ffmpeg'",
      "import '@ffmpeg/ffmpeg'",
      "import { FFmpeg } from '@ffmpeg/ffmpeg/dist/esm/index.js'",
    ]
    for (const code of bad) expect(bundledFfmpegImports(stripComments(code)), code).not.toEqual([])
    const ok = [
      "const { fetchFile } = await import('@ffmpeg/util')",
      "import core from '@ffmpeg/core'",
      'const { FFmpeg } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ ffmpegLoaderURL(origin))',
      "// const { FFmpeg } = await import('@ffmpeg/ffmpeg')",
      "/* import { FFmpeg } from '@ffmpeg/ffmpeg' */",
      "const label = 'see node_modules/@ffmpeg/ffmpeg/dist/esm/classes.js line ~105'",
    ]
    for (const code of ok) expect(bundledFfmpegImports(stripComments(code)), code).toEqual([])
  })

  it('the postinstall copy covers every file the loader and the worker import, transitively', () => {
    expect(existsSync(path.join(DIST, 'index.js')), '@ffmpeg/ffmpeg dist layout moved').toBe(true)
    const needed = closure(['index.js', 'worker.js'])
    expect(needed).toEqual(expect.arrayContaining(['classes.js', 'const.js', 'errors.js', 'index.js', 'types.js', 'utils.js', 'worker.js']))
    const copied = copiedLoaderFiles()
    expect(needed.filter((f) => !copied.includes(f)), 'add it to scripts/copy-ffmpeg-core.mjs').toEqual([])
  })

  it('video-compress imports the loader by URL with both bundler ignore hints', () => {
    const src = stripCommentsOfFile(path.join(ROOT, 'src/lib/video-compress.js'))
    const raw = readFileSync(path.join(ROOT, 'src/lib/video-compress.js'), 'utf8')
    expect(src).toMatch(/await import\(\s*ffmpegLoaderURL\(origin\)\s*\)/)
    // The hints are comments, so they are read from the raw source (a plain
    // string match: a regex over comment delimiters reads as a stripper to
    // tests/comment-strip-meta-guard.test.js).
    expect(raw).toContain('import(/* webpackIgnore: true */ /* turbopackIgnore: true */ ffmpegLoaderURL(origin))')
    expect(ffmpegLoaderURL('https://crm.example.invalid')).toBe('https://crm.example.invalid/ffmpeg/index.js')
  })
})
