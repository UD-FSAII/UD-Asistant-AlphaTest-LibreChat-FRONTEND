import { memo } from 'react';
import { TooltipAnchor } from '@librechat/client';
import { useGetStorageUsage } from '~/data-provider/Files/queries';

const MB = 1024 * 1024;

function StorageIndicator() {
  const { data, isLoading, error } = useGetStorageUsage();

  if (!data || !data.limit) {
    return null;
  }

  const pct = Math.min(100, (data.used / data.limit) * 100);

  const r = 7;
  const circumference = 2 * Math.PI * r;
  const displayPct = Math.max(pct, 3);
  const offset = circumference * (1 - displayPct / 100);
  const color = pct >= 90 ? 'stroke-red-500' : pct >= 75 ? 'stroke-amber-500' : 'stroke-gray-400';
  const label = `Storage: ${(data.used / MB).toFixed(1)} MB of ${(data.limit / MB).toFixed(0)} MB used`;

  return (
    <TooltipAnchor
      side="top"
      description={label}
      render={
        <span
          className="inline-flex cursor-help items-center gap-1 px-1 text-xs text-text-secondary"
          role="img"
          aria-label={label}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <circle
              className="stroke-gray-300 dark:stroke-gray-600"
              strokeWidth="2"
              fill="transparent"
              r={r}
              cx="9"
              cy="9"
            />
            <circle
              className={`origin-[50%_50%] -rotate-90 transition-[stroke-dashoffset] ${color}`}
              strokeWidth="2"
              strokeDasharray={`${circumference} ${circumference}`}
              strokeDashoffset={offset}
              fill="transparent"
              r={r}
              cx="9"
              cy="9"
            />
          </svg>
          <span>{Math.round(pct)}%</span>
        </span>
      }
    />
  );
}

export default memo(StorageIndicator);