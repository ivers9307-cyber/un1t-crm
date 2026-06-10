// Transport-agnostic SDK core shared by web + mobile.
//
// A "transport" is base URL + per-call auth headers + a fetch impl.
// Web injects a same-origin cookie transport; mobile injects the
// Bearer-JWT authHeaders() transport. Domain modules (me, staff, …)
// are layered on top by buildSdk(); this file is only the request
// primitive and the { success, data?, error?, issues? } envelope
// normalisation, so every caller — web component or RN screen —
// handles responses identically.

export function createTransport(options = {}) {
  const { baseUrl = '', getAuthHeaders, fetchImpl } = options
  // Only fall back to globalThis.fetch when fetchImpl was not supplied at all
  // (key absent from options). An explicit null/false means "no fetch".
  const doFetch = 'fetchImpl' in options ? fetchImpl : (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined)
  if (typeof doFetch !== 'function') {
    throw new TypeError('createTransport: no fetch implementation available')
  }
  const resolveHeaders =
    typeof getAuthHeaders === 'function'
      ? getAuthHeaders
      : ({ json }) => ({ Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}) })

  return async function request(path, { method = 'GET', body, locationId } = {}) {
    const hasBody = body != null
    const headers = await resolveHeaders({ json: hasBody, locationId })

    let res
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        credentials: 'include', // web cookie auth; harmless on RN
        body: hasBody ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      return { success: false, error: `Network error: ${err?.message || err}` }
    }

    let json
    try {
      json = await res.json()
    } catch {
      return { success: false, error: `Non-JSON response (${res.status})` }
    }

    if (!res.ok && json?.success !== false) {
      return { success: false, error: json?.error || `HTTP ${res.status}` }
    }
    return json
  }
}

// Assemble the domain method objects over a resolved `request` fn.
// New domains get one import + one line here.
export function buildSdk(request, domains) {
  const sdk = { request }
  for (const [name, factory] of Object.entries(domains)) {
    sdk[name] = factory(request)
  }
  return sdk
}
