import Link from 'next/link';
import type { CSSProperties } from 'react';

/** A column header that sorts by that column: a real link, with the sort state announced. */
export function SortableTh(props: {
  label: string;
  sortKey: string;
  current: string;
  href: (sort: string) => string;
  style?: CSSProperties;
}) {
  const active = props.current === props.sortKey;
  return (
    <th scope="col" style={props.style}>
      <Link href={props.href(props.sortKey)}>
        {props.label}
        {active ? ' (sorted)' : ''}
      </Link>
    </th>
  );
}
