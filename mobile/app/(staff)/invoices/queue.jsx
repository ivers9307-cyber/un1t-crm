// INV-M.1 — mobile bookkeeper queue. Lean counterpart of the web
// /invoices inbox for the two things worth doing from a phone:
//
//   • Multi-select + "Extract selected" (INV-BULK.4 parity) — tap
//     rows still awaiting extraction to select them, then run the
//     same hybrid the web uses: the first few synchronously via
//     /api/invoices-inbox/bulk-analyse, the rest queued to the
//     background drainer via /bulk-queue-analysis.
//   • A red "Not in Xero" chip (XERO-CONTACT-RED.1 parity) on rows
//     whose Xero supplier contact is unresolved — read-only here;
//     matching/creating the supplier stays a web-inbox job.
//
// Everything else (PDF review, field edits, send-to-Xero) stays on
// the web inbox by design. Gated by the cross-platform `bookkeeper`
// permission — the same key the bulk routes enforce server-side.
import { useState, useCallback, useMemo, useEffect } from 'react'
import { View, Text, ScrollView, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { Stack, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { listInvoicesQueue, bulkAnalyse, bulkQueueAnalysis } from '../../../lib/invoices-queue-api'
import {
  isExtractable,
  splitExtractIds,
  xeroSupplierUnresolved,
  mergeExtractCounts,
  queueStatusMeta,
  SOURCE_LABEL,
} from '../../../lib/invoices-queue'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

// Literal class strings per tone — NativeWind needs them statically
// analysable. Light-theme chip recipe: bg-<c>-500/20 + text-<c>-700.
const TONE_STYLE = {
  amber:  { bg: 'bg-amber-500/20',  text: 'text-amber-700',  color: '#D97706' },
  blue:   { bg: 'bg-blue-500/20',   text: 'text-blue-700',   color: '#2563EB' },
  purple: { bg: 'bg-purple-500/20', text: 'text-purple-700', color: '#7C3AED' },
  slate:  { bg: 'bg-slate-500/20',  text: 'text-slate-700',  color: '#64748B' },
}

const SUMMARY_LABEL = { extracted: 'extracted', failed: 'failed', skipped: 'skipped', queued: 'queued' }

function formatReceivedAt(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function amountLabel(fields) {
  const total = Number(fields?.total)
  if (!Number.isFinite(total)) return null
  const cur = fields?.currency
  return !cur || cur === 'EUR' ? `€${total.toFixed(2)}` : `${cur} ${total.toFixed(2)}`
}

export default function BookkeeperQueue() {
  const { profile, activeLocation } = useAuth()
  // Same key the bulk routes enforce server-side (top-level web
  // permission, resolved cross-platform via canDashboard).
  const canView = canMobile(profile, 'bookkeeper', activeLocation)

  const [rows, setRows] = useState([])
  const [selected, setSelected] = useState(() => new Set())
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [summary, setSummary] = useState(null)

  const load = useCallback(async () => {
    const r = await listInvoicesQueue({ locationId: activeLocation?.id })
    if (r.success === false) { setError(r.error || 'Failed to load'); setRows([]); return }
    setError(null)
    setRows(Array.isArray(r.data) ? r.data : [])
  }, [activeLocation?.id])

  useFocusEffect(useCallback(() => {
    if (!canView) { setLoading(false); return }
    load().finally(() => setLoading(false))
  }, [canView, load]))

  // INV-BULK.3 parity — while any visible row is queued or mid-analysis,
  // silently re-fetch every 5s so the queue visibly drains.
  const queueActive = useMemo(
    () => rows.some((r) => r.analysis_queued_at && ['received', 'quality_approved'].includes(r.status)),
    [rows],
  )
  useEffect(() => {
    if (!queueActive) return undefined
    const t = setInterval(() => { load() }, 5000)
    return () => clearInterval(t)
  }, [queueActive, load])

  const extractableRows = useMemo(() => rows.filter(isExtractable), [rows])
  const selectedExtractableIds = useMemo(
    () => extractableRows.filter((r) => selected.has(r.id)).map((r) => r.id),
    [extractableRows, selected],
  )
  const allSelected = extractableRows.length > 0 && extractableRows.every((r) => selected.has(r.id))
  const anyUnresolved = useMemo(() => rows.some(xeroSupplierUnresolved), [rows])

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(extractableRows.map((r) => r.id)))
  }

  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false) }

  async function extractSelected() {
    const ids = selectedExtractableIds
    if (!ids.length || busy) return
    setBusy(true)
    setError(null)
    setSummary(null)
    // Queue the overflow FIRST (instant, no-timeout), then run the small
    // sync leg — if the sync call dies mid-flight (iOS ~60s fetch cap)
    // the rest is already safely queued, and the poll above will pick up
    // whatever the server finished anyway.
    const { syncIds, queueIds } = splitExtractIds(ids)
    try {
      let queueData = null
      if (queueIds.length) {
        const qr = await bulkQueueAnalysis(queueIds)
        if (qr.success === false) throw new Error(qr.error || 'Queue failed')
        queueData = qr.data
      }
      const sr = await bulkAnalyse(syncIds)
      if (sr.success === false) throw new Error(sr.error || 'Extract failed')
      setSummary(mergeExtractCounts(sr.data, queueData))
      setSelected(new Set()) // never re-send the same rows
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Bookkeeper queue', headerLeft: () => <BackHeaderLeft label="Accounting" fallbackHref="/accounting" /> }} />

      {!canView ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">
            The bookkeeper queue needs the bookkeeper permission — ask a master to grant it.
          </Text>
        </View>
      ) : (
        <>
          <View className="flex-row items-center justify-between px-4 pt-3 pb-2">
            <Text className="text-xs uppercase tracking-wider text-un1t-subtle">
              {loading ? 'Loading…' : `${rows.length} awaiting action`}
            </Text>
            {extractableRows.length > 0 && (
              <Pressable onPress={toggleAll} accessibilityRole="button" hitSlop={8}>
                <Text className="text-xs text-un1t-subtle underline">
                  {allSelected ? 'Clear selection' : `Select all (${extractableRows.length})`}
                </Text>
              </Pressable>
            )}
          </View>

          <ScrollView
            contentContainerClassName={`px-4 ${selected.size > 0 ? 'pb-28' : 'pb-10'}`}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
          >
            {error && (
              <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
                <Text className="text-red-500 text-sm">{error}</Text>
              </View>
            )}
            {summary && (
              <View className="bg-un1t-surface border border-un1t-border rounded-xl p-3 mb-3">
                <Text className="text-xs text-un1t-text">
                  Extract result: {Object.entries(summary).map(([k, v]) => `${v} ${SUMMARY_LABEL[k] || k}`).join(' · ') || 'nothing to do'}
                </Text>
              </View>
            )}

            {loading ? (
              <View className="py-12 items-center"><ActivityIndicator /></View>
            ) : rows.length === 0 ? (
              <View className="py-16 items-center px-6">
                <Ionicons name="file-tray-outline" size={30} color="#94A3B8" />
                <Text className="text-base font-semibold text-un1t-text mt-3">Queue is clear</Text>
                <Text className="text-xs text-un1t-subtle text-center mt-1">
                  Supplier invoices awaiting bookkeeper action at {activeLocation?.name || 'this studio'} show up here.
                </Text>
              </View>
            ) : (
              <>
                {rows.map((inv) => {
                  const f = inv.extracted_fields || {}
                  const meta = queueStatusMeta(inv)
                  const tone = TONE_STYLE[meta.tone] || TONE_STYLE.slate
                  const extractable = isExtractable(inv)
                  const checked = selected.has(inv.id)
                  const unresolved = xeroSupplierUnresolved(inv)
                  const amount = amountLabel(f)
                  return (
                    <Pressable
                      key={inv.id}
                      onPress={extractable ? () => toggle(inv.id) : undefined}
                      disabled={!extractable}
                      accessibilityRole={extractable ? 'checkbox' : undefined}
                      accessibilityState={extractable ? { checked } : undefined}
                      className={`bg-white border rounded-2xl p-4 mb-2 flex-row items-center ${checked ? 'border-un1t-text' : 'border-un1t-border'} ${extractable ? 'active:opacity-70' : ''}`}
                    >
                      {extractable && (
                        <Ionicons
                          name={checked ? 'checkmark-circle' : 'ellipse-outline'}
                          size={22}
                          color={checked ? '#111827' : '#94A3B8'}
                          style={{ marginRight: 10 }}
                        />
                      )}
                      <View className="flex-1">
                        <View className="flex-row items-center justify-between mb-1">
                          <Text className="text-base font-semibold text-un1t-text flex-1" numberOfLines={1}>
                            {f.supplier_name || inv.sender_email || inv.attachment_filename || '(no sender)'}
                          </Text>
                          {amount && <Text className="text-base font-semibold text-un1t-text ml-2">{amount}</Text>}
                        </View>
                        <Text className="text-xs text-un1t-subtle mb-1.5" numberOfLines={1}>
                          {SOURCE_LABEL[inv.source_type] || 'Invoice'} · {formatReceivedAt(inv.received_at)}
                          {inv.subject ? ` · ${inv.subject}` : ''}
                        </Text>
                        <View className="flex-row items-center gap-1.5 flex-wrap">
                          <View className={`px-2 py-0.5 rounded-full ${tone.bg}`}>
                            <Text className={`text-[11px] uppercase font-medium ${tone.text}`}>{meta.label}</Text>
                          </View>
                          {unresolved && (
                            <View className="px-2 py-0.5 rounded-full bg-red-500/20 flex-row items-center">
                              <Ionicons name="alert-circle-outline" size={11} color="#DC2626" />
                              <Text className="text-[11px] uppercase font-medium ml-1 text-red-700">Not in Xero</Text>
                            </View>
                          )}
                        </View>
                      </View>
                    </Pressable>
                  )
                })}
                {anyUnresolved && (
                  <Text className="text-[11px] text-un1t-subtle px-1 mt-1">
                    “Not in Xero” — the supplier isn’t matched to an existing Xero contact. Match or create it in the web invoices inbox before sending.
                  </Text>
                )}
              </>
            )}
          </ScrollView>

          {selected.size > 0 && (
            <View className="absolute inset-x-0 bottom-0 bg-white border-t border-un1t-border px-4 pt-3 pb-8 flex-row items-center">
              <Text className="text-sm text-un1t-text font-medium flex-1">{selectedExtractableIds.length} selected</Text>
              <Pressable
                onPress={() => setSelected(new Set())}
                disabled={busy}
                accessibilityRole="button"
                className="px-3 py-2 mr-2"
              >
                <Text className="text-sm text-un1t-subtle">Clear</Text>
              </Pressable>
              <Pressable
                onPress={extractSelected}
                disabled={busy || selectedExtractableIds.length === 0}
                accessibilityRole="button"
                className={`px-4 py-2 rounded-full bg-un1t-text ${busy ? 'opacity-60' : 'active:opacity-80'}`}
              >
                <Text className="text-sm font-medium text-un1t-bg">
                  {busy ? 'Extracting…' : `Extract selected (${selectedExtractableIds.length})`}
                </Text>
              </Pressable>
            </View>
          )}
        </>
      )}
    </View>
  )
}
