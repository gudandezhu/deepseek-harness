import semver from 'semver'

export const MIN_SUPPORTED_CORE_VERSION = '0.1.7-rc.1'

function normalizeVersion(version: string): string {
  let value = version
  let packaged = false
  while (value.startsWith('dsh-') || value.startsWith('src-')) {
    packaged ||= value.startsWith('dsh-')
    value = value.replace(/^(?:src|dsh)-/, '')
  }
  return packaged ? value.replace(/-\d+$/, '') : value
}

export function compareVersions(a: string, b: string): number {
  const pa = semver.parse(normalizeVersion(a))
  const pb = semver.parse(normalizeVersion(b))
  if (!pa || !pb)
    return 0
  return semver.compare(pa, pb)
}

export function coreProfileName(version: string): string {
  const parsed = semver.parse(normalizeVersion(version))
  return parsed ? `Core-${parsed.major}.${parsed.minor}.${parsed.patch}` : ''
}

export function isCoreUpgrade(from: string, to: string): boolean {
  const current = semver.parse(normalizeVersion(from))
  const target = semver.parse(normalizeVersion(to))
  if (!current || !target)
    return false
  const currentCore = [current.major, current.minor, current.patch]
  const targetCore = [target.major, target.minor, target.patch]
  for (let index = 0; index < currentCore.length; index += 1) {
    if (targetCore[index]! !== currentCore[index]!)
      return targetCore[index]! > currentCore[index]!
  }
  return false
}

export function isCoreUnsupported(version: string): boolean {
  return compareVersions(version, MIN_SUPPORTED_CORE_VERSION) < 0
}
