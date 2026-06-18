// src/lib/hr-detections.js
//
// HR-DETECT.1 — durable "detected HR" log. Pure planning core + best-effort IO
// (IO functions added in a later task). Recording is anchored on
// /api/bridge/samples (the always-on stream that sees every broadcasting strap,
// paired or not) and enriched from /api/bridge/scan.
//
// Two tables (mig 292):
//   hr_detections        — rolling registry, one row per (location_id, device_key)
//   hr_detection_visits  — appearance history, one row per contiguous visit
//
// A "visit" is a run of detections with gaps < DETECTION_VISIT_GAP_MS. It closes
// implicitly (no cron) once last_sample_at goes stale; the next sample opens a new one.

import { randomUUID } from 'node:crypto'
import { canonicaliseDeviceKey } from './bridge-samples'

export const DETECTION_VISIT_GAP_MS = 5 * 60 * 1000

function protocolForKey(key) {
  return typeof key === 'string' && key.startsWith('ant:') ? 'ant' : 'ble'
}

/**
 * Collapse a raw samples batch into one entry per canonical device_key.
 * @param {Array<{device_key:string, recorded_at?:string, bpm?:number}>} samples
 * @returns {Array<{deviceKey:string, latestBpm:number|null, peakBpm:number|null,
 *   count:number, latestAt:string|null, name:null, rssi:null}>}
 */
export function aggregateSamplesByDevice(samples = []) {
  const byKey = new Map()
  for (const s of samples || []) {
    const key = canonicaliseDeviceKey(s?.device_key)
    if (!key) continue
    const bpm = Number.isFinite(s?.bpm) ? s.bpm : null
    const at = typeof s?.recorded_at === 'string' ? s.recorded_at : null
    const cur = byKey.get(key) || {
      deviceKey: key, latestBpm: null, peakBpm: null, count: 0, latestAt: null, name: null, rssi: null,
    }
    cur.count += 1
    if (bpm != null) {
      cur.peakBpm = cur.peakBpm == null ? bpm : Math.max(cur.peakBpm, bpm)
      if (cur.latestAt == null || (at && at >= cur.latestAt)) { cur.latestBpm = bpm; cur.latestAt = at }
    } else if (at && (cur.latestAt == null || at >= cur.latestAt)) {
      cur.latestAt = at
    }
    byKey.set(key, cur)
  }
  return [...byKey.values()]
}

/**
 * Pure planner: given the existing registry + current visits + this batch's
 * per-device aggregate, produce the rows to upsert. No IO. Deterministic when
 * `newId` is injected.
 *
 * @returns {{ registryRows: object[], visitRows: object[] }}
 */
export function planDetectionWrites({
  existingDetections = [],
  existingVisits = [],
  entries = [],
  locationId,
  nowMs,
  nowIso,
  gapMs = DETECTION_VISIT_GAP_MS,
  liveClass = null,
  bridgeId = null,
  touchVisits = true,
  newId = randomUUID,
} = {}) {
  const detByKey = new Map(existingDetections.map((d) => [d.device_key, d]))
  const visitById = new Map(existingVisits.map((v) => [v.id, v]))
  const registryRows = []
  const visitRows = []

  for (const e of entries) {
    const key = e?.deviceKey
    if (!key) continue
    const existing = detByKey.get(key)
    const detId = existing?.id ?? newId()
    const firstSeenAt = existing?.first_seen_at ?? nowIso
    const mergedBpm = e.latestBpm ?? existing?.last_bpm ?? null
    const mergedName = e.name ?? existing?.last_name ?? null
    const mergedRssi = e.rssi != null ? e.rssi : (existing?.last_rssi ?? null)
    let visitCount = existing?.visit_count ?? 0
    let currentVisitId = existing?.current_visit_id ?? null

    if (touchVisits) {
      const cur = currentVisitId ? visitById.get(currentVisitId) : null
      const lastSampleMs = cur?.last_sample_at ? Date.parse(cur.last_sample_at) : null
      const openNew = !cur || lastSampleMs == null || (nowMs - lastSampleMs > gapMs)
      if (openNew) {
        const vid = newId()
        visitCount += 1
        currentVisitId = vid
        visitRows.push({
          id: vid, detection_id: detId, location_id: locationId, device_key: key,
          started_at: nowIso, last_sample_at: nowIso,
          peak_bpm: e.peakBpm ?? null, last_bpm: e.latestBpm ?? null,
          sample_count: e.count ?? 0,
          glofox_event_id: liveClass?.glofox_event_id ?? null,
          class_name: liveClass?.class_name ?? null,
        })
      } else {
        visitRows.push({
          id: currentVisitId, detection_id: detId, location_id: locationId, device_key: key,
          started_at: cur.started_at,
          last_sample_at: nowIso,
          peak_bpm: Math.max(cur.peak_bpm ?? 0, e.peakBpm ?? 0) || null,
          last_bpm: e.latestBpm ?? cur.last_bpm ?? null,
          sample_count: (cur.sample_count ?? 0) + (e.count ?? 0),
          glofox_event_id: cur.glofox_event_id ?? null,
          class_name: cur.class_name ?? null,
        })
      }
    }

    registryRows.push({
      id: detId, location_id: locationId, device_key: key, protocol: protocolForKey(key),
      first_seen_at: firstSeenAt, last_seen_at: nowIso,
      last_bpm: mergedBpm, last_name: mergedName, last_rssi: mergedRssi,
      last_bridge_id: bridgeId,
      visit_count: visitCount, current_visit_id: currentVisitId,
      updated_at: nowIso,
    })
  }

  return { registryRows, visitRows }
}
