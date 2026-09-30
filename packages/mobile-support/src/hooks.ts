import { useCallback, useEffect, useRef, useState } from 'react';

/** A spoken message: a new id each time, so the same sentence can be read twice. */
export interface News {
  id: number;
  text: string;
}

export function useNews(): [News | null, (text: string | null) => void] {
  const [news, setNews] = useState<News | null>(null);
  const counter = useRef(0);
  const say = useCallback((text: string | null) => {
    setNews(text ? { id: ++counter.current, text } : null);
  }, []);
  return [news, say];
}

/**
 * Load something on mount and again every `everyMs` while the screen is open (and when `reload` is called).
 * The timer and any answer that arrives after the screen is gone are cleaned up, so nothing updates an
 * unmounted screen and nothing keeps polling.
 */
export function usePolled<T>(
  load: () => Promise<T>,
  everyMs: number | null,
  onData?: (next: T, previous: T | null) => void,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef<T | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const next = await loadRef.current();
      if (!alive.current) return;
      const previous = latest.current;
      latest.current = next;
      setData(next);
      setError(null);
      onDataRef.current?.(next, previous);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    const timer = everyMs ? setInterval(() => void reload(), everyMs) : null;
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
    };
  }, [reload, everyMs]);

  return { data, error, loading, reload };
}
