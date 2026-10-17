import React from 'react';

const LABELS = { WATCHING: 'Watching', COMPLETED: 'Completed', PLAN_TO_WATCH: 'Plan to Watch', PAUSED: 'On Hold', DROPPED: 'Dropped' };
const COLORS = { WATCHING: 'bg-indigo-500', COMPLETED: 'bg-indigo-300', PLAN_TO_WATCH: 'bg-slate-500', PAUSED: 'bg-slate-600', DROPPED: 'bg-slate-700' };
const MINUTES_PER_EP = 24; // AniList duration is not stored, so hours are an estimate

export default function Stats({ watchlist }) {
  const total = watchlist.length;
  const eps = watchlist.reduce((n, a) => n + (a.progress || 0), 0);
  const hours = Math.round((eps * MINUTES_PER_EP) / 60);
  const scored = watchlist.filter((a) => a.score);
  const avg = scored.length ? (scored.reduce((n, a) => n + a.score, 0) / scored.length).toFixed(1) : '-';
  const counts = Object.keys(LABELS).map((k) => ({ k, n: watchlist.filter((a) => a.status === k).length }));
  const done = counts.find((c) => c.k === 'COMPLETED').n;
  const rate = total ? Math.round((done / total) * 100) : 0;
  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, 5);

  const Card = ({ label, value }) => (
    <div className="p-5 rounded-2xl border border-slate-700/50 bg-slate-800/50">
      <div className="text-slate-400 text-sm">{label}</div>
      <div className="text-2xl font-bold text-white">{value}</div>
    </div>
  );

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold text-white">Stats</h1>
      {total === 0 ? (
        <div className="text-center py-20 text-slate-400 bg-slate-800/30 rounded-2xl border border-slate-800">Nothing to count yet.</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card label="Titles" value={total} />
            <Card label="Episodes watched" value={eps} />
            <Card label="Time watched (est.)" value={`~${hours} h`} />
            <Card label="Average score" value={avg} />
          </div>
          <div className="bg-slate-800/30 border border-slate-700/50 p-6 rounded-2xl space-y-3">
            <h2 className="text-xl font-bold text-white">By status <span className="text-sm font-normal text-slate-400">({rate}% completed)</span></h2>
            {counts.map(({ k, n }) => (
              <div key={k} className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0 text-slate-400">{LABELS[k]}</span>
                <div className="flex-1 h-2.5 rounded-full bg-slate-800 overflow-hidden">
                  <div className={`h-full ${COLORS[k]}`} style={{ width: `${(n / total) * 100}%` }} />
                </div>
                <span className="w-8 text-right text-slate-300">{n}</span>
              </div>
            ))}
          </div>
          {top.length > 0 && (
            <div className="bg-slate-800/30 border border-slate-700/50 p-6 rounded-2xl">
              <h2 className="text-xl font-bold text-white mb-3">Top rated</h2>
              <ol className="space-y-2 text-sm">
                {top.map((a) => (
                  <li key={a.id} className="flex justify-between gap-3">
                    <span className="truncate text-slate-200">{a.title?.english || a.title?.romaji}</span>
                    <span className="text-amber-400 font-semibold">{a.score}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </div>
  );
}
