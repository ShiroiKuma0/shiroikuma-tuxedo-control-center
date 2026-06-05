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
 * Entry point for the bundled Aquaris keeper service. Run headless via the app's
 * own Electron binary as a plain Node process:
 *
 *   ELECTRON_RUN_AS_NODE=1 <electron> <this-file>
 *
 * It is the default owner of the Aquaris BLE link and yields to the GUI when the
 * GUI is running (see AquarisLink). See the packaged systemd --user unit.
 */

import { AquarisLink } from './AquarisLink';

const link: AquarisLink = new AquarisLink('keeper');

function shutdown(signal: string): void {
    console.log(`aquaris-keeper: got ${signal}, stopping`);
    link.stop()
        .catch((err: unknown): void => console.error(`aquaris-keeper: stop failed => ${err}`))
        .finally((): void => process.exit(0));
}

process.on('SIGTERM', (): void => shutdown('SIGTERM'));
process.on('SIGINT', (): void => shutdown('SIGINT'));

link.start();
