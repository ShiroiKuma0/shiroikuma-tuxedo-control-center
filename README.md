<div align="center">

<img src="src/dist-data/tuxedo-control-center_256.png" width="120" alt="白い熊 TUXEDO Control Center" />

# 白い熊 TUXEDO Control Center

*Control your TUXEDO laptop — CPU, fans, power profiles & the Aquaris cooler.*

**A fork of [TUXEDO Control Center](https://github.com/tuxedocomputers/tuxedo-control-center) with major
additions: a load-reactive autopilot in the daemon, headless Aquaris water-cooler control over
Bluetooth, and a full set of D-Bus/SSH command-line tools.**

**📥 Latest release: [`3.0.6+28`](https://github.com/ShiroiKuma0/shiroikuma-tuxedo-control-center/releases/latest)** — [all releases & .deb downloads »](https://github.com/ShiroiKuma0/shiroikuma-tuxedo-control-center/releases)

</div>

---

## Install (replaces the official package)

This is a **replace-mode** fork: the `.deb` installs as `shiroikuma-tuxedo-control-center` to
`/opt/shiroikuma-tuxedo-control-center` and declares `Conflicts/Replaces/Provides: tuxedo-control-center`,
so `apt` cleanly **supersedes** any installed official TUXEDO Control Center — only one TCC runs at a
time. It keeps upstream's `tccd` system daemon, the `com.tuxedocomputers.tccd` D-Bus name, the polkit
actions and your `/etc/tcc/` configuration, so everything carries over.

```bash
sudo apt install ./shiroikuma-tuxedo-control-center_3.0.6+28.deb
```

Requires `tuxedo-drivers` (or `tuxedo-keyboard`), like upstream. The binary/command stays
`tuxedo-control-center`; only the package, install path and display name are renamed.

---

## What this fork adds

### 🌡️ Autopilot — load-reactive auto-tuning, built into `tccd`

A new worker inside the privileged daemon watches the signals it already collects — CPU utilisation
(`/proc/stat`), CPU package power (Intel RAPL), GPU load and temperatures — and **automatically switches
between a high-load profile and a rest profile**. It attacks fast on real load and releases on a
smoothed average, so a momentary blip can't flip it. A manual profile pick (in the GUI or via
`tccprofile`) pauses the autopilot so your choice sticks, and it resumes after a few minutes. It's
aggressive by default, fully tunable from the CLI, and persists across reboots.

### 💧 Headless Aquaris cooling

The external **Aquaris** water-cooler (fan / LED / pump over Bluetooth LE) is GUI-only upstream. The fork
adds a user-level **keeper** service that holds the BLE link headlessly — keeping the LED dark and
continuously enforcing a desired state — so the Aquaris is controllable **over SSH and the CLI**, and
driven by the autopilot. Ownership is **keeper-authoritative**: an autostarted tray GUI can never starve
it and leave the cooler stranded. Under load the autopilot runs the Aquaris fan a step ahead of the
laptop's own fan (off at rest, ramping as the system heats up, leading at load onset). A manual
`tccaquaris on/off/fan` takes over only temporarily — it lapses back to the autopilot after the same
resume timeout the profile pause uses, so a one-off fan tweak never leaves the cooler stuck.

And if the Aquaris firmware ever **wedges** — a dropped Bluetooth link can freeze the fan at its last
speed while the device stops advertising, leaving it blasting and unreachable — the keeper heals that
too: it detects the signature and **power-cycles the unit through a Tasmota smart plug** on the LAN
(plug IP from `$KXTCC` / `~/.kxrc`), so a wedge costs minutes of noise instead of days.

### 🖥️ Headless control over D-Bus — a CLI toolkit

The daemon keeps upstream's `com.tuxedocomputers.tccd` D-Bus name, so the whole stack is controllable
from a terminal or over SSH. The fork ships a set of wrappers, packaged into the `.deb` and symlinked
onto your `PATH`:

- **`tcc`** — a live 3-column terminal monitor (dashboard · profiles · Aquaris), refreshed every second.
- **`tccinfo`** — one-shot or live dashboard readings (CPU/GPU temps, fans, power, clocks).
- **`tccprofile`** — list profiles, or switch the active profile persistently.
- **`tccaquaris`** — control the Aquaris (fan / LED / on-off) headlessly via the keeper.
- **`tccauto`** — view and tune the autopilot (status, on/off, high/rest profiles, thresholds).

### 🛡️ Daemon robustness

- **No more D-Bus freezes.** The daemon's user-presence check ran `w` *synchronously* on its single
  event loop; under a bloated process table that scan could take 20 s+ and freeze the entire D-Bus
  interface (profile switching from the GUI and CLI would hang). It now runs asynchronously with a
  timeout and an overlap guard.
- **Reliable profile re-apply.** A settings reload now re-derives the active profile from the state map,
  so `tccprofile` switching to an already-mapped profile actually applies instead of silently no-op'ing
  behind a stale temporary override.

### 📦 Replace-mode packaging & identity

Renamed package, `/opt` path and `白い熊 TUXEDO Control Center` display name, with the upstream daemon,
D-Bus name, polkit actions and `/etc/tcc/` kept as shared singletons. The Electron runtime identity is
pinned to upstream so the single-instance lock and window class stay correct, and the build stamps a
monotonic `<base>+<N>` version so upgrades sort cleanly across upstream bumps.

### 🎨 Branding & UX

`白い熊 TUXEDO Control Center` window, tray and launcher labels, plus a dashboard fix that removes the
permanent vertical scrollbar at startup so the dashboard fits the default window cleanly.

---

## Built on TUXEDO Control Center

This is a personal fork of TUXEDO's
[tuxedo-control-center](https://github.com/tuxedocomputers/tuxedo-control-center); all credit for the
underlying application goes to TUXEDO Computers. It inherits TCC's **GPL-3.0** licence — see
[`COPYING`](COPYING).
