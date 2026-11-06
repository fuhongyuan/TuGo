export type RuntimePromptLocale = 'en' | 'zh-CN' | 'zh-TW'

export const normalizePromptLocale = (value: unknown): RuntimePromptLocale =>
  value === 'zh-CN' || value === 'zh-TW' ? value : 'en'
