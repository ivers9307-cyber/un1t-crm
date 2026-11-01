// MCP.1 — every agent tool, in the order of the MCP.1 design's tool list.
// A new tool module is added here exactly once (tests/agent-tools-guard.test.js).

import whoami from './whoami.js'

/** @type {ReadonlyArray<ReturnType<typeof import('./registry.js').defineTool>>} */
export const TOOLS = Object.freeze([
  whoami,
])
