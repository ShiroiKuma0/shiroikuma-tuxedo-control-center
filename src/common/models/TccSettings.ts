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

import { defaultCustomProfile, defaultMobileCustomProfileID, TUXEDODevice } from './DefaultProfiles';

export enum ProfileStates {
    AC = 'power_ac',
    BAT = 'power_bat',
}

export enum KeyboardBacklightColorModes {
    static,
    breathing,
}

export interface KeyboardBacklightCapabilitiesInterface {
    modes: Array<KeyboardBacklightColorModes>;
    zones: number;
    maxBrightness: number;
    maxRed: number;
    maxGreen: number;
    maxBlue: number;
}

export interface KeyboardBacklightStateInterface {
    mode: KeyboardBacklightColorModes;
    brightness: number;
    red: number;
    green: number;
    blue: number;
}

/**
 * Autopilot (fork addition) — load-reactive auto profile switching + Aquaris
 * cooling target. Tunables persist in /etc/tcc/settings (reloaded on SIGHUP);
 * the daemon-side AutoProfileWorker reads them every tick. Defaults are
 * deliberately aggressive (react before things get hot); adjust via the
 * `tccauto` CLI / the SetAutopilot* D-Bus methods.
 */
export interface IAutopilotSettings {
    /** Master switch — on at boot. */
    enabled: boolean;
    /** Profile applied under load. Empty => profile #1 in the GetProfilesJSON order. */
    highLoadProfileId: string;
    /** Profile applied at rest. Empty => profile #3 in the GetProfilesJSON order. */
    restProfileId: string;
    /** CPU utilisation (0..1, from /proc/stat) thresholds. */
    cpuUtilHigh: number;
    cpuUtilLow: number;
    /** CPU package power as a fraction (0..1) of the RAPL max limit. */
    cpuPowerHigh: number;
    cpuPowerLow: number;
    /** GPU load (0..1, power- or frequency-derived) thresholds. */
    gpuLoadHigh: number;
    gpuLoadLow: number;
    /** Any sensor at/above this °C forces the high-load profile. */
    tempHigh: number;
    /** EMA smoothing factor (0..1) for the *release* signals — higher = snappier, lower = steadier. */
    emaAlpha: number;
    /** Seconds the system must stay below the *Low thresholds before dropping to rest. */
    releaseSec: number;
    /** Seconds after a manual profile pick before the autopilot resumes (0 = stay paused until re-enabled). */
    resumeAfterSec: number;
    /** Aquaris fan auto-control on/off. */
    aquarisEnabled: boolean;
    /** Aquaris tracks the internal (PC) fan %: OFF at/below aquarisPcFanMin, then
     *  scaling linearly to aquarisFanMax at aquarisPcFanMax. Defaults (50→100 PC
     *  fan ⇒ 0→100 Aquaris) give ~10% Aquaris per 5% PC-fan change. */
    aquarisPcFanMin: number;
    aquarisPcFanMax: number;
    aquarisFanMax: number;
}

export const defaultAutopilotSettings: IAutopilotSettings = {
    enabled: true,
    highLoadProfileId: '',
    restProfileId: '',
    // High thresholds = instant attack (on raw signals); Low thresholds = release
    // (on smoothed signals). Lows sit above typical idle noise — incl. a dGPU that
    // reports ~0.3 clock-ratio when it briefly wakes — so the system reliably
    // settles to rest, while still reacting fast to real load.
    cpuUtilHigh: 0.3,
    cpuUtilLow: 0.15,
    cpuPowerHigh: 0.45,
    cpuPowerLow: 0.25,
    gpuLoadHigh: 0.6,
    gpuLoadLow: 0.4,
    tempHigh: 75,
    emaAlpha: 0.3,
    releaseSec: 20,
    resumeAfterSec: 1800,
    aquarisEnabled: true,
    aquarisPcFanMin: 50,
    aquarisPcFanMax: 100,
    aquarisFanMax: 100,
};

export interface ITccSettings {
    fahrenheit: boolean;
    stateMap: {
        power_ac: string;
        power_bat: string;
    };
    shutdownTime: string | null;
    cpuSettingsEnabled: boolean;
    fanControlEnabled: boolean;
    keyboardBacklightControlEnabled: boolean;
    ycbcr420Workaround: Array<Object>;
    chargingProfile: string | null;
    chargingPriority: string | null;
    keyboardBacklightStates: Array<KeyboardBacklightStateInterface>;
    autopilot?: IAutopilotSettings;
}

export const defaultSettings: ITccSettings = {
    fahrenheit: false,
    stateMap: {
        power_ac: '__default_custom_profile__',
        power_bat: '__default_custom_profile__',
    },
    shutdownTime: null,
    cpuSettingsEnabled: true,
    fanControlEnabled: true,
    keyboardBacklightControlEnabled: true,
    ycbcr420Workaround: [],
    chargingProfile: null,
    chargingPriority: null,
    keyboardBacklightStates: [],
    autopilot: { ...defaultAutopilotSettings },
};

export const defaultSettingsXP1508UHD: ITccSettings = {
    fahrenheit: false,
    stateMap: {
        power_ac: 'Default',
        power_bat: 'Custom XP1508 UHD',
    },
    shutdownTime: null,
    cpuSettingsEnabled: true,
    fanControlEnabled: true,
    keyboardBacklightControlEnabled: true,
    ycbcr420Workaround: [],
    chargingProfile: null,
    chargingPriority: null,
    keyboardBacklightStates: [],
    autopilot: { ...defaultAutopilotSettings },
};

const defaultSettingsMobile: ITccSettings = {
    fahrenheit: false,
    stateMap: {
        power_ac: defaultCustomProfile.id,
        power_bat: defaultMobileCustomProfileID,
    },
    shutdownTime: null,
    cpuSettingsEnabled: true,
    fanControlEnabled: true,
    keyboardBacklightControlEnabled: true,
    ycbcr420Workaround: [],
    chargingProfile: null,
    chargingPriority: null,
    keyboardBacklightStates: [],
    autopilot: { ...defaultAutopilotSettings },
};

export const deviceCustomSettings: Map<TUXEDODevice, ITccSettings> = new Map();

deviceCustomSettings.set(TUXEDODevice.IBPG8, defaultSettingsMobile);
deviceCustomSettings.set(TUXEDODevice.AURA14G3, defaultSettingsMobile);
deviceCustomSettings.set(TUXEDODevice.AURA15G3, defaultSettingsMobile);
