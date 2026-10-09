// Who may MANAGE HR policies (publish a version, open /policies/manage).
//
// C141 ORGROLE.2 — MASTER ONLY (Richard, 2 Oct 2026). At the time the
// `policies` and `policy_versions` tables carried no organisation, so an
// organisation admin (C18's rule) would have published into OTHER
// organisations. W0.5 (mig 713, 9 Oct) gave policies an organisation and
// scoped every read; editing stays master-only until the org-admin editor
// wave (Richard's call). Everyone keeps /policies itself (reading, their
// own organisation's).
//
// One rule for the pages, the "Manage policies" link and
// POST /api/admin/policies/[slug]/versions (UI gating = route rule).
// Pure and import-free so server pages and routes share it.

/** @param {object|null} user  getCurrentUser() result */
export function canManagePolicies(user) {
  return Boolean(user && (user.isMaster === true || user.profileRole === 'master'))
}
