// MCP.1 — every agent tool, in the order of the MCP.1 design's tool list.
// A new tool module is added here exactly once (tests/agent-tools-guard.test.js).

import whoami from './whoami.js'
import getShifts from './get-shifts.js'
import getTimeOff from './get-time-off.js'
import getHolidayAllowance from './get-holiday-allowance.js'
import listStaff from './list-staff.js'
import listShiftTemplates from './list-shift-templates.js'
import createShift from './create-shift.js'
import staffHoursReport from './staff-hours-report.js'
import staffCostReport from './staff-cost-report.js'

/** @type {ReadonlyArray<ReturnType<typeof import('./registry.js').defineTool>>} */
export const TOOLS = Object.freeze([
  whoami,
  getShifts,
  getTimeOff,
  getHolidayAllowance,
  listStaff,
  listShiftTemplates,
  createShift,
  staffHoursReport,
  staffCostReport,
])
