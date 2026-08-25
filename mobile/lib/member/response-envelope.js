// Shared 200-body guard for the mobile HTTP helpers (api / crmApi).
// A success body is acceptable only when it is a non-null object carrying one
// of the recognised envelope keys. Dependency-free on purpose so the contract
// test can import it under node without pulling Expo modules.
export function isAcceptableSuccessBody(json) {
  return (
    typeof json === 'object' &&
    json !== null &&
    ('success' in json || 'ok' in json || 'data' in json)
  )
}
