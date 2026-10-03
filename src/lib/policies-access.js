// Who may MANAGE HR policies (publish a version, open /policies/manage).
//
// C141 ORGROLE.2 — MASTER ONLY (Richard, 2 Oct 2026). The `policies` and
// `policy_versions` tables carry no organisation: a published version is the
// current version for every studio in the estate. An organisation admin
// (C18's rule) would therefore publish into OTHER organisations, so the
// organisation-admin rule is not enough here. Everyone keeps /policies
// itself (reading).
//
// One rule for the pages, the "Manage policies" link and
// POST /api/admin/policies/[slug]/versions (UI gating = route rule).
// Pure and import-free so server pages and routes share it.

/** @param {object|null} user  getCurrentUser() result */
export function canManagePolicies(user) {
  return Boolean(user && (user.isMaster === true || user.profileRole === 'master'))
}
