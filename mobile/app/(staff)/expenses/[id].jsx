// FTE-EXPENSES.2 (mobile) — claim detail + line item management.
//
// Surfaces:
//   - Period + status + totals at the top
//   - Items list (read-only for non-drafts)
//   - "Add item" inline form (draft only) with camera/photo/PDF
//     receipt capture
//   - Submit-for-approval button (draft, ≥1 item)
//   - Revoke button (submitted, submitter only)
//   - Delete-draft button (draft, no items required)
//   - Decline reason banner when status === 'declined'
//
// The add-item form uses expo-image-picker for camera + photo
// library and expo-document-picker for PDFs — same approach as the
// contractor invoice flow, just with the photo path added because
// receipt photos are the dominant input here (staff don't typically
// have PDF receipts for €4 of parking).

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  TextInput, Alert, Linking, RefreshControl,
} from 'react-native'
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as ImagePicker from 'expo-image-picker'
import * as DocumentPicker from 'expo-document-picker'
import {
  getExpenseClaim, addExpenseItem, deleteExpenseItem,
  submitExpenseClaim, revokeExpenseClaim, deleteExpenseClaim,
  getReceiptUrl, periodLabel,
  EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS,
} from '../../../lib/expenses-api'

const STATUS_STYLE = {
  draft:     { label: 'Draft',           color: '#64748B', bg: 'bg-slate-500/20', text: 'text-slate-700' },
  submitted: { label: 'Awaiting review', color: '#D97706', bg: 'bg-amber-500/20', text: 'text-amber-700' },
  approved:  { label: 'Approved',        color: '#059669', bg: 'bg-green-500/20', text: 'text-green-700' },
  declined:  { label: 'Declined',        color: '#DC2626', bg: 'bg-red-500/20',   text: 'text-red-700' },
  revoked:   { label: 'Revoked',         color: '#64748B', bg: 'bg-slate-500/20', text: 'text-slate-700' },
}

export default function ExpenseClaimDetailScreen() {
  const { id } = useLocalSearchParams()
  const router = useRouter()
  const [claim, setClaim] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [addingItem, setAddingItem] = useState(false)

  const fetchDetail = useCallback(async () => {
    setError(null)
    const r = await getExpenseClaim(id)
    if (r.success === false) {
      setError(r.error || 'Failed to load')
      setClaim(null)
    } else {
      setClaim(r.data)
    }
  }, [id])

  useEffect(() => { setLoading(true); fetchDetail().finally(() => setLoading(false)) }, [fetchDetail])
  useFocusEffect(useCallback(() => { fetchDetail() }, [fetchDetail]))

  async function onRefresh() { setRefreshing(true); await fetchDetail(); setRefreshing(false) }

  async function doSubmit() {
    if (!claim) return
    if (claim.item_count === 0) {
      Alert.alert('Add an item first', 'You need at least one expense item before submitting.')
      return
    }
    Alert.alert(
      'Submit for approval?',
      `${claim.item_count} item${claim.item_count === 1 ? '' : 's'} totalling €${Number(claim.total_amount).toFixed(2)} will be sent for review. You won't be able to edit after this until the approver responds.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Submit', onPress: async () => {
          setBusy(true)
          const r = await submitExpenseClaim(id)
          setBusy(false)
          if (r.success === false) { Alert.alert('Failed', r.error || 'Could not submit'); return }
          fetchDetail()
        }},
      ]
    )
  }

  async function doRevoke() {
    Alert.alert(
      'Revoke this claim?',
      'You can edit and resubmit afterwards — this just pulls it back before the approver looks.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Revoke', style: 'destructive', onPress: async () => {
          setBusy(true)
          const r = await revokeExpenseClaim(id)
          setBusy(false)
          if (r.success === false) { Alert.alert('Failed', r.error || 'Could not revoke'); return }
          fetchDetail()
        }},
      ]
    )
  }

  async function doDelete() {
    Alert.alert(
      'Delete this draft?',
      'This removes the draft and any uploaded receipts. Cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: async () => {
          setBusy(true)
          const r = await deleteExpenseClaim(id)
          setBusy(false)
          if (r.success === false) { Alert.alert('Failed', r.error || 'Could not delete'); return }
          router.back()
        }},
      ]
    )
  }

  async function deleteItem(itemId) {
    Alert.alert('Remove this item?', '', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        setBusy(true)
        const r = await deleteExpenseItem(id, itemId)
        setBusy(false)
        if (r.success === false) { Alert.alert('Failed', r.error || 'Could not remove'); return }
        fetchDetail()
      }},
    ])
  }

  async function openReceipt(itemId) {
    const r = await getReceiptUrl(id, itemId)
    if (r.success === false || !r.url) { Alert.alert('Could not open receipt', r.error || 'No URL returned'); return }
    Linking.openURL(r.url)
  }

  if (loading) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <ActivityIndicator color="#94A3B8" />
      </View>
    )
  }
  if (error || !claim) {
    return (
      <View className="flex-1 bg-un1t-bg p-6 items-center justify-center">
        <Ionicons name="alert-circle" size={32} color="#DC2626" />
        <Text className="text-sm text-red-700 mt-2 text-center">{error || 'Claim not found'}</Text>
      </View>
    )
  }

  const isMine = claim.viewer_role === 'self'
  const isDraft = claim.status === 'draft'
  const isSubmitted = claim.status === 'submitted'
  const statusStyle = STATUS_STYLE[claim.status]

  return (
    <View className="flex-1 bg-un1t-bg">
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
      >
        {/* Header card */}
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-3">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-xl font-bold text-un1t-text">{periodLabel(claim.period_start)}</Text>
            <View className={`px-2 py-1 rounded-full ${statusStyle.bg}`}>
              <Text className={`text-[11px] uppercase font-medium ${statusStyle.text}`}>
                {statusStyle.label}
              </Text>
            </View>
          </View>
          <Text className="text-xs text-un1t-subtle mb-3">
            {claim.profile?.full_name} · {claim.location?.name}
          </Text>
          <View className="flex-row items-end justify-between">
            <View>
              <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle">Total</Text>
              <Text className="text-2xl font-bold text-un1t-text">€{Number(claim.total_amount).toFixed(2)}</Text>
            </View>
            <View className="items-end">
              <Text className="text-[11px] text-un1t-subtle">
                {claim.item_count} item{claim.item_count === 1 ? '' : 's'}
              </Text>
              <Text className="text-[11px] text-un1t-subtle">
                incl. €{Number(claim.total_vat_amount).toFixed(2)} VAT
              </Text>
            </View>
          </View>
          {claim.notes && (
            <Text className="text-xs text-un1t-subtle mt-3 italic">{claim.notes}</Text>
          )}
        </View>

        {/* Decline reason callout */}
        {claim.status === 'declined' && claim.decline_reason && (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-3">
            <Text className="text-xs uppercase tracking-wider text-red-700 font-semibold mb-1">Decline reason</Text>
            <Text className="text-sm text-red-800">{claim.decline_reason}</Text>
            <Text className="text-xs text-un1t-subtle mt-2">
              You can start a new claim for the same month from the Expenses tab.
            </Text>
          </View>
        )}

        {/* Items list */}
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl mb-3">
          <View className="px-4 py-3 border-b border-un1t-border flex-row items-center justify-between">
            <Text className="text-sm font-semibold text-un1t-text">Items</Text>
            <Text className="text-[11px] text-un1t-subtle">{claim.items?.length || 0}</Text>
          </View>
          {(!claim.items || claim.items.length === 0) ? (
            <View className="p-4 items-center">
              <Text className="text-sm text-un1t-subtle text-center">
                {isDraft && isMine
                  ? 'No items yet. Tap "Add item" below to capture your first receipt.'
                  : 'No items.'}
              </Text>
            </View>
          ) : (
            claim.items.map((it) => (
              <View key={it.id} className="px-4 py-3 border-b border-un1t-border/40 flex-row items-center">
                <View className="flex-1 mr-3">
                  <View className="flex-row items-center gap-2 mb-0.5">
                    <Text className="text-sm text-un1t-text font-medium">€{Number(it.amount).toFixed(2)}</Text>
                    <Text className="text-[11px] text-un1t-subtle">{EXPENSE_CATEGORY_LABELS[it.category]}</Text>
                  </View>
                  <Text className="text-xs text-un1t-subtle">
                    {it.expense_date}{it.vendor ? ` · ${it.vendor}` : ''}
                  </Text>
                  {it.description && (
                    <Text className="text-xs text-un1t-subtle mt-0.5" numberOfLines={2}>{it.description}</Text>
                  )}
                </View>
                <View className="flex-row items-center gap-2">
                  {it.receipt_path && (
                    <Pressable onPress={() => openReceipt(it.id)} className="p-1.5 active:opacity-60">
                      <Ionicons name="document-text-outline" size={20} color="#94A3B8" />
                    </Pressable>
                  )}
                  {isDraft && isMine && (
                    <Pressable onPress={() => deleteItem(it.id)} className="p-1.5 active:opacity-60">
                      <Ionicons name="trash-outline" size={18} color="#DC2626" />
                    </Pressable>
                  )}
                </View>
              </View>
            ))
          )}
        </View>

        {/* Add-item form (draft only, submitter only) */}
        {isDraft && isMine && (
          addingItem ? (
            <AddItemForm
              claimId={id}
              busy={busy}
              setBusy={setBusy}
              onCancel={() => setAddingItem(false)}
              onSaved={() => { setAddingItem(false); fetchDetail() }}
            />
          ) : (
            <Pressable
              onPress={() => setAddingItem(true)}
              className="bg-blue-600 rounded-full py-3.5 mb-3 items-center active:opacity-80"
            >
              <View className="flex-row items-center gap-2">
                <Ionicons name="add-circle" size={18} color="#FFFFFF" />
                <Text className="text-white font-semibold">Add item</Text>
              </View>
            </Pressable>
          )
        )}

        {/* Action buttons */}
        {isDraft && isMine && claim.item_count > 0 && !addingItem && (
          <Pressable
            onPress={doSubmit}
            disabled={busy}
            className="bg-emerald-600 rounded-full py-3.5 mb-2 items-center active:opacity-80"
          >
            {busy ? <ActivityIndicator color="#FFFFFF" /> : (
              <View className="flex-row items-center gap-2">
                <Ionicons name="paper-plane" size={18} color="#FFFFFF" />
                <Text className="text-white font-semibold">Submit for approval</Text>
              </View>
            )}
          </Pressable>
        )}

        {isSubmitted && isMine && (
          <Pressable
            onPress={doRevoke}
            disabled={busy}
            className="bg-un1t-surface border border-un1t-border rounded-full py-3.5 mb-2 items-center active:opacity-80"
          >
            <Text className="text-un1t-subtle font-medium">Revoke claim</Text>
          </Pressable>
        )}

        {isDraft && isMine && !addingItem && (
          <Pressable
            onPress={doDelete}
            disabled={busy}
            className="bg-un1t-surface border border-red-500/30 rounded-full py-3.5 items-center active:opacity-80"
          >
            <Text className="text-red-700 font-medium">Delete draft</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  )
}

// -------------------------------------------------------------------
// Add-item inline form. Same field set as the web version but
// optimised for one-thumb data entry — category as chips, big VAT
// stepper buttons might come in a follow-up.
// -------------------------------------------------------------------
function AddItemForm({ claimId, busy, setBusy, onCancel, onSaved }) {
  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState({
    expense_date: today,
    category: 'travel',
    amount: '',
    vat_amount: '',
    vendor: '',
    description: '',
    receipt: null,
  })
  const [error, setError] = useState(null)

  // INVOICES-QUEUE.1 PR 3 — Claude Vision OCR removed from this
  // surface. The submitter just attaches the receipt; OCR runs
  // later from the bookkeeper's Analyse action inside /invoices.

  function attachReceipt(receipt) {
    setForm((f) => ({ ...f, receipt }))
  }

  async function captureFromCamera() {
    setError(null)
    const perm = await ImagePicker.requestCameraPermissionsAsync()
    if (perm.status !== 'granted') { setError('Camera permission denied — grant in Settings.'); return }
    const r = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      base64: false,
    })
    if (r.canceled || !r.assets?.[0]) return
    const a = r.assets[0]
    attachReceipt({
      uri: a.uri,
      name: a.fileName || `receipt-${Date.now()}.jpg`,
      mimeType: a.mimeType || 'image/jpeg',
    })
  }

  async function pickFromLibrary() {
    setError(null)
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (perm.status !== 'granted') { setError('Photo library permission denied — grant in Settings.'); return }
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      base64: false,
    })
    if (r.canceled || !r.assets?.[0]) return
    const a = r.assets[0]
    attachReceipt({
      uri: a.uri,
      name: a.fileName || `receipt-${Date.now()}.jpg`,
      mimeType: a.mimeType || 'image/jpeg',
    })
  }

  async function pickPdf() {
    setError(null)
    const r = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'image/*'],
      multiple: false,
      copyToCacheDirectory: true,
    })
    if (r.canceled || !r.assets?.[0]) return
    const a = r.assets[0]
    attachReceipt({
      uri: a.uri,
      name: a.name || `receipt-${Date.now()}.pdf`,
      mimeType: a.mimeType || 'application/pdf',
    })
  }

  async function submit() {
    setError(null)
    if (!form.amount || Number(form.amount) <= 0) { setError('Amount must be greater than zero.'); return }
    setBusy(true)
    const r = await addExpenseItem({
      claimId,
      expenseDate: form.expense_date,
      category: form.category,
      amount: form.amount,
      vatAmount: form.vat_amount || 0,
      vendor: form.vendor || null,
      description: form.description || null,
      receipt: form.receipt,
    })
    setBusy(false)
    if (r.success === false) { setError(r.error || 'Could not add item'); return }
    onSaved()
  }

  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-3">
      <Text className="text-sm font-semibold text-un1t-text mb-3">Add expense item</Text>

      {/* Receipt capture */}
      <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-2">Receipt</Text>
      {form.receipt ? (
        <>
          <View className="flex-row items-center justify-between bg-un1t-bg border border-un1t-border rounded-xl p-3 mb-2">
            <View className="flex-row items-center gap-2 flex-1 min-w-0">
              <Ionicons name="document-attach" size={18} color="#059669" />
              <Text className="text-xs text-un1t-subtle flex-1" numberOfLines={1}>{form.receipt.name}</Text>
            </View>
            <Pressable
              onPress={() => {
                setForm({ ...form, receipt: null })
              }}
              className="p-1"
            >
              <Ionicons name="close" size={18} color="#DC2626" />
            </Pressable>
          </View>

          {/* INVOICES-QUEUE.1 PR 3 — OCR banner removed. Claude
              Vision runs from the bookkeeper's queue, not here. */}
        </>
      ) : (
        <View className="flex-row gap-2 mb-3">
          <Pressable onPress={captureFromCamera} className="flex-1 bg-un1t-bg border border-un1t-border rounded-xl py-3 items-center active:opacity-70">
            <Ionicons name="camera-outline" size={20} color="#94A3B8" />
            <Text className="text-[11px] text-un1t-subtle mt-1">Camera</Text>
          </Pressable>
          <Pressable onPress={pickFromLibrary} className="flex-1 bg-un1t-bg border border-un1t-border rounded-xl py-3 items-center active:opacity-70">
            <Ionicons name="images-outline" size={20} color="#94A3B8" />
            <Text className="text-[11px] text-un1t-subtle mt-1">Photos</Text>
          </Pressable>
          <Pressable onPress={pickPdf} className="flex-1 bg-un1t-bg border border-un1t-border rounded-xl py-3 items-center active:opacity-70">
            <Ionicons name="document-outline" size={20} color="#94A3B8" />
            <Text className="text-[11px] text-un1t-subtle mt-1">File</Text>
          </Pressable>
        </View>
      )}

      {/* Category */}
      <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-2">Category</Text>
      <View className="flex-row flex-wrap gap-1.5 mb-3">
        {EXPENSE_CATEGORIES.map((c) => (
          <Pressable
            key={c}
            onPress={() => setForm({ ...form, category: c })}
            className={`px-3 py-1.5 rounded-full border ${form.category === c ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-bg border-un1t-border'}`}
          >
            <Text className={`text-xs ${form.category === c ? 'text-un1t-bg font-semibold' : 'text-un1t-subtle'}`}>
              {EXPENSE_CATEGORY_LABELS[c]}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Amount + VAT */}
      <View className="flex-row gap-2 mb-3">
        <View className="flex-1">
          <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-1">Amount (€)</Text>
          <TextInput
            value={form.amount}
            onChangeText={(v) => setForm({ ...form, amount: v })}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor="#94A3B8"
            className="bg-un1t-bg border border-un1t-border rounded-xl px-3 py-2.5 text-sm text-un1t-text"
          />
        </View>
        <View className="flex-1">
          <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-1">VAT (€)</Text>
          <TextInput
            value={form.vat_amount}
            onChangeText={(v) => setForm({ ...form, vat_amount: v })}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor="#94A3B8"
            className="bg-un1t-bg border border-un1t-border rounded-xl px-3 py-2.5 text-sm text-un1t-text"
          />
        </View>
      </View>

      {/* Date */}
      <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-1">Date</Text>
      <TextInput
        value={form.expense_date}
        onChangeText={(v) => setForm({ ...form, expense_date: v })}
        placeholder="YYYY-MM-DD"
        placeholderTextColor="#94A3B8"
        className="bg-un1t-bg border border-un1t-border rounded-xl px-3 py-2.5 text-sm text-un1t-text mb-3"
      />

      {/* Vendor + description (optional) */}
      <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-1">Vendor (optional)</Text>
      <TextInput
        value={form.vendor}
        onChangeText={(v) => setForm({ ...form, vendor: v })}
        placeholder="e.g. Irish Rail"
        placeholderTextColor="#94A3B8"
        maxLength={200}
        className="bg-un1t-bg border border-un1t-border rounded-xl px-3 py-2.5 text-sm text-un1t-text mb-3"
      />

      <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-1">Description (optional)</Text>
      <TextInput
        value={form.description}
        onChangeText={(v) => setForm({ ...form, description: v })}
        placeholder="What was this for?"
        placeholderTextColor="#94A3B8"
        maxLength={500}
        className="bg-un1t-bg border border-un1t-border rounded-xl px-3 py-2.5 text-sm text-un1t-text mb-3"
      />

      {error && (
        <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
          <Text className="text-sm text-red-700">{error}</Text>
        </View>
      )}

      <View className="flex-row gap-2">
        <Pressable
          onPress={onCancel}
          className="flex-1 bg-un1t-bg border border-un1t-border rounded-full py-3 items-center active:opacity-70"
        >
          <Text className="text-un1t-subtle font-medium">Cancel</Text>
        </Pressable>
        <Pressable
          onPress={submit}
          disabled={busy || !form.amount}
          className={`flex-1 rounded-full py-3 items-center ${busy || !form.amount ? 'bg-un1t-border' : 'bg-blue-600 active:opacity-80'}`}
        >
          {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text className="text-white font-semibold">Save item</Text>}
        </Pressable>
      </View>
    </View>
  )
}
