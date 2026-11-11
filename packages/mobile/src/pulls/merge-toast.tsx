import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/** A merge that the phone did: the list shows it in a toast for a few seconds. */
export interface DoneMerge {
  name: string;
  branchDeleted: boolean;
}

const SHOW_MS = 6_000;

const ToastContext = createContext<{ merge?: DoneMerge; show: (merge: DoneMerge) => void }>({ show: () => {} });

export function MergeToastProvider({ children }: { children: ReactNode }) {
  const [merge, setMerge] = useState<DoneMerge>();
  useEffect(() => {
    if (!merge) return;
    const timer = setTimeout(() => setMerge(undefined), SHOW_MS);
    return () => clearTimeout(timer);
  }, [merge]);
  return <ToastContext.Provider value={{ merge, show: setMerge }}>{children}</ToastContext.Provider>;
}

export const useMergeToast = () => useContext(ToastContext);
