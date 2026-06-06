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

import * as child_process from 'node:child_process';
import { execCommandAsync } from '../../common/classes/Utils';
import { XDisplayRefreshRateController } from '../../common/classes/XDisplayRefreshRateController';
import type { IDisplayFreqRes, IDisplayMode } from '../../common/models/DisplayFreqRes';
import type { ITccProfile } from '../../common/models/TccProfile';
import { DaemonWorker } from './DaemonWorker';
import type { TuxedoControlCenterDaemon } from './TuxedoControlCenterDaemon';

export class DisplayRefreshRateWorker extends DaemonWorker {
    private controller: XDisplayRefreshRateController;
    private displayInfo: IDisplayFreqRes;
    private displayInfoFound: boolean = false;
    private previousUsers: string[] = [];
    private wAvailable: boolean = undefined;
    private disallowedUserNames: string[] = ['sddm', 'gdm', 'gdm-gree', 'root'];
    // Guard so a slow `w` can never overlap with the next 5s tick (see checkUsers).
    private wInFlight: boolean = false;

    constructor(tccd: TuxedoControlCenterDaemon) {
        super(5000, 'DisplayRefreshrateWorker', tccd);
        this.controller = new XDisplayRefreshRateController();
    }

    public async onStart(): Promise<void> {
        try {
            this.wAvailable = !!(await execCommandAsync('which w')).toString().trim();
            if (!this.wAvailable) {
                console.log('DisplayRefreshrateWorker: w not available');
            }
        } catch (err: unknown) {
            console.error(`DisplayRefreshrateWorker: onStart failed => ${err}`);
            this.wAvailable = false;
        }
    }

    // Run `w --no-header` without ever blocking the daemon's single event loop.
    // FORK FIX: upstream used child_process.execSync here, which freezes the whole
    // D-Bus interface while `w` runs. On a system whose process table had been
    // bloated by a leaked-SSH-session storm, `w` (it scans all of /proc) took
    // 20s+, so every GetProfilesJSON / SetTempProfile call hung — profile
    // switching in the GUI and the CLI appeared stuck. Run it async with a hard
    // timeout (< the 5s poll interval) and SIGKILL on overrun so a pathological
    // `w` can never wedge the daemon. Returns null on failure/timeout.
    private runW(): Promise<string | null> {
        return new Promise((resolve: (value: string | null) => void): void => {
            child_process.exec(
                'w --no-header',
                { timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
                (err: unknown, stdout: string): void => {
                    if (err) {
                        console.error(`DisplayRefreshrateWorker: 'w --no-header' failed or timed out => ${err}`);
                        resolve(null);
                    } else {
                        resolve(stdout);
                    }
                },
            );
        });
    }

    // user is able to switch XDG_SESSION_TYPE in login screen and thus a new check needs to be done
    // not checking XDG_SESSION_TYPE during login screen, checking again on user change
    private async checkUsers(): Promise<boolean[]> {
        // Skip if a previous `w` is still running (system under load): report the
        // last known availability and "no change" so we neither block nor flap.
        if (this.wInFlight) {
            return [this.previousUsers.length > 0, false];
        }

        this.wInFlight = true;
        let output: string | null;
        try {
            output = await this.runW();
        } finally {
            this.wInFlight = false;
        }

        // On failure/timeout keep the previous state and report no change.
        if (output === null) {
            return [this.previousUsers.length > 0, false];
        }

        const userInformation: string[] = output.split('\n');

        const loggedInUsers: string[] = [];

        for (const line of userInformation) {
            const result: RegExpMatchArray = line.match(/^([^\s\d]+)/);

            if (result) {
                const userName: string = result[0];

                if (userName && !this.disallowedUserNames.includes(userName)) {
                    loggedInUsers.push(userName);
                }
            }
        }

        const usersAvailable: boolean = loggedInUsers.length > 0;
        const usersChanged: boolean = JSON.stringify(loggedInUsers) !== JSON.stringify(this.previousUsers);

        this.previousUsers = loggedInUsers;

        return [usersAvailable, usersChanged];
    }

    private resetToDefault(): void {
        this.displayInfo = undefined;
        this.displayInfoFound = false;
        this.controller.resetValues();
    }

    public async onWork(): Promise<void> {
        if (!this.wAvailable) {
            return;
        }

        const [usersAvailable, usersChanged] = await this.checkUsers();

        if (usersChanged) {
            this.resetToDefault();
        }

        if (usersAvailable && !this.controller.checkVariablesAvailable()) {
            if (!this.displayInfoFound && this.controller.getIsTTY() !== true) {
                await this.updateDisplayData();
            }
        }
        this.setActiveDisplayMode();
    }

    public async onExit(): Promise<void> {}

    private setActiveDisplayMode(): void {
        const activeprofile: ITccProfile = this.tccd.getCurrentProfile();

        const useRefRate: boolean = activeprofile?.display?.useRefRate;
        const activeMode: IDisplayMode = this.displayInfo?.activeMode;

        if (useRefRate && activeMode) {
            const refreshRate: number = activeprofile.display.refreshRate;
            // todo: add variable checks to avoid access error
            const hasDifferentRefreshRate: boolean = refreshRate !== activeMode?.refreshRates[0];

            if (hasDifferentRefreshRate) {
                const status: boolean = this.controller.setRefreshRateAndResolution(
                    activeMode.xResolution,
                    activeMode.yResolution,
                    refreshRate,
                );

                if (status) {
                    console.log(
                        `DisplayRefreshRateWorker: setActiveDisplayMode: Set ${refreshRate}Hz with ${
                            activeMode.xResolution
                        }x${activeMode.yResolution} and XAUTHORITY "${this.controller.getXAuthorityFile()}"`,
                    );
                    activeMode.refreshRates[0] = refreshRate;
                } else {
                    console.error(
                        `DisplayRefreshRateWorker: setActiveDisplayMode: Failed to set refresh rate ${refreshRate}Hz with ${
                            activeMode.xResolution
                        }x${
                            activeMode.yResolution
                        } for display "${this.controller.getDisplay()}" with the name "${this.controller.getDisplayName()}" and XAUTHORITY "${this.controller.getXAuthorityFile()}"`,
                    );
                    this.resetToDefault();
                }
            }
        }
    }

    private async updateDisplayData(): Promise<void> {
        this.resetToDefault();
        await this.controller.setVariables();

        if (
            this.controller.checkVariablesAvailable() &&
            this.controller.getIsTTY() === false &&
            this.controller.getIsWayland() === false &&
            this.controller.getIsX11() === 1
        ) {
            this.displayInfo = this.controller.getDisplayModes();

            if (this.displayInfo === undefined) {
                this.tccd.dbusData.displayModesJSON = '{}';
            } else {
                this.displayInfoFound = true;
                this.tccd.dbusData.displayModesJSON = JSON.stringify(this.displayInfo);
            }
        } else {
            this.tccd.dbusData.displayModesJSON = '{}';
        }

        if (this.controller.checkVariablesAvailable()) {
            this.tccd.dbusData.isX11 = this.controller.getIsX11();

            if (this.controller.getIsX11() === 1) {
                console.log('DisplayRefreshRateWorker: Detected x11');
            }

            if (this.controller.getIsWayland()) {
                console.log('DisplayRefreshRateWorker: Detected wayland');
            }

            if (this.controller.getIsTTY()) {
                console.log('DisplayRefreshRateWorker: Detected tty');
            }
        }
    }
}
