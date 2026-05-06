// Submit a new invoice. Modal-presented from the Invoices tab.
// Picks a PDF via expo-document-picker, posts as multipart to
// /api/invoices.
//
// `resubmitMonth` query param pre-selects the month and is set by
// the "Resubmit a corrected invoice" button on a declined detail
// page. Otherwise default = previous calendar month.

import { useState, useMemo, useEffect } from 'react'
import {
  View, Text, TextInput, Pressable, ScrollView,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useRouter, useLocalSearchParams, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as DocumentPicker from 'expo-document-picker'
import { useAuth } from '../../lib/auth-context'
import {
  submitInvoice, recentMonthOptions, defaultMonthKey,
} from '../../lib/invoices-api'

export default function NewInvoiceScreen() {
  const { activeLocation } = useAuth()
  const router = useRouter()
  const params = useLocalSearchParams()

  const months = useMemo(() => recentMonthOptions(new Date(), 6), [])
  const [month, setMonth] = useState(
    typeof params.resubmitMonth === 'string' ? params.resubmitMonth : defaultMonthKey()
  )
  const [amount, setAmount] = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState(null) // { uri, name, mimeType, size }
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    // If the URL had a resubmitMonth and the user navigates away then
    // back without a fresh param, don't clobber their selection.
    if (typeof params.resubmitMonth === 'string' && params.resubmitMonth !== month) {
      setMonth(params.resubmitMonth)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.resubmitMonth])

  async function pickPdf() {
    setError(null)
    const r = await DocumentPicker.getDocumentAsync({
      type: 'application/pdf',
      multiple: false,
      copyToCacheDirectory: true,
    })
    if (r.canceled) return
    const asset = r.assets?.[0]
    if (!asset) return
    if (asset.size && asset.size > 10 * 1024 * 1024) {
      setError('PDF must be 10 MB or less.')
      return
    }
    setFile({
      uri: asset.uri,
      name: asset.name || 'invoice.pdf',
      mimeType: asset.mimeType || 'application/pdf',
      size: asset.size,
    })
  }

  async function handleSubmit() {
    setError(null)
    if (!file) {
      setError('Please attach the PDF.')
      return
    }
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Amount must be a positive number.')
      return
    }
    if (!activeLocation?.id) {
      setError('No active location — pick a studio in the side menu before submitting.')
      return
    }
    setSubmitting(true)
    try {
      const r = await submitInvoice({
        monthKey: month,
        amount: amt,
        invoiceNumber: invoiceNumber.trim() || null,
        notes: notes.trim() || null,
        locationId: activeLocation.id,
        file,
      })
      if (!r.success) {
        setError(r.error || 'Submit failed')
        setSubmitting(false)
        return
      }
      // Done — pop back to the list. The list re-fetches on focus.
      router.back()
    } catch (e) {
      setError(e?.message || 'Submit failed')
      setSubmitting(false)
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: 'New invoice' }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1 bg-un1t-black"
      >
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text className="text-sm text-un1t-light mb-5">
            One invoice per calendar month. PDF only, max 10 MB.
            {activeLocation?.name ? ` Submitting for ${activeLocation.name} — switch studios in the side menu to change.` : ''}
          </Text>

          {/* Period chips */}
          <Field label="Period">
            <View className="flex-row flex-wrap gap-2">
              {months.map((m) => {
                const selected = m.key === month
                return (
                  <Pressable
                    key={m.key}
                    onPress={() => setMonth(m.key)}
                    className={`px-3 py-2 rounded-full border ${
                      selected
                        ? 'bg-un1t-white border-un1t-white'
                        : 'bg-un1t-dark border-un1t-gray'
                    }`}
                  >
                    <Text className={`text-xs font-medium ${selected ? 'text-un1t-black' : 'text-un1t-light'}`}>
                      {m.label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          </Field>

          <Field label="Amount (€)">
            <TextInput
              keyboardType="decimal-pad"
              value={amount}
              onChangeText={setAmount}
              placeholder="e.g. 1250.00"
              placeholderTextColor="#64748B"
              className="bg-un1t-dark border border-un1t-gray rounded-xl px-3 py-3 text-base text-un1t-white"
            />
          </Field>

          <Field label="Your invoice reference (optional)">
            <TextInput
              value={invoiceNumber}
              onChangeText={setInvoiceNumber}
              placeholder="e.g. INV-2026-04"
              placeholderTextColor="#64748B"
              maxLength={50}
              className="bg-un1t-dark border border-un1t-gray rounded-xl px-3 py-3 text-base text-un1t-white"
            />
          </Field>

          <Field label="Notes (optional)">
            <TextInput
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={3}
              maxLength={500}
              placeholder="Anything the approver should know"
              placeholderTextColor="#64748B"
              className="bg-un1t-dark border border-un1t-gray rounded-xl px-3 py-3 text-base text-un1t-white"
              style={{ minHeight: 80, textAlignVertical: 'top' }}
            />
          </Field>

          <Field label="PDF">
            <Pressable
              onPress={pickPdf}
              className="bg-un1t-dark border border-dashed border-un1t-gray rounded-xl p-4 active:opacity-70"
            >
              <View className="flex-row items-center">
                <Ionicons name={file ? 'document-text' : 'cloud-upload-outline'} size={20} color={file ? '#2563EB' : '#94A3B8'} />
                <View className="flex-1 ml-3">
                  {file ? (
                    <>
                      <Text className="text-sm font-semibold text-un1t-white" numberOfLines={1}>
                        {file.name}
                      </Text>
                      <Text className="text-xs text-un1t-light mt-0.5">
                        {file.size ? `${(file.size / 1024 / 1024).toFixed(2)} MB · ` : ''}Tap to replace
                      </Text>
                    </>
                  ) : (
                    <>
                      <Text className="text-sm font-semibold text-un1t-white">Choose PDF</Text>
                      <Text className="text-xs text-un1t-light mt-0.5">Browse files on this device</Text>
                    </>
                  )}
                </View>
                {file && <Ionicons name="checkmark-circle" size={20} color="#10B981" />}
              </View>
            </Pressable>
          </Field>

          {error && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-4 flex-row items-start">
              <Ionicons name="alert-circle" size={16} color="#DC2626" />
              <Text className="text-sm text-red-700 ml-2 flex-1">{error}</Text>
            </View>
          )}

          <Pressable
            onPress={handleSubmit}
            disabled={submitting}
            className="bg-blue-600 active:opacity-80 disabled:opacity-50 px-4 py-4 rounded-xl items-center flex-row justify-center mt-2"
          >
            {submitting
              ? <ActivityIndicator color="#FFFFFF" />
              : <Ionicons name="cloud-upload-outline" size={18} color="#FFFFFF" />}
            <Text className="text-base font-semibold text-white ml-2">
              {submitting ? 'Submitting…' : 'Submit invoice'}
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  )
}

function Field({ label, children }) {
  return (
    <View className="mb-4">
      <Text className="text-xs uppercase font-semibold text-un1t-light mb-2">{label}</Text>
      {children}
    </View>
  )
}
