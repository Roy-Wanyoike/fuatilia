'use strict';

/**
 * TypeScript bridge for the Next dev server (e2e harness only).
 *
 * WHY THIS EXISTS: the repo pins typescript@7 (the native "typescript-go"
 * package). Its module surface exports only a version reporter — it does
 * NOT ship `lib/typescript.js`, the classic compiler API that Next 15.5's
 * dev-server TypeScript verification hard-requires
 * (next/dist/lib/verify-typescript-setup.js → has-necessary-dependencies).
 * Without a bridge, `next dev` marks TypeScript "missing", tries to
 * auto-install it, and crashes — the dev server has never been able to run
 * against this repository.
 *
 * The e2e harness provisions a pinned TS5 compiler (see dev-server.mjs) and
 * sets FUATILIA_E2E_TS5_ROOT; this preload (loaded via NODE_OPTIONS=--require
 * before Next boots) redirects ONLY the two specifiers Next's verification
 * resolves — `typescript/package.json` and `typescript/lib/typescript.js` —
 * into that provisioned package. Nothing else changes: the repository's own
 * `tsc --noEmit` gate keeps running the repo's TS7; no production or
 * config file is touched. Without FUATILIA_E2E_TS5_ROOT this file is a no-op.
 */

const Module = require('node:module');
const path = require('node:path');

const ts5Root = process.env.FUATILIA_E2E_TS5_ROOT;

if (typeof ts5Root === 'string' && ts5Root.length > 0) {
  const realTypescriptLib = path.join(ts5Root, 'lib', 'typescript.js');
  const realTypescriptPkg = path.join(ts5Root, 'package.json');

  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function patchedResolveFilename(request, ...rest) {
    if (request === 'typescript/lib/typescript.js') {
      return originalResolveFilename.call(this, realTypescriptLib, ...rest);
    }
    if (request === 'typescript/package.json') {
      return originalResolveFilename.call(this, realTypescriptPkg, ...rest);
    }
    return originalResolveFilename.call(this, request, ...rest);
  };
}
