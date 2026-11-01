// MCP.1 — the date-range rule the roster and report tools share. Not a tool
// (tests/agent-tools-guard.test.js NOT_TOOLS).
//
// A bad or too-wide range is a zod issue, so runTool answers `invalid_input`
// with the cap named before any read. The check is `reportPeriodError`, the
// rule the in-app assistant and the Reporting tab apply (real calendar dates,
// end not before start, at most `maxDays` days). Wall-clock dates stay
// `YYYY-MM-DD`; nothing here parses them as instants.

import { z } from 'zod'
import { reportPeriodError } from '@/lib/report-period'

/** The `start` and `end` fields of a range input. */
export const rangeFields = {
  start: z.string().describe('First day, YYYY-MM-DD, on the studio\'s calendar.'),
  end: z.string().describe('Last day (inclusive), YYYY-MM-DD, on the studio\'s calendar.'),
}

/**
 * A superRefine callback for an object with `start` and `end`.
 * @param {{ maxDays: number, what: string }} opts `what` is the noun in the message ("A shift lookup")
 */
export function checkRange({ maxDays, what }) {
  return (value, ctx) => {
    const message = reportPeriodError(value.start, value.end, { startName: 'start', endName: 'end', maxDays, what })
    if (message) ctx.addIssue({ code: 'custom', message })
  }
}
