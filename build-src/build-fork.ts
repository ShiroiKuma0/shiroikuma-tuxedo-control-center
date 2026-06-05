/*!
 * Fork build helper — 白い熊 TUXEDO Control Center.
 *
 * The .deb analogue of the Android forks' `buildFoss` Gradle task:
 *   1. set the fork version `<upstreamVersion>+<N>` into BOTH package.json files,
 *   2. production build (app + service + native lib),
 *   3. package the replace-mode .deb,
 *   4. restore the package.json files to the clean upstream version,
 *   5. copy the .deb to ~/tmp and bump the fork build number.
 *
 * Run via `npm run pack-fork` (which is `tsx ./build-src/build-fork.ts`), so the
 * working directory is the repo root.
 *
 * Three versions must all be equal, or the GUI's tccd-version-check (e-app/.../initMain.ts)
 * restart-loops (it re-spawns itself with an extra --tray every 5 s when
 * `tccdVersion !== app.getVersion()`):
 *   - tccd daemon  -> from `src/package.json` `version` (pkg bakes it into the binary; reported
 *                     on D-Bus). So we stamp `src/package.json` to <base>+<N>.
 *   - Electron app (`app.getVersion()`) AND the .deb `Version` field -> from electron-builder's
 *     `extraMetadata.version`, set via the TCC_FORK_VERSION env (see electron-builder.ts).
 *     IMPORTANT: electron-builder STRIPS semver build-metadata (the `+N`) from a plain
 *     package.json `version`, so `+N` must be injected through extraMetadata, not the field.
 * Root package.json is stamped too (harmless/consistency), but extraMetadata is what actually
 * carries `+N` into the app and the package. The stamping is transient: package.json `version`
 * tracks clean upstream in git; the +N only exists during the build and is restored in `finally`.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = process.cwd();
const rootPkgPath = path.join(repoRoot, 'package.json');
const srcPkgPath = path.join(repoRoot, 'src', 'package.json');
const buildNumberPath = path.join(repoRoot, 'build-src', 'fork-build-number');
const packagesDir = path.join(repoRoot, 'dist', 'packages');
const tmpDir = path.join(os.homedir(), 'tmp');

const rootPkgRaw = fs.readFileSync(rootPkgPath, 'utf8');
const srcPkgRaw = fs.readFileSync(srcPkgPath, 'utf8');
const baseVersion: string = JSON.parse(rootPkgRaw).version;

const n = parseInt(fs.readFileSync(buildNumberPath, 'utf8').trim(), 10);
if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid fork build number in ${buildNumberPath}`);
}
const forkVersion = `${baseVersion}+${n}`;

// Replace only the top-level "version" field (first match), preserving formatting.
function withVersion(raw: string, version: string): string {
    return raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
}

let restored = false;
function restorePackageJson(): void {
    if (restored) {
        return;
    }
    fs.writeFileSync(rootPkgPath, rootPkgRaw);
    fs.writeFileSync(srcPkgPath, srcPkgRaw);
    restored = true;
}
// Safety net so a crash/Ctrl-C never leaves the tree with a +N version.
process.on('exit', restorePackageJson);
process.on('SIGINT', (): void => {
    restorePackageJson();
    process.exit(1);
});

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): void {
    console.log(`\x1b[36m> ${cmd} ${args.join(' ')}\x1b[0m`);
    execFileSync(cmd, args, { cwd: repoRoot, stdio: 'inherit', env: { ...process.env, ...env } });
}

console.log(`\x1b[35mFork build ${forkVersion} (upstream ${baseVersion}, fork #${n})\x1b[0m`);

try {
    // 1. Stamp the fork version into both package.json files.
    fs.writeFileSync(rootPkgPath, withVersion(rootPkgRaw, forkVersion));
    fs.writeFileSync(srcPkgPath, withVersion(srcPkgRaw, forkVersion));

    // 2. Production build (app + service + native lib).
    run('npm', ['run', 'build-prod']);

    // 3. Package the replace-mode .deb. TCC_FORK_VERSION → electron-builder extraMetadata
    //    so the +N survives in the deb Version and app.getVersion() (electron-builder would
    //    otherwise strip semver build-metadata from a plain package.json version).
    run('npm', ['run', 'electron-builder', '--', 'deb'], { TCC_FORK_VERSION: forkVersion });
} finally {
    // 4. Always restore clean upstream version in git.
    restorePackageJson();
}

// 5. Copy the produced .deb to ~/tmp.
const debs = fs
    .readdirSync(packagesDir)
    .filter((f) => f.endsWith('.deb'))
    .map((f) => ({ f, t: fs.statSync(path.join(packagesDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
if (debs.length === 0) {
    throw new Error(`No .deb produced in ${packagesDir}`);
}
const debName = debs[0].f;
fs.mkdirSync(tmpDir, { recursive: true });
const dest = path.join(tmpDir, debName);
fs.copyFileSync(path.join(packagesDir, debName), dest);

// 6. Bump the fork build number for next time.
fs.writeFileSync(buildNumberPath, `${n + 1}\n`);

console.log(`>>> ${dest}`);
console.log(`>>> deb version ${forkVersion}`);
console.log(`>>> next fork build number ${n + 1}`);
