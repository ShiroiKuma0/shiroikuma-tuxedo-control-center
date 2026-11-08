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
 * AutoProfileWorker (fork addition) — the "autopilot".
 *
 * Reacts to system load and (a) switches the active profile between a high-load
 * profile and a rest profile, and (b) computes a desired Aquaris fan target that
 * the user-level keeper applies over BLE (the daemon has no Bluetooth). All
 * signals are read from data the daemon already collects (CPU package power via
 * RAPL, GPU freq/power, CPU/GPU fan speed + temp), plus a tiny /proc/stat CPU
 * utilisation reader added here.
 *
 * Profile switching reuses the existing temp-profile path: it sets
 * dbusData.tempProfileId and calls triggerStateCheck() — exactly what the D-Bus
 * SetTempProfileById does — but *without* going through that D-Bus method, so a
 * genuine manual pick (GUI / tccprofile, which DO call SetTempProfile*) stamps
 * dbusData.manualProfileOverrideTs and PAUSES the autopilot. The pause clears on
 * SetAutopilotEnabled(true) or after `resumeAfterSec`.
 *
 * Tunables live in settings.autopilot (persisted to /etc/tcc/settings, reloaded
 * on SIGHUP); they are re-read every tick so changes take effect live.
 */

import * as fs from 'node:fs';
import { determineState } from '../../common/classes/StateUtils';
import { defaultAutopilotSettings, type IAutopilotSettings } from '../../common/models/TccSettings';
import { DaemonWorker } from './DaemonWorker';
import type { TuxedoControlCenterDaemon } from './TuxedoControlCenterDaemon';

interface CpuStatSample {
    busy: number;
    total: number;
}

/** Aggregate ("cpu") line plus one entry per core ("cpuN"), keyed by core name. */
interface CpuStatSnapshot {
    all: CpuStatSample;
    cores: Map<string, CpuStatSample>;
}

interface AutopilotSignals {
    cpuUtil: number; // 0..1, aggregate over all cores
    cpuCoreMax: number; // 0..1, busiest single core
    cpuPowerFrac: number; // 0..1 of RAPL max (0 when unknown)
    gpuLoad: number; // 0..1 (0 when unknown)
    maxTemp: number; // °C, -1 when unknown
    internalFan: number; // %, -1 when unknown
}

interface AquarisAutoTarget {
    enabled: boolean;
    fanOn: boolean;
    fanDutyCycle: number;
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

export class AutoProfileWorker extends DaemonWorker {
    private prevCpuStat: CpuStatSnapshot | undefined;
    private coolSinceMs: number | undefined;
    private pausedUntilMs: number = 0;
    private lastSeenOverrideTs: number = 0;
    // Exponential moving averages of the release signals — so a single-tick blip
    // (e.g. the dGPU briefly waking, a background task) doesn't reset the release.
    private ema: { cpuUtil: number; cpuCoreMax: number; cpuPowerFrac: number; gpuLoad: number } | undefined;

    constructor(tccd: TuxedoControlCenterDaemon) {
        super(1000, 'AutoProfileWorker', tccd);
    }

    public async onStart(): Promise<void> {
        this.prevCpuStat = this.readCpuStat();
        this.coolSinceMs = undefined;
        this.ema = undefined;
        // Don't treat a temp-profile override that predates us as a fresh manual pick.
        this.lastSeenOverrideTs = this.tccd.dbusData.manualProfileOverrideTs ?? 0;
    }

    public async onWork(): Promise<void> {
        // Merge defaults so a key added in a newer build is never undefined, even when
        // the settings were (re)loaded by a path that skips the forward-fill (an
        // undefined threshold makes every comparison false — e.g. never `cool`).
        const cfg: IAutopilotSettings = { ...defaultAutopilotSettings, ...(this.tccd.settings.autopilot ?? {}) };
        const now: number = Date.now();

        // Detect external manual profile picks (GUI / tccprofile go through the
        // D-Bus SetTempProfile* methods, which stamp manualProfileOverrideTs;
        // our own switches below do not). A fresh pick pauses profile control.
        const overrideTs: number = this.tccd.dbusData.manualProfileOverrideTs ?? 0;
        if (overrideTs > this.lastSeenOverrideTs) {
            this.lastSeenOverrideTs = overrideTs;
            this.pausedUntilMs = cfg.resumeAfterSec > 0 ? now + cfg.resumeAfterSec * 1000 : Number.MAX_SAFE_INTEGER;
        }

        if (!cfg.enabled) {
            // Hand sensor collection back to stock behaviour and stop steering.
            this.tccd.dbusData.autopilotStatusJSON = JSON.stringify({ enabled: false, paused: false });
            return;
        }

        // Keep RAPL / GPU sampling alive headlessly (CpuPowerWorker / GpuInfoWorker
        // only collect while this flag is set; the GUI normally toggles it).
        this.tccd.dbusData.sensorDataCollectionStatus = true;

        const signals: AutopilotSignals = this.gatherSignals();
        const paused: boolean = now < this.pausedUntilMs;

        // Update smoothed (EMA) release signals.
        const a: number = clamp(cfg.emaAlpha ?? 0.3, 0.01, 1);
        if (this.ema === undefined) {
            this.ema = {
                cpuUtil: signals.cpuUtil,
                cpuCoreMax: signals.cpuCoreMax,
                cpuPowerFrac: signals.cpuPowerFrac,
                gpuLoad: signals.gpuLoad,
            };
        } else {
            this.ema.cpuUtil = a * signals.cpuUtil + (1 - a) * this.ema.cpuUtil;
            this.ema.cpuCoreMax = a * signals.cpuCoreMax + (1 - a) * this.ema.cpuCoreMax;
            this.ema.cpuPowerFrac = a * signals.cpuPowerFrac + (1 - a) * this.ema.cpuPowerFrac;
            this.ema.gpuLoad = a * signals.gpuLoad + (1 - a) * this.ema.gpuLoad;
        }

        // ---- profile decision: instant attack on RAW signals, debounced release
        // on the SMOOTHED signals (so transient blips can't keep us out of rest). ----
        const hot: boolean =
            signals.cpuUtil >= cfg.cpuUtilHigh ||
            signals.cpuCoreMax >= cfg.cpuCoreHigh ||
            signals.cpuPowerFrac >= cfg.cpuPowerHigh ||
            signals.gpuLoad >= cfg.gpuLoadHigh ||
            (signals.maxTemp >= 0 && signals.maxTemp >= cfg.tempHigh);
        const cool: boolean =
            !hot &&
            this.ema.cpuUtil < cfg.cpuUtilLow &&
            this.ema.cpuCoreMax < cfg.cpuCoreLow &&
            this.ema.cpuPowerFrac < cfg.cpuPowerLow &&
            this.ema.gpuLoad < cfg.gpuLoadLow;
        // "Cooled" once the internal (PC) fan has wound down past the Aquaris-off
        // point. We only drop to the rest profile once the load is gone AND the
        // laptop has finished actively cooling — so the performance profile (and
        // the Aquaris) hold through the whole cool-down instead of cutting out early.
        const cooled: boolean = signals.internalFan < 0 || signals.internalFan <= cfg.aquarisPcFanMin;
        const restReady: boolean = cool && cooled;

        let decision: 'high' | 'rest' | 'hold' = 'hold';
        if (hot) {
            this.coolSinceMs = undefined;
            decision = 'high';
        } else if (restReady) {
            if (this.coolSinceMs === undefined) {
                this.coolSinceMs = now;
            }
            if (now - this.coolSinceMs >= cfg.releaseSec * 1000) {
                decision = 'rest';
            }
        } else {
            // load gone but still cooling (or moderate load): hold current profile
            this.coolSinceMs = undefined;
        }

        const profiles: Array<{ id: string; name?: string }> = this.readProfiles();
        const highId: string = this.resolveProfileId(cfg.highLoadProfileId, 0, profiles);
        const restId: string = this.resolveRestProfileId(cfg.restProfileId, profiles);

        let targetId: string | undefined;
        if (decision === 'high') {
            targetId = highId;
        } else if (decision === 'rest') {
            targetId = restId;
        }

        const activeId: string | undefined = this.tccd.activeProfile?.id;
        if (!paused && targetId !== undefined && targetId !== '' && targetId !== activeId) {
            // Mirror SetTempProfileById's internal effect, minus the D-Bus entry
            // point (so we don't trip our own manual-pick pause).
            this.tccd.dbusData.tempProfileId = targetId;
            this.tccd.triggerStateCheck();
        }

        // ---- Aquaris fan target: tracks the internal (PC) fan % — scales down
        // with it and only switches off below aquarisPcFanMin — but leads the fan's
        // spin-up via a lead floor while `hot`. Not gated by the manual *profile* pause. ----
        const aquaris: AquarisAutoTarget = this.computeAquarisTarget(cfg, signals, hot);
        // Carry resumeAfterSec so the keeper can time-out a manual Aquaris fan
        // override back to auto-follow in lockstep with the daemon's profile-pause
        // resume (one resume knob governs both manual overrides).
        this.tccd.dbusData.aquarisAutoTargetJSON = JSON.stringify({ ...aquaris, resumeAfterSec: cfg.resumeAfterSec });

        this.tccd.dbusData.autopilotStatusJSON = JSON.stringify({
            enabled: true,
            paused,
            pausedUntilMs: paused ? this.pausedUntilMs : 0,
            decision,
            cooled,
            activeProfileId: activeId ?? '',
            activeProfileName: this.tccd.activeProfile?.name ?? '',
            highLoadProfileId: highId,
            restProfileId: restId,
            signals,
            smoothed: this.ema,
            aquaris,
        });
    }

    public async onExit(): Promise<void> {}

    /** Clear a manual-pick pause so the autopilot resumes immediately. */
    public clearPause(): void {
        this.pausedUntilMs = 0;
        this.lastSeenOverrideTs = this.tccd.dbusData.manualProfileOverrideTs ?? this.lastSeenOverrideTs;
    }

    // ---- signal gathering ---------------------------------------------------

    private gatherSignals(): AutopilotSignals {
        return {
            ...this.sampleCpuUtil(),
            cpuPowerFrac: this.readCpuPowerFrac(),
            gpuLoad: this.readGpuLoad(),
            ...this.readTempsAndFan(),
        };
    }

    private static parseCpuLine(line: string): CpuStatSample {
        const v: number[] = line.trim().split(/\s+/).slice(1).map(Number);
        const idle: number = (v[3] || 0) + (v[4] || 0); // idle + iowait
        const total: number = v.reduce((a: number, b: number): number => a + (b || 0), 0);
        return { busy: total - idle, total };
    }

    private readCpuStat(): CpuStatSnapshot | undefined {
        try {
            const lines: string[] = fs.readFileSync('/proc/stat', 'utf8').split('\n');
            let all: CpuStatSample | undefined;
            const cores: Map<string, CpuStatSample> = new Map();
            for (const line of lines) {
                if (!line.startsWith('cpu')) {
                    break; // the cpu lines come first
                }
                const name: string = line.slice(0, line.indexOf(' '));
                if (name === 'cpu') {
                    all = AutoProfileWorker.parseCpuLine(line);
                } else {
                    cores.set(name, AutoProfileWorker.parseCpuLine(line));
                }
            }
            return all === undefined ? undefined : { all, cores };
        } catch (_e: unknown) {
            return undefined;
        }
    }

    private static util(cur: CpuStatSample, prev: CpuStatSample): number {
        const dTotal: number = cur.total - prev.total;
        return dTotal > 0 ? clamp((cur.busy - prev.busy) / dTotal, 0, 1) : 0;
    }

    /** Aggregate utilisation plus the busiest core's, over the last tick. */
    private sampleCpuUtil(): { cpuUtil: number; cpuCoreMax: number } {
        const cur: CpuStatSnapshot | undefined = this.readCpuStat();
        const prev: CpuStatSnapshot | undefined = this.prevCpuStat;
        this.prevCpuStat = cur;
        if (cur === undefined || prev === undefined) {
            return { cpuUtil: 0, cpuCoreMax: 0 };
        }
        let cpuCoreMax = 0;
        for (const [name, c] of cur.cores) {
            const p: CpuStatSample | undefined = prev.cores.get(name);
            if (p !== undefined) {
                cpuCoreMax = Math.max(cpuCoreMax, AutoProfileWorker.util(c, p));
            }
        }
        return { cpuUtil: AutoProfileWorker.util(cur.all, prev.all), cpuCoreMax };
    }

    private readCpuPowerFrac(): number {
        try {
            const p = JSON.parse(this.tccd.dbusData.cpuPowerValuesJSON);
            if (typeof p.powerDraw === 'number' && p.powerDraw >= 0 && typeof p.maxPowerLimit === 'number' && p.maxPowerLimit > 0) {
                return clamp(p.powerDraw / p.maxPowerLimit, 0, 1);
            }
        } catch (_e: unknown) {
            /* unknown */
        }
        return 0;
    }

    private readGpuLoad(): number {
        let load = 0;
        const frac = (cur: unknown, max: unknown): number => {
            if (typeof cur === 'number' && cur >= 0 && typeof max === 'number' && max > 0) {
                return clamp(cur / max, 0, 1);
            }
            return 0;
        };
        try {
            const d = JSON.parse(this.tccd.dbusData.dGpuInfoValuesJSON);
            load = Math.max(load, frac(d.powerDraw, d.maxPowerLimit), frac(d.coreFrequency, d.maxCoreFrequency));
        } catch (_e: unknown) {
            /* unknown */
        }
        try {
            const i = JSON.parse(this.tccd.dbusData.iGpuInfoValuesJSON);
            load = Math.max(load, frac(i.coreFrequency, i.maxCoreFrequency));
        } catch (_e: unknown) {
            /* unknown */
        }
        return load;
    }

    private readTempsAndFan(): { maxTemp: number; internalFan: number } {
        let maxTemp = -1;
        let internalFan = -1;
        try {
            const f = JSON.parse(this.tccd.dbusData.fanData || '{}');
            for (const key of ['cpu', 'gpu1', 'gpu2']) {
                const t: unknown = f?.[key]?.temp?.data;
                const s: unknown = f?.[key]?.speed?.data;
                if (typeof t === 'number' && t > 0) {
                    maxTemp = Math.max(maxTemp, t);
                }
                if (typeof s === 'number' && s >= 0) {
                    internalFan = Math.max(internalFan, s);
                }
            }
        } catch (_e: unknown) {
            /* unknown */
        }
        return { maxTemp, internalFan };
    }

    // ---- helpers ------------------------------------------------------------

    private computeAquarisTarget(cfg: IAutopilotSettings, signals: AutopilotSignals, hot: boolean): AquarisAutoTarget {
        if (!cfg.aquarisEnabled) {
            return { enabled: false, fanOn: false, fanDutyCycle: 0 };
        }
        // PC-fan curve: OFF at/below aquarisPcFanMin, else run at the PC fan plus
        // aquarisFanOffset, clamped to aquarisFanMax (defaults: off ≤50% PC fan,
        // otherwise +10% above it, so PC fan 90% ⇒ Aquaris 100%).
        const pcFan: number = signals.internalFan;
        const pcDuty: number = pcFan > cfg.aquarisPcFanMin ? clamp(pcFan + cfg.aquarisFanOffset, 0, cfg.aquarisFanMax) : 0;
        // Lead the laptop fan's spin-up: while under load (`hot`), floor the duty at
        // aquarisLeadDuty so the Aquaris reacts immediately instead of waiting for the
        // PC fan to ramp. `hot` clears the instant load stops, so the wind-down/off
        // is governed purely by the PC-fan curve (unchanged).
        const leadDuty: number = hot ? cfg.aquarisLeadDuty : 0;
        const duty: number = Math.round(clamp(Math.max(pcDuty, leadDuty), 0, cfg.aquarisFanMax));
        return { enabled: true, fanOn: duty > 0, fanDutyCycle: duty };
    }

    private readProfiles(): Array<{ id: string; name?: string }> {
        try {
            const arr = JSON.parse(this.tccd.dbusData.profilesJSON);
            return Array.isArray(arr) ? arr : [];
        } catch (_e: unknown) {
            return [];
        }
    }

    /**
     * Rest profile: the configured id if it still exists; otherwise the profile the
     * stateMap assigns to the current power state — what the machine would run
     * without the autopilot. Deliberately NOT a list position: the old fallback
     * (profile #3) was "Powersave extreme", which pinned the CPU at 800 MHz.
     */
    private resolveRestProfileId(configured: string, profiles: Array<{ id: string }>): string {
        if (configured && profiles.some((p): boolean => p.id === configured)) {
            return configured;
        }
        try {
            const stateId: string | undefined = this.tccd.settings.stateMap?.[determineState().toString()];
            if (stateId && profiles.some((p): boolean => p.id === stateId)) {
                return stateId;
            }
        } catch (_e: unknown) {
            /* fall through */
        }
        // No usable rest target: return '' so the worker never switches to rest.
        return '';
    }

    /** Configured id if it still exists, else the profile at `fallbackIndex` (then first, then active). */
    private resolveProfileId(configured: string, fallbackIndex: number, profiles: Array<{ id: string }>): string {
        if (configured && profiles.some((p): boolean => p.id === configured)) {
            return configured;
        }
        return profiles[fallbackIndex]?.id ?? profiles[0]?.id ?? this.tccd.activeProfile?.id ?? configured;
    }
}
