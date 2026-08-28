import { describe, expect, it, vi } from 'vitest'
import { promptLanguageFor, resolveLanguage, resolveSystemLanguage, translate } from './i18n'

describe('language resolution', () => {
  it('maps Simplified and Traditional Chinese environments explicitly', () => {
    expect(resolveLanguage('zh-Hans-SG')).toBe('zh-CN')
    expect(resolveLanguage('zh-HK')).toBe('zh-TW')
    expect(promptLanguageFor('zh-TW')).toBe('zh-TW')
  })

  it('falls back to English for unsupported languages and prompts', () => {
    expect(resolveLanguage('ar-SA')).toBe('en')
    expect(promptLanguageFor('ja')).toBe('en')
    expect(promptLanguageFor('fr')).toBe('en')
  })

  it('uses the first supported operating-system language', () => {
    vi.stubGlobal('navigator', { languages: ['ar-SA', 'de-DE'], language: 'ar-SA' })
    expect(resolveSystemLanguage()).toBe('de')
    vi.unstubAllGlobals()
  })

  it('translates main UI and settings keys with English fallback', () => {
    expect(translate('zh-CN', 'projects')).toBe('项目')
    expect(translate('zh-TW', 'manageModels')).toBe('管理模型連線')
    expect(translate('de', 'projects')).toBe('Projekte')
    expect(translate('ja', 'serviceUrl')).toBe('Service URL (optional)')
  })
})
