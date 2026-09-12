import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './en.json';
import zhTW from './zh-TW.json';

export const LANG_STORAGE_KEY = 'cf_lang';

export const SUPPORTED_LANGS = ['zh-TW', 'en'] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

function isLang(value: string | null): value is Lang {
  return value === 'zh-TW' || value === 'en';
}

/** Stored preference wins; otherwise guess from the browser, defaulting to zh-TW. */
export function detectLang(): Lang {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LANG_STORAGE_KEY);
  } catch {
    /* storage blocked */
  }
  if (isLang(stored)) return stored;
  const nav = typeof navigator !== 'undefined' ? navigator.language : '';
  return nav.toLowerCase().startsWith('zh') ? 'zh-TW' : 'en';
}

export function persistLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* storage blocked; language still applies for this session */
  }
  i18n.changeLanguage(lang);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    'zh-TW': { translation: zhTW },
    en: { translation: en },
  },
  lng: detectLang(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

if (typeof document !== 'undefined') {
  document.documentElement.lang = detectLang();
}

export default i18n;
