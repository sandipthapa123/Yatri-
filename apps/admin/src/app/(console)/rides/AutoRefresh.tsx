'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';

/**
 * Keeps a live view current by re-rendering the server page. Because content that changes by
 * itself is a barrier for some people, it is switchable (WCAG 2.2.2) and quiet: it never moves
 * focus and never announces; the "Updated at" line is plain text, not a live region.
 */
export function AutoRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  const id = useId();
  const [on, setOn] = useState(true);
  const [at, setAt] = useState<string | null>(null);

  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => {
      router.refresh();
      setAt(new Date().toLocaleTimeString());
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [on, seconds, router]);

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 14 }}>
      <input id={id} type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
      <label htmlFor={id}>Refresh every {seconds} seconds</label>
      {at ? <span style={{ color: 'var(--color-text-secondary)' }}>Updated at {at}</span> : null}
    </div>
  );
}
