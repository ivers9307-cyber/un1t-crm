// W1.S* — the UN1T literal sweep guard (SaaS Wave 1, decision 5).
//
// Every sweep PR appends the files it cleaned to SWEPT; the guard reads each
// one, strips comments, removes the Appendix "keep" literals listed in KEEP,
// and fails on any remaining "UN1T". A later PR can therefore not reintroduce
// a customer- or staff-visible UN1T literal into a swept file: the tenant's
// brand arrives through getLocationBranding / productName / the location's
// own name (plan: docs/superpowers/plans/2026-10-10-saas-wave1-identity.md,
// Track S). The match is case-sensitive on purpose: `un1t-` CSS tokens, env
// names and package ids are internal identifiers, not copy.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// W1.S3 — Mia prompts, WhatsApp merge fields, the assistant and hyrox prompts.
const SWEPT = [
  'src/lib/agent/core.js',
  'src/lib/agent/default-copy.js',
  'src/lib/agent/welcome-greeting.js',
  'src/lib/agent/prompt.js',
  'src/lib/agent/approval-suggest.js',
  'src/lib/agent/followups.js',
  'src/lib/agent/auto-reply.js',
  'src/lib/churn-winback.js',
  'src/lib/whatsapp.js',
  'src/lib/sequences/steps.js',
  'src/lib/communications/compose.js',
  'src/components/WABroadcastEditor.jsx',
  'src/app/api/settings/customer-agent/route.js',
  'src/app/settings/customer-agent/CustomerAgentClient.jsx',
  'src/lib/assistant-prompt.js',
  'src/lib/hyrox/prompt.js',
  'src/lib/hyrox/expand-runner.js',
  'src/lib/hyrox/generate-block.js',
  'src/app/api/hyrox/blocks/[id]/expand/route.js',
  'src/app/api/hyrox/sessions/[id]/regenerate/route.js',
]

// Appendix rows marked `keep`: UN1T-specific by design. None in W1.S3.
const KEEP = {}

const stripComments = (s) => s
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('UN1T literal sweep (W1.S*)', () => {
  it.each(SWEPT)('%s carries no customer/staff-visible UN1T literal', (file) => {
    const src = stripComments(readFileSync(resolve(process.cwd(), file), 'utf8'))
    const allowed = KEEP[file] || []
    const stripped = allowed.reduce((s, lit) => s.split(lit).join(''), src)
    const hits = stripped.split('\n').map((l, i) => (/UN1T/.test(l) ? `${i + 1}: ${l.trim()}` : null)).filter(Boolean)
    expect(hits, `${file} still carries UN1T on:\n${hits.join('\n')}`).toEqual([])
  })
})
