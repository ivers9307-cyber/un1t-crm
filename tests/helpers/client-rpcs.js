// The public functions a signed-in client session may call (FNEXECSWEEP.1, mig
// 667): the only ones authenticated holds EXECUTE on. Add one only with its
// GRANT, in the same PR. Read by tests/function-execute-guard.test.js (every
// client .rpc() is on it; its latest CREATE grants it) and
// tests/closed-table-escapes-guard.test.js (none is a SECURITY DEFINER writer
// of a closed table).
export const CLIENT_RPCS = Object.freeze(['list_enabled_integrations', 'scan_straps_for_contact'])
