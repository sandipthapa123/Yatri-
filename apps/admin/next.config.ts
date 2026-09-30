import path from 'node:path';

import type { NextConfig } from 'next';

/**
 * Response headers for every admin page: it may not be framed (clickjacking), it sends no referrer
 * to other sites, it declines browser features it never uses, and the browser is told to keep using
 * https. (A full script/style CSP is deliberately not set here: Next injects inline scripts, and a
 * CSP that has not been exercised in a real browser would break sign-in. Add one with nonces when a
 * browser test exists.)
 */
const securityHeaders = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@yatri/shared', '@yatri/types'],
  // A self-contained server for the container image (see deploy/Dockerfile.admin); the workspace
  // root is where its packages live.
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
