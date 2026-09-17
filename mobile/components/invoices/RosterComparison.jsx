// INVOICEREVIEW.2 — roster vs invoice on the phone. Renders the model from
// lib/invoice-review.js reviewComparisonView(); all decisions (snapshot vs
// live, the "matches roster" tolerance, colours) live there, tested.
//
// RosterComparison        — renders a view you already have (invoice detail).
// InvoiceRosterCheck      — fetches GET /api/invoices/[id] (the same route
//                           the web review panel uses) and renders it; used
//                           on the Approvals inbox card so an approver sees
//                           the comparison BEFORE tapping Approve.
import { useEffect, useState } from 'react'
import { View, Text, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { getInvoice } from '../../lib/invoices-api'
import { reviewComparisonView } from '../../lib/invoice-review'

function Rows({ rows }) {
  return rows.map((r) => (
    <View key={r.label} className="flex-row items-baseline justify-between py-0.5">
      <Text className="text-xs text-un1t-subtle">{r.label}</Text>
      <Text className={`text-sm ${r.emphasize ? 'font-semibold' : ''} ${r.warn ? 'text-amber-700' : 'text-un1t-text'}`}>
        {r.value}{r.sub ? <Text className="text-[11px] text-un1t-subtle">{`  (${r.sub})`}</Text> : null}
      </Text>
    </View>
  ))
}

export function RosterComparison({ view, compact = false }) {
  if (!view) return null
  return (
    <View className={compact ? 'mt-2' : 'bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-4'}>
      <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1.5">{view.heading}</Text>
      <Rows rows={view.rows} />
      <View className="flex-row items-baseline justify-between py-0.5 mt-1 pt-1.5 border-t border-un1t-border">
        <Text className="text-xs text-un1t-subtle">Invoiced</Text>
        <Text className="text-sm font-semibold text-un1t-text">{view.invoiced}</Text>
      </View>
      <View className={`flex-row items-center self-start rounded-full px-2 py-1 mt-1.5 ${view.verdict.bg}`}>
        <Ionicons
          name={view.verdict.tone === 'green' ? 'checkmark-circle-outline' : 'alert-circle-outline'}
          size={12}
          color={view.verdict.tint}
        />
        <Text className={`text-[11px] font-semibold ml-1 ${view.verdict.text}`}>{view.verdict.summary}</Text>
      </View>
      {view.note ? <Text className="text-[11px] text-un1t-subtle mt-1.5">{view.note}</Text> : null}
      {view.current ? (
        <View className="mt-2 pt-2 border-t border-dashed border-un1t-border">
          <Text className="text-[11px] font-semibold text-un1t-subtle mb-1">{view.current.heading}</Text>
          <Rows rows={view.current.rows} />
          <Text className="text-[11px] text-un1t-subtle mt-0.5">{view.current.summary}</Text>
        </View>
      ) : null}
    </View>
  )
}

export function InvoiceRosterCheck({ invoiceId }) {
  const [state, setState] = useState({ loading: true, view: null, error: null })

  useEffect(() => {
    let alive = true
    getInvoice(invoiceId)
      .then((r) => {
        if (!alive) return
        if (r?.success === false || !r?.data) {
          // Don't echo the server text: the detail route 404s a caller who
          // holds the approvals permission without being owner/master.
          setState({ loading: false, view: null, error: 'Roster check unavailable.' })
        } else {
          setState({ loading: false, view: reviewComparisonView(r.data), error: null })
        }
      }, () => {
        if (alive) setState({ loading: false, view: null, error: 'Roster check unavailable.' })
      })
    return () => { alive = false }
  }, [invoiceId])

  if (state.loading) {
    return (
      <View className="flex-row items-center mt-2">
        <ActivityIndicator size="small" color="#94A3B8" />
        <Text className="text-[11px] text-un1t-subtle ml-2">Checking roster…</Text>
      </View>
    )
  }
  if (!state.view) {
    return <Text className="text-[11px] text-un1t-subtle mt-2">{state.error || 'No roster comparison available.'}</Text>
  }
  return <RosterComparison view={state.view} compact />
}
