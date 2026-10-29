/** @type {import('next').NextConfig} */
const nextConfig = {
  trailingSlash: false,
  deploymentId: 'next-dev',
  poweredByHeader: false,
  transpilePackages: ['@hiden/html-cache'],
};

export default nextConfig;
