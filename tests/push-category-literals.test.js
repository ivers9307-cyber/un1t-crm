// PUSHCAT.1 — a sendPush `category` is the BARE name; push.js adds `notify_`.
//
// WHY THIS TEST EXISTS. `resolvePushAllowedIds` gates on
// `notify_${category}` — it prepends the prefix itself. Three equipment
// senders passed the PERMISSION KEY instead (`category: 'notify_inspection_due'`),
// so the gate resolved `notify_notify_inspection_due`. That key is
// unregistered, and an unregistered key fails CLOSED: `resolvePermission`'s
// last tier is `defaults[role][key] === true`, false for every role that
// holds a profile_locations row. The inspection-day reminder, the overdue
// sweep and the equipment-fault alert therefore reached masters and silently
// nobody else — from the day EQUIP-MAINT.3 shipped, under green tests,
// because each route test asserted the prefixed literal it was written with.
// The comment above each call site even said "Registered in
// MOBILE_PERMISSIONS": the KEY was registered; the category was not the key.
//
// Two halves, because the mistake has two:
//   1. a source scan — no sender spells the prefix into `category`;
//   2. every registered `notify_<category>` routes to a real Android channel,
//      so registering the permission without the channel (the other thing
//      EQUIP-MAINT.3 skipped — both inspection categories fell to the legacy
//      'default' bucket) is a failing test rather than a quiet misfile.
//
// 🔴 IT IS A FLOOR, NOT PROOF. The scan reads string literals: a category
// built from a variable or a template is invisible to it. It also cannot say
// a bare category is REGISTERED — `category:` is an overloaded property name
// here (audit events, expenses, issues all carry one), so "every literal must
// be a notify key" would drown in false positives. The behavioural half lives
// in src/lib/push.test.js, which runs the real resolver.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { MOBILE_PERMISSIONS } from '../shared/permissions.js'
import { ANDROID_CHANNELS, androidChannelId } from '../shared/push-channels.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = /\.(js|jsx|mjs|ts|tsx)$/
const TEST_FILE = /\.test\.(js|jsx|mjs|ts|tsx)$/

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (SOURCE.test(entry.name) && !TEST_FILE.test(entry.name)) out.push(full)
  }
  return out
}

// `category: 'notify_…'` in any quote style, with or without quoted key.
const PREFIXED = /\bcategory['"]?\s*:\s*['"`]notify_[a-z0-9_]*/gi

describe('sendPush categories are bare — push.js prepends notify_ itself', () => {
  it('no sender passes a category that already carries the notify_ prefix', () => {
    const offenders = []
    for (const file of walk(path.join(ROOT, 'src'))) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        for (const m of line.match(PREFIXED) || []) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${m}`)
        }
      })
    }
    expect(
      offenders,
      'a prefixed category gates on notify_notify_<x>, which is unregistered and reaches only masters — pass the bare name'
    ).toEqual([])
  })

  it('every registered notify_<category> routes to a real Android channel, not the legacy default', () => {
    const notifyKeys = MOBILE_PERMISSIONS.filter(p => p.isNotify).map(p => p.key)
    expect(notifyKeys.length).toBeGreaterThan(20) // the scan found something
    const unrouted = notifyKeys
      .map(key => key.replace(/^notify_/, ''))
      .filter(category => androidChannelId({ category }) === 'default')
    expect(unrouted, 'add these to CATEGORY_CHANNELS in shared/push-channels.js').toEqual([])
    for (const key of notifyKeys) {
      expect(Object.keys(ANDROID_CHANNELS)).toContain(androidChannelId({ category: key.replace(/^notify_/, '') }))
    }
  })
})
