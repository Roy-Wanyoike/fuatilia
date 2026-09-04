/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This lane ships without an ESLint config on purpose (foundation scope);
  // correctness is gated by `tsc --noEmit` + vitest, run in CI-equivalent local gates.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
