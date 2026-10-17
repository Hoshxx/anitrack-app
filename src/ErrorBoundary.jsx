import React from 'react';

export default class ErrorBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { console.error('UI crashed:', err); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="min-h-screen bg-slate-900 text-slate-300 flex flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-2xl font-bold text-white">Something broke</h1>
        <p className="text-sm text-slate-400 max-w-xs">Your saved list is safe. Reload to try again.</p>
        <button onClick={() => window.location.reload()} className="px-5 py-2.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-xl font-semibold">Reload</button>
      </div>
    );
  }
}
