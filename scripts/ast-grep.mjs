#!/usr/bin/env node
/*
 * Resolve and exec the real ast-grep binary.
 *
 * Why this wrapper exists: pnpm generates a `.bin/ast-grep` cmd-shim that wraps
 * the file with `node`, but @ast-grep/cli's `bin` target IS a native ELF/exe
 * (its postinstall copies the platform binary over the placeholder). The shim
 * therefore tries to run a binary as a JS module and crashes. We bypass the
 * shim by resolving the package's own binary path and exec'ing it directly.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

function resolveBinary() {
  // The @ast-grep/cli package directory; its `ast-grep` file is the binary.
  const pkgJson = require.resolve('@ast-grep/cli/package.json');
  const pkgDir = dirname(pkgJson);
  const exe = process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep';
  return join(pkgDir, exe);
}

const binary = resolveBinary();
const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });

if (result.error) {
  console.error(`Failed to run ast-grep at ${binary}:`, result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
