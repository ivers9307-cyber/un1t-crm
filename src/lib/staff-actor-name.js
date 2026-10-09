// Who did it, as a name for history rows (a move, a settlement, a waitlist
// removal, an agent-approved move). Under impersonation (a master acting as
// someone, see getCurrentUser's impersonatingFrom) the REAL caller is named,
// "<master> as <user>", so the history reads true. One copy; it used to be
// pasted into each route.

/**
 * @param {object|null|undefined} user  getCurrentUser()'s answer
 * @returns {string}
 */
export function staffActorName(user) {
  const userName = user?.full_name || user?.email || 'staff'
  const imp = user?.impersonatingFrom
  if (imp?.masterId) return `${imp.masterName || imp.masterEmail || 'master'} as ${userName}`
  return userName
}
