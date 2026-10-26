# Changelog

This file carries **both** histories: the 白い熊 TUXEDO Control Center fork's releases first, newest
first, then upstream [tuxedo-control-center](https://github.com/tuxedocomputers/tuxedo-control-center)'s
own changelog below, unchanged.

# 白い熊 TUXEDO Control Center fork

## 3.0.6+34 — 2026-10-26

Built on upstream tuxedo-control-center 3.0.6. The keeper now finds an Aquaris that BlueZ has lost sight of, and the wedge handling of +28 is rebuilt as an honest kill switch.

### Aquaris / keeper — rediscover a missing device

- **The problem:** a long-running BLE discovery session can go deaf to a device it has already reported. The controller's duplicate filter suppresses its further advertisements, BlueZ expires the temporary device after 30 s, and from then on the keeper's lookup fails with "Device not found" for as long as the session lives — with the adapter still claiming to scan. On 2026-10-26 the Aquaris sat powered and advertising for an hour like that; a fresh `bluetoothctl scan on` found it within seconds.
- **The fix:** while the device is missing, the keeper throws away its scan and starts a fresh one with `DuplicateData=true` every 30 s, until the device appears. Logged once per outage. Skipped when BlueZ is unreachable or no adapter is powered; other programs' scan sessions are left alone.
- **Scan leak closed:** a scan the keeper opened on its own BlueZ D-Bus connection (the wedge probe's) could not be stopped by node-ble, so it kept running under the live link — the time-sharing that destabilises it. Every scan the keeper owns is now stopped the moment it connects.

### Aquaris / keeper — wedge kill switch (replaces the +28 "recovery")

- **A plug cycle does not recover the Aquaris.** After mains returns the unit powers up only when the button on its front is pressed, so the +28 premise was wrong. The plug is now a **kill switch**: it ends a wedged unit blowing at a frozen duty, it does not bring it back.
- **Verdict:** 5 minutes without hearing the device, held back only when our own Bluetooth is plainly unusable (BlueZ unreachable or no powered adapter). It deliberately does not require hearing other advertisers, so a quiet room cannot veto it. The Bluetooth adapter is never power-cycled.
- **Action:** cut the plug, hold 10 s (2 s is not enough — the unit rides it out on its capacitors), then switch it back on and keep retrying until confirmed, because the laptop's charging brick is fed through the same plug. One shot per outage (persisted), then a critical desktop notification: no cooling until the front button is pressed.
- **Plug wattage is no longer used as evidence** — it meters the laptop rather than the cooler. Fan duty is reported, never relied on.
- **Keeper state survives restarts:** the last applied fan state and the kill marker persist to `~/.config/tccaquaris/keeper-state.json`, since `status.json` drops its `applied` block on every failed tick.
- **Quieter journal:** the wedge watch and repeated identical tick errors log at most once a minute (a 42 h outage had written ~26 000 lines).

### `tcc` monitor

- **No more fiction when the link is down:** with no link the Aquaris panel shows `unknown (no link)` plus a `Wanted :` line, instead of printing the wish from `desired.json` as fact.
- **Plug state and control:** a `Plug :` line (polled every 5 s from `$KXTCC` / `~/.kxrc`), `s` to switch the plug on or off (confirmed when switching off), and full-width banners when the plug is off or the keeper has cut a wedged unit — both telling you to press the front button.

## 3.0.6+28 — 2026-07-23

The keeper now recovers a wedged Aquaris on its own, by power-cycling it through a Tasmota smart plug.

### Aquaris / keeper — firmware-wedge auto-recovery

- **The problem:** a dropped BLE link can wedge the Aquaris firmware — the fan freezes at its last duty
  while the device stops advertising, so it is unreachable over Bluetooth and can run at full blast for
  days if nobody is around to pull the plug (exactly what happened on 2026-07-20). The only cure is a
  power-cycle.
- **The fix:** the keeper watches for the wedge signature — *"Device not found" for at least 3 minutes
  straight*, **and** the smart plug reachable and reporting ON, **and** the fan on in the last state it
  successfully applied (the state a wedge freezes) — and then **power-cycles the unit through a Tasmota
  smart plug** (Nous A1T) on the LAN: `Power Off`, 5 s, `Power On`. The un-wedged firmware boots with the
  fan off, the keeper reconnects within seconds, and the autopilot resumes — a wedge now costs a few
  minutes of noise instead of days.
- **Deliberately conservative:** at most one power-cycle per 10 minutes; a wedge with the fan *off* is
  quiet and only logged; an unreachable or switched-off plug never triggers a cycle. If the plug's
  `Power On` confirmation is ever lost mid-cycle, a standing obligation retries it on every tick and
  blocks further cycles — the unit can never be left powered off.
- **Configuration:** the plug's IP is read from the `KXTCC` environment variable, falling back to a live
  parse of `~/.kxrc` (`export KXTCC=<ip>`) on every check — the keeper runs under `systemd --user`,
  which doesn't source shell rc files, and the live parse means an IP change applies without a keeper
  restart. With no `KXTCC` configured anywhere, the keeper behaves exactly as before.
- Plug wattage (`Status 8`) is logged alongside each wedge check for diagnostics, but no decision rests
  on it (the A1T's energy metering is uncalibrated out of the box).

## 3.0.6+27 — 2026-06-29

The manual Aquaris fan override now times out back to the autopilot, symmetric with the profile pause.

### Aquaris / keeper — manual fan override auto-resumes

- **A manual fan command is temporary again, not a one-way latch.** `tccaquaris on`, `off` and
  `fan <pct>` take over the Aquaris fan (setting `auto=false`), but they now stamp the moment they did so,
  and the keeper **re-arms autopilot fan-follow automatically** once the override has lasted longer than
  the autopilot's resume timeout. Previously a manual fan command disabled auto-follow *permanently*, so
  the Aquaris would sit idle under heavy load until an explicit `tccaquaris auto on` — exactly the
  "laptop fan screaming, Aquaris not turning on" failure this fixes.
- **One resume clock for both overrides.** The timeout is the same `resumeAfterSec` knob (default 5
  minutes) that governs the manual *profile* pause, so manual profile picks and manual fan picks now lapse
  on one consistent clock. The daemon publishes `resumeAfterSec` alongside the Aquaris fan target on D-Bus
  (`GetAquarisAutoTargetJSON`), so the keeper stays in lockstep with `/etc/tcc/settings`; it falls back to
  5 minutes if the daemon can't be reached, and `resumeAfterSec = 0` preserves the old "stay manual until
  re-enabled" behaviour.
- **Indefinite manual is still available.** `tccaquaris auto off` disables auto-follow *without* a
  timeout, so you can hold manual control for as long as you like; `tccaquaris auto on` resumes
  immediately. The `tccaquaris` status line now shows when a manual override is pending its revert.

## 3.0.6+26 — 2026-06-25

Stability fix for the headless Aquaris keeper.

### Aquaris / keeper — BLE link stability

- **Stop Bluetooth discovery once connected.** The keeper started scanning to find the device but never
  stopped, so the adapter kept *actively scanning while holding the connection* — the radio time-shares
  scan windows with the link, which causes spurious disconnects. A disconnect would then wedge the
  Aquaris firmware (the fan keeps running while the device stops advertising → unreachable, i.e. "stuck
  on while reporting off", recoverable only by power-cycling the unit). The keeper now stops discovery
  the moment it connects and only scans while actively searching for the device.
- **Rebuild the node-ble stack on a dropped link.** Every reconnect re-fetched the GATT characteristic on
  the same D-Bus connection, leaking an event listener each time (a `MaxListeners` warning and the keeper
  growing to minutes of CPU). The keeper now tears the whole node-ble stack down and rebuilds it fresh on
  a dropped link — once per drop, not per retry, so there is no churn during an outage — which also
  recovers a wedged Bluetooth adapter.

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

# Upstream tuxedo-control-center

# Changelog

## [3.0.6] - 2026-05-28
### Changed
- Tomte menu not available if version above 3.0.0

## [3.0.5] - 2026-05-22
### Changed
- Systeminfos: Use installed package if available, otherwise download latest version

### Fixed
- Profile manager save new profile button not working

## [3.0.4] - 2026-05-26
### Fixed
- Profile "Cool and breezy" not having intended max frequency limit
- Frequency configuration slider min/max values not being able to set lower/upper limit
- Stray connection attempts to spellchecker dictionary by disabling (unused) spellchecker

## [3.0.3] - 2026-04-16
### Fixed
- Hotfix for crypt password change, problematic characters restricted

## [3.0.2] - 2026-04-09
### Fixed
- Fan control for certain devices (most notably for InfinityBook Pro Gen9 AMD where one fan can get stuck on high speed in certain cases)
- System profiles support for InfinityBook Max 16 AMD
- Adjust default frequency limit for InfinityBook Pro Intel and InfinityBook Max Intel to not be limiting

## [3.0.1] - 2026-03-30
### Fixed
- Missing Aquaris menu on Stellaris Gen7

## [3.0.0] - 2026-03-25
### Added
- Wayland check for GPU selection
- Systeminfos file size check
- Missing increment/decrement buttons in edit profile
- Dev dependencies (esbuild, prettier formatter and biome linter)

### Changed
- Major internal frameworks updates
  - Electron 41
  - Angular 21
  - Node 24
  - Material design 3
  - chart.js 4
- Major internal restructure due to above changes (Electron context isolation, GUI adjustments for Angular/Material etc.)
- Fan control
  - Custom fan control draggable points GUI (instead of sliders)
  - Fan control CPU optimization
- Settings content width adjusts with window size
- Various aspects of GUI (font, font size, framing)
- Custom battery thresholds (where available) now using dropdowns (previously sliders)
- Async tccd background workers
- Extended error handling and logging

### Fixed
- Dashboard fan speed now always reflects sensor value, previously only showed set fan speed when fan control was active
- Dashboard now hides values when none are available (for example during suspend/wakeup)
- Crash of tccd due to EC timeout
- Access errors for keyboard backlight
- Fan speed for dGPU not shown in certain cases
- Global settings checkbox not representing actual state
- Cases of GPU selection in tray being incorrectly shown/hidden
- D-Bus related access errors
- Refreshrate worker trying to use empty values

## [2.1.23] - 2026-02-05
### Added
- Additional ID for Gemini 17 Gen4 Intel devices
- Desktop shortcut to TUXEDO category

### Fixed
- Non used platform profiles for InfinityBook Max Gen10 AMD
- Accidental wakeup of dGPU from reading display brightness in on-demand

## [2.1.22] - 2025-12-19
### Added
- Quirk for Gemini Gen4 Intel using CPU EPP `performance` instead of default `balance_performance`
- GPU hybrid graphics selection identification for InfinityBook Max Gen10 AMD

### Fixed
- Workaround for profile generation when intel_pstate no_turbo is unavailable (Gemini Gen4 Intel)
- Take min/max frequency over all cores instead of using core 0 as reference

## [2.1.21] - 2025-11-26
### Added
- "TCC" keyword to desktop-file

### Changed
- "Remote support" removed from support area

### Fixed
- Default "System profile" in some cases not being the highest performing one
- Text tweaks and typos

## [2.1.20] - 2025-09-10
### Fixed
- Revert the Sirius "start TCC" shortcut due to an issue with keyboard input in certain applications in Wayland

## [2.1.19] - 2025-09-08
### Added
- Aquaris support for Stellaris Gen7
- Extra "start TCC" shortcut key F14 to support the Sirius gauge key (on Wayland)

### Fixed
- Issue with "System profiles" not changing power limits for InfinityBook Pro Gen10 AMD

## [2.1.18] - 2025-08-01
### Added
- Dashboard support for new AMD iGPUs (IBP Gen10 AMD)
- Dashboard support for new Intel iGPUs (Stellaris Gen7 Intel)

### Fixed
- Systeminfos: Ticket number format hint
- Suspend for certain devices where wakeup fails when cores are disabled
- Non used platform profiles for IBP Gen10 AMD

## [2.1.17] - 2025-07-10
### Fixed
- Download of system diagnostics script failing, URL adjusted

## [2.1.16] - 2024-12-18
### Changed
- Descriptive text when no keyboard backlight control is found updated to reflect current
  expectation on driver and kernel versions

### Fixed
- Various amd-pstate related issues known to happen when limiting CPU frequency in different
  ways, modified to comply with current kernel feature behaviour
  and to workaround current kernel bugs

## [2.1.15] - 2024-12-09
### Added
- Aquaris support for missing Stellaris 16 Gen6 variants

## [2.1.14] - 2024-11-18
### Added
- Temperature readout from alternative Sirius interface (prep for fan control support)

### Changed
- Crypt password change adjustments, now allows up to 512 characters

## [2.1.13] - 2024-08-05
### Fixed
- Various cases of where, sometimes, power limit sliders would
  prevent actually saving TCC-profile even though it looked like it
  had been saved

## [2.1.12] - 2024-07-04
### Fixed
- TCC GUI with Aquaris does not start when using Aquaris tray menu entry

## [2.1.11] - 2024-06-11
### Fixed
- Packaging would in some cases produce hard links

## [2.1.10] - 2024-06-05
### Added
- Pulse Gen3 & Gen4 dashboard iGPU support
- Pulse Gen4 power profile changed to TDP value slider view at TCC Profile edit

### Changed
- Pulse Gen3 & Gen4 power profile TDP values adjusted according to firmware update

### Fixed
- Show hwmon based dashboard info even if fan control is not available

## [2.1.9] - 2024-05-25
### Added
- NVIDIA cTGP (configurable TGP) adjustable per TCC profile for supported models
  with this feature enabled
- Enable Aquaris menu for Stellaris Gen6
- Support for new PWM fan control

### Fixed
- Use device specific defaults for new profile
- Build script touchups

## [2.1.8] - 2024-04-03
### Added
- Support for Stellaris Intel Gen6
- Alternative view of _profile edit => system profile_ displaying
  power limit info instead of profile name, introduced for
  Pulse Gen3
- Alternative display of temperatures in fahrenheit switchable in Global settings

### Changed
- Critical temperature (aka minimum speed for high temperatures) of
  fan control split into two ranges: from 80&deg;C 30% and from
  90&deg;C 40%

### Fixed
- Irregular fan speed on wakeup or when disabling fan control,
  sometimes manifesting as full fan on wakeup from suspend
- Issue in on-demand mode keeping dGPU awake in certain cases even
  after closing dashboard/GUI
- Minor performance improvement fixes
- Occasional crash on reload provoked through tuxedo-driver
  package update
- Occasional race condition stability fix when GUI loading before the tccd DBus
  is initialized (manifesting as missing profiles in tray menu)

## [2.1.7] - 2024-02-22
### Fixed
- Always restoring keyboard backlight brightness to zero after lid close

## [2.1.6] - 2024-02-13
### Added
- Appstream metainfo for packaging
- Support for Pulse Gen3 keyboard backlight

### Fixed
- Webcam view throwing errors not being able to open webcam (most notably on Pulse Gen3)
- Dashboard
  - Missing GPU sensor values
  - Sensor value missing when actually only zero
  - Alternate display for low numbers instead of rounding down
- RPM package upgrade ending up without executable link in /usr/bin

## [2.1.5] - 2024-01-25
### Fixed
- CPU frequency limits not working for devices using amd-pstate-epp cpufreq driver

## [2.1.4] - 2024-01-18
### Fixed
- Fan control issue manifesting as missing temp and speed in dashboard

## [2.1.3] - 2024-01-16
### Added
- Support for Aquaris Gen6

### Fixed
- Custom fan mode. Fixes certain cases where custom fan table did not
  get applied, throwing errors in log, etc.
- Disconnection of other bluetooth devices while scanning for Aquaris.

## [2.1.2] - 2023-12-21
### Added
- Support for Sirius keyboard backlight
- Support for Sirius system profiles

### Fixed
- Issue on tccd start causing one thread to get stuck on full load blocking the initialization for an extended amount of time
- .Xauthority file not found causing excessive tccd log output

## [2.1.1] - 2023-12-13
### Added
- Laptop screen refresh rate configurable per TCC profile allowing
  configuration of reduced refresh rate in battery operation
- Fn-lock status viewable and changeable in the tray menu for
  supported devices
- Dashboard is extended with CPU and GPU power usage info
  - CPU power usage is displayed where available in the CPU section
  - GPU section now shows iGPU or dGPU (or both) depending on graphics mode
  - GPU section also showing power usage and current frequency where available
- Charging thresholds (for supported devices) in the Settings => Battery Charging Options area
  - Allows fine-tuning of how the battery is charged in the form of start and end thresholds
  - Available to choose from three preset profiles plus a custom mode where the thresholds are freely configurable
- Fan profiles extended with further options
  - Maximum fan speed parameter to adjust the preset profiles
  - All-new custom fan mode that allows configuring of a special fan profile in nine temperature ranges

### Changed
- Rework of GPU selection in tray menu and additionally added to GUI in Settings => Graphics switching

## [2.0.11] - 2023-11-10
### Fixed
- Missing profiles for InfinityBook Pro Gen8

## [2.0.10] - 2023-10-26
### Added
- Support for Polaris/Stellaris AMD Gen5

## [2.0.9] - 2023-09-22
### Added
- Support for Aura Gen3 (default mobile profile)

## [2.0.8] - 2023-07-14
### Added
- Four-zone keyboard backlight GUI support
- Profile definitions for InfinityBook Pro 16 Gen8

### Changed
- Zoned keyboard backlight GUI design + usability improvements
- Extended GUI info text in case keyboard backlight control is not found

### Fixed
- Occasionally not recognized keyboard backlight

## [2.0.7] - 2023-05-23
### Added
- Clarifying info text + link added to battery charging profiles
- Default profiles for IBP Gen8

### Fixed
- Wrong keyboard backlight restored after LID wakeup
- Keyboard backlight GUI hover color
- Tweaks to GUI loading

## [2.0.5] - 2023-05-04
### Fixed
- Keyboard backlight for Stellaris Gen5 membrane version
- Buffered write for keyboard backlight where available
  (should greatly speed up keyboard painting for supported devices)

## [2.0.4] - 2023-04-25
### Added
- Support for Stellaris 16 Gen5

### Fixed
- Keyboard backlight color picker missing styles and dark mode

## [2.0.2] - 2023-03-28
### Fixed
- Keyboard backlight detection for certain devices like Stellaris and Fusion
- Keyboard backlight paint order
- Various text and translation adjustments
- Error on acpi-cpufreq boost parameter validation
- Now correctly blurs cpu freq settings when globally disabled

## [2.0.0] - 2023-03-22
### Added
- Keyboard backlight GUI (Tools => Keyboard backlight)
  - Set brightness
  - Set color for single zone RGB keyboards
  - Set colors for three-zone RGB keyboards
  - Implements part of linux' `/sys/class/leds` interface: `kbd_backlight` for (single brightness, multi color/intensity)
  - Restore last settings on boot
- Webcam settings (Tools => Webcam)
  - A number of useful and non-useful parameters exposed to tweak and play around with
  - Preview of webcam picture while tweaking
  - Save and restore presets
  - Chosen preset restored on boot or reconnect of device
- Tomte GUI (Settings => Tomte)
  - Graphical interface to TUXEDO Tomte
  - Exposes most of the knobs Tomte allows you to configure such as
    - Choose operation mode
    - View which modules are applied for your device
    - Change behaviour of modules
- Backup profile settings
  - Exporting current custom profiles to file
  - Importing custom profiles from file

### Changed
- TDP slider validation behaviour now moves other sliders accordingly instead of limiting currently changed slider
- Removed CPU settings tabs and consequently allowing setting CPU TDP and CPU frequency settings simultaneously
- Battery charging settings icon replaced
- Tools icon replaced

### Fixed
- Temporary set profile retained when saving tccd settings or profiles
- Fixes related to keeping and re-applying profiles on save

## [1.2.5] - 2023-03-03
### Fixed
- Certain icon sizes and alignment
- Theme colors sometimes not being applied correctly (like in dropdown menus)
- Support ticket number validation range extended

## [1.2.4] - 2023-01-11
### Changed
- Display backlight brightness now only set when explicitly chosen in profile

### Fixed
- Inadvertently blended out profile edit system control area now visible again
- Fan availability conditions tweaked to not falsely show fan control for
  unsupported devices

## [1.2.3] - 2022-12-21
### Added
- Battery charging options for a number of devices
  - Choose one of three "charging profiles" to influence peak charge and charging time
  - Choose whether to prioritize charging or performance when on USB-C PD
  - For now available through "Settings" => "Battery charging options" (for devices with this feature)
  - Tray shortcut coming soon

### Changed
- Dark/light mode adjustments
  - Now three options available light, dark and "system setting".
  - System setting attempts to use advertised system theme mode when
    choosing TCC theme.
  - Also fixes some GUI details (like scrollbars) that were not rendered in the correct theme
- Config reload/save logic of `tccd` no longer requires restart of service

### Fixed
- Core available check on setting validation (should prevent some log
  messages when cores are disabled)
- `xrandr` output on systeminfos execution
- Disable cpu min/max freq validation for `intel_pstate` while interface is bugged

## [1.2.2] - 2022-10-17
### Changed
- Fan control logic tweaks and fixes

## [1.2.1] - 2022-10-14
### Changed
- TDP Label text adjustments (EN)

### Fixed
- Old boost workaround for devices where max frequency is not available
  broke frequency set GUI on newer AMD devices where the scaling driver is
  `amd-pstate`. This has been fixed and the new driver allows more variable
  frequency limits (similar to `intel_pstate`).
- Frequency settings save fixed on some devices where TDP control is not available

## [1.2.0] - 2022-10-10
### Added
- Support for system profile selection for a number of devices like
  - BA1501
  - Pulse 14/15 Gen 1
  - Polaris gen 1
- Support for multiple TDP selection for a number of devices like
  - Infinitybook Pro 14 Gen 6/7
  - Pulse 15 Gen 2
  - Polaris Gen 2/3
  - Stellaris Gen 2/3/4
- TCC-profile description
- Support for per-device profiles
  - Old profiles stay for most devices
  - New default profiles for TDP control capable devices

### Changed
- Password prompt improvements.
  - If asked to change settings to `tccd` there will not be another prompt for awhile.
  - More descriptive password prompt text
- Profile edit layout adjustments
- Profile overview refresh
  - Overview now shows profile description initially
  - Button added to activate profile temporarily
  - Overlay to assign profiles to states removed
  - Switchable between "description view" and detailed view for
    profile comparison
- Dashboard slimmed down

## [1.1.8] - 2022-10-06
### Added
- Checks to detect a valid ticket number to send with the systeminfos
  plus info about what could be missing or wrong

### Changed
- Re-enable fan control for Stellaris AMD Gen 4
- Fan control logic change for newer devices taking into account
  min fan speed and fan off possibility from driver

## [1.1.7] - 2022-09-19
### Added
- Basic support for Stellaris AMD Gen 4

## [1.1.6] - 2022-08-01
### Changed
- Packaging dependency tweaks (RPM) for wider compatibility

## [1.1.5] - 2022-07-15
### Added
- TUXEDO Aquaris control
  - Fan speed presets
  - Fan speed manual set (slider + input)
  - LED RGB color picker
  - LED static/rainbow mode picker
  - LED breath checkbox
  - Assign custom name to find device easier
  - Save/restore last used configuration
  - Links and notices to online instructions on how to use the device

## [1.1.4] - 2022-04-21
### Changed
- First steps of basic dependency/framework updates
  - Electron 13
  - Node 14
  - Angular 10

### Fixed
- Ubuntu 22.04 KDE with nvidia based systems sometimes refused to start TCC gui

## [1.1.3] - 2022-04-01

### Changed
- Dependencies on `libappindicator3-1` switched to `libayatana-appindicator3-1` (DEB + RPM)
- Alternative dependency on `libappindicator` for fedora (RPM)

### Fixed
- AMD boost max frequency workaround patched

## [1.1.2] - 2021-12-07

### Fixed
- Unable to assign profile to state on profile overview

## [1.1.1] - 2021-11-26

### Changed
- Updated packages/dependencies

### Fixed
- Crypt: Fix for inconsistent behaviour of listing/detecting encrypted drives
- Profile GUI input name related tweaks

## [1.1.0] - 2021-08-26
### Added
- Profiles: *System profile* selection for TCC profiles for certain devices (more to come).
  The system profiles usually affect power allowance and sometimes fan control when not
  using the TCC fan control.
- Profiles: Fan control parameter *Minimum fan speed* applied to existing fan curves.
- Profiles: Fan control parameter *Offset fan speed* applied to existing fan curves.
- Togglable visualization of fan curves.
- AMD (amdgpu): Chroma subsampling activation for external displays (experimental).
  Usable on many AMD CPU devices without discrete graphics card.
- Tray: Menu option to activate a profile temporarily.
- Tray: Menu option to toggle temporary powersave prevention.
- Tools: GUI for changing crypt password.
- Option to turn off TCC fan control in global settings.
- Option to turn off TCC CPU control in global settings.

### Changed
- TCC GUI title now using window manager default title.
- Better hiding of not available options for clarity both regarding
  available devices and features for these.
- Theme selection moved to settings.
- *Settings* button moved from tools to menu side.

### Fixed
- *Cool and breezy*/*Extreme powersave* profiles that in certain cases did not apply
  the CPU limits properly.
- Unreliable CPU info max freq for AMD devices sometimes yields max non boost freq
  sometimes boost freq and sometimes a seemingly random number depending on which
  kernel used around 5.11. Now changed to consistently use available freqs.

## [1.0.14] - 2021-05-20
### Added
- Systeminfo clarifications
  - Third clear *done* step when finished sending
  - Blurring while asking for password/working
  - Not possible to send again without going through *step 1*

### Fixed
- Systeminfo environmental variable passthrough
- Deb install message that looked like an error now hidden
- Adjust GUI window width/height if working screen area
  is found to be smaller than the default width/height
- Minimize icon size

## [1.0.13] - 2021-04-23
### Changed
- Max frequency for AMD CPUs clarified as 'boost' instead of max
  base frequency. Additionally now max frequency for these devices can be
  set to max base frequency with or without boost.
- Now using 'same speed' approach for fan control on all devices. This means
  that the same speed will be used for all fans. The speed written will be
  the highest decided from each individual sensor. This should better
  share the cooling between multiple fans where available.
- Fantables updated
  - Minimum 'on' fanspeeds now at 20% to make sure fans start better over all
  - Freezy fan profile now always on and even more freezy for those
    warm spring days

### Fixed
- Fan control for certain devices (like XP14 version without nvidia) where
  there is not one temp sensor per fan

## [1.0.12] - 2021-04-09
### Changed
- Default ODM perf. profile *performance* for some devices when returning fan control to the system

### Fixed
- *Shutdown timer* now uses standard `shutdown` functionality/logic
- Profile edit frequency slider missing update
- Profile overview selected profile update issue

## [1.0.11] - 2021-02-25
### Fixed
- More robust check for nvidia prime support
- Install autostart for new users (and in FAI)
- Fixed automatic restart after update having weird side effects,
  still needs one more (manual) restart of GUI before taking effect

## [1.0.9] - 2021-01-28
### Added
- Profile CPU setting "Maximum performance" now allows governor performance use

## [1.0.8] - 2020-12-11
### Changed
- Now uses interface from the `tuxedo-io` module in `tuxedo-keyboard` package instead of `tuxedo-cc-wmi`
- As of the transition to `tuxedo-io` newer devices like the *InfinityBook S 14 Gen6* are supported as well

### Fixed
- Fan control fail when tccd loads before kernel interface module
- Tray enable autostart when config folder is missing
- Writing to unwritable intel noTurbo parameter

## [1.0.7] - 2020-10-27
### Fixed
- Minor text adjustments
- RPM packaging, files conflicting with other packages

## [1.0.6] - 2020-10-08
### Changed
- Backlight brightness workarounds
  - Scaling fix for amdgpu bl
  - Tweak for slow driver loading or drivers that
    are not ready when presenting their interface

## [1.0.5] - 2020-09-29
### Added
- Fan control support for more devices with multiple fans (Polaris, Pulse)
- Added graphics selection (prime-select) tray options

## [1.0.4] - 2020-08-26
### Added
- New *Tools* area with shutdown timer feature
- Reintroducing state selection at profile edit
- Reintroducing profile copy

### Fixed
- Slightly changed behaviour of dashboard gauges to
  attempt to reduce CPU load
- Restart GUI when TCC is updated

## [1.0.3] - 2020-06-23
### Added
- Support for new devices
- Basic tray icon (optional autostart)
- Global keyboard shortcut (Tux+Alt+F6) to start

### Changed
- Revised fan tables for existing fan profiles
- New fan profile *Silent*
- New fan profile *Freezy*
- Cool & Breezy now uses the *Quiet* fan profile
- Powersave extreme now uses the *Silent* fan profile

## [1.0.2] - 2020-05-25
### Changed
- Default governor choice matched to the current cpufreq driver
  Results in better support for non-intel processors
- Make use of `scaling_available_frequencies` to limit choice (of frequencies)
- Change default profiles to take more dynamic values depending
  on available frequencies (minor differences to existing default profiles)

### Fixed
- State switching issue (failure to read power supply online value)
- AMD GPU backlight driver read brightness workaround

## [1.0.1] - 2020-04-16
### Fixed
- Read error for sysfs backlight path (when changed after tccd startup)

## [1.0.0] - 2020-04-08
### Added
- Packaging dependencies

### Changed
- Fix for visibility of GPU gauges on some models without GPU
- png -> svg icon for desktop/task bar

## [0.9.1] - 2020-03-30
### Changed
- Renaming adjustments of tuxedo-wmi -> tuxedo-cc-wmi

## [0.9.0] - 2020-03-26
### Added
- Systems availability checks
- Blending of features in backend on missing wmi control

### Changed
- Various size and theme color tweaks
- Fan control algorithm (added sensor input filtering)

### Fixed
- Inactive (but used) profile dot visibility
- Disable changing inactive profile options

## [0.8.2] - 2020-03-18
### Changed
- Tweaks and fixes for review

## [0.8.1] - 2020-03-17
### Changed
- Latest design adjustments

## [0.8.0] - 2020-03-06
### Added / Changed
- New control through tuxedo-wmi module
- Most of the new design implemented

## [0.7.4] - 2019-12-09
### Added
- Theme switching
- Light/dark theme for testing & toggling

## [0.7.3] - 2019-12-02
### Changed
- Preset profile changes
- Removed *Fast and furious*
- *Cool and breezy* now has all cores but disabled turbo
- *All cores powersave* is now *Powersave extreme*
    with minimum clock and disconnected webcam

### Fixed
- Package upgrade: RPM
- Package remove: Delete config files
- Package upgrade: Do not delete logs

## [0.7.0] - 2019-11-29
### Added
- Language support
- German translation
- Licencing GPLv3

### Changed
- Profile setting name change "No Turbo" changed to Turbo
- Various packaging tweaks

## [0.6.3] - 2019-11-18
### Fixed
- Temperature reporting

## [0.6.2] - 2019-11-18
### Added
- CPU dashboard
- DBus service and client

### Removed
- Old CPU settings

## [0.6.1] - 2019-11-08
### Fixed
- Changelog asset path

## [0.6.0] - 2019-11-08
### Added
- Basic fan control integration
- Slight fan control logic modification
- Fan profiles assignable to TCC profiles
- Info area with changelog and general app version information

## [0.5.3] - 2019-10-24
### Fixed
- Added missing enforcing of no_turbo setting

### Changed
- Phone number in support area

## [0.5.2] - 2019-10-23
### Changed
- Webcam control logic. Webcam control should now work more consistenly.
- CPU frequency settings will no longer be enforced when no_turbo is activated
  to prevent constant writing of settings.

## [0.5.1] - 2019-10-22
### Added
- Webcam status icon to profile overview tiles

### Changed
- Profile details true/false status strings to more meaningful values

## [0.5.0] - 2019-10-22
### Added
- USB devices controller (logic only)
- Profile manager -> profiles overview tiles
- Profile overview button
- Profile filter on All, Preset, Default and In use
- Profile name input box on details page (activated for custom profiles)
- Webcam control (on / off) from profiles

### Changed
- Profile manager selected (viewed) profile is now mainly changed through clicking the
  overview tiles. Selected profile can be deselected via "profile overview" button.
- Main nav "active profile" entry now links to the profile overview tiles
- Profile save moved to profile manager toolbar
- Profile state choices moved away from profile manager toolbar to profile details
  similar to the profile overview tiles
- Profile save now saves chosen state (multiple possible) as well
- Profile save now saves profile name as well

## [0.4.0] - 2019-09-20
### Added
- State logic to daemon and GUI.
- Current states are 'Mains powered' and 'Battery powered'
- Buttons for assigning a profile to a state in profile manager

### Changed
- Single active profile setting changed to one active profile per state
- Profile dropdown moved to profile manager
- Buttons refreshed and labels replaced with icons in profile manager

### Removed
- Activate single state button

## [0.3.1] - 2019-09-18
### Added
- FEATURES.md aka general feature list
- CHANGELOG.md Basic changelog from start of versioning
- Icon to main nav exit option
- 'Discard' button for CPU profile edit

### Changed
- Current CPU frequency values are now periodically checked with active profile and rewritten if found not to be the same.
- 'Save' button on CPU profile edit relocated

## [0.3.0] - 2019-09-11
### Added
- Support feature
- systeminfos.sh download and run functionality to support area
- Anydesk install from repo and run functionality to support area
- Icons to support feature
- Icons to the main navigation

## [0.2.1] - 2019-09-05
### Added
- Fallback for displayed brightness value change. Now reads from sysfs when known dbus is not available.
- More info about backlight driver and used dbus interface

### Changed
- Application of new CPU frequency profile now sets default values for all parameters first. Then applies parameters to all cores while all cores are still online. Then disables any cores.

## [0.2.0] - 2019-09-03
### Added
- GUI for display brightness
- Functionality for tracking and controlling current brightness thorugh dbus (in GUI, for gnome only)
- Edit custom profile display brightness settings

### Changed
- Tweaks to profile manager buttons
- ESC to cancel profile name input
- More responsive update of CPU min/max frequency slider values

### Fixed
- Now disallows deleting the last custom profile to prevent emtpy custom profile list

## [0.1.2] - 2019-08-29
### Changed
- Modifications to nav menu
- Tweaks to profile-manager buttons

## [0.1.1] - 2019-08-29
### Changed
- Replace 'default' strings for default profile values with machine specific values
- Visual adjustments to cpu-settings
- Modified current editing profile logic
- Adjusted profile manager buttons

## [0.1.0] - 2019-08-28
### Added
- Profile manager feature
- Basic rename profile functionality

## [0.0.2] - 2019-08-26
### Added
- CPU frequency feature
- Editing CPU frequency features for custom profiles
- Viewing configured and "live" info from cores
- Comparing default profiles
- Basic tuxedo theme css template

## [0.0.1] - 2019-08-29
### Added
- Versioning (start of dev test versions)
- Basically start of the GUI with basic CPU frequency list for cores and Angular material framework

### Implementation before versioning
- Daemon
- Project structure
- Development features
- Etc.
