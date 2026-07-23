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

const NORDIC_UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NORDIC_UART_TX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

const CFG_DIR: string = path.join(os.homedir(), '.config', 'tccaquaris');
const DESIRED_FILE: string = path.join(CFG_DIR, 'desired.json');
const STATUS_FILE: string = path.join(CFG_DIR, 'status.json');
const LOCK_FILE: string = path.join(CFG_DIR, 'owner.lock');

const POLL_MS = 1500;
const STALE_MS = 4000;
// GUI defers to the keeper for this long after the GUI starts, so the keeper
// (which autostarts at login too) wins the boot race and the GUI never grabs
// the link out from under it.
const STARTUP_GRACE_MS = 6000;
// Fallback for the manual-fan-override resume timeout when the daemon's
// resumeAfterSec can't be read over D-Bus (matches defaultAutopilotSettings).
const DEFAULT_RESUME_SEC = 300;

// ---- Aquaris firmware-wedge recovery via a Tasmota smart plug --------------
// A dropped BLE link can wedge the Aquaris firmware: the fan freezes at its last
// duty and the device stops advertising, so it is unreachable over BLE and can
// run at full blast for days. The only cure is a power-cycle — so the keeper,
// when it sees the wedge signature (device absent for a sustained period right
// after the fan was on), power-cycles the unit through a Tasmota plug on the
// LAN. The plug's IP comes from the KXTCC environment variable, falling back to
// a live parse of ~/.kxrc (the keeper runs under systemd --user, which does not
// source shell rc files), so an IP edit there applies without a keeper restart.
const KXRC_FILE = path.join(os.homedir(), '.kxrc');
// Sustained "Device not found" before the wedge check may fire. Normal
// reconnects take seconds; a genuine wedge never comes back on its own.
const WEDGE_ABSENT_MS = 3 * 60 * 1000;
// At most one power-cycle per this period, so a device that is genuinely gone
// (unplugged, out of range) doesn't get its plug toggled forever.
const WEDGE_COOLDOWN_MS = 10 * 60 * 1000;
const PLUG_HTTP_TIMEOUT_MS = 5000;
// How long the plug stays off during a cycle — long enough to drain the unit.
const PLUG_CYCLE_OFF_MS = 5000;

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

    // Wedge recovery (fork): when the "Device not found" streak started, whether
    // the fan was on in the last state we successfully applied (the wedge freezes
    // the device in that state), when we last power-cycled the plug, and whether
    // a "Power On" is still owed to the plug after a cycle whose confirmation
    // failed (never leave the Aquaris powered off).
    private deviceAbsentSinceMs: number | undefined;
    private lastAppliedFanOn = false;
    private lastPlugCycleMs = 0;
    private plugPendingOn = false;

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
                this.log(`tick error: ${msg}`);
                if (this.role === 'keeper') {
                    await this.maybeRecoverWedge(msg);
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
        // Wedge-recovery bookkeeping: a successful apply means the device is
        // reachable (and the plug necessarily on); remember whether the fan is
        // running — that is the state a wedge would freeze.
        this.deviceAbsentSinceMs = undefined;
        this.lastAppliedFanOn = desired.fanOn === true;
        this.plugPendingOn = false;
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

    // ---- firmware-wedge recovery via the Tasmota plug ------------------------
    /**
     * Called on every failed keeper tick. Fires a plug power-cycle when the wedge
     * signature holds: "Device not found" for WEDGE_ABSENT_MS straight, the plug
     * reachable and reporting ON, and the fan on in the last applied state (the
     * state the wedge froze). Deliberately conservative — a wedge with the fan
     * off is quiet and only logged, and a device that is genuinely unplugged
     * gets no evidence and no cycling.
     */
    private async maybeRecoverWedge(errMsg: string): Promise<void> {
        // A cycle whose "Power On" confirmation failed leaves an obligation:
        // retry before anything else, and never cycle again while it is owed.
        if (this.plugPendingOn) {
            const pendingIp: string | undefined = this.plugAddress();
            if (pendingIp !== undefined && (await this.plugPower(pendingIp, 'On')) === 'ON') {
                this.plugPendingOn = false;
                this.log('wedge recovery: plug power restored (pending On cleared)');
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
        if (absentMs < WEDGE_ABSENT_MS || now - this.lastPlugCycleMs < WEDGE_COOLDOWN_MS) {
            return;
        }
        const ip: string | undefined = this.plugAddress();
        if (ip === undefined) {
            return; // no plug configured (KXTCC not set anywhere)
        }
        const power: string | undefined = await this.plugPower(ip);
        if (power !== 'ON') {
            this.log(`wedge check: plug ${ip} ${power === undefined ? 'unreachable' : `reports ${power}`} — not cycling`);
            return;
        }
        // Watts are logged for calibration only — the A1T's metering is not
        // calibrated, so no decision rests on the absolute value.
        const watts: number | undefined = await this.plugWatts(ip);
        this.log(
            `wedge check: device absent ${Math.round(absentMs / 1000)}s, plug ON` +
                `${watts !== undefined ? ` (${watts} W)` : ''}, lastAppliedFanOn=${this.lastAppliedFanOn}`,
        );
        if (!this.lastAppliedFanOn) {
            return; // wedged quiet (fan was off) — harmless, leave it to a human
        }
        this.lastPlugCycleMs = now;
        this.plugPendingOn = true; // cleared only once "On" is confirmed
        this.log(`WEDGE: Aquaris unreachable ${Math.round(absentMs / 1000)}s with fan on — power-cycling plug ${ip}`);
        await this.plugPower(ip, 'Off');
        await sleep(PLUG_CYCLE_OFF_MS);
        if ((await this.plugPower(ip, 'On')) === 'ON') {
            this.plugPendingOn = false;
        }
        // The firmware boots fan-off; give the reboot a fresh absence window.
        this.lastAppliedFanOn = false;
        this.deviceAbsentSinceMs = undefined;
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
