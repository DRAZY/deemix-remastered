import { describe, expect, test } from 'bun:test'
import { installMode, isDeveloperIdSigned, newer, portableAsset, verifyDigest } from '../electron/updatePlan'

describe('installMode', () => {
  test('dev builds never update in place', () => {
    expect(installMode({ platform: 'darwin', packaged: false, developerIdSigned: true })).toEqual({ kind: 'manual', reason: 'dev' })
  })
  test('only a Developer ID Mac build updates in place', () => {
    expect(installMode({ platform: 'darwin', packaged: true, developerIdSigned: true })).toEqual({ kind: 'mac' })
    expect(installMode({ platform: 'darwin', packaged: true, developerIdSigned: false })).toEqual({ kind: 'manual', reason: 'unsigned' })
  })
  test('Windows installer and portable', () => {
    expect(installMode({ platform: 'win32', packaged: true })).toEqual({ kind: 'installer' })
    expect(installMode({ platform: 'win32', packaged: true, portableExe: 'C:\\a.exe', portableDirWritable: true })).toEqual({ kind: 'portable' })
    expect(installMode({ platform: 'win32', packaged: true, portableExe: 'C:\\a.exe', portableDirWritable: false })).toEqual({ kind: 'manual', reason: 'readonly' })
  })
  test('Linux: AppImage updates itself, .deb and AUR go to the release page', () => {
    expect(installMode({ platform: 'linux', packaged: true, appImage: '/x.AppImage' })).toEqual({ kind: 'appimage' })
    expect(installMode({ platform: 'linux', packaged: true })).toEqual({ kind: 'manual', reason: 'unsupported' })
  })
})

describe('isDeveloperIdSigned', () => {
  const signed = 'Authority=Developer ID Application: Andre Hall (W966GFT83K)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=W966GFT83K\n'
  test('accepts our team', () => expect(isDeveloperIdSigned(signed)).toBe(true))
  test('refuses ad-hoc', () => expect(isDeveloperIdSigned('Signature=adhoc\nTeamIdentifier=not set\n')).toBe(false))
  test('refuses another team', () => expect(isDeveloperIdSigned(signed.replaceAll('W966GFT83K', 'AAAAAAAAAA'))).toBe(false))
})

describe('newer', () => {
  test('compares numerically', () => {
    expect(newer('2.6.10', '2.6.9')).toBe(true)
    expect(newer('v2.6.6', '2.6.5')).toBe(true)
    expect(newer('2.6.5', '2.6.5')).toBe(false)
    expect(newer('2.6.4', '2.6.5')).toBe(false)
  })
})

describe('portable self-update', () => {
  const url = (n: string) => `https://github.com/DRAZY/deemix-remastered/releases/download/v2.6.6/${n}`
  const assets = ['Deemix.Remastered-Portable-2.6.6-x64.exe', 'Deemix.Remastered-Portable-2.6.6-arm64.exe', 'Deemix.Remastered-Setup-2.6.6-x64.exe'].map((name) => ({ name, browser_download_url: url(name) }))
  test('picks this architecture', () => {
    expect(portableAsset(assets, 'x64')?.name).toBe('Deemix.Remastered-Portable-2.6.6-x64.exe')
    expect(portableAsset(assets, 'arm64')?.name).toBe('Deemix.Remastered-Portable-2.6.6-arm64.exe')
  })
  test('refuses a download from anywhere else', () => {
    expect(portableAsset([{ name: assets[0].name, browser_download_url: 'https://evil.example/a.exe' }], 'x64')).toBeNull()
  })
  test('installs only on a matching digest', () => {
    expect(verifyDigest('ABC', 'a.exe', 'sha256:abc')).toBe('abc')
    expect(() => verifyDigest('abc', 'a.exe', 'sha256:def')).toThrow()
    expect(() => verifyDigest('abc', 'a.exe', null)).toThrow()
  })
})
