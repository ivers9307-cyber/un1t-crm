// STAFF-C2a — edit a staff member's basic details (name + employment
// type) from mobile. Owner/master only (matches the PUT gate). Sends
// ONLY { full_name, employment_type } — never `assignments` — so the
// server's UniFi/door/assignment branch is never reached. Role /
// permission / studio / door editing stays on web (C2b/C3).
import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, ActivityIndicator, Pressable } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { z } from 'zod'
import { useAuth } from '../../../../lib/auth-context'
import { sdk } from '../../../../lib/sdk'
import { Form, FormField, Button } from '../../../../components/ui'
import BackHeaderLeft from '../../../../components/BackHeaderLeft'

const OWNER_ROLES = ['master', 'owner']
const EMPLOYMENT = [{ key: 'fte', label: 'Full-time' }, { key: 'contractor', label: 'Contractor' }]

const EditSchema = z.object({
  full_name: z.string().min(1, 'Name is required').max(200),
  employment_type: z.enum(['fte', 'contractor']),
})

export default function StaffEdit() {
  const params = useLocalSearchParams()
  const id = Array.isArray(params.id) ? params.id[0] : params.id
  const { profile } = useAuth()
  const router = useRouter()
  const canEdit = !!profile && OWNER_ROLES.includes(profile.role)

  const [initial, setInitial] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    const res = await sdk.staff.get(id)
    if (!res.success) { setError(res.error || 'Failed to load'); return }
    setInitial({
      full_name: res.data?.full_name || '',
      employment_type: res.data?.employment_type === 'contractor' ? 'contractor' : 'fte',
    })
  }, [id])

  useEffect(() => {
    if (!canEdit) { setLoading(false); return }
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [canEdit, load])

  async function save(values) {
    setSaving(true)
    setError(null)
    const res = await sdk.staff.update(id, {
      full_name: values.full_name,
      employment_type: values.employment_type,
    })
    setSaving(false)
    if (!res.success) { setError(res.error || 'Save failed'); return }
    router.back()
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Edit staff', headerLeft: () => <BackHeaderLeft label="Back" fallbackHref={`/staff/${id}`} /> }} />

      {!canEdit ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">Editing staff is owner-only.</Text>
        </View>
      ) : loading || !initial ? (
        <View className="py-16 items-center"><ActivityIndicator /></View>
      ) : (
        <ScrollView contentContainerClassName="px-4 pt-4 pb-10">
          {error && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
              <Text className="text-red-500 text-sm">{error}</Text>
            </View>
          )}
          <Form initialValues={initial} schema={EditSchema} onSubmit={save}>
            {({ submit }) => (
              <>
                <FormField name="full_name" label="Full name" required />

                <FormField name="employment_type" label="Employment">
                  {({ value, onChange }) => (
                    <View className="flex-row gap-2">
                      {EMPLOYMENT.map(opt => {
                        const active = value === opt.key
                        return (
                          <Pressable
                            key={opt.key}
                            onPress={() => onChange(opt.key)}
                            className={`flex-1 rounded-xl px-3 py-2 items-center ${active ? 'bg-un1t-accent' : 'bg-un1t-surface border border-un1t-border'}`}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                          >
                            <Text className={`text-sm font-medium ${active ? 'text-white' : 'text-un1t-subtle'}`}>{opt.label}</Text>
                          </Pressable>
                        )
                      })}
                    </View>
                  )}
                </FormField>

                <View className="mt-6">
                  <Button
                    label={saving ? 'Saving…' : 'Save changes'}
                    onPress={submit}
                    disabled={saving}
                    loading={saving}
                  />
                </View>
              </>
            )}
          </Form>
        </ScrollView>
      )}
    </View>
  )
}
