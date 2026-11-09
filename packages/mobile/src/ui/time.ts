const pad = (value: number) => String(value).padStart(2, '0');

/** The local time of the day, as `formatTime` of the terminal: `14:05`. */
export const formatTime = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** How long ago, as `formatAgo` of the terminal: `just now`, `12 min ago`, `3 h ago`, `2 d ago`. */
export function formatAgo(now: Date, at: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}
