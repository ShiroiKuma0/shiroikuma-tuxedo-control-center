# HANDOFF — 白い熊 TUXEDO Control Center (fork of tuxedo-control-center)

Prepared for 白い熊. This is the blueprint we execute together when we "start in it".
Nothing in the repo has been modified or committed yet — this file is the plan plus the
ready-to-drop-in `.claude/` content.

---

## 0. TL;DR

- App name (display): **白い熊 TUXEDO Control Center**
- Package name / install dir: `shiroikuma-tuxedo-control-center` → `/opt/shiroikuma-tuxedo-control-center`
- Fork mode: **Replace upstream** (decided). The `.deb` declares
  `Conflicts/Replaces/Provides: tuxedo-control-center`; apt swaps upstream out. Only one TCC ever runs.
- We **keep** upstream's system singletons: `tccd`/`tccd-sleep` daemon, the
  `com.tuxedocomputers.tccd` D-Bus name, polkit actions, and `/etc/tcc/`. This means the
  remote-control D-Bus surface you originally asked about (CPU temp, fan data, profile switching)
  is unchanged and keeps working over SSH.
- Workflow mirrors the Android forks (`shiroikuma-messeji` etc.): `master` mirrors upstream,
  `custom` is the dev branch, fork build number `+N` resets on each upstream bump.
- Two skills: **`build-deb`** (build the signed `.deb`, then ask before installing) and
  **`upstream-new-version`** (rebase `custom` onto a new upstream release → fresh `+1`).

This is the **first non-Android, Electron/Angular/Node fork** in `~/git/`, so the build/packaging
half is new (npm + electron-builder + `.deb`), but the fork *workflow* is identical to the others.

---

## 1. Repo & branch model

The clone currently has only `origin` (your fork) and the `master` branch. Setup adds the rest.

| | Android forks (e.g. messeji) | This repo |
| --- | --- | --- |
| Mirror branch | `main` | **`master`** (upstream's default) |
| Dev branch | `custom` | **`custom`** (all our work) |
| `origin` | `ShiroiKuma0/shiroikuma-messeji` | `git@github.com:ShiroiKuma0/shiroikuma-tuxedo-control-center` |
| `upstream` | FossifyOrg/Messages | **`https://github.com/tuxedocomputers/tuxedo-control-center.git`** (to be added) |

Upstream uses GitLab tags `v…` mirrored to GitHub; current base is **3.0.6**.

---

## 2. The customization layer (replace mode) — exact edits

Eight files, plus the versioning helper. Everything not listed here stays byte-identical to upstream
(that's the point — keep our diff a small, replayable layer).

**Naming split (important):**
- `productName` = `shiroikuma-tuxedo-control-center` → drives the `/opt` dir, the `.deb` package
  name, and the artifact filename prefix.
- `executableName` = `tuxedo-control-center` (kept) → the binary inside `/opt`, the
  `/usr/bin/tuxedo-control-center` symlink, and `StartupWMClass`. Keeping it avoids churn in the
  desktop files and the after-install symlink, and keeps the `tuxedo-control-center` command working.
- Display label `白い熊 TUXEDO Control Center` lives only in the `.desktop` `Name=` (and optionally
  the window title) — never in `productName` (which must be a filesystem-safe slug).

### 2.1 `package.json` (root only — leave `src/package.json` unmodified)
- Root `"name": "tuxedo-control-center"` → `"name": "shiroikuma-tuxedo-control-center"`.
- **Do not touch `src/package.json`** — electron-builder derives the Electron app name from the
  packaging `productName`, not from `src/package.json`, so renaming it has no effect on the runtime
  name and only adds churn. Runtime identity is pinned in code instead (§2.9). See `CLAUDE.md`
  "Two separate identities".
- Leave `"version"` tracking upstream (`3.0.6`) — the fork `+N` is applied at package time, never
  written into `version` (see §3).
- Add a script (root `package.json`): `"pack-fork": "tsx ./build-src/build-fork.ts"`.

### 2.2 `build-src/electron-builder.ts`
- Add `executableName: 'tuxedo-control-center'` to **both** the deb and rpm `builder.Configuration`
  objects (keeps the binary/symlink/WMClass names). `productName` resolves from `package.json` `name`.
- Add to the deb `fpm` array (next to the existing `tuxedofancontrol` entries):
  `'--conflicts=tuxedo-control-center'`, `'--replaces=tuxedo-control-center'`,
  `'--provides=tuxedo-control-center'`. (Mirror in the rpm `fpm` if we ever ship rpm.)
- Refactor so the deb config is produced by an exported function
  `export function debConfig(version: string, filenameAddition: string): builder.Configuration`
  so `build-fork.ts` can reuse it with an injected fork version (see §3). Keep the CLI entry
  (`deb`/`rpm`/`all`/`fnameadd=`) working as-is for plain upstream-style builds.

### 2.3 `src/common/classes/TccPaths.ts` (3 constants)
Replace the prefix `/opt/tuxedo-control-center/` → `/opt/shiroikuma-tuxedo-control-center/` in:
`TCCD_EXEC_FILE`, `TCCD_PYTHON_CAMERACTRL_FILE`, `V4L2_NAMES_FILE`. **Keep** the inner
`resources/dist/tuxedo-control-center/…` segment (that's the build-output dir name, not the install
dir) and **keep** `PID_FILE`, `SETTINGS_FILE`, `PROFILES_FILE`, `WEBCAM_FILE`, `FANTABLES_FILE`,
`TCCD_LOG_FILE` (the `/etc/tcc`, `/var/log/tccd`, pid — shared, replace mode).

### 2.4 `src/dist-data/tccd.service`
`ExecStart`/`ExecStop`: prefix `/opt/tuxedo-control-center/` → `/opt/shiroikuma-tuxedo-control-center/`
(keep the rest of the path, and keep the unit name `tccd`).

### 2.5 `src/dist-data/tuxedo-control-center.desktop`
- `Name=TUXEDO Control Center` → `Name=白い熊 TUXEDO Control Center`
- `Exec="/opt/tuxedo-control-center/tuxedo-control-center" %U`
  → `Exec="/opt/shiroikuma-tuxedo-control-center/tuxedo-control-center" %U`
- `Icon=/opt/tuxedo-control-center/resources/…` → `…/opt/shiroikuma-tuxedo-control-center/resources/…`
- Keep `StartupWMClass=tuxedo-control-center` (executableName unchanged).

### 2.6 `src/dist-data/tuxedo-control-center-tray.desktop`
- `Name=TUXEDO Control Center` → `Name=白い熊 TUXEDO Control Center`
- `Exec=/opt/tuxedo-control-center/tuxedo-control-center --tray`
  → `Exec=/opt/shiroikuma-tuxedo-control-center/tuxedo-control-center --tray`

### 2.7 `build-src/after_install.sh`
- `DIST_DATA=/opt/tuxedo-control-center/resources/…` → `…/opt/shiroikuma-tuxedo-control-center/resources/…`
- Symlink line: source becomes `/opt/shiroikuma-tuxedo-control-center/tuxedo-control-center`; **keep**
  the link target `/usr/bin/tuxedo-control-center`.
- `chmod 4755 '/opt/tuxedo-control-center/chrome-sandbox'`
  → `'/opt/shiroikuma-tuxedo-control-center/chrome-sandbox'`.
- Everything else (stops TFC, copies the `tccd`/dbus/polkit/udev files, enables `tccd tccd-sleep`)
  stays — replace mode keeps those names.

### 2.8 No change needed
- `src/dist-data/tccd-sleep.service` — only does `systemctl stop/start tccd`, no `/opt` path.
- `build-src/after_remove.sh` — removes fixed paths (`tccd`, dbus conf, `/usr/bin/tuxedo-control-center`,
  `/etc/tcc`) that we keep; no `/opt` reference.
- The dbus/polkit/systemd identifiers (`com.tuxedocomputers.tccd*`, `tccd`) — kept on purpose.

### 2.9 `src/e-app/backendAPIs/initMain.ts` (GUI launch fix)
Because electron-builder names the Electron app after the packaging `productName`
(`shiroikuma-...`), the GUI's single-instance check broke. Two edits:
- Add `app.setName('tuxedo-control-center');` immediately before
  `const applicationLock = app.requestSingleInstanceLock();` — pins the runtime app name (→
  `~/.config/<name>/`, `WM_CLASS`) to upstream.
- In `exitIfProcessExists()`, change the default `singletonLockPath` from the hard-coded
  `'~/.config/tuxedo-control-center/SingletonLock'` to
  `path.join(app.getPath('userData'), 'SingletonLock')` — robust regardless of app name.

Without these, the app logs `initMain: SingletonLock check failed` and calls `app.exit(0)` before
the window opens.

### Customization summary table (the audit checklist for every rebase)

| What | Value | Where |
| --- | --- | --- |
| Package / `productName` | `shiroikuma-tuxedo-control-center` | `package.json` + `src/package.json` `name` |
| Install dir | `/opt/shiroikuma-tuxedo-control-center` | derived from `productName` |
| Binary / command (kept) | `tuxedo-control-center` | `executableName` in `electron-builder.ts` |
| Launcher label | `白い熊 TUXEDO Control Center` | `*.desktop` `Name=` |
| Supersede upstream | `Conflicts/Replaces/Provides: tuxedo-control-center` | deb `fpm` in `electron-builder.ts` |
| `/opt` paths | `…shiroikuma-tuxedo-control-center…` | `TccPaths.ts`, `tccd.service`, `*.desktop`, `after_install.sh` |
| Daemon / D-Bus / config (kept) | `tccd`, `com.tuxedocomputers.tccd`, `/etc/tcc` | unchanged |
| Fork build number | `+N`, resets on upstream bump | `build-src/fork-build-number` |

---

## 3. Versioning & numbering (mirrors messeji, adapted to deb)

- `version` in `package.json`/`src/package.json` **tracks upstream** (e.g. `3.0.6`) and is left clean.
- `build-src/fork-build-number` holds **our** increment `N`, starting at `1`.
- Fork `.deb` `Version` = `<upstreamVersion>+<N>` (e.g. `3.0.6+1`). Debian sorts
  `3.0.6 < 3.0.6+1 < 3.0.6+2 < 3.0.7+1`, so upgrades stay monotonic across upstream bumps
  (the deb analog of messeji's `versionCode` math — no integer arithmetic needed, the string sorts).
- Artifact filename: `shiroikuma-tuxedo-control-center_<upstreamVersion>+<N>_amd64.deb`
  (arch on this machine is `amd64`).
- First build of any upstream line is `+1`; each rebuild-with-changes is `+2`, `+3`, …;
  a new upstream release **resets `N` to `1`**.

> **Implemented note:** `build-src/build-fork.ts` stamps `<base>+<N>` into **both** root and
> `src/package.json` for the build, then restores them (no `extraMetadata`). This keeps `tccd`'s
> reported version == `app.getVersion()` == the `.deb` version — a mismatch makes the GUI restart-loop
> (see `CLAUDE.md` versioning). The contract below is the original sketch; the file is the source of truth.

`build-src/build-fork.ts` is the single entry point — the deb analog of messeji's `buildFoss` task.
Original sketch:
1. `base` = `version` from `package.json`; `N` = `build-src/fork-build-number`.
2. `forkVersion = `${base}+${N}``.
3. Run `npm run build-prod`.
4. Package the deb via `debConfig(forkVersion, '')` (§2.2) — sets deb `Version` = `forkVersion`
   and artifact prefix from `productName`. (Inject the version with electron-builder
   `extraMetadata: { version: forkVersion }`.)
5. Copy the result to `~/tmp/shiroikuma-tuxedo-control-center_<forkVersion>_amd64.deb`.
6. Increment `N` → `N+1` in `build-src/fork-build-number`.
7. Print `>>> <path>` and `>>> deb version <forkVersion>` so the skill can confirm the exact filename.

---

## 4. Build & packaging notes

- Toolchain: **Node 24** + native build deps. Upstream ships `npm run install-build-dep`
  (`nodesource 24`, `autoconf automake build-essential gcc g++ make rpm`). Native bits:
  `node-gyp` (TuxedoIOAPI.node), `@yao-pkg/pkg` (bundles `tccd` as a single binary),
  `electron-builder install-app-deps`, `patch-package` (see `patches/`).
- Native/forked deps to be aware of on a fresh `npm ci`: `dbus-next`, `node-ble`, `usocket`
  are git forks (tuxedoxt/tuxedoder) — they need the build toolchain present.
- Plain build commands (unchanged upstream): `npm run pack-prod` (build + deb + rpm),
  `npm run build-prod`, `npm run start` (run the built app), `npm run tests`, `npm run lint` (biome).
- Our fork build: **`npm run pack-fork`** (build-prod → replace-mode deb at `+N` → copy to `~/tmp`
  → bump `N`). This is what the `build-deb` skill calls.
- Installing the `.deb` is a **separate, asked-for** step: `sudo apt install ~/tmp/<file>.deb`
  (apt pulls deps and runs `after_install.sh`). Never auto-install.

---

## 5. `.claude/` to create (full content below)

### 5.1 `.claude/settings.json`
```json
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Edit(*)",
      "Write(*)",
      "Read(*)",
      "Bash(git commit*)",
      "Bash(git push*)",
      "Bash(git add*)",
      "Bash(git rebase*)",
      "Bash(git checkout*)",
      "Bash(git branch*)",
      "Bash(git merge*)",
      "Bash(git stash*)",
      "Bash(git reset*)",
      "Bash(git fetch*)",
      "Bash(git remote*)"
    ]
  }
}
```

### 5.2 `.claude/settings.local.json`
```json
{
  "permissions": {
    "allow": [
      "Read(//home/shiroikuma/git/**)",
      "Bash(npm ci*)",
      "Bash(npm install*)",
      "Bash(npm run *)",
      "Bash(node *)",
      "Bash(tsx *)",
      "Bash(busctl *)",
      "Bash(systemctl status tccd*)",
      "Bash(sudo apt install *)",
      "WebFetch(domain:raw.githubusercontent.com)"
    ]
  }
}
```

### 5.3 `.claude/skills/build-deb/SKILL.md`
```markdown
---
name: build-deb
description: Build the 白い熊 TUXEDO Control Center .deb with the pack-fork flow, then always ask whether to install it on this machine via apt. Use whenever the user asks to build the app, build the package/.deb, make a release build, or build and install.
---

# Build the fork .deb and optionally install it

## Steps

1. **Note the output filename.** Read the version and fork build number:
   - `grep '"version"' package.json | head -1` and `cat build-src/fork-build-number`
   - The .deb will be `shiroikuma-tuxedo-control-center_<version>+<N>_amd64.deb`, using the `N`
     value **before** the build (build-fork bumps it afterward). deb Version = `<version>+<N>`.

2. **Build:** `npm run pack-fork < /dev/null`
   (the `< /dev/null` guarantees it never blocks on stdin).
   - This runs `build-prod`, packages the replace-mode deb (productName
     `shiroikuma-tuxedo-control-center`, `Conflicts/Replaces/Provides: tuxedo-control-center`),
     copies the .deb to `~/tmp/<name>`, and increments `build-src/fork-build-number`.
   - The task prints `>>> <path>` and `>>> deb version <ver>`; use those to confirm the exact
     filename, and confirm `BUILD SUCCESS`.
   - Prereqs: Node 24 + native toolchain. On a fresh checkout run `npm ci` first (builds the
     forked native deps dbus-next/node-ble/usocket and TuxedoIOAPI.node).

3. **Always ask** (via AskUserQuestion) whether to install the .deb on this machine — every build,
   no assuming. Options: "Yes, install via apt" / "No, just build".

4. **If yes, install directly yourself:**
   - `sudo apt install ~/tmp/<name>.deb` (apt resolves deps and runs after_install.sh: it enables
     and restarts `tccd`/`tccd-sleep` and supersedes any installed upstream `tuxedo-control-center`).
   - Confirm with `systemctl status tccd --no-pager` and `dpkg -l shiroikuma-tuxedo-control-center`.
   - This is the local machine, not a phone — there is no adb. Installing means apt on this host.

## Hard rules (same as the Android forks)

- After implementing a change the user asked for, **always build it** with `pack-fork` **without
  waiting to be asked**, confirm `BUILD SUCCESS`, **then ask** whether to install.
- **Never install on your own.** Only after the user confirms.
- **Never commit or push on your own.** Push goes to `origin` `custom` only on explicit instruction.

## Notes

- The fork keeps upstream's `tccd` daemon and `com.tuxedocomputers.tccd` D-Bus name, so after install
  the remote-control surface (CPU temp / fan data / profile switching over `busctl --system`) works
  unchanged. Aquaris control stays GUI/Bluetooth-only unless we add a CLI path (roadmap).
- Plain (non-fork-numbered) packaging is still `npm run pack-prod` (deb + rpm). We ship the fork deb.
```

### 5.4 `.claude/skills/upstream-new-version/SKILL.md`
```markdown
---
name: upstream-new-version
description: Rebase our fork onto a new upstream release of tuxedocomputers/tuxedo-control-center. Use when the user says a new upstream version is out, asks to update/sync to upstream, bump to the new TCC release, or rebase custom onto the latest upstream.
---

# Rebase the fork onto a new upstream release

Move `master` to the new upstream release, replay our `custom` customizations on top, and produce a
fresh `+1` build.

> **Never `git push` or `git commit` unprompted, and never install the .deb unprompted.** After the
> rebase + build you stop and let the user test; you only `git push` when they explicitly say "Push".

## Background — versioning here

- `version` in `package.json`/`src/package.json` **tracks upstream**, left clean.
- `build-src/fork-build-number` (`N`) is our fork increment; it **resets to 1** on each new upstream
  version. Fork deb `Version` = `<version>+<N>`; artifact
  `shiroikuma-tuxedo-control-center_<version>+<N>_amd64.deb`.

## Steps

1. **Fetch upstream:** `git fetch upstream --tags`. Identify the new release tag
   (`git tag --sort=-creatordate | head`) and confirm its version:
   `git show <tag>:package.json | grep '"version"'`.

2. **Advance `master`** (mirrors upstream): `git checkout master` then
   `git merge --ff-only upstream/master` (or `git reset --hard <tag>` to track an exact tag).

3. **Rebase `custom` onto `master`:** `git checkout custom` then `git rebase master`. Resolve
   conflicts so **all** customizations survive. Conflict-prone files: `package.json`,
   `src/package.json`, `build-src/electron-builder.ts`, `build-src/after_install.sh`,
   `src/common/classes/TccPaths.ts`, `src/dist-data/*.service`, `src/dist-data/*.desktop`.

4. **Set versions:** set `version` in `package.json` and `src/package.json` to the **new upstream**
   value (`npm version <ver> --no-git-tag-version` in root and in `src/`, or `npm run ver -- <ver>`).
   **Reset `build-src/fork-build-number` to `1`.**

5. **Verify our customizations are intact** (the table in `HANDOFF.md` §2):
   package name `shiroikuma-tuxedo-control-center`; install dir
   `/opt/shiroikuma-tuxedo-control-center`; `executableName: 'tuxedo-control-center'`;
   `Conflicts/Replaces/Provides: tuxedo-control-center`; `Name=白い熊 TUXEDO Control Center` in both
   `.desktop` files; `/opt` prefix fixed in `TccPaths.ts`/`tccd.service`/`after_install.sh`; daemon
   and D-Bus names kept as `tccd` / `com.tuxedocomputers.tccd`.
   - If upstream restructured the build (e.g. moved to a `build` block in `package.json`, changed
     `electron-builder.ts`, renamed dist-data files), port our changes to the new structure rather
     than forcing the old diff.
   - If `npm ci` is needed (lockfile/dep changes), run it before building.

6. **Build the new `+1`** via the **build-deb** skill (`npm run pack-fork < /dev/null`), then **ask**
   before any install. This is the first build of the new line (`<newVersion>+1`).

7. **Stop.** Let the user test. Commit/push only on explicit "Push" (rebasing rewrites `custom`
   history, so `git push --force-with-lease origin custom`; `master` is a fast-forward).

## Notes

- Keep our changes a **small, legible layer** on top of upstream — prefer rebasing (linear history)
  over merging, so the customization set stays easy to audit and replay.
```

### 5.5 `CLAUDE.md` (repo root)
See the proposed content in §7 below — it is short and mostly points at this handoff's tables and the
two skills. (We can fold HANDOFF.md into CLAUDE.md once the setup is done, or keep CLAUDE.md as the
living doc and delete HANDOFF.md.)

---

## 6. Setup runbook — "when we start in it"

Run on `~/git/shiroikuma-tuxedo-control-center`. None of this is done yet.

1. **Remotes:** `git remote add upstream https://github.com/tuxedocomputers/tuxedo-control-center.git`
   then `git fetch upstream --tags`.
2. **Branches:** `master` already mirrors origin; create the dev branch:
   `git checkout -b custom` (from `master` = upstream 3.0.6). All work lives on `custom`.
3. **Deps:** ensure Node 24 (`npm run install-build-dep` if needed), then `npm ci`. Confirm a clean
   plain build first: `npm run build-prod` (sanity — before any customization).
4. **Apply the customization layer** (§2) as one or a few tidy commits on `custom`.
5. **Add versioning:** create `build-src/fork-build-number` (`1`) and `build-src/build-fork.ts`
   (§3); add the `pack-fork` script.
6. **Add `.claude/`** (§5): `settings.json`, `settings.local.json`, the two skills, and `CLAUDE.md`.
7. **First fork build:** `npm run pack-fork` → `~/tmp/shiroikuma-tuxedo-control-center_3.0.6+1_amd64.deb`.
   Then ask before installing.
8. **Test, then push on your say-so** (`origin custom`).

---

## 7. Proposed `CLAUDE.md` (repo root)

```markdown
# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

**白い熊 TUXEDO Control Center** — a personal fork of
[tuxedo-control-center](https://github.com/tuxedocomputers/tuxedo-control-center), TUXEDO's
Electron/Angular/Node system-tuning app for TUXEDO laptops (CPU, fans, profiles, Aquaris, etc.).

This repo (`ShiroiKuma0/shiroikuma-tuxedo-control-center`) is a fork. We track upstream and layer a
small set of customizations on top, rebuilt as upstream releases new versions.

## Fork Workflow — READ THIS FIRST

- `origin` → `git@github.com:ShiroiKuma0/shiroikuma-tuxedo-control-center` (push here).
- `upstream` → `https://github.com/tuxedocomputers/tuxedo-control-center.git` (read-only, for rebasing).
- **`master`** mirrors upstream. We do **not** develop on it.
- **`custom`** is our development branch. All our work lives here.

### Fork mode: REPLACE upstream

We install to `/opt/shiroikuma-tuxedo-control-center` as package
`shiroikuma-tuxedo-control-center`, declaring `Conflicts/Replaces/Provides: tuxedo-control-center`
so apt swaps upstream out. We **keep** upstream's system singletons: the `tccd`/`tccd-sleep` daemon,
the `com.tuxedocomputers.tccd` D-Bus name, polkit actions, and `/etc/tcc/`. Only one TCC runs.

### Our customizations

See `HANDOFF.md` §2 for the exact file list and the audit table used on every rebase. In short:
package/productName and `/opt` path are renamed to `shiroikuma-…`; the binary/command stays
`tuxedo-control-center` (`executableName`); the launcher label is `白い熊 TUXEDO Control Center`;
the daemon/D-Bus/config names are kept.

### Versioning & .deb naming

- `version` tracks upstream (currently `3.0.6`), kept clean.
- `build-src/fork-build-number` (`N`) is our increment, starting at `1`, **reset to 1** on each
  upstream bump. Fork deb `Version` = `<version>+<N>`; artifact
  `shiroikuma-tuxedo-control-center_<version>+<N>_amd64.deb` (→ `~/tmp`).

### Building

`npm run pack-fork` (the `build-deb` skill) builds the replace-mode deb at `+N`, copies it to
`~/tmp`, and bumps `N`. Needs Node 24 + the native toolchain (`npm ci` on a fresh checkout).

### HARD RULES

- After implementing a requested change, **always build** with `pack-fork` without being asked,
  confirm `BUILD SUCCESS`, **then ask** whether to install (`sudo apt install ~/tmp/<deb>`).
- **Never install the .deb unprompted.** **Never commit or push unprompted** (push → `origin custom`).

## Skills

- **build-deb** — build the fork .deb, then ask before installing.
- **upstream-new-version** — rebase `custom` onto a new upstream release → fresh `+1`.

## Remote control over SSH (why daemon names are kept)

Because we keep `com.tuxedocomputers.tccd` on the system bus, headless control works:
`busctl --system call com.tuxedocomputers.tccd /com/tuxedocomputers/tccd com.tuxedocomputers.tccd
GetFanDataJSON` (CPU temp + fan), `… GetProfilesJSON` / `… SetTempProfile s "<name>"` (switch
profile). Aquaris (fan/LED/pump) is GUI + Bluetooth-only (`src/e-app/LCT21001.ts`) and is **not** on
D-Bus — adding a headless Aquaris path is a candidate fork feature (see HANDOFF.md §8).
```

---

## 8. Connection to your original goal (+ optional roadmap)

You started this wanting SSH/remote control of: CPU temp, fan level, profile switching, and Aquaris
(connect / set levels / disconnect). Because replace mode **keeps** `com.tuxedocomputers.tccd`:

- **CPU temp / fan / profiles** → already reachable headlessly via `busctl --system` against the
  daemon (no fork change needed). `GetFanDataJSON`, `GetProfilesJSON`, `SetTempProfile` /
  `SetTempProfileById`. (`SetTempProfile*` is temporary — reverts on AC/battery change; persist by
  editing `/etc/tcc/settings`.)
- **Aquaris** → still **not** on D-Bus. It lives in the Electron app over Bluetooth LE
  (`src/e-app/LCT21001.ts`, `src/e-app/backendAPIs/aquarisAPI.ts`), so it needs the GUI running.

**Optional fork feature (the real payoff of owning this fork):** add Aquaris to the daemon's D-Bus
interface — e.g. `AquarisConnect`, `AquarisDisconnect`, `AquarisSetFan(i)`, `AquarisSetLed(s)` in
`TccDBusInterface.ts`/`TccDBusService.ts`, backed by a daemon-side port of the `LCT21001` BLE logic.
That would make all six of your tasks controllable over SSH. It's a meaningful chunk of work (moving
BLE from `e-app` into the daemon) and is **out of scope for the initial fork** — flag it and we can
scope it as a `custom`-branch feature later.

---

## 9. Open items / verify at runtime

- **`executableName` / WMClass:** confirm after the first build that the binary really lands at
  `/opt/shiroikuma-tuxedo-control-center/tuxedo-control-center` and the tray/single-instance works
  with `StartupWMClass=tuxedo-control-center`. If electron-builder 26 names it differently, adjust the
  `.desktop` `Exec`/`StartupWMClass` and the `after_install.sh` symlink to match.
- **`extraMetadata.version` injection:** verify the deb `Version` field comes out as `3.0.6+1`
  (`dpkg-deb -f <deb> Version`) and that `+` is accepted end-to-end by fpm/electron-builder 26.8.
- **`Provides` semantics:** confirm apt treats the fork as satisfying `tuxedo-control-center` deps and
  cleanly removes the upstream package on install (test on a VM/snapshot first if upstream TCC is live).
- **`npm ci` on this host:** the forked native deps (`dbus-next`, `node-ble`, `usocket`) +
  `node-gyp`/`pkg` need the full toolchain; first build may be slow.
- **Decide CLAUDE.md vs HANDOFF.md:** once setup lands, either fold this into `CLAUDE.md` and delete
  `HANDOFF.md`, or keep `HANDOFF.md` git-ignored as scratch.

---

*When you're ready, say "start in it" (or "go") and I'll run §6: add the upstream remote, cut
`custom`, apply the customization layer, write `build-fork.ts` + `.claude/`, and produce the first
`3.0.6+1` build — stopping before any install or push.*
