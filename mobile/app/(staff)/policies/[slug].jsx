// Policy viewer — renders the current version body inline with
// passive view tracking. No Acknowledge button (POLICIES-VIEWS.1
// replaced the explicit ack with view tracking).
//
// View session:
//   - startPolicyView() on focus → returns view_id
//   - Tick every 1s while focused, incrementing total + the
//     centre-most-visible section's dwell
//   - endPolicyView() on blur / unmount / AppState background

import { useState, useCallback, useRef, useMemo } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, Platform, AppState,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useLocalSearchParams, useFocusEffect, Stack, useRouter } from 'expo-router'
import { listPolicies, startPolicyView, endPolicyView } from '../../../lib/policies-api'

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

// Mirror src/lib/policies.js#detectSectionHeadings exactly so the
// dwell keys reported to the server match what the admin report
// expects.
function splitBodyIntoSections(body) {
  if (!body) return [{ heading: null, content: '' }]
  const lines = body.split(/\r?\n/)
  const sections = []
  let cur = { heading: null, content: [] }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    const next = (lines[i + 1] || '').trim()
    const isHeading = trimmed && next === '' && (
      /^\d+\.\s+\S/.test(trimmed) ||
      (!/[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed) && trimmed.replace(/\s+/g, '').length >= 5)
    )
    if (isHeading) {
      if (cur.content.length > 0 || cur.heading) sections.push({ heading: cur.heading, content: cur.content.join('\n') })
      cur = { heading: trimmed, content: [line] }
    } else {
      cur.content.push(line)
    }
  }
  if (cur.content.length > 0 || cur.heading) sections.push({ heading: cur.heading, content: cur.content.join('\n') })
  return sections
}

export default function PolicyViewer() {
  const { slug } = useLocalSearchParams()
  const router = useRouter()
  const [policy, setPolicy] = useState(null)
  const [error, setError] = useState(null)

  // View tracking refs (mutable, no re-renders).
  const viewIdRef = useRef(null)
  const dwellRef = useRef(Object.create(null))      // heading → seconds
  const totalRef = useRef(0)
  const lastFlushedDurationRef = useRef(0)
  const sectionLayoutsRef = useRef({})              // heading → { y, height }
  const scrollYRef = useRef(0)
  const viewportHeightRef = useRef(0)
  const tickerRef = useRef(null)
  const flushTimerRef = useRef(null)

  // Load the policy from the list endpoint (we don't have a single-
  // policy GET on mobile yet, but the list is cheap at this scale).
  const load = useCallback(async () => {
    setError(null)
    const res = await listPolicies()
    if (!res?.success) {
      setError(res?.error || 'Failed to load')
      return
    }
    const match = (res.data || []).find((p) => p.slug === slug)
    if (!match) {
      setError('Policy not found')
      return
    }
    setPolicy(match)
  }, [slug])

  // Compute sections once per body change.
  const sections = useMemo(
    () => splitBodyIntoSections(policy?.current_version?.body_markdown || ''),
    [policy?.current_version?.body_markdown],
  )

  // Find the section whose midpoint is closest to the viewport
  // centre (or the first section whose top is above the centre).
  function currentlyVisibleSection() {
    const scrollY = scrollYRef.current
    const vh = viewportHeightRef.current
    if (vh <= 0) return null
    const focal = scrollY + vh / 2
    let best = null
    let bestDistance = Infinity
    for (const [heading, layout] of Object.entries(sectionLayoutsRef.current)) {
      if (!layout) continue
      const mid = layout.y + layout.height / 2
      const dist = Math.abs(mid - focal)
      if (dist < bestDistance) {
        best = heading
        bestDistance = dist
      }
    }
    return best
  }

  // Start the session + the 1Hz ticker. flush()es and clears on
  // blur (useFocusEffect cleanup) or AppState 'background'.
  useFocusEffect(useCallback(() => {
    let cancelled = false
    load()

    async function start() {
      const res = await startPolicyView(slug)
      if (cancelled) return
      if (res?.success) {
        viewIdRef.current = res.view?.id || null
      }
    }
    start()

    // Reset counters for this session.
    totalRef.current = 0
    dwellRef.current = Object.create(null)
    lastFlushedDurationRef.current = 0

    tickerRef.current = setInterval(() => {
      totalRef.current += 1
      const heading = currentlyVisibleSection()
      if (heading) {
        dwellRef.current[heading] = (dwellRef.current[heading] || 0) + 1
      }
    }, 1000)

    // Periodic flush every 30s so a long read doesn't lose data if
    // the app crashes / is force-killed before useFocusEffect's
    // cleanup gets to run.
    flushTimerRef.current = setInterval(() => {
      flush()
    }, 30000)

    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background' || s === 'inactive') flush()
    })

    return () => {
      cancelled = true
      if (tickerRef.current) { clearInterval(tickerRef.current); tickerRef.current = null }
      if (flushTimerRef.current) { clearInterval(flushTimerRef.current); flushTimerRef.current = null }
      sub.remove()
      flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]))

  function flush() {
    const viewId = viewIdRef.current
    if (!viewId) return
    const total = totalRef.current
    if (total <= 0) return
    if (total <= lastFlushedDurationRef.current) return
    lastFlushedDurationRef.current = total
    // Fire-and-forget — the server-side PATCH is idempotent
    // (max(prev, new)) so concurrent flushes are safe.
    endPolicyView(slug, {
      viewId,
      totalDurationSeconds: total,
      sectionDwell: { ...dwellRef.current },
    }).catch(() => { /* best-effort */ })
  }

  if (policy === null && error === null) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <Stack.Screen options={{ title: 'Policy' }} />
        <ActivityIndicator />
      </View>
    )
  }

  if (error) {
    return (
      <View className="flex-1 bg-un1t-bg p-6">
        <Stack.Screen options={{ title: 'Policy' }} />
        <View className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4">
          <Text className="text-sm font-semibold text-red-700">Couldn't load this policy</Text>
          <Text className="text-xs text-red-700 mt-1">{error}</Text>
          <View className="flex-row gap-2 mt-3">
            <Pressable
              onPress={load}
              className="bg-red-600 active:opacity-80 px-3 py-2 rounded-md"
            >
              <Text className="text-xs font-semibold text-white">Try again</Text>
            </Pressable>
            <Pressable
              onPress={() => router.back()}
              className="bg-un1t-border active:opacity-80 px-3 py-2 rounded-md"
            >
              <Text className="text-xs font-semibold text-un1t-text">Go back</Text>
            </Pressable>
          </View>
        </View>
      </View>
    )
  }

  const ver = policy.current_version

  return (
    <>
      <Stack.Screen options={{ title: policy.title }} />
      <ScrollView
        className="flex-1 bg-un1t-bg"
        contentContainerClassName="p-4 pb-20"
        scrollEventThrottle={250}
        onScroll={(e) => { scrollYRef.current = e.nativeEvent.contentOffset.y }}
        onLayout={(e) => { viewportHeightRef.current = e.nativeEvent.layout.height }}
      >
        <View className="mb-4">
          <Text className="text-2xl font-bold text-un1t-text">{policy.title}</Text>
          {ver && (
            <Text className="text-xs text-un1t-subtle mt-1">
              v{ver.version_number} · effective {fmtDate(ver.effective_date)}
            </Text>
          )}
          {policy.description && (
            <Text className="text-sm text-un1t-subtle mt-2">{policy.description}</Text>
          )}
          {ver?.change_summary && ver.version_number > 1 && (
            <View className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-3 mt-3 flex-row gap-2">
              <Ionicons name="sparkles-outline" size={14} color="#1D4ED8" />
              <View className="flex-1">
                <Text className="text-xs font-semibold text-blue-700">
                  What changed in v{ver.version_number}
                </Text>
                <Text className="text-xs text-blue-700 mt-0.5">{ver.change_summary}</Text>
              </View>
            </View>
          )}
        </View>

        {!ver && (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-4">
            <Text className="text-sm text-red-700">
              This policy has no published version yet.
            </Text>
          </View>
        )}

        {ver && (
          <View className="bg-white rounded-2xl p-5 border border-un1t-border">
            {sections.map((s, i) => (
              <View
                key={i}
                onLayout={(e) => {
                  if (s.heading) {
                    sectionLayoutsRef.current[s.heading] = {
                      y: e.nativeEvent.layout.y,
                      height: e.nativeEvent.layout.height,
                    }
                  }
                }}
              >
                <Text
                  style={{
                    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
                    fontSize: 15,
                    lineHeight: 22,
                    color: '#111827',
                  }}
                >
                  {s.content}
                  {i < sections.length - 1 ? '\n' : ''}
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </>
  )
}
