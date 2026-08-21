// Shared App Router path resolver for guard tests.
//
// Two guards need to answer the same question — "does this URL path have a
// file that answers it?" — and got it wrong in opposite directions before
// this helper existed:
//
//   • src/lib/command-palette.test.js — every href the palette navigates to
//     must be a real page (K5: /events/<id> was a hard 404).
//   • tests/next-rewrites.test.js — every next.config.js rewrite destination
//     must be a real page or route (AUDIT-13.C: /races/:id → /events/:id
//     mapped a 404 to a 404 for three months).
//
// The resolution rules are subtle enough that having two copies would be its
// own drift hazard, which is exactly the defect class both callers exist to
// catch. One implementation, one place.
//
// Rules mirrored from the App Router:
//   • a (route-group) directory does NOT consume a URL segment, so it must
//     be tried both before and interleaved with literal/dynamic matches at
//     every level — and it can hold the terminal page.js itself
//     (src/app/communications/(hub)/page.js is /communications).
//   • a [dynamic] directory matches any single segment, including a
//     :placeholder from a rewrite source pattern.
//   • literal beats group beats dynamic, which is Next's own precedence.

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

export const APP_DIR = path.join(import.meta.dirname, '../../src/app')

export const PAGE_FILES = ['page.js', 'page.jsx']
export const ENDPOINT_FILES = ['page.js', 'page.jsx', 'route.js', 'route.ts']

const isRouteGroup = (name) => /^\(.+\)$/.test(name)
const isDynamic = (name) => /^\[.+\]$/.test(name)

/**
 * @param {string} dir     directory to resolve from
 * @param {string[]} segments  remaining URL segments
 * @param {string[]} files  candidate terminal filenames
 * @returns {string|null} absolute path of the answering file, or null
 */
export function findEndpoint(dir, segments, files = PAGE_FILES) {
  if (segments.length === 0) {
    for (const name of files) {
      const file = path.join(dir, name)
      if (existsSync(file)) return file
    }
  }

  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return null
  }

  if (segments.length > 0) {
    const [segment, ...rest] = segments
    const direct = entries.find((e) => e.name === segment)
    if (direct) {
      const hit = findEndpoint(path.join(dir, direct.name), rest, files)
      if (hit) return hit
    }
  }

  for (const entry of entries) {
    if (isRouteGroup(entry.name)) {
      const hit = findEndpoint(path.join(dir, entry.name), segments, files)
      if (hit) return hit
    }
  }

  if (segments.length > 0) {
    const [, ...rest] = segments
    const dynamic = entries.find((e) => isDynamic(e.name))
    if (dynamic) {
      const hit = findEndpoint(path.join(dir, dynamic.name), rest, files)
      if (hit) return hit
    }
  }

  return null
}

/** Resolve a URL path to its page file (query string ignored). */
export function pageFileFor(urlPath) {
  return findEndpoint(APP_DIR, urlPath.split('?')[0].split('/').filter(Boolean), PAGE_FILES)
}

/** Resolve a URL path to its page OR route handler (query string ignored). */
export function endpointFileFor(urlPath) {
  return findEndpoint(APP_DIR, urlPath.split('?')[0].split('/').filter(Boolean), ENDPOINT_FILES)
}
