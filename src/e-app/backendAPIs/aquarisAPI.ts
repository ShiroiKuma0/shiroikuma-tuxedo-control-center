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
 * Fork: the Aquaris IPC handlers no longer drive BLE directly. Instead they
 * edit the shared desired state at ~/.config/tccaquaris/desired.json, which is
 * applied by whichever AquarisLink currently owns the connection — the GUI's own
 * link (while running) or the bundled keeper (headless). This is what lets the
 * GUI, the keeper and the `tccaquaris` CLI all coexist over a single BLE link,
 * and keeps the LED off by default. See src/e-app/AquarisLink.ts.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import type { AquarisState } from '../../common/models/IAquarisAPI';
import { AquarisAPIFunctions } from '../../common/models/IAquarisAPI';
import { AquarisLink } from '../AquarisLink';
import { DeviceInfo } from '../LCT21001';
import { hasAquaris } from './initMain';

const AQ_MAC: string = process.env.AQ_MAC ?? 'EE:5E:11:D8:5A:B5';

const CFG_DIR: string = path.join(os.homedir(), '.config', 'tccaquaris');
const DESIRED_FILE: string = path.join(CFG_DIR, 'desired.json');
const STATUS_FILE: string = path.join(CFG_DIR, 'status.json');

const DEFAULT_DESIRED: AquarisState = {
    deviceUUID: AQ_MAC,
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
};

function readDesired(): AquarisState {
    try {
        const parsed = JSON.parse(fs.readFileSync(DESIRED_FILE, 'utf8')) as Partial<AquarisState>;
        return { ...DEFAULT_DESIRED, ...parsed, deviceUUID: AQ_MAC };
    } catch (_e: unknown) {
        return { ...DEFAULT_DESIRED };
    }
}

function writeDesired(state: AquarisState): void {
    try {
        fs.mkdirSync(CFG_DIR, { recursive: true });
        const tmp: string = `${DESIRED_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, DESIRED_FILE);
    } catch (err: unknown) {
        console.error(`aquarisAPI: writeDesired failed => ${err}`);
    }
}

function patchDesired(patch: Partial<AquarisState>): void {
    writeDesired({ ...readDesired(), ...patch });
}

function statusConnected(): boolean {
    try {
        const s = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) as { connected?: boolean };
        return s.connected === true;
    } catch (_e: unknown) {
        return false;
    }
}

// The GUI owns the Aquaris BLE link for its whole lifetime (started from initMain
// once the device is known). It heart-beats owner.lock so the bundled keeper
// yields; on quit we stop it so the keeper re-acquires.
let aquarisLink: AquarisLink | undefined;

export function startAquarisLink(): void {
    if (aquarisLink === undefined) {
        aquarisLink = new AquarisLink('gui');
        aquarisLink.start();
    }
}

export async function aquarisCleanUp(): Promise<void> {
    if (aquarisLink !== undefined) {
        const link: AquarisLink = aquarisLink;
        aquarisLink = undefined;
        await link.stop();
    }
}

export const aquarisHandlers: Map<string, (...args: any[]) => any> = new Map<string, (...args: any[]) => any>()
    // The link is owned/held by an AquarisLink, not by these handlers; connect /
    // disconnect / discover are therefore no-ops kept for IPC compatibility.
    .set(AquarisAPIFunctions.connect, async (_deviceUUID: string): Promise<void> => {})
    .set(AquarisAPIFunctions.disconnect, async (): Promise<void> => {})
    .set(AquarisAPIFunctions.isConnected, async (): Promise<boolean> => statusConnected())
    .set(AquarisAPIFunctions.hasBluetooth, async (): Promise<boolean> => true)
    .set(AquarisAPIFunctions.startDiscover, async (): Promise<void> => {})
    .set(AquarisAPIFunctions.stopDiscover, async (): Promise<void> => {})

    .set(AquarisAPIFunctions.getDevices, async (): Promise<DeviceInfo[]> => {
        const info: DeviceInfo = new DeviceInfo();
        info.uuid = AQ_MAC;
        info.name = 'CoolingSystem';
        info.rssi = 0;
        return [info];
    })

    .set(AquarisAPIFunctions.getState, async (): Promise<AquarisState> => readDesired())

    .set(AquarisAPIFunctions.readFwVersion, async (): Promise<string> => '')

    .set(
        AquarisAPIFunctions.updateLED,
        async (red: number, green: number, blue: number, state: number): Promise<void> => {
            patchDesired({ red, green, blue, ledMode: state, ledOn: true });
        },
    )
    .set(AquarisAPIFunctions.writeRGBOff, async (): Promise<void> => {
        patchDesired({ ledOn: false });
    })

    .set(AquarisAPIFunctions.writeFanMode, async (dutyCyclePercent: number): Promise<void> => {
        patchDesired({ fanDutyCycle: dutyCyclePercent, fanOn: true });
    })
    .set(AquarisAPIFunctions.writeFanOff, async (): Promise<void> => {
        patchDesired({ fanOn: false });
    })

    .set(AquarisAPIFunctions.writePumpMode, async (dutyCyclePercent: number, voltage: number): Promise<void> => {
        patchDesired({ pumpDutyCycle: dutyCyclePercent, pumpVoltage: voltage, pumpOn: true });
    })
    .set(AquarisAPIFunctions.writePumpOff, async (): Promise<void> => {
        patchDesired({ pumpOn: false });
    })

    // desired.json IS the persistent state — nothing extra to save.
    .set(AquarisAPIFunctions.saveState, async (): Promise<void> => {});

ipcMain.handle('comp-get-has-aquaris', (_event: IpcMainInvokeEvent): Promise<boolean> => {
    return new Promise<boolean>(
        (resolve: (value: boolean | PromiseLike<boolean>) => void, reject: (reason?: unknown) => void): void => {
            try {
                resolve(hasAquaris());
            } catch (err: unknown) {
                console.error(`aquarisAPI: comp-get-has-aquaris failed => ${err}`);
                reject(err);
            }
        },
    );
});
