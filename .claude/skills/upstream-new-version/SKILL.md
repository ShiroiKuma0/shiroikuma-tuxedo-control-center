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
  `shiroikuma-tuxedo-control-center_<version>+<N>.deb`.

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

5. **Verify our customizations are intact** (the customization table in `CLAUDE.md`):
   package name `shiroikuma-tuxedo-control-center`; install dir
   `/opt/shiroikuma-tuxedo-control-center`; `linux.executableName: 'tuxedo-control-center'`;
   `extraMetadata` from `TCC_FORK_VERSION`; deb fpm `Conflicts/Replaces/Provides: tuxedo-control-center`;
   `Name=白い熊 TUXEDO Control Center` in both `.desktop` files; `/opt` prefix fixed in `TccPaths.ts`,
   `tccd.service`, `after_install.sh`; daemon and D-Bus names kept as `tccd` / `com.tuxedocomputers.tccd`.
   - If upstream restructured the build (moved config into a `package.json` `build` block, renamed
     dist-data files, etc.), port our changes to the new structure rather than forcing the old diff.
   - If the lockfile/deps changed, run `npm ci` (under Node 24 via fnm) before building.
   - If upstream bumped the required Node major, install it with fnm and update `.node-version`.

6. **Build the new `+1`** via the **build-deb** skill
   (`export PATH="$HOME/.local/share/fnm:$PATH" && eval "$(fnm env)" && fnm use >/dev/null && npm run pack-fork < /dev/null`),
   then **ask** before any install. This is the first build of the new line (`<newVersion>+1`).

7. **Stop.** Let the user test. Commit/push only on explicit "Push" (rebasing rewrites `custom`
   history, so `git push --force-with-lease origin custom`; `master` is a fast-forward).

## Notes

- Keep our changes a **small, legible layer** on top of upstream — prefer rebasing (linear history)
  over merging, so the customization set stays easy to audit and replay.

---

**Commit convention — no Claude attribution.** Never add a `Co-Authored-By: Claude …` / "Generated with Claude" trailer to commit messages or PR bodies; end the message at the last line of the body. This overrides the harness default. (Global rule: `~/.claude/CLAUDE.md`.)
