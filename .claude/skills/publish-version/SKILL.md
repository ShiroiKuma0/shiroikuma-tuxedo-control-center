---
name: publish-version
description: Publish the latest local .deb build as a GitHub release of this fork — refresh the README (fork-style, major features), write a very specific CHANGELOG entry, tag the bare version, ensure the default branch is `custom`, and create the release with the ~/tmp .deb attached. Use when 白い熊 says publish / release / cut a version / ship it to GitHub.
---

# Publish a version of shiroikuma-tuxedo-control-center to GitHub

Ship the **latest already-built** `.deb` as a GitHub release, with a polished fork-style README and an
exhaustive CHANGELOG, landing the repo homepage on our fork work (`custom`).

This is **shiroikuma-tuxedo-control-center** — 白い熊's **REPLACE-mode** fork of TUXEDO's
[tuxedo-control-center](https://github.com/tuxedocomputers/tuxedo-control-center) (an
Electron / Angular / Node hardware-control app for TUXEDO laptops), package
`shiroikuma-tuxedo-control-center`, label `白い熊 TUXEDO Control Center`. The build/identity/versioning
facts live in the **`build-deb`** and **`upstream-new-version`** skills (and the repo `CLAUDE.md`) —
this skill is **only** about cutting a GitHub release of a `.deb` those have already produced.

> **Never rebuild to publish.** Attach the newest `.deb` already in `~/tmp/` (see the global
> `no-pointless-rebuilds` rule). The version you publish = that `.deb`'s version. If you think a fresh
> build is needed, that's a separate `build-deb` run that 白い熊 drives and tests first — not part of
> publishing.

## 0. Detect the version

- Newest fork deb: `ls -t ~/tmp/shiroikuma-tuxedo-control-center_*.deb | head -1`.
- The **version** is the filename field between the first `_` and `.deb` — e.g.
  `shiroikuma-tuxedo-control-center_3.0.6+25.deb` → **`3.0.6+25`**. It is `<upstream base>+<fork build
  N>` (the `+N` tail is set by `build-src/fork-build-number`; see `build-deb`). Use it verbatim
  everywhere (tag, README latest-release line, release title, changelog heading). If there is no `.deb`
  in `~/tmp/`, stop and tell 白い熊 to build first (`build-deb`) — do **not** build it yourself.

## 1. Ensure the homepage lands on `custom`

The GitHub repo's **default branch must be `custom`** (so visitors see our fork, not the
upstream-mirroring `master`). It may still default to `master` — flip it on the first publish:
```bash
gh repo view ShiroiKuma0/shiroikuma-tuxedo-control-center --json defaultBranchRef --jq '.defaultBranchRef.name'
# if it is not "custom":
gh repo edit ShiroiKuma0/shiroikuma-tuxedo-control-center --default-branch custom
```

## 2. Refresh `README.md` (fork-style, major features)

The repo currently carries **upstream's** README (`# TUXEDO Control Center`). Replace it with our
fork-style homepage — the centered-header, "**a fork of X with major additions**" style modelled on the
sibling **shiroikuma-jami** / **shiroikuma-jiyusagyoban** / **shiroikuma-futokxkb** READMEs. Structure:

- **Centered header block** (`<div align="center">`): the app icon
  (`src/dist-data/tuxedo-control-center_256.png`, width 120), the title **白い熊 TUXEDO Control Center**,
  a one-line "control your TUXEDO laptop — CPU, fans, power profiles & the Aquaris cooler" tagline, and a
  **"A fork of [TUXEDO Control Center](https://github.com/tuxedocomputers/tuxedo-control-center) with
  major additions: …"** sentence that names the headline features.
- The **install note — REPLACE mode, not side-by-side** (this is the key difference from the Android
  forks): a `.deb` for Debian/Ubuntu. `sudo apt install ./shiroikuma-tuxedo-control-center_<version>.deb`
  installs to `/opt/shiroikuma-tuxedo-control-center` and declares `Conflicts/Replaces/Provides:
  tuxedo-control-center`, so apt **supersedes** any installed official `tuxedo-control-center` (only one
  TCC runs). It keeps upstream's `tccd` system daemon, the `com.tuxedocomputers.tccd` D-Bus name, polkit
  actions and `/etc/tcc/` config. Needs `tuxedo-drivers` (or `tuxedo-keyboard`).
- The **latest-release line** — update the version to the one from step 0:
  `**📥 Latest release: [\`<version>\`](…/releases/latest)** — [all releases & .deb downloads »](…/releases)`.
- Then a **section per major feature** (emoji heading + a few real sentences each), in importance order.
  **Pick the updates that matter most vs stock TUXEDO Control Center** and describe them invitingly.
  Maintain/extend these to reflect everything currently shipped — at the time of writing the headline set is:
  - 🌡️ **Autopilot — load-reactive auto-tuning, built into `tccd`** — a new daemon worker that watches
    CPU utilisation (`/proc/stat`), CPU package power (RAPL), GPU load and temperatures, and automatically
    switches between a high-load profile and a rest profile (fast attack, EMA-smoothed release). A manual
    profile pick pauses it; it resumes after a timeout. Aggressive by default, tunable from the CLI, and
    persisted across reboots.
  - 💧 **Headless Aquaris cooling** — the external Aquaris water-cooler (fan / LED / pump over Bluetooth
    LE) is GUI-only upstream. The fork adds a user-level **keeper** service that holds the BLE link
    headlessly (keeping the LED dark and enforcing a desired state), so the Aquaris is controllable over
    SSH/CLI and driven by the autopilot. Ownership is **keeper-authoritative** (an autostarted GUI can't
    starve it), and the autopilot runs the Aquaris fan a step ahead of the laptop fan — off at rest,
    ramping with load.
  - 🖥️ **Headless CLI over D-Bus** — `tcc` (a live 3-column terminal monitor: dashboard / profiles /
    Aquaris), plus `tccinfo`, `tccprofile`, `tccaquaris` and `tccauto`: full profile / fan / temperature /
    Aquaris / autopilot control from a terminal or over SSH. Packaged into the `.deb` and symlinked onto
    `PATH`; the daemon keeps upstream's `com.tuxedocomputers.tccd` D-Bus name so remote control works out
    of the box.
  - 🛡️ **Daemon robustness** — the daemon's user-presence check ran `w` synchronously on its single
    event loop, which could freeze the whole D-Bus interface under a bloated process table → made async
    with a timeout. Plus a settings-reload fix so `tccprofile` to an already-mapped profile actually
    applies instead of silently no-op'ing.
  - 📦 **Replace-mode packaging** — installs as `shiroikuma-tuxedo-control-center` and supersedes the
    official package via `Conflicts/Replaces/Provides`, while keeping the upstream daemon / D-Bus / polkit
    / `/etc/tcc` singletons intact.
  - 🎨 **Branding & UX** — `白い熊 TUXEDO Control Center` window / tray / launcher labels, and a dashboard
    startup-scrollbar fix so it fits the default window cleanly.
- A closing **"Built on TUXEDO Control Center"** + license note: the fork inherits TCC's **GPL-3.0**
  licence (`COPYING`).

Write real, specific prose — not a bullet dump. Keep it inviting, like the jami / jiyusagyoban READMEs.

## 3. Update `CHANGELOG.fork.md` — exhaustive

**Use a separate `CHANGELOG.fork.md`, NOT the root `CHANGELOG.md`.** The root `CHANGELOG.md` is
**upstream's** and is compiled into the app (`build-ng-prod` → `copy-changelog` `cp`s it into
`src/ng-app/assets/`) and rewritten on every `upstream-new-version` rebase — so the fork's release log
lives in its own file to avoid clobbering it and to avoid rebase conflicts.

Create `CHANGELOG.fork.md` on the first publish. Add each new section **above** the previous one:
```
## <version> — <YYYY-MM-DD>
```
(use the current date from the environment). **Be very specific — list everything in this release**:

- **First release:** summarize the whole fork stack — cross-check `git log master..custom --oneline`
  (commit subjects are self-describing) and group the work into `###` subsections (Autopilot, Aquaris /
  keeper, CLI tools, Daemon robustness, Packaging & identity, Branding & UX, Fixes). Note the upstream
  base it's built on (the version minus the `+N` tail, e.g. `3.0.6`).
- **Subsequent releases:** the previous fork tag is the latest existing GitHub release
  (`gh release list --repo ShiroiKuma0/shiroikuma-tuxedo-control-center`); list everything since with
  `git log <lastForkTag>..custom --oneline`, and cross-check the prior `CHANGELOG.fork.md` section so
  nothing is missed.

This file is the authoritative, GitHub-readable fork record. Keep the `build-src/fork-build-number`
counter bumps out of the prose — they're noise, not features.

## 4. Commit, tag, push, release

```bash
# .scratch/ is gitignored (scratch-dir-not-tmp). Add it once if missing, and stage it with the docs commit.
grep -qxF '.scratch/' .gitignore || printf '\n.scratch/\n' >> .gitignore

git add README.md CHANGELOG.fork.md .gitignore
git commit -F - <<'MSG'
docs: changelog + README for <version> release
MSG
git push origin custom

# Annotated tag = the bare version, NO "v" prefix. Distinct from upstream's vX.Y.Z tags (the "+N" tail).
git tag -a "<version>" -m "白い熊 TUXEDO Control Center <version>"
git push origin "<version>"

# Release notes = this version's CHANGELOG.fork.md section. Use a LITERAL match (index($0,h)==1), NOT a
# regex: the "+N" tail puts a "+" in the version, and "+" is a regex metachar, so /^## <version>/ would
# fail to match. index() treats the header as a plain string.
mkdir -p .scratch
awk -v h="## <version>" 'index($0,h)==1{p=1;next} /^## /{if(p)exit} p' CHANGELOG.fork.md > .scratch/release-notes.md
gh release create "<version>" \
  --repo ShiroiKuma0/shiroikuma-tuxedo-control-center \
  --title "白い熊 TUXEDO Control Center <version>" \
  --notes-file .scratch/release-notes.md \
  ~/tmp/shiroikuma-tuxedo-control-center_<version>.deb
```
Then verify: `gh release list --repo ShiroiKuma0/shiroikuma-tuxedo-control-center` shows it as **Latest**
and `gh release view "<version>" --repo ShiroiKuma0/shiroikuma-tuxedo-control-center --json assets` lists
the `.deb`. Report the release URL.

## Hard rules / invariants
- **Never rebuild to publish** — attach the newest `.deb` already in `~/tmp/` (step 0). Publishing never
  triggers a `pack-fork` build.
- The transient `release-notes.md` goes in the gitignored **`.scratch/`**, never `~/tmp/`
  (see `scratch-dir-not-tmp`).
- `gh` / `scp` / `git push` / `git tag … push` run **unsandboxed** (`dangerouslyDisableSandbox: true`).
- **No Claude/Anthropic attribution** in the commit, tag, or release body (repo `CLAUDE.md` / global
  rule). End the commit/tag message at the last line of its body.
- Tag is the **bare version** (e.g. `3.0.6+25`), no `v` — distinct from upstream's `vX.Y.Z` tags so the
  two never collide.
- The release is cut from **`custom`**. Don't touch `master` (it only mirrors upstream), and never stage
  build output (`dist/`, `usr/`, `.deb`s) in the docs commit.
- The fork release log is **`CHANGELOG.fork.md`** — leave the upstream-mirroring root `CHANGELOG.md`
  (compiled into the app) alone.
