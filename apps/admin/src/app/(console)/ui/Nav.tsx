'use client';

import { holdsPermission, type AdminPermission } from '@yatri/types';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { NAV } from '../../../lib/nav';

/** The main menu. The current page is marked in text and underline (`aria-current`), not only colour. */
export function Nav({ permissions }: { permissions: AdminPermission[] }) {
  const path = usePathname();
  const isCurrent = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  return (
    <nav className="console-nav" aria-label="Main">
      <ul>
        {NAV.filter((n) => holdsPermission(permissions, n.permission)).map((n) => (
          <li key={n.href}>
            <Link href={n.href} aria-current={isCurrent(n.href) ? 'page' : undefined}>
              {n.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
