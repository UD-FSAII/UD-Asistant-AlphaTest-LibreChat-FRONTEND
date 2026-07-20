import { atom } from 'recoil';
import Cookies from 'js-cookie';
import { atomWithLocalStorage } from './utils';

const readStoredLang = () => {
  if (typeof localStorage === 'undefined') {
    return undefined;
  }

  const storedLang = localStorage.getItem('lang');
  if (!storedLang) {
    return undefined;
  }

  try {
    const parsedLang = JSON.parse(storedLang);
    return typeof parsedLang === 'string' ? parsedLang : storedLang;
  } catch {
    return storedLang;
  }
};

/**
 * UD Assistant customization: the interface is English-only.
 * Upstream falls back to the browser locale (and any stored/cookie value), which
 * would show a non-English UI to users whose browser is set to another language.
 * Since the language selector is hidden (see Nav/Settings/controls.tsx), that would
 * leave them stuck. Force 'en' unconditionally.
 */
const defaultLang = () => 'en';
const lang = atomWithLocalStorage('lang', defaultLang());
const languageLoading = atom<boolean>({
  key: 'languageLoading',
  default: false,
});

export default { lang, languageLoading };
