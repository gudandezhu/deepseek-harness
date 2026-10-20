import { describe, expect, it } from 'vitest'
import { compareVersions, coreProfileName, isCoreUnsupported, isCoreUpgrade, MIN_SUPPORTED_CORE_VERSION } from '@/utils/core-version'
import { normalizeProfileId } from '@/utils/profile-id'

describe('compareVersions', () => {
  it.each([
    ['0.1.7-alpha.1', '0.1.7-rc.1', -1],
    ['0.1.7-beta.2', '0.1.7-rc.1', -1],
    ['0.1.7-rc.0', '0.1.7-rc.1', -1],
    ['0.1.7-rc.1', '0.1.7-rc.1', 0],
    ['0.1.7-rc.10', '0.1.7-rc.2', 1],
    ['0.1.7', '0.1.7-rc.1', 1],
    ['0.2.1-rc.1', '0.2.0', 1],
    ['dsh-src-dsh-0.1.5-rc.3-1', 'src-0.1.7-rc.1', -1],
    ['dsh-0.1.7-rc.0-39009013600', 'src-0.1.7-rc.1', -1],
    ['dsh-0.1.7-rc.1-39009013600', '0.1.7-rc.1', 0],
    ['dsh-0.1.7-39009013600', 'src-0.1.7', 0],
    ['dsh-0.2.1-rc.1-39009013600', 'src-0.2.1-rc.1', 0],
    ['0.2.1-rc.2', '0.2.1-rc.1', 1],
    ['dsh-0.2.1-rc.2-39022695148', 'src-0.2.1-rc.2', 0],
    ['0.2.1-preview-1', '0.2.1-preview', 1],
    ['src-0.2.1-preview-1', '0.2.1-preview', 1],
    ['dsh-0.2.1-preview-1-39009013600', '0.2.1-preview-1', 0],
  ])('%s 与 %s 的版本顺序为 %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected)
  })

  it.each([
    ['', '0.2.1-rc.1'],
    ['not-a-version', '0.1.7-rc.1'],
    ['0.2.1-rc.1', ''],
    ['0.1.7-rc.1', 'app'],
  ])('无法解析的比较 %s / %s 返回中立值', (a, b) => {
    expect(compareVersions(a, b)).toBe(0)
  })
})

describe('isCoreUnsupported', () => {
  it('最低支持版本固定为 0.1.7-rc.1', () => {
    expect(MIN_SUPPORTED_CORE_VERSION).toBe('0.1.7-rc.1')
  })

  it.each([
    '0.1.0-rc.7',
    '0.1.2-rc.1',
    '0.1.5-rc.1',
    '0.1.5-rc.3',
    '0.1.6',
    '0.1.7-alpha.1',
    '0.1.7-alpha.999',
    '0.1.7-beta.2',
    '0.1.7-rc.0',
    'dsh-0.1.7-rc.0-39009013600',
    'dsh-src-0.1.7-rc.0-39009013600',
    'src-0.1.7-rc.0',
    'src-0.1.7-alpha.1',
  ])('%s 低于最低支持版本，判为不兼容', (version) => {
    expect(isCoreUnsupported(version)).toBe(true)
  })

  it.each([
    '0.1.7-rc.1',
    '0.1.7-rc.2',
    '0.1.7',
    '0.1.8-alpha.1',
    '0.2.0-rc.2',
    '0.2.1-rc.1',
    '0.2.1-rc.2',
    'src-0.1.7-rc.1',
    'dsh-src-dsh-0.1.7-rc.1-39009013600',
    'dsh-0.2.1-rc.1-39009013600',
  ])('%s 达到最低支持版本，判为兼容', (version) => {
    expect(isCoreUnsupported(version)).toBe(false)
  })

  it.each(['', 'not-a-version', 'local'])('版本 %s 缺失或不可解析时不误判为不兼容', (version) => {
    expect(isCoreUnsupported(version)).toBe(false)
  })
})

describe('coreProfileName', () => {
  it('取主/次/补丁版本号并加 Core- 前缀，丢掉预发布标识', () => {
    expect(coreProfileName('0.1.7-rc.2')).toBe('Core-0.1.7')
    expect(coreProfileName('0.2.1-rc.1')).toBe('Core-0.2.1')
    expect(coreProfileName('0.17.1')).toBe('Core-0.17.1')
    expect(coreProfileName('0.18.0-rc.1')).toBe('Core-0.18.0')
    expect(coreProfileName('1.2.3')).toBe('Core-1.2.3')
  })

  it.each(['0.1.7-alpha.1', '0.1.7-rc.1', '0.1.7-rc.2', '0.1.7'])('%s 共用 Core-0.1.7 档案名', (version) => {
    expect(coreProfileName(version)).toBe('Core-0.1.7')
  })

  it('剥掉 dsh-/src- 前缀后再取名，包括旧安装的 tag', () => {
    expect(coreProfileName('dsh-0.1.0-rc.8-32331963388')).toBe('Core-0.1.0')
    expect(coreProfileName('dsh-src-0.2.1-rc.1-39009013600')).toBe('Core-0.2.1')
    expect(coreProfileName('src-2.0.0')).toBe('Core-2.0.0')
  })

  it.each(['', 'local', 'app-0.1.0-rc.8'])('版本 %s 缺失或不可解析时为空串', (version) => {
    expect(coreProfileName(version)).toBe('')
  })

  it('patch 不同的两个核心归一化后仍有各自可读的档案 id', () => {
    expect(normalizeProfileId(coreProfileName('0.1.5-rc.2'))).toBe('core-015')
    expect(normalizeProfileId(coreProfileName('0.1.7-rc.2'))).toBe('core-017')
    expect(normalizeProfileId(coreProfileName('0.2.1-rc.1'))).toBe('core-021')
  })
})

describe('isCoreUpgrade', () => {
  it('核心号变大（含 patch）都算升级，包括旧安装迁移', () => {
    expect(isCoreUpgrade('0.1.5', '0.1.7')).toBe(true)
    expect(isCoreUpgrade('0.1.7-rc.1', '0.2.1-rc.1')).toBe(true)
    expect(isCoreUpgrade('0.2.0-rc.2', '0.2.1-rc.1')).toBe(true)
    expect(isCoreUpgrade('0.17.1', '0.18.0')).toBe(true)
    expect(isCoreUpgrade('0.17.1', '1.0.0')).toBe(true)
    expect(isCoreUpgrade('0.17.1', '2.0.0')).toBe(true)
    expect(isCoreUpgrade('0.1.5-rc.1', '0.1.6-alpha.2')).toBe(true)
  })

  it('同一核心号的预发布标识互换不算升级', () => {
    expect(isCoreUpgrade('0.1.7-rc.1', '0.1.7-rc.2')).toBe(false)
    expect(isCoreUpgrade('0.1.7-rc.2', '0.1.7-rc.1')).toBe(false)
    expect(isCoreUpgrade('0.1.7-rc.2', '0.1.7-alpha.1')).toBe(false)
    expect(isCoreUpgrade('0.1.5-rc.1', '0.1.5')).toBe(false)
    expect(isCoreUpgrade('0.1.5', '0.1.5-rc.1')).toBe(false)
    expect(isCoreUpgrade('0.2.1-alpha.1', '0.2.1-rc.1')).toBe(false)
    expect(isCoreUpgrade('0.2.1-rc.1', '0.2.1')).toBe(false)
  })

  it('平级不算升级', () => {
    expect(isCoreUpgrade('0.1.5', '0.1.5')).toBe(false)
    expect(isCoreUpgrade('0.1.5-rc.1', '0.1.5-rc.1')).toBe(false)
    expect(isCoreUpgrade('0.2.1-rc.1', '0.2.1-rc.1')).toBe(false)
  })

  it('降级不算升级', () => {
    expect(isCoreUpgrade('0.2.1-rc.1', '0.1.7-rc.1')).toBe(false)
    expect(isCoreUpgrade('0.2.1-rc.1', '0.2.0-rc.2')).toBe(false)
    expect(isCoreUpgrade('0.1.7', '0.1.5')).toBe(false)
    expect(isCoreUpgrade('0.1.7-rc.2', '0.1.5-rc.1')).toBe(false)
    expect(isCoreUpgrade('0.18.0', '0.17.1')).toBe(false)
    expect(isCoreUpgrade('1.0.0', '0.9.9')).toBe(false)
  })

  it('任一侧版本缺失或不可解析时不误报', () => {
    expect(isCoreUpgrade('', '0.18.0')).toBe(false)
    expect(isCoreUpgrade('local', '0.18.0')).toBe(false)
    expect(isCoreUpgrade('0.17.1', '')).toBe(false)
    expect(isCoreUpgrade('0.17.1', 'app')).toBe(false)
  })

  it('带 dsh-/src- 前缀的 release tag 按同一版本判定', () => {
    expect(isCoreUpgrade('dsh-0.1.5-rc.8-1', 'src-0.1.7')).toBe(true)
    expect(isCoreUpgrade('dsh-0.1.7-rc.1-1', 'src-0.1.7-rc.2-2')).toBe(false)
    expect(isCoreUpgrade('dsh-src-0.2.0-rc.2-38900000000', 'src-0.2.1-rc.1-39009013600')).toBe(true)
  })
})
