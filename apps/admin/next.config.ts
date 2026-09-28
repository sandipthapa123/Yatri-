import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@yatri/shared', '@yatri/types'],
};

export default nextConfig;
