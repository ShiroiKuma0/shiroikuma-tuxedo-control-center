/*!
 * Copyright (c) 2019-2026 TUXEDO Computers GmbH <tux@tuxedocomputers.com>
 *
 * This file is part of TUXEDO Control Center.
 *
 * TUXEDO Control Center is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * TUXEDO Control Center is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with TUXEDO Control Center.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Shared "Aquaris link" — holds the single BLE connection to the Aquaris
 * (LCT21001 / LCT22002) and continuously applies a desired state from
 * ~/.config/tccaquaris/desired.json. Used by BOTH the GUI (role 'gui') and the
 * bundled keeper service (role 'keeper').
 *
 * Ownership (keeper-authoritative): the KEEPER is the default owner — it
 * heart-beats ~/.config/tccaquaris/owner.lock (owner='keeper') on a steady timer
 * and NEVER yields to the GUI. The GUI is a hot standby: it only drives the
 * device while the keeper's lock is stale/absent (keeper stopped/crashed), plus a
 * short boot-race grace. Both apply the same desired.json (the tccaquaris CLI and
 * the GUI controls just edit that file), so the GUI loses nothing by deferring —
 * the keeper applies its changes within ~1.5 s.
 *
 * Rationale: the previous GUI-priority hand-off could deadlock — an autostarted
 * tray GUI would grab the lock and, if it then couldn't connect to the device,
 * hold the lock forever while the keeper yielded, leaving the Aquaris
 * uncontrolled with nobody present. Keeper-authoritative cannot starve: a wedged
 * GUI simply defers, and the keeper keeps (re)trying and owns status.json.
 *
 * Clean disconnect (no LCT 'reset' frame) is used on defer/stop so the pump/fan
 * keep running through any brief gap. The device firmware lights the LED blue
 * while powered + unconnected; the idle desired state is LED off.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as dbus from 'dbus-next';
import type * as NodeBle from 'node-ble';
import { createBluetooth } from 'node-ble';

export type AquarisRole = 'gui' | 'keeper';

export interface AquarisDesired {
    red: number;
    green: number;
    blue: number;
    ledMode: number;
    fanDutyCycle: number;
    pumpDutyCycle: number;
    pumpVoltage: number;
    ledOn: boolean;
    fanOn: boolean;
    pumpOn: boolean;
    // Autopilot (fork): when true, the daemon's auto fan target overrides the
    // fan fields below (LED/pump stay user-controlled).
    auto?: boolean;
    // Epoch ms of the last manual fan override (tccaquaris on/off/fan). While this
    // is set and auto is false, the keeper re-arms auto=true once resumeAfterSec
    // has lapsed, so a manual fan tweak reverts to the autopilot on its own.
    // `tccaquaris auto off` clears it (explicit, indefinite manual).
    manualFanTs?: number;
}

interface AquarisAutoTarget {
    enabled: boolean;
    fanOn: boolean;
    fanDutyCycle: number;
    // Seconds a manual fan override persists before the keeper re-arms auto-follow
    // (mirrors the daemon's resumeAfterSec). Absent => keeper uses DEFAULT_RESUME_SEC.
    resumeAfterSec?: number;
}

interface OwnerLock {
    owner: string;
    pid: number;
    ts: number;
}

/** What BlueZ says about our own radio — the control for the wedge verdict. */
interface BleProbe {
    powered: boolean;
    discovering: boolean;
    othersSeen: number;
    adapterPath: string | undefined;
}

const NORDIC_UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NORDIC_UART_TX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

const CFG_DIR: string = path.join(os.homedir(), '.config', 'tccaquaris');
const DESIRED_FILE: string = path.join(CFG_DIR, 'desired.json');
const STATUS_FILE: string = path.join(CFG_DIR, 'status.json');
const LOCK_FILE: string = path.join(CFG_DIR, 'owner.lock');
// What the keeper must remember across its own restarts. status.json cannot
// serve: a failed tick rewrites it without the `applied` block, so the last
// known device state is gone the moment it is needed.
const KEEPER_STATE_FILE: string = path.join(CFG_DIR, 'keeper-state.json');

const POLL_MS = 1500;
const STALE_MS = 4000;
// GUI defers to the keeper for this long after the GUI starts, so the keeper
// (which autostarts at login too) wins the boot race and the GUI never grabs
// the link out from under it.
const STARTUP_GRACE_MS = 6000;
// Fallback for the manual-fan-override resume timeout when the daemon's
// resumeAfterSec can't be read over D-Bus (matches defaultAutopilotSettings).
const DEFAULT_RESUME_SEC = 300;

// ---- Wedge kill switch via a Tasmota smart plug ----------------------------
// A dropped BLE link can wedge the Aquaris firmware: the fan freezes at its last
// duty and the device stops advertising, so it is unreachable, uncontrollable,
// and blows at that duty for as long as it has power. That is what the plug is
// for — and it is a KILL SWITCH, not a recovery. Cutting and restoring mains
// does NOT bring the unit back: it powers up only when the button on its front
// is physically pressed. So the keeper can end a runaway fan but never undo it;
// restoring the unit is a human job (press the button), and the keeper says so
// loudly when it cuts power.
//
// The power chain is: plug -> laptop's charging brick -> Aquaris -> laptop.
// Measured 2026-07-26, and it shapes everything here:
//   - The plug is switched back ON after the cut, and pass-through keeps the
//     LAPTOP charging even with the Aquaris dead (AC0=1, 46-75 W observed for
//     minutes with the unit off). So a kill costs no uptime — but the plug must
//     never be left off, hence the restore obligation.
//   - Therefore plug WATTAGE SAYS NOTHING about the Aquaris. What it meters is
//     overwhelmingly the laptop: ~80 W with the unit running is indistinguishable
//     from 46-75 W with it dead. An earlier draft gated the kill on a calibrated
//     "is it still drawing power" check; that check was reading the wrong device
//     and has been removed. Do not reintroduce it.
//   - A false positive is cheap: if the unit was already off, cutting power to it
//     changes nothing and the laptop keeps charging. That is why 5 minutes of
//     silence is enough on its own.
//   - The BLE adapter is NEVER power-cycled. An earlier draft did that one second
//     before the cut and the machine hard-killed; the plug cycle itself was then
//     cleared by test (5x short cuts and a 10 s cut that genuinely killed the
//     unit, all survived), leaving the adapter reset as the only suspect.
//
// The plug's IP comes from the KXTCC environment variable, falling back to
// a live parse of ~/.kxrc (the keeper runs under systemd --user, which does not
// source shell rc files), so an IP edit there applies without a keeper restart.
const KXRC_FILE = path.join(os.homedir(), '.kxrc');
// Sustained "Device not found" before the wedge verdict may be reached. Short
// on purpose: the verdict does not rest on waiting, it rests on corroboration
// (below), so there is nothing to gain by letting a stuck fan run longer.
const WEDGE_ABSENT_MS = 5 * 60 * 1000;
// Don't probe or report anything until the outage outlasts an ordinary reconnect.
const WEDGE_QUIET_MS = 60 * 1000;
// A BLE scan window long enough for other advertisers in the room to show up.
const BLE_PROBE_SCAN_MS = 15 * 1000;
// How long the plug stays off during a kill. Measured 2026-07-26: a 2 s cut is
// NOT enough — the Aquaris rides it out on its capacitors and reconnects — while
// 10 s reliably puts it down.
const PLUG_OFF_HOLD_MS = 10 * 1000;
// The periodic "still stuck" line is the only trace an outage leaves, but at
// one per failed tick it buried the journal (~10/min for as long as the outage
// lasts). Emit it, and repeats of an unchanged tick error, at most this often.
const WEDGE_LOG_INTERVAL_MS = 60 * 1000;
const PLUG_HTTP_TIMEOUT_MS = 5000;

const BLUEZ_BUS_NAME = 'org.bluez';
const BLUEZ_ADAPTER_IFACE = 'org.bluez.Adapter1';
const BLUEZ_DEVICE_IFACE = 'org.bluez.Device1';

const DEFAULT_DESIRED: AquarisDesired = {
    red: 0,
    green: 119,
    blue: 255,
    ledMode: 0,
    fanDutyCycle: 50,
    pumpDutyCycle: 60,
    pumpVoltage: 3,
    ledOn: false,
    fanOn: false,
    pumpOn: false,
    // Default ON: a fresh/reset desired.json follows the tccd autopilot. A manual
    // `tccaquaris on|off|fan` sets auto=false explicitly to take over; `auto on` resumes.
    auto: true,
};

const TCCD_BUS_NAME = 'com.tuxedocomputers.tccd';
const TCCD_PATH = '/com/tuxedocomputers/tccd';

function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void): NodeJS.Timeout => setTimeout(resolve, ms));
}
function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, Math.round(Number(n))));
}
function readJson<T>(file: string): T | null {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch (_e: unknown) {
        return null;
    }
}

export class AquarisLink {
    private readonly mac: string;
    private stopping = false;
    private yielding = false;
    private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    private bluetooth: NodeBle.Bluetooth | undefined;
    private destroyBt: (() => void) | undefined;
    private adapter: NodeBle.Adapter | undefined;
    private device: NodeBle.Device | undefined;
    private uartTx: NodeBle.GattCharacteristic | undefined;

    private applied: { led?: string; fan?: string; pump?: string } = {};
    private startedAtMs = 0;

    // Autopilot (fork): lazy system-bus link to tccd for the auto fan target.
    private tccBus: dbus.MessageBus | undefined;
    private tccIface: dbus.ClientInterface | undefined;

    // Wedge detection (fork): when the "Device not found" streak started, what the
    // device was last known to be doing, and what it draws when healthy. The fan
    // fields and the baseline are persisted (KEEPER_STATE_FILE) because they can
    // only be refreshed by a successful apply — an outage that outlives a keeper
    // restart would otherwise start with no knowledge at all, which is exactly
    // what happened on 2026-07-26.
    private deviceAbsentSinceMs: number | undefined;
    private lastAppliedFanOn = false;
    private lastAppliedFanDuty = 0;
    // Set the moment we cut power, cleared only by a successful apply (i.e. the
    // unit is genuinely back). Without it the kill repeats every WEDGE_ABSENT_MS
    // forever: the plug feeds the laptop's charging brick, so the draw stays high
    // after the Aquaris is dead (that draw is the laptop) and the verdict would
    // otherwise re-fire forever.
    private killedAtMs: number | undefined;
    // A restore whose "Power On" confirmation failed leaves an obligation: the
    // same brick powers the laptop, so the plug must never be left off.
    private plugRestorePending = false;
    private lastWedgeLogMs = 0;
    private lastTickErrorLogMs = 0;
    private lastTickErrorMsg = '';
    private bluezBus: dbus.MessageBus | undefined;

    constructor(
        private readonly role: AquarisRole,
        mac?: string,
    ) {
        this.mac = mac ?? process.env.AQ_MAC ?? 'EE:5E:11:D8:5A:B5';
    }

    public start(): void {
        try {
            fs.mkdirSync(CFG_DIR, { recursive: true });
            if (!fs.existsSync(DESIRED_FILE)) {
                fs.writeFileSync(DESIRED_FILE, JSON.stringify(DEFAULT_DESIRED, null, 2));
            }
        } catch (_e: unknown) {
            /* ignore */
        }
        if (this.role === 'keeper') {
            // Recover what we knew about the device before this process existed —
            // an outage can easily outlive a keeper restart.
            this.loadKeeperState();
            // The keeper is the authoritative owner: claim immediately and heart-beat
            // the ownership lock on a steady 1 s timer, decoupled from the (sometimes
            // slow) BLE connect/apply loop — so a slow connect can't let the lock go
            // stale and let the GUI wrongly grab the link.
            this.writeLock();
            this.heartbeatTimer = setInterval((): void => this.writeLock(), 1000);
        } else {
            // GUI hot standby — record start for the boot-race grace.
            this.startedAtMs = Date.now();
        }
        this.log(`AquarisLink starting (role=${this.role}, mac=${this.mac})`);
        void this.loop();
    }

    public async stop(): Promise<void> {
        this.stopping = true;
        if (this.heartbeatTimer !== undefined) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        // Don't delete the lock here: the keeper's heartbeat simply stops, so the
        // lock goes stale within STALE_MS and the GUI standby takes over — while a
        // quick service *restart* (< STALE_MS) keeps the lock fresh and avoids churn.
        await this.disconnect('stop');
        try {
            this.destroyBt?.();
        } catch (_e: unknown) {
            /* ignore */
        }
        this.writeStatus({ owner: null, connected: false, error: `stopped (${this.role})` });
    }

    // ---- main loop ----------------------------------------------------------
    private async loop(): Promise<void> {
        while (!this.stopping) {
            try {
                await this.tick();
            } catch (e: unknown) {
                const msg: string = e instanceof Error ? e.message : String(e);
                this.writeStatus({ owner: this.role, connected: false, error: msg });
                await this.dropIfDisconnected();
                this.logTickError(msg);
                if (this.role === 'keeper') {
                    await this.maybeKillWedged(msg);
                }
            }
            await sleep(POLL_MS);
        }
    }

    private async tick(): Promise<void> {
        // Keeper is authoritative and never yields. The GUI defers to a live keeper
        // (fresh keeper lock) and for a short grace after its own start, so the
        // keeper is never starved by a wedged/autostarted GUI.
        if (this.role === 'gui') {
            const inStartupGrace: boolean = Date.now() - this.startedAtMs < STARTUP_GRACE_MS;
            if (inStartupGrace || this.keeperHoldsLock()) {
                if (!this.yielding) {
                    await this.disconnect('defer to keeper');
                    this.yielding = true;
                }
                return; // leave status.json to the keeper
            }
        }
        this.yielding = false;
        if (this.role === 'keeper') {
            this.writeLock(); // claim promptly; the steady heartbeat also maintains it
        }

        const desired: AquarisDesired = this.readDesired();
        // Autopilot: let the daemon's fan target drive the fan (LED/pump stay manual).
        // On any D-Bus error we keep the file's fan values (fail-safe). A manual
        // `tccaquaris on/off/fan` sets auto=false and stamps manualFanTs; here we
        // re-arm auto-follow once that override has lapsed past resumeAfterSec, so a
        // manual fan tweak reverts to the autopilot on its own (in lockstep with the
        // daemon's profile pause). `tccaquaris auto off` clears manualFanTs, so an
        // explicit "stay manual" persists until `tccaquaris auto on`.
        const target: AquarisAutoTarget | null =
            desired.auto === true || desired.manualFanTs !== undefined ? await this.getAquarisAutoTarget() : null;
        if (desired.auto !== true && desired.manualFanTs !== undefined) {
            const resumeSec: number = target?.resumeAfterSec ?? DEFAULT_RESUME_SEC;
            if (resumeSec > 0 && Date.now() - desired.manualFanTs >= resumeSec * 1000) {
                desired.auto = true;
                desired.manualFanTs = undefined;
                this.writeDesired(desired); // persist re-arm BEFORE the target override mutates fan fields
                this.log('autopilot fan-follow re-armed (manual override lapsed)');
            }
        }
        if (desired.auto === true && target !== null && target.enabled) {
            desired.fanOn = target.fanOn;
            desired.fanDutyCycle = target.fanDutyCycle;
        }
        await this.connect(); // retries internally; throws if device busy/absent (caught by loop)
        await this.applyDesired(desired);
        this.writeStatus({ owner: this.role, device: this.mac, connected: true, applied: desired, error: null });
        // Wedge bookkeeping: a successful apply means the device is reachable, so
        // remember what it is doing — that is the state a wedge would freeze it in,
        // and all we can report about the fan once it stops answering.
        this.deviceAbsentSinceMs = undefined;
        this.lastAppliedFanOn = desired.fanOn === true;
        this.lastAppliedFanDuty = desired.fanDutyCycle;
        // The unit is genuinely back, so a previous kill is spent: re-arm.
        this.killedAtMs = undefined;
        if (this.role === 'keeper') {
            this.saveKeeperState();
        }
    }

    // ---- persisted keeper knowledge -----------------------------------------
    private loadKeeperState(): void {
        const s = readJson<{ fanOn?: boolean; fanDutyCycle?: number; killedAtMs?: number }>(KEEPER_STATE_FILE);
        if (s === null) {
            return;
        }
        this.lastAppliedFanOn = s.fanOn === true;
        this.lastAppliedFanDuty = typeof s.fanDutyCycle === 'number' ? s.fanDutyCycle : 0;
        // A kill must survive a keeper restart, or the one-shot guard is no guard.
        this.killedAtMs = typeof s.killedAtMs === 'number' ? s.killedAtMs : undefined;
    }

    private saveKeeperState(): void {
        try {
            fs.writeFileSync(
                KEEPER_STATE_FILE,
                JSON.stringify({
                    fanOn: this.lastAppliedFanOn,
                    fanDutyCycle: this.lastAppliedFanDuty,
                    killedAtMs: this.killedAtMs,
                    ts: Date.now(),
                }),
            );
        } catch (_e: unknown) {
            /* best effort — the in-memory copy still works for this run */
        }
    }

    // ---- autopilot fan target (from tccd over the system bus) ----------------
    private async getAquarisAutoTarget(): Promise<AquarisAutoTarget | null> {
        try {
            if (this.tccIface === undefined) {
                if (this.tccBus === undefined) {
                    this.tccBus = dbus.systemBus();
                }
                const proxy = await this.tccBus.getProxyObject(TCCD_BUS_NAME, TCCD_PATH);
                this.tccIface = proxy.getInterface(TCCD_BUS_NAME);
            }
            const json: string = await this.tccIface.GetAquarisAutoTargetJSON();
            const t = JSON.parse(json);
            if (typeof t?.fanDutyCycle === 'number') {
                return {
                    enabled: !!t.enabled,
                    fanOn: !!t.fanOn,
                    fanDutyCycle: t.fanDutyCycle,
                    resumeAfterSec: typeof t.resumeAfterSec === 'number' ? t.resumeAfterSec : undefined,
                };
            }
        } catch (_e: unknown) {
            this.tccIface = undefined; // force reconnect next time
        }
        return null;
    }

    // ---- wedge kill switch via the Tasmota plug ------------------------------
    /**
     * Called on every failed keeper tick. Cuts power at the plug when the Aquaris
     * has answered nothing for WEDGE_ABSENT_MS with reconnects retried throughout.
     *
     * Five minutes of silence is enough on its own, because a false positive is
     * nearly free: the power chain is plug -> brick -> Aquaris -> laptop, and
     * pass-through keeps the LAPTOP charging even with the Aquaris dead, so
     * cutting an already-off unit costs nothing. The one case worth holding back
     * for is our own radio being dead — then the unit may be perfectly healthy and
     * merely unheard, and killing it would cost 白い熊 a walk to the front button
     * for nothing. That is all bleRadioUsable() guards.
     *
     * Explicitly NOT used as evidence:
     *   - plug wattage. What the meter sees is overwhelmingly the laptop (~80 W
     *     running, 46-75 W with the Aquaris dead), so it cannot distinguish the
     *     two. An earlier draft gated on it; it was reading the wrong device.
     *   - the fan. Worth 3-6 W against a ±7 W swing — invisible. Reported only.
     *
     * The plug is switched back ON after the cut (PLUG_OFF_HOLD_MS off, long
     * enough that the unit actually powers down rather than riding it out on its
     * capacitors) so the laptop keeps charging. The Aquaris itself stays dead
     * until its front button is pressed, which is the whole point.
     */
    private async maybeKillWedged(errMsg: string): Promise<void> {
        // An unconfirmed restore is an obligation: the laptop is fed through this
        // plug, so it must never be left switched off.
        if (this.plugRestorePending) {
            const pendingIp: string | undefined = this.plugAddress();
            if (pendingIp !== undefined && (await this.plugPower(pendingIp, 'On')) === 'ON') {
                this.plugRestorePending = false;
                this.log('plug power restored (pending On cleared)');
            }
            return;
        }
        if (!/device not found/i.test(errMsg)) {
            return; // other errors neither start nor reset the absence streak
        }
        const now: number = Date.now();
        if (this.deviceAbsentSinceMs === undefined) {
            this.deviceAbsentSinceMs = now;
            return;
        }
        const absentMs: number = now - this.deviceAbsentSinceMs;
        if (absentMs < WEDGE_QUIET_MS) {
            return; // too soon to call an outage anything
        }
        const absentSec: number = Math.round(absentMs / 1000);
        // One shot. After a kill the unit is dead and stays unreachable, while the
        // plug's draw stays high (that is the laptop), so without this the verdict
        // would re-fire every WEDGE_ABSENT_MS forever. Cleared by a successful
        // apply — i.e. only when the unit is genuinely back.
        if (this.killedAtMs !== undefined) {
            this.logWedge(
                `wedge watch: unreachable ${absentSec}s, already cut ${Math.round((now - this.killedAtMs) / 60000)} min ago — ` +
                    'waiting for the front button',
            );
            return;
        }
        if (absentMs < WEDGE_ABSENT_MS) {
            this.logWedge(
                `wedge watch: unreachable ${absentSec}s` +
                    `${this.lastAppliedFanOn ? ` (fan last set to ${this.lastAppliedFanDuty}%)` : ''} — ` +
                    `verdict in ${Math.round((WEDGE_ABSENT_MS - absentMs) / 1000)}s`,
            );
            return;
        }
        const ip: string | undefined = this.plugAddress();
        if (ip === undefined) {
            this.logWedge(`wedge watch: unreachable ${absentSec}s, no plug configured (KXTCC unset)`);
            return;
        }
        const power: string | undefined = await this.plugPower(ip);
        if (power !== 'ON') {
            // Already dark, or the plug is unreachable — either way, nothing to cut.
            this.logWedge(`wedge watch: plug ${ip} ${power === undefined ? 'unreachable' : `reports ${power}`}`);
            return;
        }
        if (!(await this.bleRadioUsable())) {
            this.logWedge(
                `wedge watch: unreachable ${absentSec}s, but our own Bluetooth is not usable — ` +
                    'the unit may be fine and simply unheard, so nothing is cut',
            );
            return;
        }
        const watts: number | undefined = await this.plugWatts(ip);
        this.log(
            `WEDGE: unreachable ${absentSec}s and our radio is up` +
                `${this.lastAppliedFanOn ? `, fan last set to ${this.lastAppliedFanDuty}%` : ''}` +
                `${watts !== undefined ? ` (plug ${watts} W — laptop included, not evidence)` : ''} — ` +
                `cycling plug ${ip} to kill the unit`,
        );
        if ((await this.plugPower(ip, 'Off')) !== 'OFF') {
            this.log(`could not switch plug ${ip} off — will retry on the next tick`);
            return;
        }
        this.killedAtMs = now;
        this.lastAppliedFanOn = false;
        this.saveKeeperState();
        // Back on promptly: the laptop is fed through this plug.
        this.plugRestorePending = true;
        await sleep(PLUG_OFF_HOLD_MS);
        if ((await this.plugPower(ip, 'On')) === 'ON') {
            this.plugRestorePending = false;
            this.log('plug back on — the laptop keeps charging; the Aquaris stays dead until its button is pressed');
        } else {
            this.log(`could not switch plug ${ip} back on — retrying every tick until it takes`);
        }
        this.notifyPowerCut(absentSec);
    }

    /** Desktop notification for the one event that needs 白い熊 to walk over. */
    private notifyPowerCut(absentSec: number): void {
        const body: string =
            `The Aquaris stopped answering for ${Math.round(absentSec / 60)} min` +
            `${this.lastAppliedFanDuty > 0 ? ` with the fan last set to ${this.lastAppliedFanDuty}%` : ''}, ` +
            'so its power was cut to stop it. Bluetooth here is working, so the unit is wedged.\n\n' +
            'The plug is back on and the laptop is still charging — but the Aquaris will NOT restart ' +
            'until you PRESS THE BUTTON on the front of the unit. There is no cooling until you do.';
        try {
            execFile(
                'notify-send',
                ['-u', 'critical', '-i', 'dialog-warning', '-a', 'Aquaris keeper', 'Aquaris: power cut', body],
                (): void => {
                    /* notify-send may be absent; the log line above is the record that matters */
                },
            );
        } catch (_e: unknown) {
            /* never let a missing notifier break the keeper */
        }
    }

    // ---- is our own Bluetooth the problem? -----------------------------------
    /**
     * Ask BlueZ what the radio is actually doing. Returns the number of OTHER
     * devices currently being seen (BlueZ publishes RSSI only for devices heard
     * in the running discovery session, so this counts live advertisers, not the
     * pairing cache) and whether the adapter is powered.
     *
     * This is the control for the whole wedge verdict: a radio that is hearing
     * the room is a radio that would hear the Aquaris if the Aquaris were
     * talking. Without it, "device not found" is equally consistent with our own
     * adapter having died, and cutting the unit's power would be blaming the
     * wrong end.
     */
    private async probeBleRadio(): Promise<BleProbe | undefined> {
        try {
            if (this.bluezBus === undefined) {
                this.bluezBus = dbus.systemBus();
            }
            const proxy = await this.bluezBus.getProxyObject(BLUEZ_BUS_NAME, '/');
            const om = proxy.getInterface('org.freedesktop.DBus.ObjectManager');
            const objects = await om.GetManagedObjects();
            let powered = false;
            let discovering = false;
            let adapterPath: string | undefined;
            let othersSeen = 0;
            const self: string = this.mac.toUpperCase();
            for (const [objPath, ifaces] of Object.entries(objects as Record<string, Record<string, any>>)) {
                const ad = ifaces[BLUEZ_ADAPTER_IFACE];
                if (ad !== undefined) {
                    adapterPath ??= objPath;
                    powered ||= ad.Powered?.value === true;
                    discovering ||= ad.Discovering?.value === true;
                }
                const dev = ifaces[BLUEZ_DEVICE_IFACE];
                // BlueZ publishes RSSI only for devices heard in the RUNNING
                // discovery session and drops it when they go quiet, so this
                // counts live advertisers rather than the pairing cache.
                if (dev !== undefined && dev.RSSI !== undefined && String(dev.Address?.value).toUpperCase() !== self) {
                    othersSeen += 1;
                }
            }
            return { powered, discovering, othersSeen, adapterPath };
        } catch (_e: unknown) {
            this.bluezBus = undefined; // force a reconnect next time
            return undefined;
        }
    }

    /**
     * Make sure a scan is actually running, else nothing ever reports an RSSI.
     * The DuplicateData filter matters: without it BlueZ does not refresh RSSI on
     * already-known devices, and the probe sees an empty room that isn't empty.
     */
    private async startDiscovery(adapterPath: string): Promise<boolean> {
        try {
            if (this.bluezBus === undefined) {
                this.bluezBus = dbus.systemBus();
            }
            const ap = await this.bluezBus.getProxyObject(BLUEZ_BUS_NAME, adapterPath);
            const iface = ap.getInterface(BLUEZ_ADAPTER_IFACE);
            try {
                await iface.SetDiscoveryFilter({
                    Transport: new dbus.Variant('s', 'le'),
                    DuplicateData: new dbus.Variant('b', true),
                });
            } catch (_e: unknown) {
                /* filter is an optimisation, not a requirement */
            }
            await iface.StartDiscovery();
            return true;
        } catch (_e: unknown) {
            return false; // already discovering (someone else's session) or refused
        }
    }

    /**
     * False only when our own Bluetooth is plainly unusable — BlueZ unreachable,
     * or no adapter powered. That is the one case where "device not found" says
     * nothing about the Aquaris, and killing a possibly-healthy unit would cost a
     * pointless walk to its front button.
     *
     * Deliberately NOT requiring that we hear other advertisers. Measured
     * 2026-07-26, this desk had exactly one other device in range, so a quiet room
     * would veto the verdict indefinitely. The count is logged as a diagnostic
     * instead: useful when reading back an outage, but it does not decide.
     */
    private async bleRadioUsable(): Promise<boolean> {
        let probe: BleProbe | undefined = await this.probeBleRadio();
        if (probe === undefined) {
            this.logWedge('wedge check: BlueZ unreachable — this end is the suspect, not cutting power');
            return false;
        }
        if (!probe.powered) {
            this.logWedge('wedge check: no powered Bluetooth adapter — this end is the suspect, not cutting power');
            return false;
        }
        // The keeper stops discovery once connected, so RSSI may be absent purely
        // because nothing is scanning. Start one so the diagnostic count means
        // something; the verdict does not depend on the answer.
        if (!probe.discovering && probe.adapterPath !== undefined) {
            await this.startDiscovery(probe.adapterPath);
            await sleep(BLE_PROBE_SCAN_MS);
            probe = (await this.probeBleRadio()) ?? probe;
        }
        this.log(`wedge check: adapter powered, hearing ${probe.othersSeen} other advertiser(s)`);
        return true;
    }


    /** Rate-limited wedge logging — an outage lasts hours; its log need not. */
    private logWedge(msg: string): void {
        const now: number = Date.now();
        if (now - this.lastWedgeLogMs < WEDGE_LOG_INTERVAL_MS) {
            return;
        }
        this.lastWedgeLogMs = now;
        this.log(msg);
    }

    /** Same idea for the per-tick error: say it once, then at most once a minute. */
    private logTickError(msg: string): void {
        const now: number = Date.now();
        if (msg === this.lastTickErrorMsg && now - this.lastTickErrorLogMs < WEDGE_LOG_INTERVAL_MS) {
            return;
        }
        this.lastTickErrorMsg = msg;
        this.lastTickErrorLogMs = now;
        this.log(`tick error: ${msg}`);
    }

    /** Plug IP: $KXTCC, else a live parse of ~/.kxrc (systemd doesn't source it). */
    private plugAddress(): string | undefined {
        const env: string | undefined = process.env.KXTCC;
        if (env !== undefined && env.trim() !== '') {
            return env.trim();
        }
        try {
            const m: RegExpMatchArray | null = fs
                .readFileSync(KXRC_FILE, 'utf8')
                .match(/^\s*(?:export\s+)?KXTCC=["']?([^"'\s#]+)/m);
            if (m !== null) {
                return m[1];
            }
        } catch (_e: unknown) {
            /* no ~/.kxrc */
        }
        return undefined;
    }

    /** Tasmota `Power` state query/set: returns 'ON'/'OFF', undefined on error. */
    private async plugPower(ip: string, set?: 'On' | 'Off'): Promise<string | undefined> {
        const resp = await this.plugHttp(ip, set === undefined ? 'Power' : `Power ${set}`);
        return typeof resp?.POWER === 'string' ? resp.POWER : undefined;
    }

    /** Tasmota `Status 8` live power draw in watts, undefined on error. */
    private async plugWatts(ip: string): Promise<number | undefined> {
        const resp = await this.plugHttp(ip, 'Status 8');
        const w = resp?.StatusSNS?.ENERGY?.Power;
        return typeof w === 'number' ? w : undefined;
    }

    private plugHttp(ip: string, cmnd: string): Promise<any | undefined> {
        return new Promise((resolve: (v: any | undefined) => void): void => {
            const req = http.get(
                `http://${ip}/cm?cmnd=${encodeURIComponent(cmnd)}`,
                { timeout: PLUG_HTTP_TIMEOUT_MS },
                (res): void => {
                    let body: string = '';
                    res.on('data', (chunk): void => {
                        body += chunk;
                    });
                    res.on('end', (): void => {
                        try {
                            resolve(JSON.parse(body));
                        } catch (_e: unknown) {
                            resolve(undefined);
                        }
                    });
                },
            );
            req.on('timeout', (): void => {
                req.destroy();
                resolve(undefined);
            });
            req.on('error', (): void => resolve(undefined));
        });
    }

    // ---- ownership lock (keeper-authoritative) ------------------------------
    /** True if a *live* keeper currently holds the lock (so the GUI must defer). */
    private keeperHoldsLock(): boolean {
        const lock: OwnerLock | null = readJson<OwnerLock>(LOCK_FILE);
        if (!lock || typeof lock.ts !== 'number') {
            return false;
        }
        if (lock.owner !== 'keeper') {
            return false;
        }
        if (lock.pid === process.pid) {
            return false;
        }
        return Date.now() - lock.ts <= STALE_MS;
    }

    private writeLock(): void {
        try {
            fs.writeFileSync(LOCK_FILE, JSON.stringify({ owner: this.role, pid: process.pid, ts: Date.now() } as OwnerLock));
        } catch (_e: unknown) {
            /* ignore */
        }
    }

    // ---- BLE ----------------------------------------------------------------
    private async connect(): Promise<void> {
        // Reuse a live connection.
        if (this.device !== undefined && this.uartTx !== undefined) {
            try {
                if (await this.device.isConnected()) {
                    return;
                }
            } catch (_e: unknown) {
                /* fall through and rebuild */
            }
        }
        // Stale/dropped link: tear the whole node-ble stack down before rebuilding.
        // Re-fetching the GATT characteristic on a reused dbus connection leaks a
        // PropertiesChanged listener on every reconnect (the MaxListenersExceeded
        // warning + ever-growing CPU); a full rebuild also recovers a wedged
        // adapter. Done once per drop here — NOT on every "device absent" retry, so
        // there's no churn during an outage.
        if (this.device !== undefined || this.uartTx !== undefined) {
            this.teardownBt();
        }
        if (this.adapter === undefined) {
            const cb = createBluetooth();
            this.bluetooth = cb.bluetooth;
            this.destroyBt = cb.destroy;
            this.adapter = await this.bluetooth.defaultAdapter();
        }
        // Find the device, scanning ONLY until we have it.
        let dev: NodeBle.Device | undefined;
        for (let i = 0; i < 5; i++) {
            try {
                dev = await this.adapter.getDevice(this.mac);
                break;
            } catch (e: unknown) {
                try {
                    if (!(await this.adapter.isDiscovering())) {
                        await this.adapter.startDiscovery();
                    }
                } catch (_e: unknown) {
                    /* ignore */
                }
                if (i === 4) {
                    throw e;
                }
                await sleep(1000);
            }
        }
        if (dev === undefined) {
            throw new Error('device not found');
        }
        this.device = dev;
        await this.device.connect();
        // Stop scanning now that we're connected. Leaving discovery on makes the
        // radio time-share scan windows with the link and is a prime cause of
        // spurious disconnects (which in turn wedge the Aquaris firmware).
        try {
            if (await this.adapter.isDiscovering()) {
                await this.adapter.stopDiscovery();
            }
        } catch (_e: unknown) {
            /* ignore */
        }
        const gatt: NodeBle.GattServer = await this.device.gatt();
        const service: NodeBle.GattService = await gatt.getPrimaryService(NORDIC_UART_SERVICE);
        this.uartTx = await service.getCharacteristic(NORDIC_UART_TX);
        this.applied = {};
        this.log('acquired link; applying full state');
    }

    /** Fully release the node-ble stack so a later connect() rebuilds it fresh. */
    private teardownBt(): void {
        try {
            this.destroyBt?.();
        } catch (_e: unknown) {
            /* ignore */
        }
        this.bluetooth = undefined;
        this.adapter = undefined;
        this.destroyBt = undefined;
        this.device = undefined;
        this.uartTx = undefined;
        this.applied = {};
    }

    private async disconnect(reason: string): Promise<void> {
        if (this.device !== undefined) {
            try {
                if (await this.device.isConnected()) {
                    await this.device.disconnect(); // clean — no reset frame
                    this.log(`released link (${reason})`);
                }
            } catch (_e: unknown) {
                /* ignore */
            }
        }
        // Full teardown so the next connect rebuilds a fresh, listener-free stack.
        this.teardownBt();
    }

    private async dropIfDisconnected(): Promise<void> {
        try {
            if (this.device !== undefined && !(await this.device.isConnected())) {
                this.teardownBt();
            }
        } catch (_e: unknown) {
            this.teardownBt();
        }
    }

    private async write(buffer: Buffer): Promise<void> {
        if (this.uartTx === undefined) {
            throw new Error('not connected');
        }
        await this.uartTx.writeValue(buffer, { type: 'request' });
    }

    // ---- apply (frames mirror LCT21001.ts) ----------------------------------
    private async applyDesired(d: AquarisDesired): Promise<void> {
        const ledKey: string = JSON.stringify([!!d.ledOn, d.red, d.green, d.blue, d.ledMode]);
        if (ledKey !== this.applied.led) {
            if (d.ledOn) {
                await this.write(
                    Buffer.from([
                        0xfe, 0x1e, 0x01, clamp(d.red, 0, 255), clamp(d.green, 0, 255), clamp(d.blue, 0, 255),
                        clamp(d.ledMode, 0, 3), 0xef,
                    ]),
                );
            } else {
                await this.write(Buffer.from([0xfe, 0x1e, 0x00, 0x00, 0x00, 0x00, 0x00, 0xef]));
            }
            this.applied.led = ledKey;
        }

        const fanKey: string = JSON.stringify([!!d.fanOn, d.fanDutyCycle]);
        if (fanKey !== this.applied.fan) {
            if (d.fanOn) {
                await this.write(Buffer.from([0xfe, 0x1b, 0x01, clamp(d.fanDutyCycle, 0, 100), 0x00, 0x00, 0x00, 0xef]));
            } else {
                await this.write(Buffer.from([0xfe, 0x1b, 0x00, 0x00, 0x00, 0x00, 0x00, 0xef]));
            }
            this.applied.fan = fanKey;
        }

        const pumpKey: string = JSON.stringify([!!d.pumpOn, d.pumpDutyCycle, d.pumpVoltage]);
        if (pumpKey !== this.applied.pump) {
            if (d.pumpOn) {
                await this.write(
                    Buffer.from([
                        0xfe, 0x1c, 0x01, clamp(d.pumpDutyCycle, 0, 100), clamp(d.pumpVoltage, 0, 3), 0x00, 0x00, 0xef,
                    ]),
                );
            } else {
                await this.write(Buffer.from([0xfe, 0x1c, 0x00, 0x00, 0x00, 0x00, 0x00, 0xef]));
            }
            this.applied.pump = pumpKey;
        }
    }

    // ---- files --------------------------------------------------------------
    private readDesired(): AquarisDesired {
        return { ...DEFAULT_DESIRED, ...(readJson<Partial<AquarisDesired>>(DESIRED_FILE) ?? {}) };
    }

    /** Persist desired.json (keeper re-arm of auto-follow). Atomic via tmp+rename;
     *  undefined fields (e.g. a cleared manualFanTs) are dropped by JSON.stringify. */
    private writeDesired(desired: AquarisDesired): void {
        try {
            const tmp: string = `${DESIRED_FILE}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(desired));
            fs.renameSync(tmp, DESIRED_FILE);
        } catch (_e: unknown) {
            /* ignore */
        }
    }

    private writeStatus(obj: Record<string, unknown>): void {
        try {
            const tmp: string = `${STATUS_FILE}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ ...obj, role: this.role, ts: new Date().toISOString() }));
            fs.renameSync(tmp, STATUS_FILE);
        } catch (_e: unknown) {
            /* ignore */
        }
    }

    private log(msg: string): void {
        console.log(`${new Date().toISOString()} AquarisLink[${this.role}] ${msg}`);
    }
}
