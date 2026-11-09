import { useEffect, useState } from 'react';

/** The time of now, again every `everyMs`: the times such as "12 min ago" move on a screen that stays open. */
export function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
