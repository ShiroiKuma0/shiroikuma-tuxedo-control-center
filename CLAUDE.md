# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project Overview

**白い熊 TUXEDO Control Center** — a personal fork of
[tuxedo-control-center](https://github.com/tuxedocomputers/tuxedo-control-center), TUXEDO's
Electron / Angular / Node system-tuning app for TUXEDO laptops (CPU, fans, profiles, Aquaris, etc.).

This repo (`ShiroiKuma0/shiroikuma-tuxedo-control-center`) is a fork. We track upstream and layer a
small set of customizations on top, rebuilt as upstream releases new versions. This is the first
non-Android, Electron fork in `~/git/`; the build half (npm + electron-builder + `.deb`) is new, but
the fork *workflow* is identical to the Android forks (e.g. `shiroikuma-messeji`).

## Fork Workflow — READ THIS FIRST

- `origin` → `git@github.com:ShiroiKuma0/shiroikuma-tuxedo-control-center` (push here).
- `upstream` → `https://github.com/tuxedocomputers/tuxedo-control-center.git` (read-only, for rebasing).
- **`master`** mirrors upstream. We do **not** develop on it.
- **`custom`** is our development branch. All our work lives here. This is the default working branch.

### Fork mode: REPLACE upstream

We install to `/opt/shiroikuma-tuxedo-control-center` as package
`shiroikuma-tuxedo-control-center`, and the `.deb` declares
`Conflicts/Replaces/Provides: tuxedo-control-center` so apt swaps upstream out. We **keep** upstream's
system singletons: the `tccd` / `tccd-sleep` daemon, the `com.tuxedocomputers.tccd` D-Bus name,
polkit actions, and `/etc/tcc/`. Only one TCC runs at a time.

### Our customizations (the audit table for every rebase)

| What | Value | Where |
| --- | --- | --- |
| Package / `productName` (packaging identity) | `shiroikuma-tuxedo-control-center` | **root** `package.json` `name` only |
| Electron runtime identity (pinned to upstream) | `tuxedo-control-center` | `app.setName('tuxedo-control-center')` in `e-app/backendAPIs/initMain.ts` |
| SingletonLock path (robust) | Electron `userData` dir | `app.getPath('userData')` in `initMain.ts` (was hard-coded `~/.config/tuxedo-control-center`) |
| Install dir | `/opt/shiroikuma-tuxedo-control-center` | derived from root `productName` |
| Binary / command (kept) | `tuxedo-control-center` | `linux.executableName` in `build-src/electron-builder.ts` |
| Launcher label | `白い熊 TUXEDO Control Center` | `src/dist-data/*.desktop` `Name=` |
| Supersede upstream | `Conflicts/Replaces/Provides: tuxedo-control-center` | deb `fpm` in `electron-builder.ts` |
| `/opt` paths | `…shiroikuma-tuxedo-control-center…` | `TccPaths.ts`, `tccd.service`, `*.desktop`, `after_install.sh` |
| Fork version stamping | both root + `src/package.json` `version` → `<base>+<N>` at build time, restored after | `build-src/build-fork.ts` |
| Daemon / D-Bus / config (kept) | `tccd`, `com.tuxedocomputers.tccd`, `/etc/tcc` | unchanged |

The binary/command stays `tuxedo-control-center` (`executableName`) while only `productName` and the
`/opt` path are renamed — this keeps the desktop files, the `/usr/bin` symlink and `StartupWMClass`
low-churn. The display label `白い熊 TUXEDO Control Center` lives only in the `.desktop` `Name=`.

**Two separate identities — do not conflate them:**
- **Packaging identity** = root `package.json` `name` = `shiroikuma-tuxedo-control-center`. Drives the
  `/opt` dir, the `.deb` `Package` field, and the artifact name. This one we rename.
- **Runtime identity** = the Electron app name, pinned to `tuxedo-control-center` via
  `app.setName('tuxedo-control-center')` in `e-app/backendAPIs/initMain.ts`. It governs
  `~/.config/<name>/` and the X11 `WM_CLASS` (must match `.desktop`
  `StartupWMClass=tuxedo-control-center`). **Note:** electron-builder derives the Electron app name
  from the packaging `productName`, **not** from `src/package.json` — so `src/package.json` is left
  at its upstream value (`tuxedo-control-center`, unmodified) and the runtime name is fixed in code.
  Without the `app.setName` pin, Electron's `userData` becomes `~/.config/shiroikuma-...` while
  `initMain.ts`'s single-instance check looked for `~/.config/tuxedo-control-center/SingletonLock` →
  `app.exit(0)` before the window opened (GUI silently wouldn't start). The check now also reads
  `app.getPath('userData')` directly, so it is correct regardless of the resolved name.

### In-app branding & UX tweaks (preserve on rebase)

- **Window / page title** `白い熊 TUXEDO Control Center`: `src/ng-app/index.html` `<title>` (this is what
  actually shows in the title bar — the main window has no `page-title-updated` guard, so the page
  title wins) and the `BrowserWindow` `title` in `e-app/backendAPIs/browserWindowsAPI.ts`.
- **Tray** title + tooltip `白い熊 TUXEDO Control Center`: `e-app/TccTray.ts`.
- **Startup scrollbar fix (all in `src/ng-app/app/dashboard/dashboard.component.scss`):** two parts.
  (1) `.dashboard` used `overflow-y: scroll` (bar *always* shown) and `bottom: 25px` → changed to
  `overflow-y: auto` and `bottom: 5px`. (2) The dashboard is tall (two gauge rows) and still
  overflowed the **default 770 px** window by ~40 px, so inter-section spacing was trimmed
  (`.system-monitor-gauges` margins `10/30` → `6/10`; `.active-tcc-profile` `padding-bottom 15` → `5`)
  so it fits at the default window. Window pixel sizing is **not** the lever and is left at upstream
  values — HiDPI (`dpr 1.25`) / Wayland / KDE make the BrowserWindow height unreliable (a tweak to it
  was tried and dropped). Verified via DevTools after full render (+ `Page.captureScreenshot`) that
  `.dashboard` no longer overflows at 770 px.

### Daemon robustness fixes (preserve on rebase)

- **Non-blocking `w` in `DisplayRefreshRateWorker`**
  (`src/service-app/classes/DisplayRefreshRateWorker.ts`): upstream `checkUsers()` runs
  `child_process.execSync('w --no-header')` on the daemon's **single event loop** every 5 s. `w`
  scans all of `/proc`, so when the process table is bloated (e.g. a leaked-SSH-session storm) it
  takes 20 s+ and freezes the **entire D-Bus interface** while it runs — `GetProfilesJSON` /
  `SetTempProfile` hang, so CLI (`tccprofile`) and GUI profile switching appear stuck. Fork makes
  `checkUsers()` `async`: a `runW()` helper uses `child_process.exec` with
  `{ timeout: 4000, killSignal: 'SIGKILL' }` (< the 5 s poll) plus a `wInFlight` guard that skips
  overlapping runs; on failure/timeout it keeps prior state and reports "no change". Parsing/regex is
  byte-for-byte upstream — only the exec mechanism changed. (Diagnosed 2026-06-06; root trigger was a
  WireGuard peer at `10.9.0.3` leaking ~750 idle `sshd` sessions. Mitigated host-side too with an
  `sshd` `ClientAliveInterval 60` / `ClientAliveCountMax 3` drop-in, which lives outside this repo.)

### Versioning & .deb naming

- `version` tracks upstream (currently `3.0.6`), kept clean.
- `build-src/fork-build-number` (`N`) is our increment, starting at `1`, **reset to 1** on each
  upstream bump. Fork deb `Version` = `<version>+<N>`; artifact
  `shiroikuma-tuxedo-control-center_<version>+<N>.deb`, copied to `~/tmp`.
- Debian sorts `3.0.6 < 3.0.6+1 < 3.0.6+2 < 3.0.7+1`, so upgrades stay monotonic across upstream bumps.
- `build-fork.ts` stamps `<base>+<N>` into **both** root and `src/package.json` for the build, then
  restores them. This keeps `tccd`'s reported version == `app.getVersion()` == the `.deb` version —
  required, because the GUI's tccd-version-check (`e-app/.../initMain.ts`) restart-loops on a mismatch
  (it re-spawns itself with an extra `--tray` every 5 s). Do **not** reintroduce a version that only
  bumps one side (the earlier `extraMetadata.version` approach did this and caused exactly that loop).

### Toolchain — Node 24 via fnm

The system node is **18**; TCC needs **24**. We use a user-level **fnm** (no sudo) with Node 24 pinned
in `.node-version`. Activate it before any npm/build command:

```bash
export PATH="$HOME/.local/share/fnm:$PATH" && eval "$(fnm env)" && fnm use >/dev/null
```

Fresh checkout: `npm ci` (compiles forked native deps dbus-next / node-ble / usocket and
TuxedoIOAPI.node — needs gcc/g++/make + libudev-dev).

### Building

`npm run pack-fork` (the **build-deb** skill) builds the replace-mode deb at `+N`, copies it to
`~/tmp`, and bumps `N`. Plain upstream-style packaging is still `npm run pack-prod` (deb + rpm) and
`npm run start` runs the built app.

### HARD RULES

- After implementing a requested change, **always build** with `pack-fork` without being asked,
  confirm success, **then ask** whether to install (`sudo apt install ~/tmp/<deb>`).
- **Never install the .deb unprompted.** **Never commit or push unprompted** (push → `origin custom`).

## Skills

- **build-deb** — build the fork .deb, then ask before installing.
- **upstream-new-version** — rebase `custom` onto a new upstream release → fresh `+1`.

## Remote control over SSH (why daemon names are kept)

Because we keep `com.tuxedocomputers.tccd` on the system bus, headless control works:
`busctl --system call com.tuxedocomputers.tccd /com/tuxedocomputers/tccd com.tuxedocomputers.tccd
GetFanDataJSON` (CPU temp + fan), `… GetProfilesJSON` / `… SetTempProfile s "<name>"` (switch
profile; `SetTempProfile*` is temporary, reverts on AC/battery change — persist via `/etc/tcc/settings`).
Aquaris (fan / LED / pump) is GUI + Bluetooth-only (`src/e-app/LCT21001.ts`,
`src/e-app/backendAPIs/aquarisAPI.ts`) and is **not** on D-Bus, so it needs the GUI running.

**Candidate `custom`-branch feature (the payoff of owning this fork):** expose Aquaris on the daemon's
D-Bus interface — e.g. `AquarisConnect` / `AquarisDisconnect` / `AquarisSetFan(i)` / `AquarisSetLed(s)`
in `TccDBusInterface.ts` / `TccDBusService.ts`, backed by a daemon-side port of the `LCT21001` BLE
logic. That would make all of the original goals (incl. connect / set levels / disconnect Aquaris)
controllable over SSH. It's a meaningful chunk of work — moving BLE from `e-app` into the daemon — and
was out of scope for the initial fork.

## Architecture (upstream, unchanged)

- `src/service-app/` — the privileged **tccd** daemon (systemd `tccd.service`). D-Bus interface in
  `TccDBusInterface.ts` / `TccDBusService.ts`; workers under `service-app/classes/` (CPU, fan,
  charging, ODM, state-switcher). Bundled to a single binary via `pkg`.
- `src/e-app/` — the Electron main process (tray, IPC, **Aquaris over BLE**).
- `src/ng-app/` — the Angular renderer (UI, including `aquaris-control/`).
- `src/common/` — shared code: `TccPaths.ts` (filesystem paths), controllers, models.
- `src/dist-data/` — installed system files (systemd units, dbus conf, polkit, `.desktop`, icons).
- `build-src/` — packaging: `electron-builder.ts`, `after_install.sh` / `after_remove.sh`,
  `build-fork.ts` (our fork build), `fork-build-number`, version scripts.
