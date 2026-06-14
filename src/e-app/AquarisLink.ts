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
 * Hand-off: the GUI heart-beats ~/.config/tccaquaris/owner.lock while it runs.
 * The keeper YIELDS (clean-disconnects, applies nothing) while that lock is
 * fresh, and re-acquires when it goes stale/absent (GUI exit/crash). Both apply
 * the same desired.json, so the tccaquaris CLI just edits that file.
 *
 * Clean disconnect (no LCT 'reset' frame) is used on yield/stop so the pump/fan
 * keep running through the brief hand-off gap. The device firmware lights the
 * LED blue while powered + unconnected, so a momentary blue blink during the
 * gap is unavoidable; the idle desired state is LED off.
 */

import * as fs from 'node:fs';
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
}

interface AquarisAutoTarget {
    enabled: boolean;
    fanOn: boolean;
    fanDutyCycle: number;
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
    auto: false,
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

    // Autopilot (fork): lazy system-bus link to tccd for the auto fan target.
    private tccBus: dbus.MessageBus | undefined;
    private tccIface: dbus.ClientInterface | undefined;

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
        // The GUI heart-beats the ownership lock on its OWN steady timer, decoupled
        // from the (sometimes slow) BLE connect/apply loop — otherwise a slow connect
        // could delay the heartbeat past STALE_MS and the keeper would wrongly take over.
        if (this.role === 'gui') {
            this.writeLock();
            this.heartbeatTimer = setInterval((): void => this.writeLock(), 1000);
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
        if (this.role === 'gui') {
            try {
                fs.rmSync(LOCK_FILE, { force: true });
            } catch (_e: unknown) {
                /* ignore */
            }
        }
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
            }
            await sleep(POLL_MS);
        }
    }

    private async tick(): Promise<void> {
        if (this.role === 'keeper' && this.guiHoldsLock()) {
            // GUI owns the link — yield (and let the GUI own status.json).
            if (!this.yielding) {
                await this.disconnect('yield to GUI');
                this.yielding = true;
                this.writeStatus({ owner: 'gui', connected: false, note: 'GUI is taking the link', error: null });
            }
            return;
        }
        this.yielding = false;
        // (GUI lock heartbeat runs on its own timer — see start())

        const desired: AquarisDesired = this.readDesired();
        // Autopilot: let the daemon's fan target drive the fan (LED/pump stay manual).
        // On any D-Bus error we keep the file's fan values (fail-safe).
        if (desired.auto) {
            const target: AquarisAutoTarget | null = await this.getAquarisAutoTarget();
            if (target !== null && target.enabled) {
                desired.fanOn = target.fanOn;
                desired.fanDutyCycle = target.fanDutyCycle;
            }
        }
        await this.connect(); // retries internally; throws if device busy/absent (caught by loop)
        await this.applyDesired(desired);
        this.writeStatus({ owner: this.role, device: this.mac, connected: true, applied: desired, error: null });
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
                return { enabled: !!t.enabled, fanOn: !!t.fanOn, fanDutyCycle: t.fanDutyCycle };
            }
        } catch (_e: unknown) {
            this.tccIface = undefined; // force reconnect next time
        }
        return null;
    }

    // ---- ownership lock -----------------------------------------------------
    private guiHoldsLock(): boolean {
        const lock: OwnerLock | null = readJson<OwnerLock>(LOCK_FILE);
        if (!lock || typeof lock.ts !== 'number') {
            return false;
        }
        if (Date.now() - lock.ts > STALE_MS) {
            return false;
        }
        if (lock.pid === process.pid) {
            return false;
        }
        return true;
    }

    private writeLock(): void {
        try {
            fs.writeFileSync(LOCK_FILE, JSON.stringify({ owner: 'gui', pid: process.pid, ts: Date.now() } as OwnerLock));
        } catch (_e: unknown) {
            /* ignore */
        }
    }

    // ---- BLE ----------------------------------------------------------------
    private async connect(): Promise<void> {
        if (this.device !== undefined && this.uartTx !== undefined) {
            try {
                if (await this.device.isConnected()) {
                    return;
                }
            } catch (_e: unknown) {
                /* reconnect below */
            }
        }
        this.uartTx = undefined;
        if (this.adapter === undefined) {
            const cb = createBluetooth();
            this.bluetooth = cb.bluetooth;
            this.destroyBt = cb.destroy;
            this.adapter = await this.bluetooth.defaultAdapter();
        }
        try {
            if (!(await this.adapter.isDiscovering())) {
                await this.adapter.startDiscovery();
            }
        } catch (_e: unknown) {
            /* ignore */
        }
        let dev: NodeBle.Device | undefined;
        for (let i = 0; i < 5; i++) {
            try {
                dev = await this.adapter.getDevice(this.mac);
                break;
            } catch (e: unknown) {
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
        const gatt: NodeBle.GattServer = await this.device.gatt();
        const service: NodeBle.GattService = await gatt.getPrimaryService(NORDIC_UART_SERVICE);
        this.uartTx = await service.getCharacteristic(NORDIC_UART_TX);
        this.applied = {};
        this.log('acquired link; applying full state');
    }

    private async disconnect(reason: string): Promise<void> {
        if (this.device === undefined) {
            return;
        }
        try {
            if (await this.device.isConnected()) {
                await this.device.disconnect(); // clean — no reset frame
                this.log(`released link (${reason})`);
            }
        } catch (_e: unknown) {
            /* ignore */
        }
        this.device = undefined;
        this.uartTx = undefined;
        this.applied = {};
    }

    private async dropIfDisconnected(): Promise<void> {
        try {
            if (this.device !== undefined && !(await this.device.isConnected())) {
                this.device = undefined;
                this.uartTx = undefined;
            }
        } catch (_e: unknown) {
            this.device = undefined;
            this.uartTx = undefined;
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
