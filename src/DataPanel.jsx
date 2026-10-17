import React, { useRef, useState } from 'react';
import { X, Download, Upload, Copy, Undo2, ShieldCheck } from 'lucide-react';
import { alertsSupported } from './notifications.js';
import { THEMES, ACCENTS, getTheme, getAccent, setTheme, setAccent } from './theme.js';
import { exportBackup, copyBackupToClipboard, parseBackup, loadPreviousSnapshot } from './storage.js';

export default function DataPanel({ watchlist, lastBackupAt, alertsOn, onToggleAlerts, layout, onLayout, onMerge, onReplace, onClose }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { type: 'ok' | 'err', text }
  const [theme, setThemeState] = useState(getTheme);
  const [accent, setAccentState] = useState(getAccent);
  const [pending, setPending] = useState(null); // parsed import awaiting merge/replace choice

  const run = async (fn) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      // Closing the share sheet rejects on some devices; that is not an error.
      if (!/cancel|dismiss/i.test(e?.message || '')) {
        setMsg({ type: 'err', text: e?.message || 'Something went wrong.' });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleExport = () =>
    run(async () => {
      const name = await exportBackup(watchlist);
      setMsg({ type: 'ok', text: `Backup ready: ${name}` });
    });

  const handleCopy = () =>
    run(async () => {
      await copyBackupToClipboard(watchlist);
      setMsg({ type: 'ok', text: 'Backup copied to clipboard.' });
    });

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    run(async () => {
      const items = parseBackup(await file.text());
      setPending(items);
    });
  };

  const applyImport = (mode) =>
    run(async () => {
      const result = mode === 'merge' ? await onMerge(pending) : await onReplace(pending);
      setMsg({ type: 'ok', text: result });
      setPending(null);
    });

  const handleUndo = () =>
    run(async () => {
      const prev = await loadPreviousSnapshot();
      if (!prev) throw new Error('Nothing to undo.');
      setMsg({ type: 'ok', text: await onReplace(prev) });
    });

  const lastText = lastBackupAt
    ? `Last backup: ${new Date(lastBackupAt).toLocaleDateString()}`
    : 'You have not made a backup yet.';

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings and backup"
        className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <ShieldCheck size={20} className="text-indigo-400" /> Settings &amp; Backup
          </h2>
          <button onClick={onClose} aria-label="Close" className="p-2 text-slate-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <p className="text-sm text-slate-400">
          {watchlist.length} anime saved. {lastText} Save a backup somewhere safe (Drive, email to yourself)
          so a reinstall or phone change never loses your list.
        </p>

        <div className="space-y-3 bg-slate-800 rounded-xl p-4">
          <div className="text-sm font-semibold text-white">Appearance</div>
          <div role="radiogroup" aria-label="Theme" className="flex rounded-lg bg-slate-900 p-1 gap-1">
            {THEMES.map((t) => (
              <button key={t} role="radio" aria-checked={theme === t}
                onClick={() => { setThemeState(t); setTheme(t); }}
                className={`flex-1 py-1.5 rounded-md text-sm capitalize ${theme === t ? 'bg-indigo-500 text-white' : 'text-slate-400 hover:text-white'}`}>
                {t}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400">Accent</span>
            {ACCENTS.map((a) => (
              <button key={a.id} aria-label={a.label} aria-pressed={accent === a.id}
                onClick={() => { setAccentState(a.id); setAccent(a.id); }}
                style={{ background: a.swatch }}
                className={`h-7 w-7 rounded-full border-2 ${accent === a.id ? 'border-slate-100' : 'border-transparent'}`} />
            ))}
          </div>
        </div>

        <div className="bg-slate-800 rounded-xl p-4 space-y-2">
          <div className="text-sm font-semibold text-white">List layout</div>
          <div role="radiogroup" aria-label="List layout" className="flex rounded-lg bg-slate-900 p-1 gap-1">
            {[['grid', 'Posters'], ['compact', 'Compact']].map(([v, l]) => (
              <button key={v} role="radio" aria-checked={layout === v} onClick={() => onLayout(v)}
                className={`flex-1 py-1.5 rounded-md text-sm ${layout === v ? 'bg-indigo-500 text-white' : 'text-slate-400 hover:text-white'}`}>{l}</button>
            ))}
          </div>
        </div>

        {alertsSupported && (
          <label className="flex items-center justify-between gap-3 bg-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200">
            <span>Episode alerts<span className="block text-xs text-slate-400">Notify when shows you are watching air</span></span>
            <input type="checkbox" className="h-5 w-5 accent-indigo-500" checked={!!alertsOn}
              onChange={async (e) => { const r = await onToggleAlerts(e.target.checked); if (r) setMsg({ type: 'err', text: r }); }} />
          </label>
        )}

        {!pending ? (
          <div className="space-y-2">
            <button disabled={busy} onClick={handleExport} className="w-full flex items-center justify-center gap-2 py-3 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white rounded-xl font-semibold">
              <Download size={18} /> Export backup file
            </button>
            <button disabled={busy} onClick={() => fileRef.current?.click()} className="w-full flex items-center justify-center gap-2 py-3 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 rounded-xl font-semibold">
              <Upload size={18} /> Import backup file
            </button>
            <div className="flex gap-2">
              <button disabled={busy} onClick={handleCopy} className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 rounded-xl text-sm">
                <Copy size={16} /> Copy to clipboard
              </button>
              <button disabled={busy} onClick={handleUndo} className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 rounded-xl text-sm">
                <Undo2 size={16} /> Undo last import
              </button>
            </div>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={handleFile} />
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-slate-200">
              Found <b>{pending.length}</b> anime in that file. How should they be imported?
            </p>
            <button disabled={busy} onClick={() => applyImport('merge')} className="w-full py-3 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white rounded-xl font-semibold">
              Merge with my list (keeps the furthest progress)
            </button>
            <button disabled={busy} onClick={() => applyImport('replace')} className="w-full py-3 bg-rose-500/20 hover:bg-rose-500/30 disabled:opacity-50 text-rose-300 rounded-xl font-semibold">
              Replace my list
            </button>
            <button disabled={busy} onClick={() => setPending(null)} className="w-full py-2 text-slate-400 hover:text-white text-sm">
              Cancel
            </button>
          </div>
        )}

        {msg && (
          <div role="status" className={`text-sm rounded-lg px-3 py-2 ${msg.type === 'ok' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>
            {msg.text}
          </div>
        )}
      </div>
    </div>
  );
}
