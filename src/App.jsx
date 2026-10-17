import React, { useState, useEffect, useRef, useMemo, createContext, useContext, useCallback } from 'react';
import { 
  ChevronLeft, ChevronRight, Calendar as CalendarIcon, Clock,
  Search, Check, Plus, Minus, RefreshCw, AlertTriangle, Info,
  Settings, ChevronDown, CheckCircle, Flame, Star,
  X, ExternalLink, Heart, Film, Trash2, Users, TrendingUp,
  Filter, ArrowUpDown, Layers, Compass, MoreVertical, SlidersHorizontal
} from 'lucide-react';
import DataPanel from './DataPanel.jsx';
import {
  loadWatchlist, saveWatchlist, snapshotPrevious, getLastBackupAt, requestPersistence, getPref, setPref
} from './storage.js';
import Stats from './Stats.jsx';
import { useToast } from './Toast.jsx';
import { Shimmer, CoverGridSkeleton, RowsSkeleton } from './Skeleton.jsx';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { scheduleAiring, ensurePermission, onWatchedAction } from './notifications.js';

const ANILIST_API = 'https://graphql.anilist.co';

const a11yClick = (fn) => ({
  role: 'button',
  tabIndex: 0,
  onClick: fn,
  onKeyDown: (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); }
  }
});

const NAV = [
  { id: 'dashboard', label: 'Home', Icon: TrendingUp },
  { id: 'watchlist', label: 'List', Icon: Film },
  { id: 'seasonal', label: 'Seasonal', Icon: Compass },
  { id: 'search', label: 'Search', Icon: Search },
  { id: 'stats', label: 'Stats', Icon: Layers }
];

const STATUS_LABEL = { WATCHING: 'Watching', PLAN_TO_WATCH: 'Plan to watch', COMPLETED: 'Completed', PAUSED: 'On hold', DROPPED: 'Dropped' };

// Swipe right on a row/card = +1 episode. Vertical scrolling is left alone.
const useSwipeRight = (onSwipe) => {
  const start = useRef(null);
  return {
    style: { touchAction: 'pan-y' },
    onTouchStart: (e) => { const t = e.touches[0]; start.current = { x: t.clientX, y: t.clientY }; },
    onTouchEnd: (e) => {
      const s0 = start.current; start.current = null;
      if (!s0) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - s0.x, dy = t.clientY - s0.y;
      if (dx > 70 && Math.abs(dx) > Math.abs(dy) * 2) onSwipe();
    }
  };
};

const bumpInfo = (item, updateProgress) => {
  let max = Infinity;
  if (item.mediaStatus === 'RELEASING' && item.airedEpisodes != null) max = item.airedEpisodes;
  else if (item.totalEpisodes != null) max = item.totalEpisodes;
  const canBump = item.progress < max;
  return {
    canBump,
    behind: item.airedEpisodes != null ? Math.max(0, item.airedEpisodes - item.progress) : 0,
    pct: item.totalEpisodes ? Math.min(100, (item.progress / item.totalEpisodes) * 100) : (item.progress ? 25 : 0),
    bump: () => { if (canBump) { updateProgress(item.id, item.progress + 1); navigator.vibrate?.(15); } }
  };
};

const getLocalUnixNow = () => Math.floor(Date.now() / 1000);

const getLocalStartOfDayUnix = (unix) => {
  const d = new Date(unix * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
};

const addLocalDays = (unix, deltaDays) => {
  const d = new Date(unix * 1000);
  d.setDate(d.getDate() + deltaDays);
  return Math.floor(d.getTime() / 1000);
};

const addLocalMonths = (unix, deltaMonths) => {
  const d = new Date(unix * 1000);
  d.setDate(1);
  d.setMonth(d.getMonth() + deltaMonths);
  return Math.floor(d.getTime() / 1000);
};

const getDayOfWeekLocal = (unix) => {
  const d = new Date(unix * 1000);
  const day = d.getDay();
  return day === 0 ? 6 : day - 1; // Monday = 0, Sunday = 6
};

const getLocalDaysInMonth = (monthStartUnix) => {
  const d = new Date(monthStartUnix * 1000);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
};

const formatLocal = (unix, options) => {
  return new Intl.DateTimeFormat(undefined, options).format(new Date(unix * 1000));
};

const CACHE_KEY = 'anitrack-api-cache-v1';
const CACHE_MAX = 25;
const hashStr = (str) => {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
};
const readCache = () => {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; }
};
const writeCache = (key, data) => {
  try {
    const c = readCache();
    c[key] = { t: Date.now(), data };
    Object.keys(c).sort((a, b) => c[b].t - c[a].t).slice(CACHE_MAX).forEach((k) => delete c[k]);
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch { /* quota: skip caching */ }
};

// Network first; if offline, fall back to the last successful response for the same request.
const fetchGraphQL = async (query, variables, signal) => {
  const cacheKey = hashStr(query + JSON.stringify(variables || {}));
  let res;
  try {
    res = await fetch(ANILIST_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    const hit = readCache()[cacheKey];
    if (hit) {
      window.dispatchEvent(new CustomEvent('anitrack:offline', { detail: hit.t }));
      return hit.data;
    }
    throw e;
  }
  if (res.status === 429) throw new Error('rate_limit');
  if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  writeCache(cacheKey, json.data);
  return json.data;
};

const parseSynopsis = (html) => {
  if (!html) return "No synopsis available.";
  let cleaned = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  return cleaned.trim() || "No synopsis available.";
};

const TickerContext = createContext(Date.now());
const useTicker = () => useContext(TickerContext);

const TickerProvider = ({ children }) => {
  const [ticker, setTicker] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) setTicker(Date.now()); }, 30000);
    const onVisible = () => { if (!document.hidden) setTicker(Date.now()); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  return (
    <TickerContext.Provider value={ticker}>
      {children}
    </TickerContext.Provider>
  );
};

const migrateWatchlistItem = (item) => {
  const statusMap = {
    'Watching': 'WATCHING',
    'Plan to Watch': 'PLAN_TO_WATCH',
    'Completed': 'COMPLETED',
    'On Hold': 'PAUSED',
    'Dropped': 'DROPPED'
  };

  const status = statusMap[item.status] || item.status || 'WATCHING';

  let title = item.title;
  if (typeof title === 'string') {
    title = { romaji: title, english: title, native: title };
  } else if (!title) {
    title = { romaji: 'Unknown Title', english: 'Unknown Title', native: '' };
  }

  let coverImage = item.coverImage;
  if (typeof coverImage === 'string') {
    coverImage = { large: coverImage, extraLarge: coverImage };
  } else if (!coverImage) {
    coverImage = { large: '', extraLarge: '' };
  }

  let progress = 0;
  if (Array.isArray(item.watchedEpisodes)) {
    progress = item.watchedEpisodes.length > 0 ? Math.max(...item.watchedEpisodes) : 0;
  } else if (typeof item.progress === 'number') {
    progress = item.progress;
  }

  return {
    id: item.id,
    idMal: item.idMal || null,
    title,
    coverImage,
    status,
    progress,
    totalEpisodes: item.totalEpisodes ?? item.episodes ?? null,
    mediaStatus: item.mediaStatus || item.status || 'RELEASING',
    airedEpisodes: item.airedEpisodes ?? null,
    nextEpisodeAt: item.nextEpisodeAt ?? null,
    score: item.score ?? null,
    notes: item.notes ?? '',
    favorite: item.favorite ?? false,
    previousProgress: item.previousProgress ?? progress
  };
};

function useWatchlist() {
  const [watchlist, setWatchlist] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [lastBackupAt, setLastBackupAt] = useState(null);

  // Hydrate from durable storage once. Nothing is written until this finishes,
  // so the empty first render can never overwrite saved data.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await requestPersistence();
      const { list, notice: n } = await loadWatchlist();
      const backupAt = await getLastBackupAt();
      if (cancelled) return;
      setWatchlist(list.map(migrateWatchlistItem));
      setNotice(n);
      setLastBackupAt(backupAt);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const watchlistRef = useRef(watchlist);
  useEffect(() => {
    watchlistRef.current = watchlist;
    if (!loaded) return;
    saveWatchlist(watchlist)
      .then(() => setSaveError(null))
      .catch((e) => setSaveError(e.message));
  }, [watchlist, loaded]);

  const add = useCallback((anime, initialProgress = 0) => {
    setWatchlist(prev => {
      if (prev.find(a => a.id === anime.id)) return prev;

      const title = typeof anime.title === 'string'
        ? { romaji: anime.title, english: anime.title, native: '' }
        : (anime.title || { romaji: 'Unknown Title', english: 'Unknown Title', native: '' });

      const coverImage = typeof anime.coverImage === 'string'
        ? { large: anime.coverImage, extraLarge: anime.coverImage }
        : (anime.coverImage || { large: '', extraLarge: '' });

      const totalEpisodes = anime.episodes || anime.totalEpisodes || null;
      const mediaStatus = anime.mediaStatus || anime.status || 'RELEASING';
      const nextAiring = anime.nextAiringEpisode;
      const airedEpisodes = anime.airedEpisodes ?? (nextAiring ? nextAiring.episode - 1 : (mediaStatus === 'FINISHED' ? totalEpisodes : null));
      const nextEpisodeAt = anime.nextEpisodeAt ?? nextAiring?.airingAt ?? null;

      let status = initialProgress > 0 ? 'WATCHING' : 'PLAN_TO_WATCH';
      if (totalEpisodes && initialProgress >= totalEpisodes && mediaStatus === 'FINISHED') {
        status = 'COMPLETED';
      }

      return [...prev, {
        id: anime.id,
        idMal: anime.idMal || null,
        title,
        coverImage,
        status,
        progress: initialProgress,
        totalEpisodes,
        mediaStatus,
        airedEpisodes,
        nextEpisodeAt,
        score: null,
        notes: '',
        favorite: false,
        previousProgress: initialProgress || 1
      }];
    });
  }, []);

  const remove = useCallback((id) => {
    setWatchlist(prev => prev.filter(a => a.id !== id));
  }, []);

  const updateStatus = useCallback((id, newStatus) => {
    setWatchlist(prev => prev.map(item => {
      if (item.id !== id) return item;
      
      let newProgress = item.progress;
      let prevProg = item.previousProgress ?? item.progress;

      if (newStatus === 'COMPLETED') {
        prevProg = item.progress > 0 ? item.progress : (item.totalEpisodes || 1);
        newProgress = item.totalEpisodes || item.progress || 1;
      } else if (item.status === 'COMPLETED' && newStatus === 'WATCHING') {
        newProgress = prevProg > 0 ? prevProg : 1;
      }

      return {
        ...item,
        status: newStatus,
        progress: newProgress,
        previousProgress: prevProg
      };
    }));
  }, []);

  const setStatusAndAdd = useCallback((anime, newStatus) => {
    setWatchlist(prev => {
      const existing = prev.find(a => a.id === anime.id);
      const totalEpisodes = anime.episodes || anime.totalEpisodes || null;
      
      if (existing) {
        let newProgress = existing.progress;
        let prevProg = existing.previousProgress ?? existing.progress;
        if (newStatus === 'COMPLETED') {
          prevProg = existing.progress > 0 ? existing.progress : (totalEpisodes || 1);
          newProgress = totalEpisodes || existing.progress || 1;
        } else if (existing.status === 'COMPLETED' && newStatus === 'WATCHING') {
          newProgress = prevProg > 0 ? prevProg : 1;
        }
        return prev.map(a => a.id === anime.id ? { ...a, status: newStatus, progress: newProgress, previousProgress: prevProg } : a);
      }
      
      const title = typeof anime.title === 'string'
        ? { romaji: anime.title, english: anime.title, native: '' }
        : (anime.title || { romaji: 'Unknown Title', english: 'Unknown Title', native: '' });

      const coverImage = typeof anime.coverImage === 'string'
        ? { large: anime.coverImage, extraLarge: anime.coverImage }
        : (anime.coverImage || { large: '', extraLarge: '' });

      const mediaStatus = anime.mediaStatus || anime.status || 'RELEASING';
      const nextAiring = anime.nextAiringEpisode;
      const airedEpisodes = anime.airedEpisodes ?? (nextAiring ? nextAiring.episode - 1 : (mediaStatus === 'FINISHED' ? totalEpisodes : null));
      const nextEpisodeAt = anime.nextEpisodeAt ?? nextAiring?.airingAt ?? null;

      let initialProgress = 0;
      if (newStatus === 'COMPLETED') initialProgress = totalEpisodes || 1;

      return [...prev, {
        id: anime.id,
        idMal: anime.idMal || null,
        title,
        coverImage,
        status: newStatus,
        progress: initialProgress,
        totalEpisodes,
        mediaStatus,
        airedEpisodes,
        nextEpisodeAt,
        score: null,
        notes: '',
        favorite: false,
        previousProgress: initialProgress || 1
      }];
    });
  }, []);

  const updateProgress = useCallback((id, newProgress) => {
    setWatchlist(prev => prev.map(item => {
      if (item.id !== id) return item;
      
      let maxAllowed = Infinity;
      if (item.mediaStatus === 'RELEASING' && item.airedEpisodes !== null && item.airedEpisodes !== undefined) {
        maxAllowed = item.airedEpisodes;
      } else if (item.totalEpisodes !== null && item.totalEpisodes !== undefined) {
        maxAllowed = item.totalEpisodes;
      }
      
      const clampedProgress = Math.max(0, Math.min(newProgress, maxAllowed));
      let status = item.status;
      let prevProg = item.previousProgress;
      
      if (item.totalEpisodes && clampedProgress >= item.totalEpisodes && item.mediaStatus === 'FINISHED') {
        status = 'COMPLETED';
      } else if (clampedProgress > 0 && status === 'PLAN_TO_WATCH') {
        status = 'WATCHING';
      } else if (clampedProgress < (item.totalEpisodes || Infinity) && status === 'COMPLETED') {
        status = 'WATCHING';
      }

      if (clampedProgress > 0) prevProg = clampedProgress;

      return { ...item, progress: clampedProgress, status, previousProgress: prevProg };
    }));
  }, []);

  const setScore = useCallback((id, score) => {
    setWatchlist(prev => prev.map(a => a.id === id ? { ...a, score: score ? Number(score) : null } : a));
  }, []);

  const setNotes = useCallback((id, notes) => {
    setWatchlist(prev => prev.map(a => a.id === id ? { ...a, notes } : a));
  }, []);

  const toggleFavorite = useCallback((id) => {
    setWatchlist(prev => prev.map(a => a.id === id ? { ...a, favorite: !a.favorite } : a));
  }, []);

  const upsert = useCallback((item) => {
    setWatchlist(prev => prev.some(a => a.id === item.id) ? prev.map(a => a.id === item.id ? item : a) : [...prev, item]);
  }, []);

  const replaceAll = useCallback(async (items) => {
    await snapshotPrevious(watchlistRef.current);
    const next = items.map(migrateWatchlistItem);
    watchlistRef.current = next;
    setWatchlist(next);
    return `Restored ${next.length} anime.`;
  }, []);

  const mergeIn = useCallback(async (items) => {
    await snapshotPrevious(watchlistRef.current);
    const byId = new Map(watchlistRef.current.map(a => [a.id, a]));
    let added = 0, updated = 0;
    for (const inc of items.map(migrateWatchlistItem)) {
      const ex = byId.get(inc.id);
      if (!ex) { byId.set(inc.id, inc); added++; }
      else if (inc.progress > ex.progress) {
        byId.set(inc.id, {
          ...ex,
          progress: inc.progress,
          status: inc.status,
          previousProgress: inc.previousProgress,
          score: ex.score ?? inc.score,
          notes: ex.notes || inc.notes,
          favorite: ex.favorite || inc.favorite
        });
        updated++;
      }
    }
    const next = [...byId.values()];
    watchlistRef.current = next;
    setWatchlist(next);
    return `Added ${added}, updated ${updated}.`;
  }, []);

  const refreshLastBackup = useCallback(async () => setLastBackupAt(await getLastBackupAt()), []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const sync = useCallback(async () => {
    const currentList = watchlistRef.current;
    if (currentList.length === 0) return { success: true };

    const ids = currentList.map(i => i.id);
    const chunkSize = 50;
    const chunks = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
      chunks.push(ids.slice(i, i + chunkSize));
    }

    const query = `
      query ($ids: [Int]) {
        Page(page: 1, perPage: 50) {
          media(id_in: $ids) {
            id idMal episodes status
            title { romaji english native }
            coverImage { large extraLarge }
            nextAiringEpisode { episode airingAt }
          }
        }
      }
    `;

    try {
      let allUpdates = [];
      for (const chunk of chunks) {
        const data = await fetchGraphQL(query, { ids: chunk });
        if (data?.Page?.media) {
          allUpdates = allUpdates.concat(data.Page.media);
        }
        if (chunks.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 500)); 
        }
      }

      setWatchlist(prev => prev.map(item => {
        const update = allUpdates.find(u => u.id === item.id);
        if (!update) return item;
        const total = update.episodes ?? item.totalEpisodes;
        const mediaStatus = update.status || item.mediaStatus;
        const next = update.nextAiringEpisode;
        const aired = next ? next.episode - 1 : (mediaStatus === 'FINISHED' ? total : null);
        
        let newStatus = item.status;
        if (total && item.progress >= total && mediaStatus === 'FINISHED') {
          newStatus = 'COMPLETED';
        }

        return {
          ...item,
          idMal: update.idMal || item.idMal,
          totalEpisodes: total,
          mediaStatus,
          airedEpisodes: aired,
          nextEpisodeAt: next?.airingAt || null,
          status: newStatus
        };
      }));
      return { success: true };
    } catch (e) {
      console.error("Watchlist sync failed:", e);
      return { success: false, error: e.message };
    }
  }, []);

  return {
    watchlist, loaded, notice, saveError, lastBackupAt,
    add, remove, updateStatus, setStatusAndAdd, updateProgress,
    setScore, setNotes, toggleFavorite, sync,
    replaceAll, mergeIn, upsert, refreshLastBackup, dismissNotice
  };
}

function useSchedulesRange(startUnix, endUnix, mode, myListOnly, watchlistIds) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [retryCount, setRetryCount] = useState(0);
  const cache = useRef(new Map());

  const retry = useCallback(() => setRetryCount(c => c + 1), []);

  useEffect(() => {
    if (myListOnly && watchlistIds.length === 0) {
      setData([]);
      setError(null);
      setLoading(false);
      return;
    }

    if (mode === 'monthly' && !myListOnly) {
      setData([]);
      setError('limit_hint');
      setLoading(false);
      return;
    }

    const cacheKey = `${mode}:${startUnix}:${endUnix}:${myListOnly}:${watchlistIds.slice().sort().join(',')}`;
    if (cache.current.has(cacheKey)) {
      setData(cache.current.get(cacheKey));
      setError(null);
      setLoading(false);
      return;
    }

    setData([]);
    setLoading(true);
    setError(null);

    const abortController = new AbortController();
    let isSubscribed = true;

    const fetchSchedules = async () => {
      let allSchedules = [];
      let page = 1;
      let hasNextPage = true;
      const MAX_PAGES = myListOnly ? 20 : 10;
      let hitTruncated = false;

      const query = `
        query ($start: Int!, $end: Int!, $page: Int!, $inIds: [Int]) {
          Page(page: $page, perPage: 50) {
            pageInfo { hasNextPage }
            airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, mediaId_in: $inIds, sort: TIME) {
              id episode airingAt
              media {
                id title { romaji english }
                coverImage { large }
                episodes status isAdult
              }
            }
          }
        }
      `;

      try {
        while (hasNextPage && page <= MAX_PAGES && isSubscribed) {
          const variables = { 
            start: startUnix - 1, 
            end: endUnix, 
            page, 
            inIds: myListOnly ? watchlistIds : undefined 
          };
          
          const result = await fetchGraphQL(query, variables, abortController.signal);
          if (!isSubscribed) return;

          const filtered = result.Page.airingSchedules.filter(s => !s.media.isAdult);
          allSchedules = [...allSchedules, ...filtered];
          
          hasNextPage = result.Page.pageInfo.hasNextPage;
          if (hasNextPage && page >= MAX_PAGES && !myListOnly) {
            hitTruncated = true;
          }
          page++;
        }

        if (isSubscribed) {
          cache.current.set(cacheKey, allSchedules);
          setData(allSchedules);
          setError(hitTruncated ? 'truncated' : null);
        }
      } catch (err) {
        if (err.name === 'AbortError' || !isSubscribed) return;
        setError(err.message === 'rate_limit' ? 'rate_limit' : (err.message || 'Failed to load schedule.'));
      } finally {
        if (isSubscribed) setLoading(false);
      }
    };

    fetchSchedules();
    return () => {
      isSubscribed = false;
      abortController.abort();
    };
  }, [startUnix, endUnix, mode, myListOnly, watchlistIds.slice().sort().join(','), retryCount]);

  return { data, loading, error, retry };
}

const CountdownLabel = ({ unixTarget }) => {
  const now = Math.floor(useTicker() / 1000);
  const diff = unixTarget - now;
  if (diff <= 0) return <span className="text-emerald-400">Released</span>;
  
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  return (
    <span className="text-indigo-400">
      {d > 0 ? `${d}d ` : ''}{h}h {m}m
    </span>
  );
};

const ProgressRing = ({ progress, total, size = 40, strokeWidth = 3 }) => {
  const r = (size - strokeWidth) / 2;
  const circ = 2 * Math.PI * r;
  const percent = total ? Math.min(progress / total, 1) : (progress > 0 ? 0.25 : 0);
  
  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle cx={size/2} cy={size/2} r={r} fill="transparent" style={{ stroke: 'var(--color-slate-700)' }} strokeWidth={strokeWidth} />
      <circle cx={size/2} cy={size/2} r={r} fill="transparent" style={{ stroke: 'var(--color-indigo-400)' }} strokeWidth={strokeWidth}
        strokeDasharray={circ} strokeDashoffset={circ * (1 - percent)}
        className="transition-all duration-500 ease-out" />
    </svg>
  );
};

const PlayCircleIcon = ({ size = 20, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <circle cx="12" cy="12" r="10"/>
    <polygon points="10 8 16 12 10 16 10 8"/>
  </svg>
);

const EpisodeRow = ({ episode, itemStatus, itemProgress, onToggleWatched, openAnime }) => {
  const now = getLocalUnixNow();
  const isAired = episode.airingAt <= now;
  const isWatched = itemProgress >= episode.episode;
  
  const handleToggle = (e) => {
    e.stopPropagation();
    if (!isAired) return;
    onToggleWatched(isWatched ? episode.episode - 1 : episode.episode);
  };

  return (
    <div 
      onClick={() => openAnime && openAnime(episode.media.id)}
      className={`flex items-center gap-3 p-3 hover:bg-slate-800/50 rounded-xl transition-colors cursor-pointer ${!isAired ? 'opacity-75' : ''}`}
    >
      <button 
        onClick={handleToggle}
        disabled={!isAired}
        className={`flex-shrink-0 w-6 h-6 rounded-md border flex items-center justify-center transition-all
          ${isWatched ? 'bg-indigo-500 border-indigo-500 text-white' : 'border-slate-600 text-transparent hover:border-indigo-400'}
          ${!isAired && 'opacity-50 cursor-not-allowed bg-slate-800 border-slate-700'}
        `}
        title={!isAired ? "Episode has not aired yet" : (isWatched ? "Mark unwatched" : "Mark watched")}
      >
        <Check size={14} className={isWatched ? 'opacity-100' : 'opacity-0'} />
      </button>
      
      <img src={episode.media.coverImage?.large} alt="" referrerPolicy="no-referrer" className="w-10 h-14 object-cover rounded-md flex-shrink-0" />
      
      <div className="flex-1 min-w-0">
        <h4 className="font-semibold text-sm text-slate-200 truncate hover:text-indigo-400 transition-colors" title={episode.media.title?.english || episode.media.title?.romaji}>
          {episode.media.title?.english || episode.media.title?.romaji}
        </h4>
        <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-2 flex-wrap">
          <span className="font-medium text-slate-200">
            Ep {episode.episode} {episode.media.episodes ? `/ ${episode.media.episodes}` : ''}
          </span>
          <span>•</span>
          <span className={isAired ? "text-slate-400" : "text-indigo-400 font-semibold"}>
            {isAired ? "Aired" : "Upcoming"}
          </span>
          <span>•</span>
          <span>{formatLocal(episode.airingAt, { hour: 'numeric', minute: '2-digit' })}</span>
          {!isAired && (
            <>
              <span>•</span>
              <CountdownLabel unixTarget={episode.airingAt} />
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const CalendarView = ({ watchlist, updateProgress, updateStatus, add, openAnime }) => {
  const [mode, setMode] = useState('daily');
  const [selectedUnix, setSelectedUnix] = useState(getLocalStartOfDayUnix(getLocalUnixNow()));
  const [myListOnly, setMyListOnly] = useState(watchlist.length > 0);
  
  const wIds = useMemo(() => watchlist.map(i => i.id), [watchlist]);

  let startUnix, endUnix;
  if (mode === 'daily') {
    startUnix = selectedUnix;
    endUnix = addLocalDays(selectedUnix, 1);
  } else if (mode === 'weekly') {
    const dayOfWeek = getDayOfWeekLocal(selectedUnix);
    startUnix = addLocalDays(selectedUnix, -dayOfWeek);
    endUnix = addLocalDays(startUnix, 7);
  } else {
    const d = new Date(selectedUnix * 1000);
    startUnix = getLocalStartOfDayUnix(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
    endUnix = addLocalMonths(startUnix, 1);
  }

  const { data: schedules, loading, error, retry } = useSchedulesRange(startUnix, endUnix, mode, myListOnly, wIds);

  const navDate = (delta) => {
    if (mode === 'daily') setSelectedUnix(addLocalDays(selectedUnix, delta));
    else if (mode === 'weekly') setSelectedUnix(addLocalDays(selectedUnix, delta * 7));
    else setSelectedUnix(addLocalMonths(selectedUnix, delta));
  };

  const navToday = () => setSelectedUnix(getLocalStartOfDayUnix(getLocalUnixNow()));

  const renderDaily = () => {
    if (loading) return <RowsSkeleton n={4} />;
    if (schedules.length === 0) return <div className="p-8 text-center text-slate-400 bg-slate-800/20 rounded-xl">Quiet day. Nothing airing.</div>;
    
    return (
      <div className="bg-slate-800/30 rounded-2xl p-2 grid grid-cols-1 lg:grid-cols-2 lg:gap-x-2">
        {schedules.map(ep => {
          const wItem = watchlist.find(w => w.id === ep.media.id);
          return (
            <EpisodeRow 
              key={ep.id} episode={ep} 
              itemStatus={wItem?.status}
              itemProgress={wItem?.progress || 0}
              openAnime={openAnime}
              onToggleWatched={(targetProg) => {
                if (wItem) updateProgress(ep.media.id, targetProg);
                else add(ep.media, targetProg);
              }}
            />
          );
        })}
      </div>
    );
  };

  const renderWeekly = () => {
    if (loading) return <RowsSkeleton n={5} />;

    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-7 gap-4">
        {Array.from({ length: 7 }).map((_, i) => {
          const dayUnix = addLocalDays(startUnix, i);
          const isToday = dayUnix === getLocalStartOfDayUnix(getLocalUnixNow());
          const isSelected = dayUnix === selectedUnix;
          const daySchedules = schedules.filter(s => s.airingAt >= dayUnix && s.airingAt < addLocalDays(dayUnix, 1));
          
          return (
            <div key={i} 
              onClick={() => { setSelectedUnix(dayUnix); setMode('daily'); }}
              className={`bg-slate-800/30 rounded-xl p-3 border-2 transition-all cursor-pointer hover:border-indigo-500/50
              ${isToday ? 'border-indigo-500 bg-indigo-500/5' : isSelected ? 'border-slate-500' : 'border-transparent'}`}
            >
              <div className="text-center mb-3">
                <div className="text-xs text-slate-400 uppercase font-bold">{formatLocal(dayUnix, { weekday: 'short' })}</div>
                <div className={`text-xl font-bold ${isToday ? 'text-indigo-400' : 'text-slate-200'}`}>
                  {formatLocal(dayUnix, { day: 'numeric' })}
                </div>
              </div>
              <div className="space-y-2">
                {daySchedules.slice(0, 5).map(ep => (
                  <div key={ep.id} onClick={(e) => { e.stopPropagation(); openAnime(ep.media.id); }} className="text-xs p-2 bg-slate-800/80 rounded-lg flex items-center gap-3 overflow-hidden cursor-pointer hover:bg-slate-700 transition-colors" title={ep.media.title.english || ep.media.title.romaji}>
                    <img src={ep.media.coverImage?.large} className="w-8 h-10 rounded object-cover flex-shrink-0" referrerPolicy="no-referrer" />
                    <div className="flex flex-col flex-1 min-w-0">
                      <span className="truncate font-medium text-slate-200">{ep.media.title.english || ep.media.title.romaji}</span>
                      <span className="text-slate-400 mt-0.5">Ep {ep.episode}</span>
                    </div>
                  </div>
                ))}
                {daySchedules.length > 5 && <div className="text-xs text-center text-slate-500 font-medium pt-1">+{daySchedules.length - 5} more</div>}
                {daySchedules.length === 0 && <div className="text-xs text-center text-slate-600 py-2">No items</div>}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderMonthly = () => {
    if (loading) return <Shimmer className="h-72 w-full" />;

    const daysInMonth = getLocalDaysInMonth(startUnix);
    const firstDayOfWeek = getDayOfWeekLocal(startUnix);
    const todayStartUnix = getLocalStartOfDayUnix(getLocalUnixNow());

    const paddingCells = Array.from({ length: firstDayOfWeek });
    const dayCells = Array.from({ length: daysInMonth }, (_, i) => i + 1);

    return (
      <div className="bg-slate-800/30 rounded-2xl p-4 border border-slate-700/50">
        <div className="grid grid-cols-7 gap-2 mb-2 text-center text-xs font-bold text-slate-400 uppercase tracking-wider">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
            <div key={d} className="py-1">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-2">
          {paddingCells.map((_, idx) => (
            <div key={`pad-${idx}`} className="bg-slate-900/20 rounded-xl min-h-[65px] sm:min-h-[85px]" />
          ))}
          {dayCells.map(dayNum => {
            const dayStartUnix = addLocalDays(startUnix, dayNum - 1);
            const dayEndUnix = addLocalDays(dayStartUnix, 1);
            const daySchedules = schedules.filter(s => s.airingAt >= dayStartUnix && s.airingAt < dayEndUnix);
            const isToday = dayStartUnix === todayStartUnix;
            const isSelected = dayStartUnix === selectedUnix;

            return (
              <button
                key={dayNum}
                onClick={() => {
                  setSelectedUnix(dayStartUnix);
                  setMode('daily');
                }}
                className={`p-2 rounded-xl flex flex-col justify-between items-start text-left min-h-[65px] sm:min-h-[85px] transition-all border
                  ${isToday ? 'border-indigo-500 bg-indigo-500/10' : isSelected ? 'border-slate-400 bg-slate-800/80' : 'border-slate-700/50 bg-slate-800/40 hover:border-indigo-400/50 hover:bg-slate-800'}
                `}
              >
                <span className={`text-xs font-bold ${isToday ? 'text-indigo-400' : 'text-slate-300'}`}>
                  {dayNum}
                </span>
                {daySchedules.length > 0 && (
                  <div className="mt-auto w-full">
                    <span className="inline-block w-full text-center text-[10px] sm:text-xs font-semibold bg-indigo-500/20 text-indigo-300 px-1 py-0.5 rounded border border-indigo-500/30 truncate">
                      {daySchedules.length} ep
                    </span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-800/50 p-4 rounded-2xl">
        <div className="flex gap-2">
          <button onClick={() => setMode('daily')} className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'daily' ? 'bg-indigo-500 text-white' : 'bg-slate-700/50 text-slate-300 hover:bg-slate-700'}`}>Daily</button>
          <button onClick={() => setMode('weekly')} className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'weekly' ? 'bg-indigo-500 text-white' : 'bg-slate-700/50 text-slate-300 hover:bg-slate-700'}`}>Weekly</button>
          <button onClick={() => setMode('monthly')} className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'monthly' ? 'bg-indigo-500 text-white' : 'bg-slate-700/50 text-slate-300 hover:bg-slate-700'}`}>Monthly</button>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <div className={`w-10 h-5 rounded-full relative transition-colors ${myListOnly ? 'bg-indigo-500' : 'bg-slate-600'}`}>
            <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-transform ${myListOnly ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </div>
          <span className="text-sm font-medium text-slate-300">My List Only</span>
          <input type="checkbox" checked={myListOnly} onChange={e => setMyListOnly(e.target.checked)} className="sr-only" />
        </label>
      </div>

      <div className="flex items-center justify-between">
        <button onClick={() => navDate(-1)} className="p-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300 transition-colors"><ChevronLeft size={20} /></button>
        <div className="text-center">
          <h2 className="text-xl font-bold text-slate-100">
            {mode === 'daily' ? formatLocal(selectedUnix, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) :
             mode === 'weekly' ? `Week of ${formatLocal(startUnix, { month: 'short', day: 'numeric' })}` :
             formatLocal(startUnix, { month: 'long', year: 'numeric' })}
          </h2>
          <button onClick={navToday} className="text-sm text-indigo-400 hover:text-indigo-300 font-medium mt-1">Go to Today</button>
        </div>
        <button onClick={() => navDate(1)} className="p-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300 transition-colors"><ChevronRight size={20} /></button>
      </div>

      {error && error !== 'truncated' && error !== 'limit_hint' && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <AlertTriangle size={20} className="flex-shrink-0" />
            <span className="text-sm font-medium">
              {error === 'rate_limit' ? 'AniList asked us to slow down. Try again in a minute.' : error}
            </span>
          </div>
          <button onClick={retry} className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 flex-shrink-0">
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      )}

      {error === 'truncated' && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-3 rounded-xl flex items-center gap-3 text-sm">
          <Info size={18} className="flex-shrink-0" />
          <span>Showing first 500 releases for this range. Switch to "My List Only" for complete schedules.</span>
        </div>
      )}

      {error === 'limit_hint' && (
        <div className="bg-slate-800/80 p-8 rounded-2xl text-center border border-slate-700">
          <CalendarIcon size={32} className="mx-auto mb-4 text-indigo-400" />
          <h3 className="text-lg font-bold text-white mb-2">Monthly View Requires My List Only</h3>
          <p className="text-slate-400 text-sm mb-4">Displaying all global anime for an entire month exceeds API limits.</p>
          <button onClick={() => setMyListOnly(true)} className="px-6 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg font-medium transition-colors">
            Switch to My List Only
          </button>
        </div>
      )}

      {mode === 'daily' && error !== 'limit_hint' && renderDaily()}
      {mode === 'weekly' && error !== 'limit_hint' && renderWeekly()}
      {mode === 'monthly' && error !== 'limit_hint' && renderMonthly()}
    </div>
  );
};

const Dashboard = ({ watchlist, updateProgress, updateStatus, add, sync, openAnime, setViewAndFilter }) => {
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);

  const handleSync = async () => {
    setSyncing(true);
    setSyncError(null);
    const res = await sync();
    if (res && !res.success) {
      setSyncError(res.error === 'rate_limit'
        ? 'AniList asked us to slow down. Try again in a minute.'
        : 'Couldn\'t reach AniList. Check your connection.');
    }
    setSyncing(false);
  };

  const watching = watchlist.filter(a => a.status === 'WATCHING');
  const completed = watchlist.filter(a => a.status === 'COMPLETED');
  const epsWatched = watchlist.reduce((acc, curr) => acc + curr.progress, 0);
  const epsBehind = watching.reduce((acc, curr) => {
    if (curr.airedEpisodes !== null && curr.airedEpisodes !== undefined && curr.progress < curr.airedEpisodes) {
      return acc + (curr.airedEpisodes - curr.progress);
    }
    return acc;
  }, 0);
  
  const ready = watching
    .filter(a => a.airedEpisodes != null && a.progress < a.airedEpisodes)
    .sort((a, b) => (a.airedEpisodes - a.progress) - (b.airedEpisodes - b.progress));

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold text-white">Dashboard</h1>
        <div className="flex items-center gap-3">
          {syncError && <span role="alert" className="text-xs text-rose-400">{syncError}</span>}
        <button onClick={handleSync} disabled={syncing} className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-medium transition-colors">
          <RefreshCw size={16} className={syncing ? 'animate-spin text-indigo-400' : ''} />
          {syncing ? 'Syncing...' : 'Sync Data'}
        </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-10 gap-y-4">
        {[
          { label: 'Watching', value: watching.length, go: () => setViewAndFilter('WATCHING') },
          { label: 'Completed', value: completed.length, go: () => setViewAndFilter('COMPLETED') },
          { label: 'Episodes watched', value: epsWatched, go: () => setViewAndFilter('ALL', 'progress') },
          { label: 'Behind', value: epsBehind, go: () => setViewAndFilter('BEHIND', 'behind') }
        ].map(t => (
          <button key={t.label} onClick={t.go} className="text-left">
            <div className="text-3xl font-bold text-white font-display">{t.value}</div>
            <div className="text-xs text-slate-400">{t.label}</div>
          </button>
        ))}
      </div>

      {watching.length > 0 && (
        <section>
          <h2 className="text-xl font-bold text-white mb-3">Ready to watch</h2>
          {ready.length === 0 ? (
            <p className="text-sm text-slate-400">You're all caught up.</p>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
              {ready.map(item => (
                <div key={item.id} {...a11yClick(() => openAnime(item.id))} className="w-28 shrink-0 cursor-pointer">
                  <div className="relative aspect-[3/4] rounded-xl overflow-hidden bg-slate-800">
                    <img src={item.coverImage?.large} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                    <span className="absolute top-1.5 left-1.5 bg-indigo-500 text-white text-[11px] font-bold px-1.5 py-0.5 rounded-md">+{item.airedEpisodes - item.progress}</span>
                    <button onClick={(e) => { e.stopPropagation(); updateProgress(item.id, item.progress + 1); }}
                      aria-label={`Mark episode ${item.progress + 1} watched`}
                      className="absolute bottom-1.5 right-1.5 w-8 h-8 rounded-full bg-indigo-500 hover:bg-indigo-600 text-white flex items-center justify-center">
                      <Plus size={16} />
                    </button>
                  </div>
                  <div className="mt-1.5 text-xs font-medium text-slate-200 line-clamp-2">{item.title?.english || item.title?.romaji}</div>
                  <div className="text-[11px] text-slate-400">Ep {item.progress + 1} ready</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <div>
        <h2 className="text-xl font-bold text-white mb-4">Release Calendar</h2>
        <CalendarView watchlist={watchlist} updateProgress={updateProgress} updateStatus={updateStatus} add={add} openAnime={openAnime} />
      </div>
    </div>
  );
};

const WatchlistCard = ({ item, updateProgress, updateStatus, remove, openAnime }) => {
  const [menu, setMenu] = useState(false);
  const { canBump, behind, pct, bump } = bumpInfo(item, updateProgress);
  const swipe = useSwipeRight(bump);
  const dim = item.status === 'DROPPED' || item.status === 'PAUSED';
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  const nextEp = item.mediaStatus === 'RELEASING' && item.nextEpisodeAt ? (item.airedEpisodes ?? item.progress) + 1 : null;

  return (
    <div {...swipe} {...a11yClick(() => openAnime(item.id))}
      className={`group relative aspect-[3/4] rounded-xl overflow-hidden bg-slate-800 cursor-pointer ${dim ? 'opacity-60' : ''}`}>
      <img src={item.coverImage?.large} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/30 to-transparent" />

      <div className="absolute top-2 left-2 flex items-center gap-1.5">
        {item.score && <span className="bg-amber-500/90 text-slate-950 font-bold text-[11px] px-1.5 py-0.5 rounded-md">{item.score}</span>}
        {item.favorite && <Heart size={14} className="fill-rose-500 text-rose-500" />}
      </div>
      <button onClick={stop(() => setMenu(m => !m))} aria-label="More options"
        className="absolute top-1.5 right-1.5 p-1.5 rounded-full bg-slate-900/60 text-white"><MoreVertical size={16} /></button>
      {menu && (
        <div onClick={(e) => e.stopPropagation()} className="absolute top-10 right-2 z-10 w-40 rounded-lg bg-slate-800 border border-slate-700 shadow-xl py-1 text-sm">
          {Object.entries(STATUS_LABEL).map(([k, l]) => (
            <button key={k} onClick={stop(() => { updateStatus(item.id, k); setMenu(false); })}
              className={`block w-full text-left px-3 py-1.5 hover:bg-slate-700 ${item.status === k ? 'text-indigo-400 font-semibold' : 'text-slate-200'}`}>{l}</button>
          ))}
          <button onClick={stop(() => { remove(item.id); setMenu(false); })} className="block w-full text-left px-3 py-1.5 border-t border-slate-700 text-slate-400 hover:bg-slate-700">Remove</button>
        </div>
      )}

      <div className="absolute bottom-2.5 left-2.5 right-2.5 pr-10">
        <h3 className="text-white font-semibold text-sm leading-tight line-clamp-2">{item.title?.english || item.title?.romaji}</h3>
        <div className="text-xs text-slate-300 mt-1">
          Ep {item.progress}/{item.totalEpisodes || '?'}
          {behind > 0 && <span className="text-indigo-400"> · {behind} new</span>}
          {behind === 0 && nextEp && <span> · Ep {nextEp} in <CountdownLabel unixTarget={item.nextEpisodeAt} /></span>}
        </div>
      </div>
      <button onClick={stop(bump)} disabled={!canBump} aria-label={`Mark episode ${item.progress + 1} watched`}
        className="absolute bottom-3 right-2 w-8 h-8 rounded-full bg-indigo-500 hover:bg-indigo-600 disabled:opacity-30 text-white flex items-center justify-center"><Plus size={16} /></button>
      <div className="absolute bottom-0 inset-x-0 h-1 bg-slate-700/60"><div className="h-full bg-indigo-500" style={{ width: `${pct}%` }} /></div>
    </div>
  );
};

const WatchlistRow = ({ item, updateProgress, openAnime }) => {
  const { canBump, behind, bump } = bumpInfo(item, updateProgress);
  const swipe = useSwipeRight(bump);
  return (
    <div {...swipe} {...a11yClick(() => openAnime(item.id))}
      className={`flex items-center gap-3 py-2 cursor-pointer ${item.status === 'DROPPED' || item.status === 'PAUSED' ? 'opacity-60' : ''}`}>
      <img src={item.coverImage?.large} alt="" referrerPolicy="no-referrer" className="w-9 h-12 rounded object-cover shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-slate-100 truncate">{item.title?.english || item.title?.romaji}</div>
        <div className="text-xs text-slate-400">Ep {item.progress}/{item.totalEpisodes || '?'}{behind > 0 && <span className="text-indigo-400"> · {behind} new</span>}</div>
      </div>
      <button onClick={(e) => { e.stopPropagation(); bump(); }} disabled={!canBump} aria-label={`Mark episode ${item.progress + 1} watched`}
        className="w-9 h-9 rounded-full bg-slate-800 hover:bg-indigo-500 hover:text-white disabled:opacity-30 text-indigo-400 flex items-center justify-center shrink-0"><Plus size={16} /></button>
    </div>
  );
};

const Watchlist = ({ watchlist, updateProgress, updateStatus, remove, openAnime, initialFilter = 'ALL', initialSort = 'title', layout = 'grid' }) => {
  const [filter, setFilter] = useState(initialFilter);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState(initialSort);

  useEffect(() => {
    setFilter(initialFilter);
    setSortBy(initialSort);
  }, [initialFilter, initialSort]);

  const filteredAndSorted = useMemo(() => {
    let result = filter === 'ALL' ? watchlist
      : filter === 'BEHIND' ? watchlist.filter(a => a.status === 'WATCHING' && a.airedEpisodes != null && a.progress < a.airedEpisodes)
      : watchlist.filter(a => a.status === filter);
    
    if (search.trim()) {
      const query = search.toLowerCase();
      result = result.filter(a => (a.title?.english || '').toLowerCase().includes(query) || (a.title?.romaji || '').toLowerCase().includes(query));
    }

    return [...result].sort((a, b) => {
      if (sortBy === 'title') {
        const titleA = a.title?.english || a.title?.romaji || '';
        const titleB = b.title?.english || b.title?.romaji || '';
        return titleA.localeCompare(titleB);
      } else if (sortBy === 'progress') {
        return b.progress - a.progress;
      } else if (sortBy === 'score') {
        return (b.score || 0) - (a.score || 0);
      } else if (sortBy === 'behind') {
        return ((b.airedEpisodes ?? 0) - b.progress) - ((a.airedEpisodes ?? 0) - a.progress);
      } else if (sortBy === 'favorite') {
        return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
      }
      return 0;
    });
  }, [watchlist, filter, search, sortBy]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <h1 className="text-3xl font-bold text-white">My Watchlist</h1>
        
        <div className="flex items-center gap-3 w-full md:w-auto flex-wrap">
          <div className="relative flex-1 md:w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input 
              type="text" 
              value={search} 
              onChange={e => setSearch(e.target.value)}
              placeholder="Filter list..."
              className="w-full bg-slate-800 text-white text-sm rounded-lg pl-9 pr-3 py-2 border border-slate-700 outline-none focus:border-indigo-500"
            />
          </div>

          <div className="flex items-center gap-2 bg-slate-800 px-3 py-2 rounded-lg border border-slate-700 cursor-pointer">
            <ArrowUpDown size={16} className="text-indigo-400" />
            <select 
              value={sortBy} 
              onChange={e => setSortBy(e.target.value)}
              className="bg-transparent text-sm text-slate-300 outline-none cursor-pointer"
            >
              <option value="title" className="bg-slate-800">Sort: Title</option>
              <option value="progress" className="bg-slate-800">Sort: Progress</option>
              <option value="score" className="bg-slate-800">Sort: Score</option>
              <option value="behind" className="bg-slate-800">Sort: Most behind</option>
              <option value="favorite" className="bg-slate-800">Sort: Favorites</option>
            </select>
          </div>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
        {[
          { key: 'ALL', label: 'All' },
          { key: 'WATCHING', label: 'Watching' },
          { key: 'BEHIND', label: 'Behind' },
          { key: 'PLAN_TO_WATCH', label: 'Plan to Watch' },
          { key: 'COMPLETED', label: 'Completed' },
          { key: 'PAUSED', label: 'On Hold' },
          { key: 'DROPPED', label: 'Dropped' }
        ].map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={`flex-shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${filter === f.key ? 'bg-indigo-500 text-white shadow-sm' : 'bg-slate-800/80 text-slate-400 hover:text-slate-200 hover:bg-slate-700'}`}>
            {f.label}
          </button>
        ))}
      </div>

      {filteredAndSorted.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          {watchlist.length === 0 ? (
            <p>Nothing here yet. Find your first show in Search.</p>
          ) : (
            <>
              <p>No matches.</p>
              <button onClick={() => { setFilter('ALL'); setSearch(''); }} className="mt-3 text-indigo-400 underline text-sm">Show everything</button>
            </>
          )}
        </div>
      ) : layout === 'compact' ? (
        <div className="divide-y divide-slate-800">
          {filteredAndSorted.map(item => (
            <WatchlistRow key={item.id} item={item} updateProgress={updateProgress} openAnime={openAnime} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3 lg:gap-4">
          {filteredAndSorted.map(item => (
            <WatchlistCard key={item.id} item={item} updateProgress={updateProgress} updateStatus={updateStatus} remove={remove} openAnime={openAnime} />
          ))}
        </div>
      )}
    </div>
  );
};

const Seasonal = ({ watchlist, add, openAnime }) => {
  const [season, setSeason] = useState(() => {
    const m = new Date().getMonth();
    if (m < 3) return 'WINTER'; if (m < 6) return 'SPRING'; if (m < 9) return 'SUMMER'; return 'FALL';
  });
  const [year, setYear] = useState(new Date().getFullYear());
  const [anime, setAnime] = useState([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(true);

  const fetchSeason = async (p = 1, append = false) => {
    setLoading(true);
    const query = `
      query ($season: MediaSeason, $year: Int, $page: Int) {
        Page(page: $page, perPage: 40) {
          pageInfo { hasNextPage }
          media(season: $season, seasonYear: $year, type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
            id idMal status episodes
            title { romaji english native }
            coverImage { large extraLarge }
            nextAiringEpisode { episode airingAt }
          }
        }
      }
    `;
    try {
      const data = await fetchGraphQL(query, { season, year, page: p });
      if (append) setAnime(prev => [...prev, ...data.Page.media]);
      else setAnime(data.Page.media);
      setHasNext(data.Page.pageInfo.hasNextPage);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  useEffect(() => {
    setPage(1);
    fetchSeason(1, false);
  }, [season, year]);

  const loadMore = () => {
    if (loading || !hasNext) return;
    const nextPage = page + 1;
    setPage(nextPage);
    fetchSeason(nextPage, true);
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center flex-wrap gap-4">
        <h1 className="text-3xl font-bold text-white">Seasonal Anime</h1>
        <div className="flex gap-4">
          <select value={season} onChange={e => setSeason(e.target.value)} className="bg-slate-800 text-white rounded-lg px-4 py-2 border border-slate-700 outline-none focus:border-indigo-500 cursor-pointer">
            <option value="WINTER">Winter</option>
            <option value="SPRING">Spring</option>
            <option value="SUMMER">Summer</option>
            <option value="FALL">Fall</option>
          </select>
          <select value={year} onChange={e => setYear(Number(e.target.value))} className="bg-slate-800 text-white rounded-lg px-4 py-2 border border-slate-700 outline-none focus:border-indigo-500 cursor-pointer">
            {Array.from({ length: new Date().getFullYear() - 1989 }, (_, i) => new Date().getFullYear() + 1 - i).map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {anime.map(item => {
          const inList = watchlist.find(w => w.id === item.id);
          return (
            <div 
              key={item.id} 
              {...a11yClick(() => openAnime(item.id))}
              className="group relative rounded-xl overflow-hidden bg-slate-800 aspect-[3/4] cursor-pointer"
            >
              <img src={item.coverImage?.large} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/40 to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 p-3">
                <h3 className="text-white font-bold text-sm line-clamp-2 leading-tight mb-2 drop-shadow-md">
                  {item.title?.english || item.title?.romaji}
                </h3>
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!inList) add(item);
                  }}
                  disabled={!!inList}
                  className={`w-full py-1.5 rounded-md text-xs font-bold transition-colors ${inList ? 'bg-emerald-500/90 text-white cursor-default' : 'bg-indigo-500 hover:bg-indigo-600 text-white'}`}
                >
                  {inList ? 'In Watchlist' : 'Add to List'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      
      {hasNext && (
        <div className="text-center pt-8 pb-12">
          <button onClick={loadMore} disabled={loading} className="px-8 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-bold transition-colors">
            {loading ? 'Fetching…' : 'Show more'}
          </button>
        </div>
      )}
    </div>
  );
};

const GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'];
const YEARS = Array.from({ length: new Date().getFullYear() + 2 - 1990 }, (_, i) => new Date().getFullYear() + 1 - i);
const DEFAULT_FILTERS = { format: '', season: '', year: '', genre: '', sort: 'POPULARITY_DESC' };

const SearchAnime = ({ watchlist, add, openAnime }) => {
  const [query, setQuery] = useState('');
  const [anime, setAnime] = useState([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const activeCount = ['format', 'season', 'year', 'genre'].filter(k => filters[k]).length;
  const hasFilters = activeCount > 0;

  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const performSearch = async (searchQuery, p = 1, append = false) => {
    console.log('[AniTrack] performSearch entered:', {
      searchQuery,
      hasFilters
    });

    if (!searchQuery.trim() && !hasFilters) return;
      
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
      
    setLoading(true);
    setError(null);
    setHasSearched(true);

    const gqlQuery = `
      query ($search: String, $page: Int, $genre: String, $year: Int, $season: MediaSeason, $format: MediaFormat, $sort: [MediaSort]) {
        Page(page: $page, perPage: 40) {
          pageInfo { hasNextPage }
          media(search: $search, type: ANIME, genre: $genre, seasonYear: $year, season: $season, format: $format, sort: $sort, isAdult: false) {
            id idMal status episodes
            title { romaji english native }
            coverImage { large extraLarge }
            nextAiringEpisode { episode airingAt }
          }
        }
      }
    `;

    try {
      const cleanSort = filters.sort ? filters.sort : 'POPULARITY_DESC';
      const variables = {
        search: searchQuery.trim() || null,
        sort: [cleanSort],
        page: p
      };

      if (filters.genre) variables.genre = filters.genre;
      if (filters.year) variables.year = Number(filters.year);
      if (filters.season) variables.season = filters.season;
      if (filters.format) variables.format = filters.format;
      
      console.log('[AniTrack] About to call AniList:', variables);
      const data = await fetchGraphQL(gqlQuery, variables, controller.signal);

      if (!data || !data.Page) {
        throw new Error("Invalid response structure from AniList");
      }

      if (append) {
        setAnime(prev => {
          const seen = new Set(prev.map(a => a.id));
          return [...prev, ...(data.Page.media || []).filter(m => !seen.has(m.id))];
        });
      } else {
        setAnime(data.Page.media || []);
      }
      setHasNext(data.Page.pageInfo.hasNextPage);
    } catch (e) {
      if (e.name === 'AbortError') return;
      setError(e.message === 'rate_limit'
        ? 'AniList asked us to slow down. Try again in a minute.'
        : 'Couldn\'t reach AniList. Check your connection and try again.');
      if (append) setPage(p - 1); 
      else setAnime([]);
    } finally {
      setLoading(false);
    }
  };


  const handleSearch = (e) => {
    e.preventDefault();
    console.log('[AniTrack] Search form submitted:', query);
    setPage(1);
    performSearch(query, 1, false);
  };


  const loadMore = () => {
    if (loading || !hasNext) return;
    const nextPage = page + 1;
    setPage(nextPage);
    performSearch(query, nextPage, true);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <h1 className="text-3xl font-bold text-white">Search Anime</h1>
        <form onSubmit={handleSearch} className="w-full md:w-auto flex gap-2">
          <div className="relative w-full md:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input 
              type="text" 
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search for anime..."
              aria-label="Search for anime"
              className="w-full bg-slate-800 text-white rounded-lg pl-10 pr-4 py-2 border border-slate-700 outline-none focus:border-indigo-500"
            />
          </div>
          <button type="submit" disabled={loading || (!query.trim() && !hasFilters)} className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white rounded-lg font-medium transition-colors">
            Search
          </button>
          <button type="button" onClick={() => setShowFilters(v => !v)} aria-label="Filters" aria-expanded={showFilters}
            className={`px-3 py-2 rounded-lg flex items-center gap-1.5 text-sm ${hasFilters ? 'bg-indigo-500/20 text-indigo-400' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
            <SlidersHorizontal size={18} />{hasFilters && <span>{activeCount}</span>}
          </button>
        </form>
      </div>

      {showFilters && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {[
            ['format', 'Format', [['', 'Any format'], ['TV', 'TV'], ['MOVIE', 'Movie'], ['OVA', 'OVA'], ['ONA', 'ONA'], ['SPECIAL', 'Special']]],
            ['season', 'Season', [['', 'Any season'], ['WINTER', 'Winter'], ['SPRING', 'Spring'], ['SUMMER', 'Summer'], ['FALL', 'Fall']]],
            ['year', 'Year', [['', 'Any year'], ...YEARS.map(y => [String(y), String(y)])]],
            ['genre', 'Genre', [['', 'Any genre'], ...GENRES.map(g => [g, g])]],
            ['sort', 'Sort', [['POPULARITY_DESC', 'Popular'], ['SCORE_DESC', 'Top rated'], ['TRENDING_DESC', 'Trending'], ['START_DATE_DESC', 'Newest'], ['SEARCH_MATCH', 'Best match']]]
          ].map(([key, label, opts]) => (
            <select key={key} aria-label={label} value={filters[key]} onChange={e => setFilters(f => ({ ...f, [key]: e.target.value }))}
              className="bg-slate-800 text-sm text-slate-200 rounded-lg px-3 py-2 border border-slate-700 outline-none focus:border-indigo-500">
              {opts.map(([v, l]) => <option key={v} value={v} className="bg-slate-800">{l}</option>)}
            </select>
          ))}
          <div className="col-span-2 md:col-span-5 flex gap-2">
            <button type="button" onClick={() => { setPage(1); performSearch(query, 1, false); }} className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium">Apply</button>
            <button type="button" onClick={() => setFilters(DEFAULT_FILTERS)} className="px-4 py-2 text-slate-400 hover:text-white text-sm">Clear</button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="text-center py-6 text-rose-300 bg-rose-500/10 rounded-2xl border border-rose-500/20">{error}</div>
      )}

      {hasSearched && anime.length === 0 && !loading && !error && (
        <div className="text-center py-20 text-slate-400 bg-slate-800/30 rounded-2xl border border-slate-800">
          Nothing matched. Try fewer words or looser filters.
        </div>
      )}

      {loading && anime.length === 0 && <CoverGridSkeleton />}

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {anime.map(item => {
          const inList = watchlist.find(w => w.id === item.id);
          return (
            <div 
              key={item.id} 
              {...a11yClick(() => openAnime(item.id))}
              className="group relative rounded-xl overflow-hidden bg-slate-800 aspect-[3/4] cursor-pointer"
            >
              <img src={item.coverImage?.large} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/40 to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 p-3">
                <h3 className="text-white font-bold text-sm line-clamp-2 leading-tight mb-2 drop-shadow-md">
                  {item.title?.english || item.title?.romaji}
                </h3>
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!inList) add(item);
                  }}
                  disabled={!!inList}
                  className={`w-full py-1.5 rounded-md text-xs font-bold transition-colors ${inList ? 'bg-emerald-500/90 text-white cursor-default' : 'bg-indigo-500 hover:bg-indigo-600 text-white'}`}
                >
                  {inList ? 'In Watchlist' : 'Add to List'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      
      {hasNext && (
        <div className="text-center pt-8 pb-12">
          <button onClick={loadMore} disabled={loading} className="px-8 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-bold transition-colors">
            {loading ? 'Fetching…' : 'Show more'}
          </button>
        </div>
      )}
    </div>
  );
};

const parseTheme = (raw) => {
  const m = String(raw).match(/^(?:#?\s*(\d+):\s*)?"(.+?)"\s*(?:by\s+(.+?))?\s*(?:\(([^()]*eps?[^()]*)\))?\s*$/i);
  return m ? { n: m[1], title: m[2], artist: m[3] || '', eps: m[4] || '' } : { n: null, title: String(raw), artist: '', eps: '' };
};
const ytSearch = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
const webSearch = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
const themeCache = new Map();

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Retries busy/rate-limited responses a couple of times before giving up.
const fetchJson = async (url, signal, retries = 2) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) throw new Error(`HTTP ${res.status}`);
    await wait(1200 * (attempt + 1));
  }
};

// AnimeThemes -> the same "1: "Title" by Artist" text shape Jikan gives us.
const fromAnimeThemes = (j) => {
  const themes = j?.anime?.[0]?.animethemes || [];
  const build = (type) => themes
    .filter(t => t.type === type)
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
    .map((t, i) => {
      const artists = (t.song?.artists || []).map(a => a.name).filter(Boolean).join(', ');
      return `${t.sequence || i + 1}: "${t.song?.title || t.slug}"${artists ? ` by ${artists}` : ''}`;
    });
  return { openings: build('OP'), endings: build('ED') };
};

// MyAnimeList (via Jikan) first; AnimeThemes if Jikan fails or has nothing.
const loadThemes = async (malId, signal) => {
  let primary = null, primaryErr = null;
  try {
    const j = await fetchJson(`https://api.jikan.moe/v4/anime/${malId}/themes`, signal);
    primary = { openings: j?.data?.openings || [], endings: j?.data?.endings || [] };
    if (primary.openings.length || primary.endings.length) return primary;
  } catch (e) { if (e.name === 'AbortError') throw e; primaryErr = e; }

  let alt = null, altErr = null;
  try {
    const q = `${encodeURIComponent('filter[has]')}=resources&${encodeURIComponent('filter[site]')}=MyAnimeList&${encodeURIComponent('filter[external_id]')}=${malId}&include=animethemes.song.artists`;
    alt = fromAnimeThemes(await fetchJson(`https://api.animethemes.moe/anime?${q}`, signal, 1));
  } catch (e) { if (e.name === 'AbortError') throw e; altErr = e; }

  if (alt && (alt.openings.length || alt.endings.length)) return alt;
  if (primary) return primary; // reached the service, nothing listed yet
  throw new Error(`Jikan: ${primaryErr?.message}${altErr ? `, AnimeThemes: ${altErr.message}` : ''}`);
};

// Openings & endings: list comes from MyAnimeList via Jikan. Videos and lyrics open as searches.
const ThemesSection = ({ malId, animeTitle }) => {
  const [open, setOpen] = useState(false);
  const [tries, setTries] = useState(0);
  const [state, setState] = useState({ status: 'idle', data: null });

  useEffect(() => {
    if (!open || !malId) return;
    if (themeCache.has(malId)) { setState({ status: 'ok', data: themeCache.get(malId) }); return; }
    const controller = new AbortController();
    setState({ status: 'loading', data: null });
    loadThemes(malId, controller.signal)
      .then(data => { themeCache.set(malId, data); setState({ status: 'ok', data }); })
      .catch(e => { if (e.name !== 'AbortError') setState({ status: 'error', data: null, detail: e.message }); });
    return () => controller.abort();
  }, [open, malId, tries]);

  const groups = state.data ? [['OP', state.data.openings], ['ED', state.data.endings]] : [];
  const empty = state.status === 'ok' && groups.every(([, list]) => list.length === 0);

  return (
    <div className="space-y-3">
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} className="flex items-center gap-2 font-bold text-white text-base">
        Openings &amp; Endings <ChevronDown size={16} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="space-y-3">
          {state.status === 'loading' && <Shimmer className="h-16 w-full" />}
          {state.status === 'error' && (
            <p className="text-sm text-slate-400">Couldn't load the themes{state.detail ? ` (${state.detail})` : ''}. <button onClick={() => setTries(t => t + 1)} className="text-indigo-400 underline">Retry</button></p>
          )}
          {empty && <p className="text-sm text-slate-400">No themes listed for this one.</p>}
          {groups.map(([kind, list]) => list.map((raw, i) => {
            const t = parseTheme(raw);
            const q = `${t.title} ${t.artist}`.trim();
            return (
              <div key={`${kind}${i}`} className="rounded-lg bg-slate-800 px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-100">{t.title}</div>
                    <div className="text-xs text-slate-400">{[t.artist, t.eps].filter(Boolean).join(' · ')}</div>
                  </div>
                  <span className="shrink-0 text-[11px] font-bold text-slate-400">{kind}{t.n || i + 1}</span>
                </div>
                <div className="flex gap-3 mt-2 text-xs">
                  <a href={ytSearch(`${animeTitle} ${kind === 'OP' ? 'opening' : 'ending'} ${q}`)} target="_blank" rel="noopener noreferrer" className="text-indigo-400 underline">Watch on YouTube</a>
                  <a href={webSearch(`${q} romaji lyrics`)} target="_blank" rel="noopener noreferrer" className="text-indigo-400 underline">Find lyrics</a>
                </div>
              </div>
            );
          }))}
          {state.status === 'ok' && <p className="text-[11px] text-slate-500">Theme list from MyAnimeList (Jikan) and AnimeThemes. Lyrics open in a web search.</p>}
        </div>
      )}
    </div>
  );
};

const AnimeDetailModal = ({ animeId, onClose, watchlistObj, openAnime }) => {
  const { watchlist, add, remove, updateStatus, setStatusAndAdd, updateProgress, setScore, setNotes, toggleFavorite } = watchlistObj;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showFullSynopsis, setShowFullSynopsis] = useState(false);
  const cache = useRef(new Map());

  const watchItem = useMemo(() => watchlist.find(w => w.id === animeId), [watchlist, animeId]);

  useEffect(() => {
    if (!animeId) return;
    const origOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = origOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [animeId, onClose]);

  const fetchData = useCallback(async () => {
    if (!animeId) return;

    if (cache.current.has(animeId)) {
      const cached = cache.current.get(animeId);
      if (cached.isAdult) {
        onClose();
        return;
      }
      setData(cached);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    const controller = new AbortController();

    const query = `
      query ($id: Int) {
        Media(id: $id) {
          id idMal
          title { romaji english native }
          coverImage { extraLarge large }
          bannerImage
          description(asHtml: false)
          season seasonYear episodes duration status format source genres
          averageScore meanScore popularity favourites
          rankings { rank type allTime season year context }
          studios(isMain: true) { nodes { name } }
          nextAiringEpisode { episode airingAt }
          startDate { year month day }
          endDate { year month day }
          externalLinks { url site type }
          relations {
            edges {
              relationType
              node {
                id type format status episodes
                title { romaji english }
                coverImage { large }
              }
            }
          }
          isAdult
        }
      }
    `;

    try {
      const res = await fetchGraphQL(query, { id: animeId }, controller.signal);
      const media = res?.Media;
      if (!media) throw new Error("Anime details not found.");
      if (media.isAdult) {
        onClose();
        return;
      }
      cache.current.set(animeId, media);
      setData(media);
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message || "Failed to load details.");
      }
    } finally {
      setLoading(false);
    }
  }, [animeId, onClose]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (!animeId) return null;

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  const titleDisplay = data?.title?.english || data?.title?.romaji || watchItem?.title?.english || watchItem?.title?.romaji || 'Anime Details';
  const titleRomaji = data?.title?.romaji || watchItem?.title?.romaji;
  const titleNative = data?.title?.native || watchItem?.title?.native;
  const coverImg = data?.coverImage?.extraLarge || data?.coverImage?.large || watchItem?.coverImage?.large || '';
  const bannerImg = data?.bannerImage || '';
  const studioName = data?.studios?.nodes?.[0]?.name || 'Unknown Studio';
  const formatText = data?.format ? data.format.replace(/_/g, ' ') : 'TV';
  const statusText = (data?.status || watchItem?.mediaStatus || 'RELEASING').replace(/_/g, ' ');
  const seasonYearText = data?.season && data?.seasonYear ? `${data.season} ${data.seasonYear}` : '';
  const scoreBadge = data?.averageScore ? `★ ${data.averageScore}%` : null;

  const mediaStatus = data?.status || watchItem?.mediaStatus || 'RELEASING';
  const nextAiring = data?.nextAiringEpisode;
  const nextAiringAt = nextAiring?.airingAt || watchItem?.nextEpisodeAt;
  const nextEpNum = nextAiring?.episode || (watchItem?.airedEpisodes !== null && watchItem?.airedEpisodes !== undefined ? watchItem.airedEpisodes + 1 : null);
  const totalEps = data?.episodes || watchItem?.totalEpisodes || null;
  const airedEps = nextAiring ? nextAiring.episode - 1 : (mediaStatus === 'FINISHED' ? totalEps : watchItem?.airedEpisodes);

  const cleanedSynopsis = parseSynopsis(data?.description);
  const isLongSynopsis = cleanedSynopsis.length > 400;

  const bestRanking = data?.rankings?.find(r => r.allTime || r.context === 'highest rated') || data?.rankings?.[0];

  let epGridCount = totalEps || 0;
  if (!epGridCount) {
    const curProgress = watchItem?.progress || 0;
    const knownAired = airedEps || 0;
    epGridCount = Math.max(knownAired, curProgress) + 3;
  }
  epGridCount = Math.min(2000, Math.max(1, epGridCount));

  const streamingLinks = (data?.externalLinks || []).filter(l => l.type === 'STREAMING' || l.site?.toLowerCase().includes('crunchyroll') || l.site?.toLowerCase().includes('netflix') || l.site?.toLowerCase().includes('hulu') || l.site?.toLowerCase().includes('bilibili')).slice(0, 6);

  const franchiseRelations = (data?.relations?.edges || []).filter(r => r.node && r.node.type === 'ANIME' && ['SEQUEL', 'PREQUEL', 'SIDE_STORY', 'PARENT', 'CHILD', 'ALTERNATIVE', 'SPIN_OFF'].includes(r.relationType));

  return (
    <div 
      onClick={handleBackdropClick} 
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-2 sm:p-4 overflow-y-auto animate-in fade-in duration-200"
    >
      <div 
        onClick={e => e.stopPropagation()} 
        className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-4xl max-h-[92vh] overflow-y-auto shadow-2xl relative flex flex-col text-slate-300"
      >
        <button 
          onClick={onClose} 
          className="absolute top-3 right-3 z-20 bg-slate-900/80 hover:bg-slate-800 text-slate-300 p-2 rounded-full border border-slate-700/60 transition-colors shadow-lg"
          title="Close (Esc)"
        >
          <X size={20} />
        </button>

        {loading && !data && (
          <div className="p-8 space-y-6 animate-pulse">
            <div className="h-48 bg-slate-800 rounded-xl" />
            <div className="h-8 bg-slate-800 rounded w-2/3" />
            <div className="h-24 bg-slate-800 rounded" />
          </div>
        )}

        {error && !data && (
          <div className="p-12 text-center space-y-4">
            <AlertTriangle size={40} className="mx-auto text-red-400" />
            <h3 className="text-xl font-bold text-white">Couldn't load this one</h3>
            <p className="text-slate-400 text-sm">{error}</p>
            <button onClick={fetchData} className="px-5 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg font-medium transition-colors inline-flex items-center gap-2">
              <RefreshCw size={16} /> Retry
            </button>
          </div>
        )}

        {(data || watchItem) && (
          <div className="flex-1 space-y-6 pb-8">
            <div className="relative">
              <div className="h-44 sm:h-60 w-full overflow-hidden bg-slate-800 relative">
                {bannerImg ? (
                  <img src={bannerImg} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover opacity-60" />
                ) : (
                  <div className="w-full h-full bg-slate-900" />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/40 to-transparent" />
              </div>

              <div className="px-6 relative flex flex-col sm:flex-row gap-4 -mt-20 sm:-mt-24 items-start sm:items-end">
                <img 
                  src={coverImg} 
                  alt="" 
                  referrerPolicy="no-referrer"
                  className="w-28 sm:w-36 h-40 sm:h-52 object-cover rounded-xl border-4 border-slate-900 shadow-2xl flex-shrink-0" 
                />
                
                <div className="flex-1 space-y-2">
                  <div className="flex flex-wrap gap-2 items-center text-xs font-semibold">
                    <span className="bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-2.5 py-1 rounded-md uppercase">
                      {formatText}
                    </span>
                    <span className="bg-slate-800 text-slate-300 border border-slate-700 px-2.5 py-1 rounded-md uppercase">
                      {statusText}
                    </span>
                    {seasonYearText && (
                      <span className="bg-slate-800 text-slate-300 border border-slate-700 px-2.5 py-1 rounded-md uppercase">
                        {seasonYearText}
                      </span>
                    )}
                    {scoreBadge && (
                      <span className="bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2.5 py-1 rounded-md font-bold">
                        {scoreBadge}
                      </span>
                    )}
                  </div>

                  <h2 className="text-2xl sm:text-3xl font-extrabold text-white leading-tight">
                    {titleDisplay}
                  </h2>
                  
                  {titleRomaji && titleRomaji !== titleDisplay && (
                    <p className="text-xs text-slate-400 font-medium">{titleRomaji}</p>
                  )}
                </div>
              </div>
            </div>

            <div className="px-6 space-y-6">
              <div className="text-xs sm:text-sm text-slate-400 border-b border-slate-800 pb-3 flex items-center gap-2 flex-wrap font-medium">
                <span className="text-slate-200">{studioName}</span>
                <span>•</span>
                <span>{totalEps ? `${totalEps} Episodes` : 'Episodes TBA'}</span>
                <span>•</span>
                <span>{data?.duration ? `${data.duration} min/ep` : 'Standard Duration'}</span>
              </div>

              {franchiseRelations.length > 0 && (
                <div className="space-y-3 bg-slate-800/40 border border-slate-700/60 p-4 rounded-xl">
                  <h3 className="font-bold text-white text-sm flex items-center gap-2">
                    <Layers size={16} className="text-indigo-400" /> Seasons & Franchise Relations
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {franchiseRelations.map(rel => (
                      <div 
                        key={rel.node.id} 
                        onClick={() => openAnime(rel.node.id)}
                        className="flex items-center gap-3 bg-slate-900/60 hover:bg-slate-800 p-2 rounded-lg border border-slate-800 hover:border-indigo-500/50 cursor-pointer transition-all group"
                      >
                        <img src={rel.node.coverImage?.large} alt="" referrerPolicy="no-referrer" className="w-10 h-12 object-cover rounded flex-shrink-0" />
                        <div className="min-w-0 flex-1">
                          <span className="text-[10px] text-indigo-300 font-bold uppercase tracking-wider block leading-none mb-1">
                            {rel.relationType.replace(/_/g, ' ')}
                          </span>
                          <h4 className="text-xs font-semibold text-slate-200 truncate group-hover:text-indigo-300 transition-colors">
                            {rel.node.title?.english || rel.node.title?.romaji}
                          </h4>
                          <span className="text-[10px] text-slate-400 uppercase">
                            {rel.node.format || 'TV'} • {rel.node.episodes ? `${rel.node.episodes} eps` : 'TBA'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="bg-slate-800/80 border border-slate-700 p-5 rounded-2xl space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <h3 className="font-bold text-white text-base flex items-center gap-2">
                    <CheckCircle size={18} className="text-indigo-400" /> My Watch Progress
                  </h3>

                  {watchItem && (
                    <button 
                      onClick={() => toggleFavorite(animeId)}
                      className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${watchItem.favorite ? 'bg-rose-500/20 text-rose-300 border-rose-500/40' : 'bg-slate-900/60 text-slate-400 border-slate-700 hover:text-white'}`}
                    >
                      <Heart size={14} className={watchItem.favorite ? 'fill-rose-500 text-rose-500' : ''} />
                      {watchItem.favorite ? 'Favorited' : 'Add Favorite'}
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 font-medium mb-1">Status</label>
                    <select 
                      value={watchItem ? watchItem.status : 'NOT_IN_LIST'}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === 'NOT_IN_LIST') {
                          remove(animeId);
                        } else if (watchItem) {
                          updateStatus(animeId, val);
                        } else {
                          setStatusAndAdd(data || { id: animeId, title: titleDisplay, coverImage: coverImg }, val);
                        }
                      }}
                      className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-xl px-3 py-2 outline-none focus:border-indigo-500 cursor-pointer"
                    >
                      <option value="NOT_IN_LIST">Not in my list</option>
                      <option value="WATCHING">Watching</option>
                      <option value="PLAN_TO_WATCH">Plan to Watch</option>
                      <option value="COMPLETED">Completed</option>
                      <option value="PAUSED">On Hold / Paused</option>
                      <option value="DROPPED">Dropped</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 font-medium mb-1">Progress</label>
                    <div className="flex items-center gap-2">
                      <button 
                        onClick={() => watchItem && updateProgress(animeId, watchItem.progress - 1)}
                        disabled={!watchItem || watchItem.progress <= 0}
                        className="p-2 bg-slate-900 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-lg border border-slate-700"
                      >
                        <Minus size={14} />
                      </button>
                      
                      <div className="flex-1 text-center font-bold text-sm bg-slate-900 py-1.5 border border-slate-700 rounded-lg text-white">
                        {watchItem ? watchItem.progress : 0} <span className="text-slate-500 text-xs font-normal">/ {totalEps || '?'}</span>
                      </div>

                      <button 
                        onClick={() => {
                          if (!watchItem) {
                            setStatusAndAdd(data || { id: animeId, title: titleDisplay, coverImage: coverImg }, 'WATCHING');
                            updateProgress(animeId, 1);
                          } else {
                            updateProgress(animeId, watchItem.progress + 1);
                          }
                        }}
                        disabled={watchItem && watchItem.progress >= (mediaStatus === 'RELEASING' ? (airedEps || Infinity) : (totalEps || Infinity))}
                        className="p-2 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-40 disabled:bg-slate-800 text-white rounded-lg transition-colors"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 font-medium mb-1">My Score</label>
                    <select 
                      disabled={!watchItem}
                      value={watchItem?.score || ''}
                      onChange={(e) => watchItem && setScore(animeId, e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-xl px-3 py-2 outline-none focus:border-indigo-500 disabled:opacity-50 cursor-pointer"
                    >
                      <option value="">No rating</option>
                      {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(num => (
                        <option key={num} value={num}>{num} ({num === 10 ? 'Masterpiece' : num >= 8 ? 'Great' : num >= 6 ? 'Good' : 'Average'})</option>
                      ))}
                    </select>
                  </div>
                </div>

                {watchItem && (
                  <div className="pt-2 border-t border-slate-700/60">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Quick Episode Select</span>
                      {totalEps && mediaStatus === 'FINISHED' && watchItem.progress < totalEps && (
                        <button 
                          onClick={() => updateProgress(animeId, totalEps)}
                          className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold transition-colors"
                        >
                          Mark all completed ({totalEps})
                        </button>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto p-1 bg-slate-900/60 rounded-xl border border-slate-800">
                      {Array.from({ length: epGridCount }, (_, i) => i + 1).map(epNum => {
                        const isWatched = watchItem.progress >= epNum;
                        const isUnaired = mediaStatus === 'RELEASING' && airedEps !== null && airedEps !== undefined && epNum > airedEps;

                        return (
                          <button
                            key={epNum}
                            disabled={isUnaired}
                            onClick={() => {
                              if (watchItem.progress === epNum) {
                                updateProgress(animeId, epNum - 1);
                              } else {
                                updateProgress(animeId, epNum);
                              }
                            }}
                            className={`w-8 h-8 rounded-lg text-xs font-bold transition-all border
                              ${isWatched ? 'bg-indigo-500 text-white border-indigo-400 shadow-sm' : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-500 hover:text-white'}
                              ${isUnaired ? 'opacity-30 cursor-not-allowed bg-slate-900 border-slate-800 text-slate-600' : ''}
                            `}
                            title={isUnaired ? `Episode ${epNum} hasn't aired yet` : `Episode ${epNum}`}
                          >
                            {epNum}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {data && (
                <div className="space-y-2">
                  <h3 className="font-bold text-white text-base">Where to watch</h3>
                  {streamingLinks.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {streamingLinks.map(l => (
                        <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer"
                          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-200">{l.site}</a>
                      ))}
                    </div>
                  ) : <p className="text-sm text-slate-400">No streaming links listed.</p>}
                </div>
              )}

              {data?.idMal && <ThemesSection malId={data.idMal} animeTitle={titleDisplay} />}

              {/* Synopsis with normal line heights and compact paragraph spacing */}
              <div className="space-y-2">
                <h3 className="font-bold text-white text-base">Synopsis</h3>
                <div className="text-sm text-slate-300 leading-normal space-y-3 bg-slate-800/30 border border-slate-800 p-4 rounded-xl">
                  {isLongSynopsis && !showFullSynopsis ? (
                    <>
                      <p>{cleanedSynopsis.slice(0, 400)}...</p>
                      <button 
                        onClick={() => setShowFullSynopsis(true)}
                        className="text-indigo-400 font-bold hover:underline inline-block mt-1"
                      >
                        Read more
                      </button>
                    </>
                  ) : (
                    <>
                      {cleanedSynopsis.split('\n').map((paragraph, idx) => (
                        paragraph.trim() ? <p key={idx}>{paragraph}</p> : null
                      ))}
                      {isLongSynopsis && (
                        <button 
                          onClick={() => setShowFullSynopsis(false)}
                          className="text-indigo-400 font-bold hover:underline inline-block mt-2"
                        >
                          Show less
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default function App() {
  const [currentView, setCurrentView] = useState('dashboard');
  const [watchlistFilter, setWatchlistFilter] = useState('ALL');
  const [watchlistSort, setWatchlistSort] = useState('title');
  const [selectedAnimeId, setSelectedAnimeId] = useState(null);
  const w = useWatchlist();

  const openAnime = useCallback((id) => {
    setSelectedAnimeId(id);
  }, []);

  const closeAnime = useCallback(() => {
    setSelectedAnimeId(null);
  }, []);

  const setViewAndFilter = useCallback((filter, sort = 'title') => {
    setWatchlistFilter(filter);
    setWatchlistSort(sort);
    setCurrentView('watchlist');
  }, []);

  const [showData, setShowData] = useState(false);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  const [alertsOn, setAlertsOn] = useState(false);
  const [offlineAt, setOfflineAt] = useState(null);

  useEffect(() => { getPref('alerts', 'false').then((v) => setAlertsOn(v === 'true')); }, []);

  useEffect(() => {
    if (!w.loaded) return;
    const t = setTimeout(() => {
      scheduleAiring(w.watchlist, alertsOn).catch((e) => console.error('Alerts failed:', e));
    }, 1000);
    return () => clearTimeout(t);
  }, [w.watchlist, w.loaded, alertsOn]);

  const toggleAlerts = async (on) => {
    if (on && !(await ensurePermission())) {
      return 'Notifications are blocked. Allow them for AniTrack in Android settings.';
    }
    setAlertsOn(on);
    await setPref('alerts', on);
    return null;
  };

  useEffect(() => {
    const goOffline = (e) => setOfflineAt(e.detail);
    const goOnline = () => setOfflineAt(null);
    window.addEventListener('anitrack:offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('anitrack:offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  useEffect(() => {
    if (!w.loaded) return;
    w.sync();
    const syncInterval = setInterval(() => w.sync(), 30 * 60 * 1000);
    return () => clearInterval(syncInterval);
  }, [w.sync, w.loaded]);

  const closeData = () => { setShowData(false); w.refreshLastBackup(); };
  const backupDue = w.loaded && !nudgeDismissed && w.watchlist.length >= 5 &&
    (!w.lastBackupAt || Date.now() - w.lastBackupAt > 14 * 24 * 3600 * 1000);

  // Android back button: close panels first, then go Home, and only then exit.
  const navRef = useRef(() => {});
  navRef.current = () => {
    if (showData) closeData();
    else if (selectedAnimeId) closeAnime();
    else if (currentView !== 'dashboard') setCurrentView('dashboard');
    else CapApp.exitApp();
  };
  useEffect(() => {
    let handle;
    CapApp.addListener('backButton', () => navRef.current()).then((h) => { handle = h; }).catch(() => {});
    return () => { handle?.remove(); };
  }, []);

  // Website / installed-PWA only: make the browser Back button close things first.
  // A spare history entry ("guard") sits on top, so Back reaches us before it leaves the app.
  // The guard is added on the first tap, because browsers skip entries added with no user interaction.
  const canBackRef = useRef(false);
  canBackRef.current = showData || !!selectedAnimeId || currentView !== 'dashboard';
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    let armed = false;
    let leaving = false;
    const GUARD = { anitrack: 'guard' };
    history.replaceState({ anitrack: 'base' }, '');
    const arm = () => {
      if (armed) return;
      armed = true;
      history.pushState(GUARD, '');
    };
    const onPop = () => {
      if (leaving || history.state?.anitrack === 'guard') return;
      if (armed && canBackRef.current) {
        history.pushState(GUARD, '');
        navRef.current();
      } else if (armed) {
        leaving = true;
        history.back();
      }
    };
    window.addEventListener('pointerdown', arm, { once: true });
    window.addEventListener('keydown', arm, { once: true });
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  const toast = useToast();
  const titleOf = (a) => a?.title?.english || a?.title?.romaji || 'That show';
  const uProgress = (id, n) => {
    const before = w.watchlist.find(a => a.id === id);
    w.updateProgress(id, n);
    if (before && n !== before.progress) {
      toast(`${titleOf(before)}: ${n > before.progress ? `episode ${n} watched` : `back to episode ${n}`}`, () => w.upsert(before));
    }
  };
  const uRemove = (id) => {
    const before = w.watchlist.find(a => a.id === id);
    w.remove(id);
    if (before) toast(`Removed ${titleOf(before)}`, () => w.upsert(before));
  };

  const [layout, setLayout] = useState('grid');
  useEffect(() => { getPref('layout', 'grid').then(v => setLayout(v === 'compact' ? 'compact' : 'grid')); }, []);
  const changeLayout = (v) => { setLayout(v); setPref('layout', v); };

  // "Mark watched" button on an episode alert. May arrive before the list has loaded.
  const pendingMarks = useRef([]);
  const applyMark = (id, ep) => {
    const it = w.watchlist.find(a => a.id === id);
    if (!it || ep <= it.progress) return;
    w.upsert({ ...it, airedEpisodes: Math.max(it.airedEpisodes ?? 0, ep) });
    w.updateProgress(id, ep);
    toast(`${titleOf(it)}: episode ${ep} watched`, () => w.upsert(it));
  };
  const markRef = useRef(applyMark);
  markRef.current = (id, ep) => { if (w.loaded) applyMark(id, ep); else pendingMarks.current.push([id, ep]); };
  useEffect(() => {
    let off;
    onWatchedAction((id, ep) => markRef.current(id, ep)).then(f => { off = f; });
    return () => off?.();
  }, []);
  useEffect(() => {
    if (!w.loaded || !pendingMarks.current.length) return;
    pendingMarks.current.splice(0).forEach(([id, ep]) => applyMark(id, ep));
  }, [w.loaded]);

  const views = {
    dashboard: <Dashboard watchlist={w.watchlist} updateProgress={uProgress} updateStatus={w.updateStatus} add={w.add} sync={w.sync} openAnime={openAnime} setViewAndFilter={setViewAndFilter} />,
    watchlist: <Watchlist watchlist={w.watchlist} updateProgress={uProgress} updateStatus={w.updateStatus} remove={uRemove} openAnime={openAnime} initialFilter={watchlistFilter} initialSort={watchlistSort} layout={layout} />,
    seasonal: <Seasonal watchlist={w.watchlist} add={w.add} openAnime={openAnime} />,
    search: <SearchAnime watchlist={w.watchlist} add={w.add} openAnime={openAnime} />,
    stats: <Stats watchlist={w.watchlist} />
  };

  return (
    <TickerProvider>
      <div className="min-h-screen bg-slate-900 text-slate-300 font-sans selection:bg-indigo-500/30">
        <header className="sticky top-0 z-40 bg-slate-900 border-b border-slate-800">
          <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
            <div className="flex items-center gap-2 text-indigo-400 cursor-pointer" onClick={() => setCurrentView('dashboard')}>
              <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center">
                <Clock size={20} />
              </div>
              <span className="text-xl font-bold tracking-tight text-white">AniTrack</span>
            </div>
            <nav className="hidden md:flex gap-1 bg-slate-800/50 p-1 rounded-xl">
              {NAV.map(n => n.id).map(v => (
                <button key={v} onClick={() => { if (v === 'watchlist') { setWatchlistFilter('ALL'); setWatchlistSort('title'); } setCurrentView(v); }}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium capitalize transition-all
                  ${currentView === v ? 'bg-indigo-500 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'}`}>
                  {v}
                </button>
              ))}
            </nav>
            <div className="flex items-center gap-4 text-sm font-medium">
              <button onClick={() => setShowData(true)} aria-label="Settings and backup" title="Settings & backup" className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
                <Settings size={18} />
              </button>
              <span className="hidden sm:inline-block text-slate-500">
                {formatLocal(getLocalUnixNow(), { dateStyle: 'long', timeStyle: 'short' })}
              </span>
            </div>
          </div>
        </header>

        <nav aria-label="Main" className="md:hidden fixed bottom-0 inset-x-0 z-40 flex bg-slate-900 border-t border-slate-800 bottom-nav">
          {NAV.map(({ id, label, Icon }) => (
            <button key={id} onClick={() => { if (id === 'watchlist') { setWatchlistFilter('ALL'); setWatchlistSort('title'); } setCurrentView(id); }}
              aria-current={currentView === id ? 'page' : undefined}
              className={`flex-1 flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium ${currentView === id ? 'text-indigo-400' : 'text-slate-500'}`}>
              <Icon size={20} />{label}
            </button>
          ))}
        </nav>

        <main className="max-w-7xl mx-auto px-4 py-8 pb-24">
          {offlineAt && (
            <div role="status" className="mb-6 text-sm bg-slate-800 border border-slate-700 text-slate-300 rounded-xl px-4 py-3">
              No signal. Showing what we saved {new Date(offlineAt).toLocaleString()}.
            </div>
          )}
          {w.notice && (
            <div role="alert" className="mb-6 flex items-center justify-between gap-3 text-sm bg-amber-500/10 border border-amber-500/30 text-amber-200 rounded-xl px-4 py-3">
              <span>{w.notice}</span>
              <button onClick={w.dismissNotice} className="underline shrink-0">Dismiss</button>
            </div>
          )}
          {w.saveError && (
            <div role="alert" className="mb-6 text-sm bg-rose-500/10 border border-rose-500/30 text-rose-200 rounded-xl px-4 py-3">
              {w.saveError} Export a backup now so you don't lose your list.
            </div>
          )}
          {backupDue && (
            <div className="mb-6 flex items-center justify-between gap-3 text-sm bg-indigo-500/10 border border-indigo-500/30 text-indigo-200 rounded-xl px-4 py-3">
              <span>Your list only lives on this device. Save a backup file?</span>
              <span className="flex gap-3 shrink-0">
                <button onClick={() => setShowData(true)} className="font-semibold underline">Back up</button>
                <button onClick={() => setNudgeDismissed(true)} aria-label="Dismiss reminder"><X size={16} /></button>
              </span>
            </div>
          )}
          {!w.loaded ? <CoverGridSkeleton /> : views[currentView]}

          <footer className="mt-16 pt-6 border-t border-slate-800 text-center text-xs text-slate-500">
            AniTrack · made by <a href="https://www.facebook.com/hoshplayss" target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-300">Hosh</a> · Anime data from AniList
          </footer>
        </main>

        {showData && (
          <DataPanel watchlist={w.watchlist} lastBackupAt={w.lastBackupAt} alertsOn={alertsOn} onToggleAlerts={toggleAlerts} layout={layout} onLayout={changeLayout} onMerge={w.mergeIn} onReplace={w.replaceAll} onClose={closeData} />
        )}

        {selectedAnimeId && (
          <AnimeDetailModal 
            animeId={selectedAnimeId} 
            onClose={closeAnime} 
            watchlistObj={{ ...w, updateProgress: uProgress, remove: uRemove }} 
            openAnime={openAnime} 
          />
        )}
      </div>
    </TickerProvider>
  );
}
