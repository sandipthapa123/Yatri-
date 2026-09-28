import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { APP_NAME } from '@yatri/shared';

import './globals.css';

export const metadata: Metadata = {
  title: `${APP_NAME} Admin`,
  description: 'Operations dashboard for the Yatri ride-sharing platform.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
