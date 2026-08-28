import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { translate, type SupportedLanguage, type UiKey } from './i18n'

type I18nValue = { language: SupportedLanguage; t: (key: UiKey) => string }
const I18nContext = createContext<I18nValue>({ language: 'en', t: key => translate('en', key) })

export function I18nProvider({ language, children }: { language: SupportedLanguage; children: ReactNode }) {
  const value = useMemo(() => ({ language, t: (key: UiKey) => translate(language, key) }), [language])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export const useI18n = () => useContext(I18nContext)
