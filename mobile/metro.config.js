const { getDefaultConfig } = require('expo/metro-config')
const { withNativeWind } = require('nativewind/metro')
const path = require('node:path')

const config = getDefaultConfig(__dirname)

// Let Metro resolve modules from ../shared so the mobile app and the
// Next.js web app share things like permission keys and default-by-role
// maps from a single source of truth (../shared/permissions.js).
// Without this Metro only walks the project root (mobile/) and the
// import would fail with "Unable to resolve".
//
// SDK 57 note: this watchFolders seam only works with the eager file-map
// crawl. The new on-demand filesystem (SDK 56+) does NOT map this sibling
// folder, so `experiments.onDemandFilesystem` is disabled in app.config.js.
const sharedRoot = path.resolve(__dirname, '..', 'shared')
config.watchFolders = [...(config.watchFolders || []), sharedRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
]

module.exports = withNativeWind(config, { input: './global.css' })
