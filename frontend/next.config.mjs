/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the workspace root to this package (#158). The repo intentionally keeps
  // two lockfiles (frontend/ for the web console, repo root for the TS domain
  // core), which makes Next.js infer the ROOT lockfile's directory as the
  // workspace root and print a "multiple lockfiles" warning on every build.
  // The inference only feeds output-file tracing (not module resolution), so it
  // was cosmetic — but pinning it keeps .next/standalone traces rooted at
  // frontend/ and silences the misleading warning. Node 20.11+/22 evaluates
  // import.meta.dirname; older Node degrades to `undefined` (inference).
  outputFileTracingRoot: import.meta.dirname,
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
