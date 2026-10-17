import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/**
 * Durable storage for AniTrack.
 *
 * Why this exists: WebView localStorage can be wiped by the OS or "Clear storage",
 * and is not reliably restored by Android backup. On device we now write to
 * Capacitor Preferences (native SharedPreferences), which survives WebView
 * eviction and is included in Android Auto Backup. localStorage is kept as a
 * mirror, so a list from older versions migrates automatically on first launch.
 */

export const KEY = 'anitrack-watchlist';
const LEGACY_KEY = 'pht-anime-watchlist';
const PREV_KEY = 'anitrack-watchlist-prev'; // snapshot taken before import/replace
const CORRUPT_KEY = 'anitrack-watchlist-corrupt'; // raw data we could not parse
const BACKUP_META_KEY = 'anitrack-last-backup';

const isNative = Capacitor.isNativePlatform();

const nativeGet = async (key) => {
  if (!isNative) return null;
  try {
    return (await Preferences.get({ key })).value ?? null;
  } catch {
    return null;
  }
};

const nativeSet = async (key, value) => {
  if (!isNative) return;
  await Preferences.set({ key, value });
};

const lsGet = (key) => {
  try { return localStorage.getItem(key); } catch { return null; }
};

const lsSet = (key, value) => {
  try { localStorage.setItem(key, value); } catch { /* quota / disabled */ }
};

const countItems = (raw) => {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.length : 0;
  } catch {
    return -1;
  }
};

/** Ask the browser not to evict our storage (no-op where unsupported). */
export const requestPersistence = async () => {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch { /* ignore */ }
};

/**
 * Load the watchlist. Returns { list, notice }.
 * Picks whichever source (native / localStorage / legacy) holds the most entries,
 * so we never "recover" into an older, smaller copy.
 */
export const loadWatchlist = async () => {
  const sources = [
    await nativeGet(KEY),
    lsGet(KEY),
    lsGet(LEGACY_KEY)
  ].filter(Boolean);

  let best = null;
  let bestCount = -1;
  let sawCorrupt = null;

  for (const raw of sources) {
    const n = countItems(raw);
    if (n < 0) { sawCorrupt = raw; continue; }
    if (n > bestCount) { best = raw; bestCount = n; }
  }

  if (sawCorrupt) {
    // Keep the unreadable data so it can be recovered manually; never overwrite it.
    lsSet(CORRUPT_KEY, sawCorrupt);
    try { await nativeSet(CORRUPT_KEY, sawCorrupt); } catch { /* ignore */ }
  }

  if (best === null) {
    return {
      list: [],
      notice: sawCorrupt
        ? 'Your saved list could not be read. A copy was kept aside; you can restore from a backup file.'
        : null
    };
  }
  return { list: JSON.parse(best), notice: null };
};

/** Persist the watchlist to every store. Throws only if all stores fail. */
export const saveWatchlist = async (list) => {
  const json = JSON.stringify(list);
  let ok = false;
  try {
    localStorage.setItem(KEY, json);
    ok = true;
  } catch { /* try native */ }
  try {
    await nativeSet(KEY, json);
    ok = true;
  } catch { /* handled below */ }
  if (!ok) throw new Error('Could not save your list (storage unavailable).');
};

/** Save a safety copy of the current list before an import/replace. */
export const snapshotPrevious = async (list) => {
  const json = JSON.stringify(list);
  lsSet(PREV_KEY, json);
  try { await nativeSet(PREV_KEY, json); } catch { /* ignore */ }
};

export const loadPreviousSnapshot = async () => {
  const raw = (await nativeGet(PREV_KEY)) || lsGet(PREV_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
};

export const getLastBackupAt = async () => {
  const raw = (await nativeGet(BACKUP_META_KEY)) || lsGet(BACKUP_META_KEY);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const markBackup = async () => {
  const now = String(Date.now());
  lsSet(BACKUP_META_KEY, now);
  try { await nativeSet(BACKUP_META_KEY, now); } catch { /* ignore */ }
};

/* ---------------- Export / import ---------------- */

export const buildBackupJson = (list) =>
  JSON.stringify(
    { app: 'AniTrack', version: 1, exportedAt: new Date().toISOString(), watchlist: list },
    null,
    2
  );

/** Export the list as a JSON file. On device this opens the Android share sheet. */
export const exportBackup = async (list) => {
  const json = buildBackupJson(list);
  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `anitrack-backup-${stamp}.json`;

  if (isNative) {
    const { uri } = await Filesystem.writeFile({
      path: fileName,
      data: json,
      directory: Directory.Cache,
      encoding: Encoding.UTF8
    });
    await Share.share({
      title: 'AniTrack backup',
      text: 'AniTrack watchlist backup',
      url: uri,
      dialogTitle: 'Save your AniTrack backup'
    });
  } else {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  await markBackup();
  return fileName;
};

/** Copy the backup JSON to the clipboard (fallback when sharing is awkward). */
export const copyBackupToClipboard = async (list) => {
  await navigator.clipboard.writeText(buildBackupJson(list));
  await markBackup();
};

/** Parse + validate backup text. Accepts our format or a bare array. Throws on bad input. */
export const parseBackup = (text) => {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const arr = Array.isArray(data) ? data : data?.watchlist;
  if (!Array.isArray(arr)) throw new Error('No watchlist found in that file.');
  const valid = arr.filter((i) => i && Number.isFinite(Number(i.id)));
  if (valid.length === 0 && arr.length > 0) throw new Error('The file has no valid entries.');
  return valid.map((i) => ({ ...i, id: Number(i.id) }));
};

/* ---------------- Small preferences (e.g. alert toggle) ---------------- */
export const getPref = async (name, fallback = null) => {
  const raw = (await nativeGet(`pref-${name}`)) ?? lsGet(`pref-${name}`);
  return raw === null || raw === undefined ? fallback : raw;
};
export const setPref = async (name, value) => {
  lsSet(`pref-${name}`, String(value));
  try { await nativeSet(`pref-${name}`, String(value)); } catch { /* ignore */ }
};
