// Customer-facing support address. Lives in shared/ (the web↔mobile seam) so
// both the web app and the native app use one value. Overridable via
// EXPO_PUBLIC_SUPPORT_EMAIL so a rebrand needs no code change; defaults to the
// current address.
export const SUPPORT_EMAIL =
  (typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_SUPPORT_EMAIL) ||
  'hello@champfitness.ie'
