// Auth-stack layout — login, password reset, etc. Headers are hidden;
// each screen draws its own. iOS modal presentation isn't used here so
// that the keyboard behaves naturally over the login form.

import { Stack } from 'expo-router'

export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false }} />
}
