'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

interface GuardValue {
  /** True while any guarded action on this page is in flight. */
  busy: boolean;
  guard: <T>(fn: () => Promise<T>, fallback: T) => Promise<T>;
}

const ActionGuardContext = createContext<GuardValue | null>(null);

/**
 * Several independent document/vehicle approve-reject forms share one page,
 * each driven by its own `useActionState`. Firing more than one of their
 * Server Actions concurrently races against `revalidatePath` — the RSC
 * refresh triggered by the first action to resolve can interrupt a second
 * one still in flight, silently dropping its mutation.
 *
 * Disabling sibling buttons via the `busy` state alone isn't quite enough:
 * React's state update and the DOM's `disabled` attribute lag one render
 * behind, so two clicks fired within that window can both slip through. The
 * `lockRef` check is synchronous — it runs before any `await`, in the same
 * tick as the call — so it can't be raced the same way.
 */
export function ActionGuardProvider({ children }: { children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const lockRef = useRef(false);

  const guard = useCallback(async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    if (lockRef.current) return fallback;
    lockRef.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      lockRef.current = false;
      setBusy(false);
    }
  }, []);

  return (
    <ActionGuardContext.Provider value={{ busy, guard }}>{children}</ActionGuardContext.Provider>
  );
}

export function useActionGuard(): GuardValue {
  const ctx = useContext(ActionGuardContext);
  if (!ctx) throw new Error('useActionGuard must be used within an ActionGuardProvider');
  return ctx;
}
