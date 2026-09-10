'use strict';

/**
 * Dev-server launcher for the Playwright harness (issue #136).
 *
 * `next dev` cannot start against this repository as-is: the repo pins
 * typescript@7 (typescript-go), which does not ship the classic
 * `lib/typescript.js` compiler API that Next 15.5's dev-server TypeScript
 * verification hard-requires — Next marks TypeScript "missing", attempts an
 * auto-install (mutating package.json), then crashes. See next-ts-bridge.cjs.
 *
 * This launcher, test code in the e2e lane:
 *   1. provisions a pinned TS5 compiler ONCE into the git-ignored
 *      e2e/.artifacts/ts5 prefix (the only compiler Next can drive);
 *   2. spawns `next dev` with the TS bridge preloaded (NODE_OPTIONS) so the
 *      dev server's TypeScript verification resolves the provisioned
 *      compiler; the repository's own tsc@7 gate is untouched;
 *   3. forwards stdout/stderr and exit codes so Playwright's webServer
 *      supervision works unchanged.
 *
 * Environment:
 *   PORT            — dev-server port (default 3100; keep in sync with
 *                     playwright.config.ts BASE_URL).
 */

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const frontendDir = path.resolve(__dirname, '..');
const ts5Prefix = path.join(__dirname, '.artifacts', 'ts5');
const ts5Package = path.join(ts5Prefix, 'node_modules', 'typescript', 'lib', 'typescript.js');
const TS5_VERSION = '5.9.3';

function provisionTs5() {
  if (fs.existsSync(ts5Package)) return;
  fs.mkdirSync(ts5Prefix, { recursive: true });
  process.stdout.write(`[e2e dev-server] provisioning typescript@${TS5_VERSION} for the Next dev bridge...\n`);
  execFileSync(
    'npm',
    [
      'install',
      '--prefix',
      ts5Prefix,
      '--no-save',
      '--no-audit',
      '--no-fund',
      `typescript@${TS5_VERSION}`,
    ],
    { stdio: 'inherit', cwd: ts5Prefix },
  );
  if (!fs.existsSync(ts5Package)) {
    throw new Error(`typescript@${TS5_VERSION} provisioning failed (${ts5Package} missing)`);
  }
}

function main() {
  const port = process.env.PORT ?? '3100';
  provisionTs5();

  const nodeOptions = [
    process.env.NODE_OPTIONS ?? '',
    `--require ${path.join(__dirname, 'next-ts-bridge.cjs')}`,
  ]
    .filter((part) => part.trim().length > 0)
    .join(' ');

  const child = spawn(
    process.execPath,
    [
      path.join(frontendDir, 'node_modules', 'next', 'dist', 'bin', 'next'),
      'dev',
      '--port',
      port,
      '--hostname',
      '127.0.0.1',
    ],
    {
      cwd: frontendDir,
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
        FUATILIA_E2E_TS5_ROOT: path.join(ts5Prefix, 'node_modules', 'typescript'),
      },
      stdio: 'inherit',
    },
  );

  child.on('exit', (code, signal) => {
    if (signal !== null) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }
}

main();
