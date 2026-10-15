import React, { useState, useEffect, useRef, useMemo, createContext, useContext, useCallback } from 'react';
import { 
  ChevronLeft, ChevronRight, Calendar as CalendarIcon, Clock,
  Search, Check, Plus, Minus, RefreshCw, AlertTriangle, Info,
  Settings, ChevronDown, CheckCircle, Flame, Star,
  X, ExternalLink, Heart, Film, Trash2, Users, TrendingUp
} from 'lucide-react';

// --- Constants & Utilities ---
const PHT_OFFSET = 8 * 60 * 60 * 1000; // +8 hours in ms
const STORAGE_KEY = 'pht-anime-watchlist';
const ANILIST_API = 'https://graphql.anilist.co';

const getPhtUnixNow = () => Math.floor(Date.now() / 1000);

// Robust PHT Date generation manipulating UTC representations to align with Manila day boundaries
const createPhtDate = (timestampMs) => new Date(timestampMs + PHT_OFFSET);

const getPhtStartOfDayUnix = (unix) => {
  const d = createPhtDate(unix * 1000);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return Math.floor((start.getTime() - PHT_OFFSET) / 1000);
};

const addPhtDays = (unix, deltaDays) => {
  return unix + (deltaDays * 86400);
};

const addPhtMonths = (unix, deltaMonths) => {
  const d = createPhtDate(unix * 1000);
  d.setUTCDate(1); // Clamp to 1st to prevent month-skipping bugs on 31st
  d.setUTCMonth(d.getUTCMonth() + deltaMonths);
  return Math.floor((d.getTime() - PHT_OFFSET) / 1000);
};

const getDayOfWeekUnix = (unix) => {
  const d = createPhtDate(unix * 1000);
  const day = d.getUTCDay();
  return day === 0 ? 6 : day - 1; // Monday = 0, Sunday = 6
};

const getPhtDaysInMonth = (monthStartUnix) => {
  const d = createPhtDate(monthStartUnix * 1000);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
};

const formatPHT = (unix, options) => {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', ...options })
    .format(new Date(unix * 1000));
};

const fetchGraphQL = async (query, variables, signal) => {
  const res = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal
  });
  if (res.status === 429) throw new Error('rate_limit');
  if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
};

// Safe HTML cleaning for anime synopsis
const parseSynopsis = (html) => {
  if (!html) return "No synopsis available.";
  let cleaned = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  return cleaned.trim() || "No synopsis available.";
};

// --- Context & Ticker Optimization ---
const TickerContext = createContext(Date.now());
const useTicker = () => useContext(TickerContext);

const TickerProvider = ({ children }) => {
  const [ticker, setTicker] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setTicker(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <TickerContext.Provider value={ticker}>
      {children}
    </TickerContext.Provider>
  );
};

// Migrates legacy item structures safely
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
    favorite: item.favorite ?? false
  };
};

function useWatchlist() {
  const [watchlist, setWatchlist] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return [];
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(migrateWatchlistItem);
    } catch (e) {
      console.error('Watchlist parse error:', e);
      return [];
    }
  });

  const watchlistRef = useRef(watchlist);
  useEffect(() => {
    watchlistRef.current = watchlist;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist));
  }, [watchlist]);

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
        favorite: false
      }];
    });
  }, []);

  const remove = useCallback((id) => {
    setWatchlist(prev => prev.filter(a => a.id !== id));
  }, []);

  const updateStatus = useCallback((id, newStatus) => {
    setWatchlist(prev => prev.map(a => a.id === id ? { ...a, status: newStatus } : a));
  }, []);

  const setStatusAndAdd = useCallback((anime, newStatus) => {
    setWatchlist(prev => {
      const existing = prev.find(a => a.id === anime.id);
      if (existing) {
        return prev.map(a => a.id === anime.id ? { ...a, status: newStatus } : a);
      }
      
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

      return [...prev, {
        id: anime.id,
        idMal: anime.idMal || null,
        title,
        coverImage,
        status: newStatus,
        progress: 0,
        totalEpisodes,
        mediaStatus,
        airedEpisodes,
        nextEpisodeAt,
        score: null,
        notes: '',
        favorite: false
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
      
      if (item.totalEpisodes && clampedProgress >= item.totalEpisodes && item.mediaStatus === 'FINISHED') {
        status = 'COMPLETED';
      } else if (clampedProgress > 0 && status === 'PLAN_TO_WATCH') {
        status = 'WATCHING';
      } else if (clampedProgress < (item.totalEpisodes || Infinity) && status === 'COMPLETED') {
        status = 'WATCHING';
      }

      return { ...item, progress: clampedProgress, status };
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

  // Syncs watchlist items safely using ref
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
        // Respect AniList API rate limits if multiple chunks are needed
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
    watchlist, add, remove, updateStatus, setStatusAndAdd, updateProgress, 
    setScore, setNotes, toggleFavorite, sync 
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
      <circle cx={size/2} cy={size/2} r={r} fill="transparent" stroke="#334155" strokeWidth={strokeWidth} />
      <circle cx={size/2} cy={size/2} r={r} fill="transparent" stroke="#818cf8" strokeWidth={strokeWidth}
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
  const now = getPhtUnixNow();
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
          ${isWatched ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-slate-600 text-transparent hover:border-indigo-400'}
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
          <span className="font-medium text-indigo-300">
            Ep {episode.episode} {episode.media.episodes ? `/ ${episode.media.episodes}` : ''}
          </span>
          <span>•</span>
          <span className={isAired ? "text-emerald-400 font-semibold" : "text-amber-400 font-semibold"}>
            {isAired ? "Aired" : "Upcoming"}
          </span>
          <span>•</span>
          <span>{formatPHT(episode.airingAt, { hour: 'numeric', minute: '2-digit' })}</span>
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
  const [selectedUnix, setSelectedUnix] = useState(getPhtStartOfDayUnix(getPhtUnixNow()));
  const [myListOnly, setMyListOnly] = useState(watchlist.length > 0);
  
  const wIds = useMemo(() => watchlist.map(i => i.id), [watchlist]);

  let startUnix, endUnix;
  if (mode === 'daily') {
    startUnix = selectedUnix;
    endUnix = addPhtDays(selectedUnix, 1);
  } else if (mode === 'weekly') {
    const dayOfWeek = getDayOfWeekUnix(selectedUnix);
    startUnix = addPhtDays(selectedUnix, -dayOfWeek);
    endUnix = addPhtDays(startUnix, 7);
  } else {
    const d = createPhtDate(selectedUnix * 1000);
    startUnix = getPhtStartOfDayUnix(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
    endUnix = addPhtMonths(startUnix, 1);
  }

  const { data: schedules, loading, error, retry } = useSchedulesRange(startUnix, endUnix, mode, myListOnly, wIds);

  const navDate = (delta) => {
    if (mode === 'daily') setSelectedUnix(addPhtDays(selectedUnix, delta));
    else if (mode === 'weekly') setSelectedUnix(addPhtDays(selectedUnix, delta * 7));
    else setSelectedUnix(addPhtMonths(selectedUnix, delta));
  };

  const navToday = () => setSelectedUnix(getPhtStartOfDayUnix(getPhtUnixNow()));

  const renderDaily = () => {
    if (loading) return <div className="p-8 text-center text-slate-400 animate-pulse">Loading schedule...</div>;
    if (schedules.length === 0) return <div className="p-8 text-center text-slate-400 bg-slate-800/20 rounded-xl">No anime releases scheduled for this day.</div>;
    
    return (
      <div className="bg-slate-800/30 rounded-2xl p-2">
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
    if (loading) return <div className="p-8 text-center text-slate-400 animate-pulse">Loading weekly schedule...</div>;

    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-7 gap-4">
        {Array.from({ length: 7 }).map((_, i) => {
          const dayUnix = addPhtDays(startUnix, i);
          const isToday = dayUnix === getPhtStartOfDayUnix(getPhtUnixNow());
          const isSelected = dayUnix === selectedUnix;
          const daySchedules = schedules.filter(s => s.airingAt >= dayUnix && s.airingAt < addPhtDays(dayUnix, 1));
          
          return (
            <div key={i} 
              onClick={() => { setSelectedUnix(dayUnix); setMode('daily'); }}
              className={`bg-slate-800/30 rounded-xl p-3 border-2 transition-all cursor-pointer hover:border-indigo-500/50
              ${isToday ? 'border-indigo-500 bg-indigo-500/5' : isSelected ? 'border-slate-500' : 'border-transparent'}`}
            >
              <div className="text-center mb-3">
                <div className="text-xs text-slate-400 uppercase font-bold">{formatPHT(dayUnix, { weekday: 'short' })}</div>
                <div className={`text-xl font-bold ${isToday ? 'text-indigo-400' : 'text-slate-200'}`}>
                  {formatPHT(dayUnix, { day: 'numeric' })}
                </div>
              </div>
              <div className="space-y-2">
                {daySchedules.slice(0, 5).map(ep => (
                  <div key={ep.id} className="text-xs p-2 bg-slate-800/80 rounded-lg flex items-center gap-3 overflow-hidden" title={ep.media.title.english || ep.media.title.romaji}>
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
    if (loading) return <div className="p-8 text-center text-slate-400 animate-pulse">Loading monthly grid...</div>;

    const daysInMonth = getPhtDaysInMonth(startUnix);
    const firstDayOfWeek = getDayOfWeekUnix(startUnix);
    const todayStartUnix = getPhtStartOfDayUnix(getPhtUnixNow());

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
            const dayStartUnix = addPhtDays(startUnix, dayNum - 1);
            const dayEndUnix = addPhtDays(dayStartUnix, 1);
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
            {mode === 'daily' ? formatPHT(selectedUnix, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) :
             mode === 'weekly' ? `Week of ${formatPHT(startUnix, { month: 'short', day: 'numeric' })}` :
             formatPHT(startUnix, { month: 'long', year: 'numeric' })}
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
              {error === 'rate_limit' ? 'Rate limited by AniList API. Please wait a moment.' : error}
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

const DashboardStat = ({ icon: Icon, label, value, colorScheme }) => {
  const schemes = {
    rose: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
    emerald: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    amber: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    indigo: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
  };

  const schemeClass = schemes[colorScheme] || schemes.indigo;

  return (
    <div className={`p-5 rounded-2xl border bg-slate-800/50 flex items-center gap-4 ${schemeClass}`}>
      <div className={`p-3 rounded-xl ${schemeClass}`}>
        <Icon size={24} />
      </div>
      <div>
        <div className="text-slate-400 text-sm font-medium">{label}</div>
        <div className="text-2xl font-bold text-white">{value}</div>
      </div>
    </div>
  );
};

const Dashboard = ({ watchlist, updateProgress, updateStatus, add, sync, openAnime }) => {
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    setSyncing(true);
    await sync();
    setSyncing(false);
  };

  const watching = watchlist.filter(a => a.status === 'WATCHING');
  const epsWatched = watchlist.reduce((acc, curr) => acc + curr.progress, 0);
  const epsBehind = watching.reduce((acc, curr) => {
    if (curr.airedEpisodes !== null && curr.airedEpisodes !== undefined && curr.progress < curr.airedEpisodes) {
      return acc + (curr.airedEpisodes - curr.progress);
    }
    return acc;
  }, 0);
  
  const continueWatching = watching.filter(a => a.airedEpisodes !== null && a.airedEpisodes !== undefined && a.progress < a.airedEpisodes);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold text-white">Dashboard</h1>
        <button onClick={handleSync} disabled={syncing} className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-medium transition-colors">
          <RefreshCw size={16} className={syncing ? 'animate-spin text-indigo-400' : ''} />
          {syncing ? 'Syncing...' : 'Sync Data'}
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <DashboardStat icon={Flame} label="Watching" value={watching.length} colorScheme="rose" />
        <DashboardStat icon={CheckCircle} label="Completed" value={watchlist.filter(a => a.status === 'COMPLETED').length} colorScheme="emerald" />
        <DashboardStat icon={Star} label="Eps Watched" value={epsWatched} colorScheme="amber" />
        <DashboardStat icon={AlertTriangle} label="Eps Behind" value={epsBehind} colorScheme="indigo" />
      </div>

      {continueWatching.length > 0 && (
        <div className="bg-slate-800/30 border border-slate-700/50 p-6 rounded-2xl">
          <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
            <PlayCircleIcon size={20} className="text-indigo-400" /> Continue Watching
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {continueWatching.slice(0, 6).map(item => (
              <div 
                key={item.id} 
                onClick={() => openAnime(item.id)}
                className="flex items-center gap-4 bg-slate-800/80 p-3 rounded-xl border border-slate-700 hover:border-indigo-500/50 transition-colors cursor-pointer"
              >
                <img src={item.coverImage?.large} alt="" referrerPolicy="no-referrer" className="w-12 h-16 rounded object-cover flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <h4 className="font-semibold text-slate-200 text-sm truncate hover:text-indigo-400 transition-colors">{item.title?.english || item.title?.romaji}</h4>
                  <div className="text-xs text-slate-400 mt-1">Ep {item.progress} / {item.totalEpisodes || '?'}</div>
                  <div className="text-xs text-indigo-400 mt-0.5">{item.airedEpisodes - item.progress} eps behind</div>
                </div>
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    updateProgress(item.id, item.progress + 1);
                  }}
                  className="w-10 h-10 rounded-full bg-indigo-500/10 hover:bg-indigo-500 hover:text-white text-indigo-400 flex flex-shrink-0 items-center justify-center transition-all"
                  title="Mark next watched"
                >
                  <Plus size={20} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h2 className="text-xl font-bold text-white mb-4">Release Calendar (PHT)</h2>
        <CalendarView watchlist={watchlist} updateProgress={updateProgress} updateStatus={updateStatus} add={add} openAnime={openAnime} />
      </div>
    </div>
  );
};

const WatchlistCard = ({ item, updateProgress, updateStatus, remove, openAnime }) => {
  const isAiring = item.mediaStatus === 'RELEASING';
  const total = item.totalEpisodes;
  let maxAllowed = Infinity;
  if (isAiring && item.airedEpisodes !== null && item.airedEpisodes !== undefined) {
    maxAllowed = item.airedEpisodes;
  } else if (total !== null && total !== undefined) {
    maxAllowed = total;
  }
  
  const nextEpNum = (item.airedEpisodes !== null && item.airedEpisodes !== undefined ? item.airedEpisodes : item.progress) + 1;
  const showNextEp = isAiring && item.nextEpisodeAt && nextEpNum > 0;

  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-2xl overflow-hidden hover:border-slate-500 transition-all group flex flex-col">
      <div className="relative aspect-[3/4] cursor-pointer" onClick={() => openAnime(item.id)}>
        <img src={item.coverImage?.large} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/40 to-transparent" />
        
        {/* Score & Favorite Badges */}
        <div className="absolute top-2 left-2 flex items-center gap-1.5">
          {item.score && (
            <span className="bg-amber-500/90 text-slate-950 font-extrabold text-[11px] px-2 py-0.5 rounded-md shadow-md flex items-center gap-0.5">
              <Star size={12} className="fill-slate-950" /> {item.score}
            </span>
          )}
          {item.favorite && (
            <span className="bg-rose-500/90 text-white p-1 rounded-md shadow-md">
              <Heart size={12} className="fill-white" />
            </span>
          )}
        </div>

        {/* Airing / Finished Status Badge */}
        <div className="absolute top-2 right-2">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md shadow-md uppercase ${isAiring ? 'bg-indigo-500/90 text-white' : 'bg-slate-800/90 text-slate-300 border border-slate-700'}`}>
            {isAiring ? 'Airing' : 'Finished'}
          </span>
        </div>

        <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-3" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-2 flex-1">
            <ProgressRing progress={item.progress} total={total} size={36} strokeWidth={4} />
            <div>
              <div className="text-white font-bold leading-none">Ep {item.progress} <span className="text-slate-300 text-sm font-normal">/ {total || '?'}</span></div>
              {total && total > item.progress && <div className="text-xs text-slate-300 mt-1">{total - item.progress} left</div>}
            </div>
          </div>
          
          <div className="flex flex-col gap-1">
            <button 
              onClick={() => updateProgress(item.id, item.progress + 1)} 
              disabled={item.progress >= maxAllowed}
              className="bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 disabled:bg-slate-600 text-white p-1.5 rounded-lg transition-colors"
            >
              <Plus size={16} />
            </button>
            <button 
              onClick={() => updateProgress(item.id, item.progress - 1)} 
              disabled={item.progress === 0}
              className="bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white p-1.5 rounded-lg transition-colors"
            >
              <Minus size={16} />
            </button>
          </div>
        </div>
      </div>
      
      <div className="p-4 flex flex-col flex-1">
        <h3 
          onClick={() => openAnime(item.id)}
          className="font-bold text-slate-100 line-clamp-1 mb-2 cursor-pointer hover:text-indigo-400 transition-colors" 
          title={item.title?.english || item.title?.romaji}
        >
          {item.title?.english || item.title?.romaji}
        </h3>
        
        {isAiring && (
          <div className="bg-slate-900/50 rounded-lg p-2.5 mt-auto text-xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Status</span>
              <span className={item.airedEpisodes !== null && item.progress < item.airedEpisodes ? "text-amber-400 font-medium" : "text-emerald-400 font-medium"}>
                {item.airedEpisodes !== null && item.progress < item.airedEpisodes ? `${item.airedEpisodes - item.progress} eps behind` : 'Caught up'}
              </span>
            </div>
            {showNextEp && (
              <div className="text-indigo-300 font-medium border-t border-slate-700/50 pt-1.5 mt-1.5">
                Next: Ep {nextEpNum} in <CountdownLabel unixTarget={item.nextEpisodeAt} />
              </div>
            )}
          </div>
        )}
        
        <div className="flex flex-col xl:flex-row justify-between items-stretch xl:items-center mt-3 pt-3 border-t border-slate-700 gap-2">
          <select 
            value={item.status} 
            onChange={(e) => updateStatus(item.id, e.target.value)}
            className="bg-slate-900 text-xs text-slate-300 rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-indigo-500 w-full xl:w-auto"
          >
            <option value="WATCHING">Watching</option>
            <option value="PLAN_TO_WATCH">Plan to Watch</option>
            <option value="COMPLETED">Completed</option>
            <option value="PAUSED">On Hold / Paused</option>
            <option value="DROPPED">Dropped</option>
          </select>
          <button onClick={() => remove(item.id)} className="text-slate-500 hover:text-red-400 text-xs transition-colors text-left xl:text-right py-1">Remove</button>
        </div>
      </div>
    </div>
  );
};

const Watchlist = ({ watchlist, updateProgress, updateStatus, remove, openAnime }) => {
  const [filter, setFilter] = useState('ALL');
  const filtered = filter === 'ALL' ? watchlist : watchlist.filter(a => a.status === filter);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center flex-wrap gap-4">
        <h1 className="text-3xl font-bold text-white">My Watchlist</h1>
        <div className="flex gap-2 bg-slate-800 p-1 rounded-lg flex-wrap">
          {[
            { key: 'ALL', label: 'All' },
            { key: 'WATCHING', label: 'Watching' },
            { key: 'PLAN_TO_WATCH', label: 'Plan to Watch' },
            { key: 'COMPLETED', label: 'Completed' },
            { key: 'PAUSED', label: 'On Hold' },
            { key: 'DROPPED', label: 'Dropped' }
          ].map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-md text-xs sm:text-sm font-medium transition-colors ${filter === f.key ? 'bg-indigo-500 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700'}`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-20 text-slate-400 bg-slate-800/30 rounded-2xl border border-slate-800">
          No anime found in this category.
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4 lg:gap-6">
          {filtered.map(item => (
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
          <select value={season} onChange={e => setSeason(e.target.value)} className="bg-slate-800 text-white rounded-lg px-4 py-2 border border-slate-700 outline-none focus:border-indigo-500">
            <option value="WINTER">Winter</option>
            <option value="SPRING">Spring</option>
            <option value="SUMMER">Summer</option>
            <option value="FALL">Fall</option>
          </select>
          <select value={year} onChange={e => setYear(Number(e.target.value))} className="bg-slate-800 text-white rounded-lg px-4 py-2 border border-slate-700 outline-none focus:border-indigo-500">
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
              onClick={() => openAnime(item.id)}
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
            {loading ? 'Loading...' : 'Load More'}
          </button>
        </div>
      )}
    </div>
  );
};

const SearchAnime = ({ watchlist, add, openAnime }) => {
  const [query, setQuery] = useState('');
  const [anime, setAnime] = useState([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const performSearch = async (searchQuery, p = 1, append = false) => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    setHasSearched(true);
    const gqlQuery = `
      query ($search: String, $page: Int) {
        Page(page: $page, perPage: 40) {
          pageInfo { hasNextPage }
          media(search: $search, type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
            id idMal status episodes
            title { romaji english native }
            coverImage { large extraLarge }
            nextAiringEpisode { episode airingAt }
          }
        }
      }
    `;
    try {
      const data = await fetchGraphQL(gqlQuery, { search: searchQuery, page: p });
      if (append) setAnime(prev => [...prev, ...data.Page.media]);
      else setAnime(data.Page.media);
      setHasNext(data.Page.pageInfo.hasNextPage);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const handleSearch = (e) => {
    e.preventDefault();
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
              className="w-full bg-slate-800 text-white rounded-lg pl-10 pr-4 py-2 border border-slate-700 outline-none focus:border-indigo-500"
            />
          </div>
          <button type="submit" disabled={loading || !query.trim()} className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white rounded-lg font-medium transition-colors">
            Search
          </button>
        </form>
      </div>

      {hasSearched && anime.length === 0 && !loading && (
        <div className="text-center py-20 text-slate-400 bg-slate-800/30 rounded-2xl border border-slate-800">
          No results found for "{query}".
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {anime.map(item => {
          const inList = watchlist.find(w => w.id === item.id);
          return (
            <div 
              key={item.id} 
              onClick={() => openAnime(item.id)}
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
            {loading ? 'Loading...' : 'Load More'}
          </button>
        </div>
      )}
    </div>
  );
};

// Anime Detail Modal Component
const AnimeDetailModal = ({ animeId, onClose, watchlistObj, openAnime }) => {
  const { watchlist, add, remove, updateStatus, setStatusAndAdd, updateProgress, setScore, setNotes, toggleFavorite } = watchlistObj;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showFullSynopsis, setShowFullSynopsis] = useState(false);
  const cache = useRef(new Map());

  const watchItem = useMemo(() => watchlist.find(w => w.id === animeId), [watchlist, animeId]);

  // Lock body scroll while open & attach Escape listener
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

  // Fetch Media details with caching & abort
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
            <h3 className="text-xl font-bold text-white">Error Loading Anime</h3>
            <p className="text-slate-400 text-sm">{error}</p>
            <button onClick={fetchData} className="px-5 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg font-medium transition-colors inline-flex items-center gap-2">
              <RefreshCw size={16} /> Retry
            </button>
          </div>
        )}

        {(data || watchItem) && (
          <div className="flex-1 space-y-6 pb-8">
            {/* Banner & Poster */}
            <div className="relative">
              <div className="h-44 sm:h-60 w-full overflow-hidden bg-gradient-to-r from-indigo-900/50 via-slate-800 to-purple-900/50 relative">
                {bannerImg ? (
                  <img src={bannerImg} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover opacity-60" />
                ) : (
                  <div className="w-full h-full bg-gradient-to-tr from-indigo-950 via-slate-900 to-slate-800 opacity-90" />
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
                  {titleNative && (
                    <p className="text-xs text-slate-500">{titleNative}</p>
                  )}
                </div>
              </div>
            </div>

            <div className="px-6 space-y-6">
              {/* Meta Subheader */}
              <div className="text-xs sm:text-sm text-slate-400 border-b border-slate-800 pb-3 flex items-center gap-2 flex-wrap font-medium">
                <span className="text-slate-200">{studioName}</span>
                <span>•</span>
                <span>{totalEps ? `${totalEps} Episodes` : 'Episodes TBA'}</span>
                <span>•</span>
                <span>{data?.duration ? `${data.duration} min/ep` : 'Standard Duration'}</span>
                {data?.source && (
                  <>
                    <span>•</span>
                    <span className="uppercase text-indigo-300 font-semibold">{data.source.replace(/_/g, ' ')}</span>
                  </>
                )}
              </div>

              {/* Airing / Release Status */}
              <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4 flex items-center justify-between flex-wrap gap-3">
                {nextAiringAt ? (
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-indigo-500/20 text-indigo-400 flex items-center justify-center flex-shrink-0">
                      <Clock size={20} />
                    </div>
                    <div>
                      <div className="text-xs text-slate-400 font-medium uppercase tracking-wider">Next Release</div>
                      <div className="text-sm font-bold text-white">
                        Ep {nextEpNum || '?'} • {formatPHT(nextAiringAt, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} PHT
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-slate-800 text-slate-400 flex items-center justify-center flex-shrink-0">
                      <Film size={20} />
                    </div>
                    <div>
                      <div className="text-xs text-slate-400 font-medium uppercase tracking-wider">Airing Status</div>
                      <div className="text-sm font-bold text-slate-200">
                        {mediaStatus === 'FINISHED' ? 'All episodes aired' : 'Release schedule TBA'}
                      </div>
                    </div>
                  </div>
                )}

                {nextAiringAt && (
                  <div className="text-sm font-bold bg-indigo-500/10 border border-indigo-500/30 px-3 py-1.5 rounded-lg text-indigo-300">
                    Releases in <CountdownLabel unixTarget={nextAiringAt} />
                  </div>
                )}
              </div>

              {/* Ratings & Rankings */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {data?.averageScore !== undefined && data?.averageScore !== null && (
                  <div className="bg-slate-800/40 border border-slate-800 p-3 rounded-xl">
                    <div className="text-xs text-slate-400">Average Score</div>
                    <div className="text-xl font-bold text-amber-400 mt-1">{data.averageScore}%</div>
                    <div className="w-full bg-slate-700 h-1.5 rounded-full mt-2 overflow-hidden">
                      <div className="bg-amber-400 h-full rounded-full" style={{ width: `${data.averageScore}%` }} />
                    </div>
                  </div>
                )}
                {data?.popularity !== undefined && data?.popularity !== null && (
                  <div className="bg-slate-800/40 border border-slate-800 p-3 rounded-xl">
                    <div className="text-xs text-slate-400">Popularity</div>
                    <div className="text-xl font-bold text-indigo-400 mt-1 flex items-center gap-1.5">
                      <Users size={16} /> {data.popularity.toLocaleString()}
                    </div>
                  </div>
                )}
                {data?.favourites !== undefined && data?.favourites !== null && (
                  <div className="bg-slate-800/40 border border-slate-800 p-3 rounded-xl">
                    <div className="text-xs text-slate-400">Favorites</div>
                    <div className="text-xl font-bold text-rose-400 mt-1 flex items-center gap-1.5">
                      <Heart size={16} /> {data.favourites.toLocaleString()}
                    </div>
                  </div>
                )}
                {bestRanking && (
                  <div className="bg-slate-800/40 border border-slate-800 p-3 rounded-xl">
                    <div className="text-xs text-slate-400">Ranked</div>
                    <div className="text-sm font-bold text-emerald-400 mt-1 flex items-center gap-1">
                      <TrendingUp size={16} /> #{bestRanking.rank} {bestRanking.context || bestRanking.type}
                    </div>
                  </div>
                )}
              </div>

              {/* My Progress Box */}
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
                  {/* Status Dropdown */}
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
                      className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-xl px-3 py-2 outline-none focus:border-indigo-500"
                    >
                      <option value="NOT_IN_LIST">Not in my list</option>
                      <option value="WATCHING">Watching</option>
                      <option value="PLAN_TO_WATCH">Plan to Watch</option>
                      <option value="COMPLETED">Completed</option>
                      <option value="PAUSED">On Hold / Paused</option>
                      <option value="DROPPED">Dropped</option>
                    </select>
                  </div>

                  {/* Progress Inputs */}
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

                  {/* Rating Score */}
                  <div>
                    <label className="block text-xs text-slate-400 font-medium mb-1">My Score</label>
                    <select 
                      disabled={!watchItem}
                      value={watchItem?.score || ''}
                      onChange={(e) => watchItem && setScore(animeId, e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-xl px-3 py-2 outline-none focus:border-indigo-500 disabled:opacity-50"
                    >
                      <option value="">No rating</option>
                      {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(num => (
                        <option key={num} value={num}>{num} ({num === 10 ? 'Masterpiece' : num >= 8 ? 'Great' : num >= 6 ? 'Good' : 'Average'})</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Episode Grid */}
                {watchItem && (
                  <div className="pt-2 border-t border-slate-700/60">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Quick Episode Select</span>
                      {totalEps && mediaStatus === 'FINISHED' && watchItem.progress < totalEps && (
                        <button 
                          onClick={() => updateProgress(animeId, totalEps)}
                          className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold"
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

                {/* Personal Notes */}
                {watchItem && (
                  <div>
                    <label className="block text-xs text-slate-400 font-medium mb-1">Personal Notes</label>
                    <textarea 
                      defaultValue={watchItem.notes || ''}
                      onBlur={(e) => setNotes(animeId, e.target.value)}
                      placeholder="Write private thoughts, favorite characters, or review notes..."
                      className="w-full h-16 bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-xl p-2.5 outline-none focus:border-indigo-500 resize-none"
                    />
                  </div>
                )}

                {watchItem && (
                  <div className="flex justify-end pt-1">
                    <button 
                      onClick={() => remove(animeId)} 
                      className="text-xs text-red-400 hover:text-red-300 font-medium inline-flex items-center gap-1 transition-colors"
                    >
                      <Trash2 size={13} /> Remove from Watchlist
                    </button>
                  </div>
                )}
              </div>

              {/* Synopsis */}
              <div className="space-y-2">
                <h3 className="font-bold text-white text-base">Synopsis</h3>
                <div className="text-sm text-slate-300 leading-relaxed whitespace-pre-line bg-slate-800/30 border border-slate-800 p-4 rounded-xl">
                  {isLongSynopsis && !showFullSynopsis ? (
                    <>
                      {cleanedSynopsis.slice(0, 400)}...
                      <button 
                        onClick={() => setShowFullSynopsis(true)}
                        className="ml-2 text-indigo-400 font-bold hover:underline inline-block"
                      >
                        Read more
                      </button>
                    </>
                  ) : (
                    <>
                      {cleanedSynopsis}
                      {isLongSynopsis && (
                        <button 
                          onClick={() => setShowFullSynopsis(false)}
                          className="ml-2 text-indigo-400 font-bold hover:underline inline-block"
                        >
                          Show less
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Genres & Information */}
              <div className="space-y-3">
                <h3 className="font-bold text-white text-base">Genres & Information</h3>
                <div className="flex flex-wrap gap-2">
                  {(data?.genres || []).map(g => (
                    <span key={g} className="bg-slate-800 border border-slate-700/80 text-indigo-300 text-xs px-3 py-1 rounded-full font-medium">
                      {g}
                    </span>
                  ))}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs bg-slate-800/20 p-3 rounded-xl border border-slate-800">
                  <div>
                    <span className="text-slate-500 block">Start Date</span>
                    <span className="text-slate-300 font-medium">
                      {data?.startDate?.year ? `${data.startDate.year}-${data.startDate.month || 1}-${data.startDate.day || 1}` : 'Unknown'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">End Date</span>
                    <span className="text-slate-300 font-medium">
                      {data?.endDate?.year ? `${data.endDate.year}-${data.endDate.month || 1}-${data.endDate.day || 1}` : 'Airing / Unknown'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Source Material</span>
                    <span className="text-slate-300 font-medium">{data?.source ? data.source.replace(/_/g, ' ') : 'Unknown'}</span>
                  </div>
                </div>
              </div>

              {/* External Links */}
              <div className="space-y-3 pt-2 border-t border-slate-800">
                <h3 className="font-bold text-white text-base">External & Streaming Links</h3>
                <div className="flex flex-wrap gap-2">
                  <a 
                    href={`https://anilist.co/anime/${data?.id || animeId}`} 
                    target="_blank" 
                    rel="noreferrer"
                    className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-3.5 py-2 rounded-xl font-semibold flex items-center gap-1.5 transition-colors shadow-md"
                  >
                    <ExternalLink size={14} /> AniList
                  </a>

                  {(data?.idMal || watchItem?.idMal) && (
                    <a 
                      href={`https://myanimelist.net/anime/${data?.idMal || watchItem?.idMal}`} 
                      target="_blank" 
                      rel="noreferrer"
                      className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-3.5 py-2 rounded-xl font-semibold flex items-center gap-1.5 transition-colors shadow-md"
                    >
                      <ExternalLink size={14} /> MyAnimeList
                    </a>
                  )}

                  {streamingLinks.map(link => (
                    <a 
                      key={link.url} 
                      href={link.url} 
                      target="_blank" 
                      rel="noreferrer"
                      className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs px-3 py-2 rounded-xl font-medium flex items-center gap-1.5 transition-colors"
                    >
                      <ExternalLink size={13} /> {link.site || 'Watch Stream'}
                    </a>
                  ))}
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
  const [selectedAnimeId, setSelectedAnimeId] = useState(null);
  const w = useWatchlist();

  const openAnime = useCallback((id) => {
    setSelectedAnimeId(id);
  }, []);

  const closeAnime = useCallback(() => {
    setSelectedAnimeId(null);
  }, []);

  // Sync Watchlist initially and every 30 minutes
  useEffect(() => {
    w.sync();
    const syncInterval = setInterval(() => w.sync(), 30 * 60 * 1000);
    return () => clearInterval(syncInterval);
  }, [w.sync]);

  const views = {
    dashboard: <Dashboard watchlist={w.watchlist} updateProgress={w.updateProgress} updateStatus={w.updateStatus} add={w.add} sync={w.sync} openAnime={openAnime} />,
    watchlist: <Watchlist watchlist={w.watchlist} updateProgress={w.updateProgress} updateStatus={w.updateStatus} remove={w.remove} openAnime={openAnime} />,
    seasonal: <Seasonal watchlist={w.watchlist} add={w.add} openAnime={openAnime} />,
    search: <SearchAnime watchlist={w.watchlist} add={w.add} openAnime={openAnime} />
  };

  return (
    <TickerProvider>
      <div className="min-h-screen bg-slate-900 text-slate-300 font-sans selection:bg-indigo-500/30">
        <header className="sticky top-0 z-40 bg-slate-900/80 backdrop-blur-xl border-b border-slate-800">
          <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
            <div className="flex items-center gap-2 text-indigo-400 cursor-pointer" onClick={() => setCurrentView('dashboard')}>
              <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center">
                <Clock size={20} />
              </div>
              <span className="text-xl font-bold tracking-tight text-white">AniTrack<span className="text-indigo-500">PHT</span></span>
            </div>
            <nav className="hidden md:flex gap-1 bg-slate-800/50 p-1 rounded-xl">
              {['dashboard', 'watchlist', 'seasonal', 'search'].map(v => (
                <button key={v} onClick={() => setCurrentView(v)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium capitalize transition-all
                  ${currentView === v ? 'bg-indigo-500 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'}`}>
                  {v}
                </button>
              ))}
            </nav>
            <div className="flex items-center gap-4 text-sm font-medium">
              <span className="hidden sm:inline-block text-slate-500">{formatPHT(getPhtUnixNow(), { dateStyle: 'long', timeStyle: 'short' })} PHT</span>
            </div>
          </div>
        </header>

        {/* Mobile Nav */}
        <div className="md:hidden flex overflow-x-auto gap-2 p-4 bg-slate-900 border-b border-slate-800">
          {['dashboard', 'watchlist', 'seasonal', 'search'].map(v => (
            <button key={v} onClick={() => setCurrentView(v)}
              className={`flex-shrink-0 px-4 py-2 rounded-lg text-sm font-medium capitalize
              ${currentView === v ? 'bg-indigo-500 text-white' : 'bg-slate-800 text-slate-400'}`}>
              {v}
            </button>
          ))}
        </div>

        <main className="max-w-7xl mx-auto px-4 py-8 pb-24">
          {views[currentView]}
        </main>

        {/* Global Anime Detail Modal */}
        {selectedAnimeId && (
          <AnimeDetailModal 
            animeId={selectedAnimeId} 
            onClose={closeAnime} 
            watchlistObj={w} 
            openAnime={openAnime} 
          />
        )}
      </div>
    </TickerProvider>
  );
}
