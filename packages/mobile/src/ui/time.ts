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

/** A duration, as `formatDuration` of the terminal out of watch mode: `12 min`, `1 h 5 min`. */
export function formatDuration(ms: number): string {
  const minutes = Math.ceil(Math.max(0, Math.round(ms / 1000)) / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

/** How long ago, short, as the rows of the app write it: `now`, `42m`, `3h`, `2d`. */
export function shortAgo(now: Date, at: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** True if `a` and `b` fall on the same day of the phone. */
export const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
