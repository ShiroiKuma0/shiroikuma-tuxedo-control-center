---
name: build-deb
description: Build the 白い熊 TUXEDO Control Center .deb with the pack-fork flow, then always ask whether to install it on this machine via apt. Use whenever the user asks to build the app, build the package/.deb, make a release build, or build and install.
---

# Build the fork .deb and optionally install it

## Steps

1. **Note the output filename.** Read the version and fork build number:
   - `grep '"version"' package.json | head -1` and `cat build-src/fork-build-number`
   - The .deb is `shiroikuma-tuxedo-control-center_<version>+<N>.deb`, using the `N`
     value **before** the build (build-fork bumps it afterward). deb `Version` = `<version>+<N>`.

2. **Build** (needs Node 24 via fnm — the system node is 18):
   - `export PATH="$HOME/.local/share/fnm:$PATH" && eval "$(fnm env)" && fnm use >/dev/null && npm run pack-fork < /dev/null`
     (`fnm use` reads the repo's `.node-version`; `< /dev/null` guarantees it never blocks on stdin).
   - This runs `build-prod`, packages the replace-mode deb (productName
     `shiroikuma-tuxedo-control-center` → `/opt/shiroikuma-tuxedo-control-center`, binary kept as
     `tuxedo-control-center`, `Conflicts/Replaces/Provides: tuxedo-control-center`), copies the .deb
     to `~/tmp/<name>`, and increments `build-src/fork-build-number`.
   - The task prints `>>> <path>` and `>>> deb version <ver>`; use those to confirm the exact
     filename, and confirm the build reached `BUILD SUCCESS` with no error.
   - On a fresh checkout run `npm ci` first (compiles the forked native deps
     dbus-next / node-ble / usocket and TuxedoIOAPI.node — needs gcc/g++/make + libudev-dev).

3. **Always ask** (via AskUserQuestion) whether to install the .deb on this machine — every build,
   no assuming. Options: "Yes, install via apt" / "No, just build".

4. **If yes, install directly yourself:**
   - `sudo apt install ~/tmp/<name>.deb` (apt resolves deps and runs after_install.sh: it enables
     and restarts `tccd`/`tccd-sleep` and supersedes any installed upstream `tuxedo-control-center`).
   - Verify: `dpkg -l shiroikuma-tuxedo-control-center` and `systemctl status tccd --no-pager`.
   - This is the local machine, not a phone — there is no adb. Installing means apt on this host.

## Hard rules (same as the Android forks)

- After implementing a change the user asked for, **always build it** with `pack-fork` **without
  waiting to be asked**, confirm success, **then ask** whether to install.
- **Never install on your own.** Only after the user confirms.
- **Never commit or push on your own.** Push goes to `origin` `custom` only on explicit instruction.

## Notes

- The fork keeps upstream's `tccd` daemon and the `com.tuxedocomputers.tccd` D-Bus name, so after
  install the remote-control surface works over SSH, e.g.
  `busctl --system call com.tuxedocomputers.tccd /com/tuxedocomputers/tccd com.tuxedocomputers.tccd GetFanDataJSON`
  (CPU temp + fan), `… GetProfilesJSON`, `… SetTempProfile s "<name>"` (switch profile).
- Plain (non-fork-numbered) packaging is still `npm run pack-prod` (deb + rpm). We ship the fork deb.
- If electron-builder asks for `fpm` or `bsdtar`, it usually downloads fpm itself; `bsdtar` may need
  `sudo apt install libarchive-tools` — ask 白い熊 before any sudo apt.

---

**Commit convention — no Claude attribution.** Never add a `Co-Authored-By: Claude …` / "Generated with Claude" trailer to commit messages or PR bodies; end the message at the last line of the body. This overrides the harness default. (Global rule: `~/.claude/CLAUDE.md`.)
