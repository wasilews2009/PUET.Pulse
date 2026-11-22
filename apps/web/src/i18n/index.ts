import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { uk } from './uk';

export type Lang = 'uk' | 'en';
const KEY = 'pulse.lang';

function stored(): Lang | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'uk' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

/** Ukrainian is the default; English when the user (or their profile) chose it. */
export const initialLang = (): Lang => stored() ?? 'uk';

void i18n.use(initReactI18next).init({
  resources: { uk: { translation: uk }, en: { translation: en } },
  lng: initialLang(),
  fallbackLng: 'uk',
  supportedLngs: ['uk', 'en'],
  interpolation: { escapeValue: false },
  returnObjects: true,
});

export function setLang(lang: Lang, remember = true) {
  void i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
  if (remember) {
    try {
      localStorage.setItem(KEY, lang);
    } catch {
      /* private mode */
    }
  }
}

export const hasStoredLang = () => stored() !== null;

/** Localized name of a bilingual entity (channel, institute, person). */
export function pick(lang: string, uk: string | null | undefined, en: string | null | undefined): string {
  return (lang === 'en' ? en || uk : uk || en) ?? '';
}

export default i18n;
