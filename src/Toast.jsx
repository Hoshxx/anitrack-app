import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);

  const close = useCallback(() => { clearTimeout(timer.current); setToast(null); }, []);
  const show = useCallback((message, onUndo) => {
    clearTimeout(timer.current);
    setToast({ message, onUndo, id: Date.now() });
    timer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <div role="status" aria-live="polite" className="fixed inset-x-0 z-[60] flex justify-center px-4 pointer-events-none"
          style={{ bottom: 'calc(5rem + env(safe-area-inset-bottom, 0px))' }}>
          <div className="pointer-events-auto w-full max-w-sm flex items-center justify-between gap-4 rounded-xl bg-slate-100 text-slate-900 px-4 py-3 text-sm shadow-lg">
            <span className="truncate">{toast.message}</span>
            {toast.onUndo && (
              <button onClick={() => { toast.onUndo(); close(); }} className="shrink-0 font-bold underline">Undo</button>
            )}
          </div>
        </div>
      )}
    </ToastCtx.Provider>
  );
}
