// UN1TSYNC.7 — the masked, client-safe view of a studio's un1t.online
// connection. The ONE place that decides what the connect route's GET/PUT
// say about a connection: the token is never in it (a caller passes the
// normalised connection, this picks the fields), and neither is a run's
// contact_errors (per-person detail the card has no use for).

/** A permission that lets the token change data on un1t.online: `clients:update`, `events:create`, ... */
const WRITE_PERMISSION = /:(create|update|delete)$/

export function hasWritePermissions(permissions) {
  return Array.isArray(permissions) && permissions.some((p) => typeof p === 'string' && WRITE_PERMISSION.test(p))
}

/**
 * @param {object|null} conn  readConnection()'s normalised connection, or the
 *   equivalent fields just written (status, displayName, config, tokenExpiresAt,
 *   lastError, lastOkAt, accessToken, source, isActive)
 * @param {object|null} lastRun  newest un1t_sync_runs row, or null
 */
export function presentUn1tConnection(conn, lastRun = null) {
  const connected = !!conn && conn.source === 'registry' && conn.isActive !== false && !!conn.accessToken
  if (!connected) return { connected: false, status: 'not_connected', last_run: presentRun(lastRun) }
  const cfg = conn.config && typeof conn.config === 'object' ? conn.config : {}
  const permissions = Array.isArray(cfg.permissions) ? cfg.permissions : []
  return {
    connected: true,
    status: conn.status || 'connected',
    studio_title: cfg.studio_title ?? conn.displayName ?? null,
    token_name: cfg.token_name ?? null,
    permissions_count: permissions.length,
    has_write_permissions: hasWritePermissions(permissions),
    expires_at: conn.tokenExpiresAt ?? null,
    last_error: conn.lastError ?? null,
    last_ok_at: conn.lastOkAt ?? null,
    last_run: presentRun(lastRun),
  }
}

function presentRun(run) {
  if (!run) return null
  const c = run.counts && typeof run.counts === 'object' ? run.counts : {}
  const counts = {}
  for (const key of ['pulled', 'contacts', 'memberships']) {
    if (c[key] !== undefined && c[key] !== null) counts[key] = c[key]
  }
  return {
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at ?? null,
    duration_ms: run.duration_ms ?? null,
    first_error: run.first_error ?? null,
    counts,
  }
}
