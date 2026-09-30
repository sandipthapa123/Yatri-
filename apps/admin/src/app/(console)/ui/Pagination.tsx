import Link from 'next/link';

import { styles } from '../drivers/styles';

/** Previous / next with the current page in words. Works without JavaScript; every link is a real link. */
export function Pagination(props: {
  page: number;
  pageSize: number;
  total: number;
  href: (page: number) => string;
}) {
  const totalPages = Math.max(1, Math.ceil(props.total / props.pageSize));
  if (totalPages <= 1) return null;
  return (
    <nav style={styles.pagination} aria-label="Pagination">
      {props.page > 1 ? (
        <Link href={props.href(props.page - 1)}>Previous</Link>
      ) : (
        <span aria-hidden="true">Previous</span>
      )}
      <span aria-current="page">
        Page {props.page} of {totalPages}
      </span>
      {props.page < totalPages ? (
        <Link href={props.href(props.page + 1)}>Next</Link>
      ) : (
        <span aria-hidden="true">Next</span>
      )}
    </nav>
  );
}

/** Build a URL that keeps the current filters. Empty values are dropped. */
export function withParams(path: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}
