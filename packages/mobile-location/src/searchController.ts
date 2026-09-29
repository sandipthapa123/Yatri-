/**
 * Framework-free search orchestration: debouncing, superseding in-flight
 * requests (cancellation), and a small in-memory cache — so typing "thamel"
 * costs one provider call, not six. Kept separate from React so it is unit
 * testable and reusable by both apps.
 */
export interface SearchControllerOptions<T> {
  fetcher: (query: string, signal: AbortSignal) => Promise<T[]>;
  onState: (state: SearchState<T>) => void;
  debounceMs?: number;
  minChars?: number;
  cacheSize?: number;
}

export type SearchState<T> =
  | { status: 'idle' }
  | { status: 'too-short'; minChars: number }
  | { status: 'loading'; query: string }
  | { status: 'success'; query: string; results: T[] }
  | { status: 'error'; query: string; error: unknown };

export class SearchController<T> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private readonly cache = new Map<string, T[]>();
  private latest = 0;
  private readonly debounceMs: number;
  private readonly minChars: number;
  private readonly cacheSize: number;

  constructor(private readonly opts: SearchControllerOptions<T>) {
    this.debounceMs = opts.debounceMs ?? 350;
    this.minChars = opts.minChars ?? 2;
    this.cacheSize = opts.cacheSize ?? 30;
  }

  /** Call on every keystroke. */
  setQuery(raw: string): void {
    this.cancelPending();
    const query = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
    if ([...query].length === 0) return this.opts.onState({ status: 'idle' });
    if ([...query].length < this.minChars) {
      return this.opts.onState({ status: 'too-short', minChars: this.minChars });
    }
    const cached = this.cache.get(query.toLowerCase());
    if (cached) return this.opts.onState({ status: 'success', query, results: cached });

    this.opts.onState({ status: 'loading', query });
    this.timer = setTimeout(() => void this.run(query), this.debounceMs);
  }

  /** Run immediately (e.g. the user pressed the search key), skipping the debounce. */
  searchNow(raw: string): void {
    this.cancelPending();
    const query = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
    if ([...query].length < this.minChars) return this.setQuery(raw);
    const cached = this.cache.get(query.toLowerCase());
    if (cached) return this.opts.onState({ status: 'success', query, results: cached });
    this.opts.onState({ status: 'loading', query });
    void this.run(query);
  }

  dispose(): void {
    this.cancelPending();
  }

  private cancelPending() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
    this.latest++;
  }

  private async run(query: string) {
    const ticket = ++this.latest;
    const abort = new AbortController();
    this.abort = abort;
    try {
      const results = await this.opts.fetcher(query, abort.signal);
      if (ticket !== this.latest) return; // superseded
      this.remember(query.toLowerCase(), results);
      this.opts.onState({ status: 'success', query, results });
    } catch (error) {
      if (ticket !== this.latest || abort.signal.aborted) return; // cancelled, not an error
      this.opts.onState({ status: 'error', query, error });
    }
  }

  private remember(key: string, results: T[]) {
    this.cache.delete(key);
    this.cache.set(key, results);
    if (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}
