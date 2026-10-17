import { getPref, setPref } from './storage.js';

export const THEMES = ['system', 'light', 'dark'];
export const ACCENTS = [
  { id: 'vermilion', label: 'Vermilion', swatch: '#f0553a' },
  { id: 'teal', label: 'Teal', swatch: '#14a597' },
  { id: 'indigo', label: 'Indigo', swatch: '#6366f1' }
];

const mq = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

const read = (name, fallback) => {
  try { return localStorage.getItem(`pref-${name}`) || fallback; } catch { return fallback; }
};

export const getTheme = () => read('theme', 'system');
export const getAccent = () => read('accent', 'vermilion');

export const applyTheme = () => {
  const t = getTheme();
  const dark = t === 'dark' || (t === 'system' && (mq ? mq.matches : true));
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.accent = getAccent();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#151412' : '#f4f2ec');
};

export const setTheme = async (t) => { await setPref('theme', t); applyTheme(); };
export const setAccent = async (a) => { await setPref('accent', a); applyTheme(); };

/** Call once at startup. index.html already applied the saved theme before first paint. */
export const initTheme = () => {
  applyTheme();
  mq?.addEventListener?.('change', () => { if (getTheme() === 'system') applyTheme(); });
  // Restore from native storage if the WebView copy was wiped.
  Promise.all([getPref('theme', 'system'), getPref('accent', 'vermilion')]).then(([t, a]) => {
    try { localStorage.setItem('pref-theme', t); localStorage.setItem('pref-accent', a); } catch { /* ignore */ }
    applyTheme();
  });
};
