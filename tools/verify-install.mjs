// ─── CI install parity check ──────────────────────────────────────────────────
//
//   npm run verify:install
//
// Answers one question that a normal local `npm ci` cannot: **would CI's npm
// accept this lockfile?**
//
// Why this exists. On a sibling project (monopoly-forge, 2026-08-01) `npm ci`
// was verified locally with npm 11 and passed, then every CI job failed at
// `npm ci` with "Missing: esbuild@0.28.1 from lock file" (27 packages in all).
// What happened there:
//
//   • vitest 4 requires vite ^6 || ^7 || ^8; the project pinned vite ^5.
//   • npm 11 resolved that by installing a *nested* vite 8 under vitest — so the
//     app built with vite 5 while the tests ran on vite 8.
//   • npm 11 then wrote a lockfile that recorded the nested vite but **not** its
//     own esbuild 0.28.1 subtree.
//   • npm 11 reinstalls happily from its own incomplete lockfile. npm 10 — the
//     npm bundled with Node 22, and therefore the npm on the runners —
//     recomputes the tree, finds those 27 packages absent, and refuses.
//
// Two lessons are baked into the checks below: a lockfile is only proven by the
// npm version that will consume it, and a second major of a build-critical
// package is the smell that precedes the broken lockfile.
//
//   1. `npm ci --dry-run` under CI's npm — does package.json agree with
//      package-lock.json? This is the check that failed there, and it is
//      non-destructive: node_modules is left alone.
//   2. `npm ls --all` — any "invalid" or "missing" edges in the installed tree.
//      (It did *not* catch the bug above: the installed tree was fine, only the
//      lockfile was incomplete. Cheap and worth keeping regardless.)
//   3. Duplicate majors of a directly-declared dependency — the root cause
//      itself, visible before any lockfile is written.
//
// Run it before pushing whenever package.json or package-lock.json changes.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Deliberately outside the repo: npm walks *upwards* looking for a package.json,
// so installing into a directory under ./node_modules makes it target the
// project root instead. It also survives `npm ci`, which wipes node_modules.
const CACHE = path.join(os.tmpdir(), 'gravity-simulator-verify-install');

// Used only when nodejs.org cannot be reached. Keep roughly in step with the
// npm bundled by the Node major in .nvmrc.
const FALLBACK_NPM = '10.9.8';

const ok = (m) => console.log(`  [32m✓[0m ${m}`);
const bad = (m) => console.log(`  [31m✗[0m ${m}`);
const info = (m) => console.log(`    ${m}`);

function nodeMajor() {
  const f = path.join(ROOT, '.nvmrc');
  if (existsSync(f)) {
    const m = readFileSync(f, 'utf8').trim().replace(/^v/, '').split('.')[0];
    if (/^\d+$/.test(m)) return m;
  }
  return '22';
}

/** The npm version bundled with the newest release of that Node major. */
async function ciNpmVersion(major) {
  try {
    const res = await fetch('https://nodejs.org/dist/index.json', {
      signal: AbortSignal.timeout(10_000),
    });
    const releases = await res.json();
    const hit = releases.find((r) => r.version.startsWith(`v${major}.`) && r.npm);
    if (hit) return { version: hit.npm, node: hit.version, source: 'nodejs.org' };
  } catch {
    /* offline — fall through */
  }
  return { version: FALLBACK_NPM, node: `v${major}.x`, source: 'offline fallback' };
}

/** Install that npm into a local cache dir and return its CLI path. */
function ensureNpm(version) {
  const dir = path.join(CACHE, `npm-${version}`);
  const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) return cli;

  mkdirSync(dir, { recursive: true });
  info(`fetching npm@${version} (one-off, cached in ${CACHE})…`);
  execFileSync(
    process.execPath,
    [
      process.env.npm_execpath ?? 'npm', 'install',
      '--prefix', dir, '--no-save', '--no-audit', '--no-fund', '--silent',
      `npm@${version}`,
    ],
    { cwd: dir, stdio: 'inherit' },
  );
  if (!existsSync(cli)) throw new Error(`npm@${version} did not install as expected`);
  return cli;
}

function runNpm(cli, args) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (err) {
    return {
      code: err.status ?? 1,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    };
  }
}

const main = async () => {
  const major = nodeMajor();
  const { version, node, source } = await ciNpmVersion(major);

  console.log('▶ CI install parity check');
  info(`.nvmrc      Node ${major}  →  CI resolves ${node}`);
  info(`CI npm      ${version}  (${source})`);
  info(`local npm   ${process.env.npm_config_user_agent?.match(/npm\/(\S+)/)?.[1] ?? 'unknown'}`);
  console.log('');

  const cli = ensureNpm(version);
  let failed = false;

  // ── 1. Lockfile / package.json agreement, as CI's npm sees it ───────────────
  const ci = runNpm(cli, ['ci', '--dry-run', '--no-audit', '--no-fund']);
  if (ci.code === 0) {
    ok(`npm@${version} accepts package-lock.json`);
  } else {
    failed = true;
    bad(`npm@${version} rejects package-lock.json — CI will fail at "npm ci"`);
    const missing = [...ci.out.matchAll(/Missing: (\S+) from lock file/g)].map((m) => m[1]);
    const invalid = [...ci.out.matchAll(/Invalid: (.+)/g)].map((m) => m[1].trim());
    if (missing.length) {
      info(`missing from lock file (${missing.length}): ${missing.slice(0, 6).join(', ')}` +
        (missing.length > 6 ? ', …' : ''));
    }
    if (invalid.length) info(`invalid: ${invalid.slice(0, 4).join('; ')}`);
    if (!missing.length && !invalid.length) {
      info(ci.out.split('\n').filter(Boolean).slice(0, 6).join('\n    '));
    }
    console.log('');
    info('Fix: delete node_modules and package-lock.json, reinstall, and make sure');
    info('every dependency range is mutually satisfiable (see check 2 below).');
  }

  // ── 2. Is the installed tree internally consistent? ─────────────────────────
  if (!existsSync(path.join(ROOT, 'node_modules'))) {
    info('node_modules missing — skipping tree check (run npm ci first)');
  } else {
    const ls = runNpm(cli, ['ls', '--all', '--json']);
    let tree = null;
    try {
      tree = JSON.parse(ls.out);
    } catch {
      /* npm ls can emit non-JSON on catastrophic failure */
    }

    const problems = [];
    const walk = (node, trail) => {
      for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
        if (dep.missing) problems.push(`missing  ${name}@${dep.required ?? '?'} (required by ${trail})`);
        else if (dep.invalid) problems.push(`invalid  ${name}@${dep.version} (${trail} wants ${dep.invalid})`);
        if (dep.dependencies) walk(dep, name);
      }
    };
    if (tree) walk(tree, tree.name ?? 'root');
    for (const p of tree?.problems ?? []) {
      if (!/^extraneous/.test(p)) problems.push(p.replace(/\n/g, ' '));
    }

    const unique = [...new Set(problems)];
    if (unique.length === 0) {
      ok('dependency tree is internally consistent (no invalid or missing edges)');
    } else {
      failed = true;
      bad(`${unique.length} dependency problem(s) — a version range is not satisfiable`);
      for (const p of unique.slice(0, 10)) info(p);
      if (unique.length > 10) info(`… and ${unique.length - 10} more`);
    }
  }

  // ── 3. A declared dependency installed at two different majors ─────────────
  // vitest pulling in its own vite major is what forced the nested subtree that
  // npm 11 then failed to record in the lockfile. Catch that cause directly.
  if (existsSync(path.join(ROOT, 'node_modules'))) {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);

    const found = new Map(); // name -> Map(version -> location)
    const scan = (dir, depth) => {
      if (depth > 6 || !existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === '.bin' || entry.name === '.cache') continue;
        const full = path.join(dir, entry.name);
        if (entry.name.startsWith('@')) {
          scan(full, depth); // scope directory, not a package itself
          continue;
        }
        try {
          const { name, version } = JSON.parse(readFileSync(path.join(full, 'package.json'), 'utf8'));
          if (name && version && declared.has(name)) {
            if (!found.has(name)) found.set(name, new Map());
            found.get(name).set(version, path.relative(ROOT, full));
          }
        } catch { /* no/!readable manifest — not a package dir */ }
        scan(path.join(full, 'node_modules'), depth + 1);
      }
    };
    scan(path.join(ROOT, 'node_modules'), 0);

    const split = [...found.entries()].filter(([, versions]) =>
      new Set([...versions.keys()].map((v) => v.split('.')[0])).size > 1);

    if (split.length === 0) {
      ok('no declared dependency is installed at two different majors');
    } else {
      failed = true;
      bad(`${split.length} declared dependency(ies) installed at conflicting majors`);
      for (const [name, versions] of split) {
        info(`${name}:`);
        for (const [v, loc] of versions) info(`    ${v}  at ${loc}`);
      }
      console.log('');
      info('A dev tool wants a different major than package.json pins, so npm nested');
      info('a second copy. Align the ranges rather than letting npm resolve it that way.');
    }
  }

  console.log('');
  if (failed) {
    console.log('[31m✗ verify:install failed — do not push; CI would fail at npm ci[0m');
    process.exit(1);
  }
  console.log('[32m✓ verify:install passed — CI\'s npm accepts this lockfile[0m');
};

main().catch((err) => {
  console.error('✗ verify-install crashed:', err.message);
  process.exit(1);
});
