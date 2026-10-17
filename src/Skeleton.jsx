import React from 'react';

export const Shimmer = ({ className = '' }) => (
  <div aria-hidden="true" className={`animate-pulse bg-slate-800 rounded-lg ${className}`} />
);

export const CoverGridSkeleton = ({ n = 10 }) => (
  <div role="status" aria-label="Loading" className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3 lg:gap-4">
    {Array.from({ length: n }, (_, i) => <Shimmer key={i} className="aspect-[3/4] rounded-xl" />)}
  </div>
);

export const RowsSkeleton = ({ n = 4 }) => (
  <div role="status" aria-label="Loading" className="space-y-3">
    {Array.from({ length: n }, (_, i) => (
      <div key={i} className="flex items-center gap-3">
        <Shimmer className="h-16 w-12 shrink-0" />
        <div className="flex-1 space-y-2"><Shimmer className="h-4 w-2/3" /><Shimmer className="h-3 w-1/3" /></div>
      </div>
    ))}
  </div>
);
