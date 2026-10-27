// USAGE.1 — every staff route has an app usage feature key.
//
// A new top-level route (web) or screen folder (phone) that resolves to
// `other` fails here until it is mapped in shared/usage-features.js or
// listed below with a reason. Otherwise the report quietly files a whole new
// feature under "Other".

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { featureForWebPath, featureForPhonePath } from '../shared/usage-features.js'

const ROOT = path.resolve(__dirname, '..')

// Public, signed-out or member-facing routes the staff tracker never runs on
// (it mounts only for a signed-in staff user, and these are public paths in
// src/proxy.js / AppShell or not pages at all).
const WEB_NOT_STAFF = new Set([
  'api', 'auth', 'login', 'reset-password', 'book', 'event', 'event-pay', 'race', 'race-pay',
  'class-pay', 'tv', 'present', 'unsubscribe', 'preferences', 'view-email', 'deposit', 'welcome',
  'free-class', 'start', 'trial', 'offers', 'privacy', 'terms', 'legal', 'technical',
  'account-deletion', 'givers', 'studio-login', 'embed', 'bca', 'host-connect', 'host', 'h',
  'use-the-app', 'cancel', 'pay-done',
])

// Staff routes deliberately filed under `other`, with the reason.
const WEB_UNCATEGORISED = {}
const PHONE_UNCATEGORISED = {}

function routeDirs(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('(') && entry.name.endsWith(')')) {
      out.push(...routeDirs(path.join(dir, entry.name)))
    } else if (!entry.name.startsWith('[') && !entry.name.startsWith('_')) {
      out.push(entry.name)
    }
  }
  return out
}

function phoneRoutes(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('(') && entry.name.endsWith(')')) {
      if (entry.name === '(auth)') continue
      out.push(...phoneRoutes(path.join(dir, entry.name)))
      continue
    }
    if (entry.name.startsWith('_') || entry.name.startsWith('[') || entry.name.includes('.test.')) continue
    const name = entry.isDirectory() ? entry.name : entry.name.replace(/\.jsx?$/, '')
    out.push(name === 'index' ? '' : name)
  }
  return out
}

describe('app usage feature coverage', () => {
  it('every staff web route resolves to a feature', () => {
    const missing = routeDirs(path.join(ROOT, 'src/app'))
      .filter((name) => !WEB_NOT_STAFF.has(name) && !(name in WEB_UNCATEGORISED))
      .filter((name) => featureForWebPath(`/${name}`) === 'other')
    expect(missing).toEqual([])
  })

  it('every staff phone screen resolves to a feature', () => {
    const missing = phoneRoutes(path.join(ROOT, 'mobile/app/(staff)'))
      .filter((name) => !(name in PHONE_UNCATEGORISED))
      .filter((name) => featureForPhonePath(`/${name}`) === 'other')
    expect(missing).toEqual([])
  })
})
