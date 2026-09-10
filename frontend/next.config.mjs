/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Container builds (frontend/Dockerfile, issue #138) set
  // NEXT_OUTPUT=standalone in the build stage to emit the self-contained
  // .next/standalone bundle. Every other build (`next dev`, plain
  // `next build`, CI gates) leaves this undefined — behavior unchanged.
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  // This lane ships without an ESLint config on purpose (foundation scope);
  // correctness is gated by `tsc --noEmit` + vitest, run in CI-equivalent local gates.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
