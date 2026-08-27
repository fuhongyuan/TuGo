const base = require('./electron-builder.json')
const { execFileSync } = require('node:child_process')

const identities = process.platform === 'darwin'
  ? execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  : ''
if (process.platform === 'darwin' && !process.env.CSC_LINK && !/Developer ID Application/.test(identities)) {
  throw new Error('A Developer ID Application certificate or CSC_LINK is required for a public release build.')
}

module.exports = {
  ...base,
  mac: {
    ...base.mac,
    // Development packages use the ad-hoc identity from the base config so
    // fused Electron binaries still launch. Public releases must let
    // electron-builder select the real Developer ID instead.
    identity: process.env.CSC_NAME || undefined,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // electron-builder reads the Apple credentials from its documented
    // environment variables. This release-only config intentionally fails
    // closed when signing/notarization credentials are unavailable.
    notarize: true,
  },
}
