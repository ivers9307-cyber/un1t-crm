// PIPEBUILD.2c — the studio's pipeline stages (slug, name, colour, role) for
// client components, so a board built in the editor renders without code.
// One fetch per locationId per page load (module-level promise cache).
import { useEffect, useMemo, useState } from 'react'

const cache = new Map()

export function resetStudioStagesCache() {
  cache.clear()
}

function load(locationId) {
  if (!cache.has(locationId)) {
    const p = fetch(`/api/locations/${locationId}/stages`)
      .then(async (res) => {
        const body = await res.json().catch(() => null)
        if (!res.ok || !body?.success || !Array.isArray(body.data?.stages)) throw new Error('stages unreadable')
        return body.data.stages
      })
      .catch((err) => {
        cache.delete(locationId) // a failure is not cached: the next mount retries
        throw err
      })
    cache.set(locationId, p)
  }
  return cache.get(locationId)
}

const EMPTY = new Map()

/** @returns {{ stages: Array|null, bySlug: Map<string, object>, error: boolean }} */
export function useStudioStages(locationId) {
  const [state, setState] = useState({ locationId: null, stages: null, error: false })

  useEffect(() => {
    if (!locationId) return undefined
    let live = true
    load(locationId).then(
      (stages) => { if (live) setState({ locationId, stages, error: false }) },
      () => { if (live) setState({ locationId, stages: null, error: true }) },
    )
    return () => { live = false }
  }, [locationId])

  const current = state.locationId === locationId ? state : { stages: null, error: false }
  const bySlug = useMemo(
    () => (current.stages ? new Map(current.stages.map((s) => [s.slug, s])) : EMPTY),
    [current.stages],
  )
  return { stages: current.stages, bySlug, error: current.error }
}
