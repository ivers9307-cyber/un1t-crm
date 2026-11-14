// APPROVALSQ.1 guard: the AI agent (src/lib/agent/) and the MCP tools
// (src/lib/agent-tools/) must never clear a request quietly. The quiet clear
// (`silent: true` with a decline) is a staff-only action on the PATCH
// /api/agent/membership-requests/[id] route. If code in either directory sent
// it, or wrote a `cleared:` marker, a request could vanish with no customer
// message and no human decision behind it.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const DIRS = ['src/lib/agent', 'src/lib/agent-tools']

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.jsx?$/.test(entry.name) && !/\.test\.|\.test-helpers\./.test(entry.name)) out.push(full)
  }
  return out
}

// APPROVALSQ.5: undo_clear is the staff-only undo of a quiet clear.
const FORBIDDEN = [/silent:\s*true/, /\bcleared\s*:/, /undo_clear/]

describe('agent and MCP tools never clear a request quietly', () => {
  for (const dir of DIRS) {
    const files = walk(path.join(ROOT, dir))

    it(`${dir} has source files to scan`, () => {
      expect(files.length).toBeGreaterThan(0)
    })

    it(`${dir} never sends silent: true, writes a cleared: key or names undo_clear`, () => {
      const offenders = files
        .filter((f) => {
          const src = fs.readFileSync(f, 'utf8')
          return FORBIDDEN.some((re) => re.test(src))
        })
        .map((f) => path.relative(ROOT, f))
      expect(offenders).toEqual([])
    })
  }
})
