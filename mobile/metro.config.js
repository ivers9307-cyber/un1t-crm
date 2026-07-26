const { getDefaultConfig } = require('expo/metro-config')
const { withNativeWind } = require('nativewind/metro')
const path = require('node:path')

const config = getDefaultConfig(__dirname)

// The web/mobile shared seam: ../shared is consumed as the `shared` package
// ("shared": "file:../shared" in package.json → npm symlinks it into
// node_modules/shared), imported as 'shared/<module>'. That rides ordinary
// node_modules resolution — Metro's symlink support is always-on — so it
// doesn't depend on the SDK 57 on-demand file map at all. (Raw relative
// escapes like '../../shared/x' are what broke on SDK 57: the on-demand
// map's lazy discovery is scoped to the project root, so files reached by
// escaping it were never mapped. Package resolution has no such scoping,
// which is why the seam moved to a package.)
//
// watchFolders keeps the symlink TARGET watched so edits to shared/ files
// hot-reload in dev; nodeModulesPaths pins module resolution to mobile's own
// dependencies (the repo root's node_modules belongs to the web app).
const sharedRoot = path.resolve(__dirname, '..', 'shared')
config.watchFolders = [...(config.watchFolders || []), sharedRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
]

module.exports = withNativeWind(config, { input: './global.css' })
