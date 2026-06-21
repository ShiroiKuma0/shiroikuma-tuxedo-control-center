# Changelog — 白い熊 TUXEDO Control Center fork

Release log for the fork-specific additions on top of
[tuxedo-control-center](https://github.com/tuxedocomputers/tuxedo-control-center). Upstream's own
changelog is in [`CHANGELOG.md`](CHANGELOG.md).

## 3.0.6+25 — 2026-06-21

First public release of the fork, built on upstream **TUXEDO Control Center 3.0.6**. Everything below is
added on top of stock TCC.

### Autopilot (load-reactive auto-tuning, in `tccd`)

- New **`AutoProfileWorker`** in the privileged daemon (1 s tick) that automatically switches between a
  high-load profile and a rest profile based on system load — no second daemon, no GUI required.
- **Signals:** CPU utilisation (new `/proc/stat` reader), CPU package power (Intel RAPL, as a fraction of
  the limit), GPU load (Intel/AMD/NVIDIA frequency or power), and CPU/GPU temperatures + the internal fan
  percentage. It holds sensor-data collection on so RAPL/GPU keep sampling headlessly.
- **Decision logic:** instant *attack* on the raw signals (switch to the high-load profile the moment
  real load appears) and a debounced *release* on EMA-smoothed signals, so a single-tick blip — e.g. a
  dGPU briefly reporting a high clock ratio when it wakes — can't keep it out of rest.
- **Manual-pick pause:** choosing a profile in the GUI or via `tccprofile` pauses the autopilot so your
  choice sticks; it resumes after a configurable timeout (default 5 minutes) or immediately via
  `tccauto on`.
- **Rest is gated on cool-down:** the profile drops to the rest profile only once load is gone *and* the
  laptop fan has wound down, so the performance profile holds through the active cool-down.
- **Tunables** live in `settings.autopilot` (`/etc/tcc/settings`, reloaded on SIGHUP). Defaults are
  deliberately aggressive; high/rest profiles default to the profiles shown as #1 and #3 by `tccprofile`.

### Aquaris cooling — headless, autopilot-driven

- **Keeper service** (`tccaquaris-keeper`, a per-user systemd unit) that holds the single Bluetooth-LE
  link to the Aquaris water-cooler and continuously applies a desired state from
  `~/.config/tccaquaris/desired.json` — so the Aquaris (fan / LED / pump), previously GUI-only, is now
  controllable headlessly over SSH and the CLI. It keeps the device's LED dark while idle.
- **Autopilot-driven fan:** the daemon publishes a desired Aquaris fan target on D-Bus and the keeper
  applies it ("daemon decides, keeper acts", since the root daemon has no Bluetooth). The Aquaris fan
  **tracks the laptop's own fan** — off at/below 50% PC fan, otherwise running ~10% above it, so it leads
  the system fan and winds down with it; a **lead floor** brings it on promptly at load onset rather than
  waiting for the laptop fan to spin up. Auto-follow is on by default.
- **Keeper-authoritative ownership:** the keeper is the sole authoritative owner of the BLE link and
  never yields; the GUI is a hot standby that only drives the device when the keeper is absent. This
  fixes a deadlock where an autostarted tray GUI could grab the link, fail to connect, and leave the
  cooler uncontrolled with nobody present.

### Headless CLI tools (over D-Bus, packaged into the `.deb`)

- **`tcc`** — interactive 3-column live monitor (dashboard | profiles | Aquaris), 1 s refresh, with keys
  to switch profiles, toggle Aquaris cooling, set the fan and toggle the LED. Reflects the Aquaris state
  actually applied on the device, and shows the autopilot's intended fan when in manual mode. A narrow
  layout kicks in automatically on small/SSH terminals.
- **`tccinfo`** — the dashboard readings (CPU/GPU temps, fans, power, clocks), one-shot or live (`-m`).
- **`tccprofile`** — list profiles, or persistently switch the active profile.
- **`tccaquaris`** — control the Aquaris by editing the desired state the keeper applies (`on`/`off`/
  `fan`/`led`/`auto on|off`, plus keeper service management).
- **`tccauto`** — autopilot control (status / `on` / `off` / `high N` / `rest N` / `set KEY VALUE` /
  `keys`).
- All five are shipped inside the `.deb` (`extraResources`) and symlinked onto `PATH` at `/usr/bin`.

### Daemon robustness

- **Fixed a D-Bus freeze:** the daemon's `DisplayRefreshRateWorker` ran `w --no-header` *synchronously*
  on its single event loop every 5 s; under a bloated process table that scan could take 20 s+ and freeze
  the entire `com.tuxedocomputers.tccd` interface (so GUI/CLI profile switching hung). It now runs `w`
  asynchronously with a 4 s timeout and an in-flight guard; parsing is unchanged.
- **Authoritative `--new_settings` reload:** the SIGHUP reload now re-derives the active profile from the
  freshly-written state map (dropping any stale temporary override), so `tccprofile` switching to a
  profile the state map already points at applies immediately instead of silently no-op'ing.

### Packaging & identity (replace mode)

- Installs as package **`shiroikuma-tuxedo-control-center`** to `/opt/shiroikuma-tuxedo-control-center`,
  declaring `Conflicts/Replaces/Provides: tuxedo-control-center` so `apt` supersedes the official package
  (only one TCC runs). Upstream's `tccd`/`tccd-sleep` daemon, the `com.tuxedocomputers.tccd` D-Bus name,
  the polkit actions and `/etc/tcc/` are kept as shared singletons.
- The binary/command stays `tuxedo-control-center`; the Electron runtime identity is pinned to upstream
  so the single-instance lock and X11 window class stay correct under the renamed package.
- Versions are stamped `<upstream base>+<N>` (e.g. `3.0.6+25`) so upgrades sort monotonically across
  upstream bumps. The fork build restores the working tree's version files even if a build is hard-killed
  mid-package.
- Fixed the GUI failing to launch under the renamed application id (single-instance lock path).

### Branding & UX

- `白い熊 TUXEDO Control Center` window, tray and launcher labels.
- Removed the permanent vertical scrollbar on the dashboard at startup, so the dashboard fits the default
  window cleanly.
