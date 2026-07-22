// Revolut Embedded Checkout SDK loader — shared by RaceCheckoutPage and the
// class-funnel checkout. Loads the merchant embed.js once and resolves the
// global RevolutCheckout. Browser-only.
const SDK_URLS = {
  sandbox: 'https://sandbox-merchant.revolut.com/embed.js',
  prod: 'https://merchant.revolut.com/embed.js',
}

export function revolutMode() {
  return process.env.NEXT_PUBLIC_REVOLUT_MODE === 'prod' ? 'prod' : 'sandbox'
}

export function revolutPublicKey() {
  return process.env.NEXT_PUBLIC_REVOLUT_PUBLIC_KEY || ''
}

export function revolutSdkUrl(mode) {
  return SDK_URLS[mode] || SDK_URLS.sandbox
}

let sdkPromise = null
export function loadRevolutSdk(mode = revolutMode()) {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'))
  if (window.RevolutCheckout) return Promise.resolve(window.RevolutCheckout)
  if (sdkPromise) return sdkPromise
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = revolutSdkUrl(mode)
    script.async = true
    script.onload = () => resolve(window.RevolutCheckout)
    script.onerror = () => reject(new Error('Failed to load Revolut SDK'))
    document.head.appendChild(script)
  })
  return sdkPromise
}
