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

import * as builder from 'electron-builder';

/**
 * buildSteps is the List with the builds
 */
const buildSteps: Array<(filenameAddition: string) => Promise<void>> = [];

const distSrc = './dist/tuxedo-control-center';

/**
 * Parse command line parameter and set up the build
 */
let filenameAddition = '';

process.argv.forEach((parameter, index, array) => {
    if (parameter.startsWith('deb')) {
        buildSteps.push(buildDeb);
    }

    if (parameter.startsWith('rpm')) {
        buildSteps.push(buildRpm);
    }

    if (parameter.startsWith('all')) {
        buildSteps.push(buildDeb);
        buildSteps.push(buildRpm);
    }

    if (parameter.startsWith('fnameadd')) {
        const parts = parameter.split('=');
        if (parts.length === 2) {
            filenameAddition = parts[1].trim();
        }
    }
});

if (buildSteps.length === 0) {
    buildSteps.push(buildDeb);
    buildSteps.push(buildRpm);
}

/**
 * Function for create the deb Package
 */
async function buildDeb(filenameAddition: string): Promise<void> {
    const config: builder.Configuration = {
        appId: 'tuxedocontrolcenter',
        artifactName: `\${productName}_\${version}${filenameAddition}.\${ext}`,
        directories: {
            output: './dist/packages',
        },
        compression: 'maximum',
        files: [`${distSrc}/**/*`],
        extraResources: [
            `${distSrc}/data/service/tccd`,
            `${distSrc}/data/service/TuxedoIOAPI.node`,
            `${distSrc}/data/CHANGELOG.md`,
            `${distSrc}/data/dist-data/tccd.service`,
            `${distSrc}/data/dist-data/tccd-sleep.service`,
            `${distSrc}/data/dist-data/tccaquaris-keeper.service`,
            `${distSrc}/data/dist-data/tuxedo-control-center_256.svg`,
            `${distSrc}/data/dist-data/tuxedo-control-center.desktop`,
            `${distSrc}/data/dist-data/tuxedo-control-center-tray.desktop`,
            `${distSrc}/data/dist-data/com.tuxedocomputers.tccd.policy`,
            `${distSrc}/data/dist-data/com.tuxedocomputers.tccd.conf`,
            `${distSrc}/data/camera/cameractrls.py`,
            `${distSrc}/data/dist-data/99-webcam.rules`,
            `${distSrc}/data/dist-data/com.tuxedocomputers.tomte.policy`,
            `${distSrc}/data/camera/v4l2_kernel_names.json`,
            // Headless CLI front-ends → /opt/.../resources/tools, symlinked onto
            // PATH by after_install.sh (tcc, tccinfo, tccprofile, tccaquaris, tccauto).
            './tools/tcc',
            './tools/tccinfo',
            './tools/tccprofile',
            './tools/tccaquaris',
            './tools/tccauto',
        ],
        // Fork build (npm run pack-fork) sets TCC_FORK_VERSION=<base>+<N>. extraMetadata
        // keeps the +N verbatim in the .deb Version and app.getVersion() (a plain
        // package.json version would have its +N build-metadata stripped by electron-builder).
        // build-fork.ts also stamps the same version into src/package.json so the tccd
        // daemon reports it too — all three must match or the GUI version-check loops.
        ...(process.env.TCC_FORK_VERSION
            ? { extraMetadata: { version: process.env.TCC_FORK_VERSION } }
            : {}),
        linux: {
            target: ['deb'],
            // Keep the upstream binary/command name even though productName (the /opt
            // dir + package name) is shiroikuma-tuxedo-control-center.
            executableName: 'tuxedo-control-center',
            category: 'System',
            icon: `${distSrc}/data/dist-data/tuxedo-control-center_256.svg`,
        },
        deb: {
            compression: 'xz',
            depends: ['tuxedo-drivers (>= 4.0.0) | tuxedo-keyboard (>= 3.1.2)', 'libayatana-appindicator3-1'],
            recommends: ['tuxedo-systeminfos'],
            category: 'System',
            afterInstall: './build-src/after_install.sh',
            afterRemove: './build-src/after_remove.sh',
            fpm: [
                '--conflicts=tuxedofancontrol',
                '--replaces=tuxedofancontrol',
                // Replace mode: this fork supersedes upstream tuxedo-control-center.
                '--conflicts=tuxedo-control-center',
                '--replaces=tuxedo-control-center',
                '--provides=tuxedo-control-center',
                '--inputs=build-src/package-files.txt',
                '--deb-compression-level=9',
            ],
        },
    };
    console.log('\x1b[36m%s\x1b[0m', 'Create Deb Package');
    console.log('config', config);
    await builder
        .build({
            targets: builder.Platform.LINUX.createTarget(),
            config,
        })
        .then((result) => {
            console.log('BUILD SUCCESS');
            console.log(result);
        })
        .catch((error: unknown): void => {
            console.error('ERROR at BUILD');
            console.error(error);
        });
}

/**
 * Function for create the Suse RPM Package
 */
async function buildRpm(filenameAddition: string): Promise<void> {
    const config: builder.Configuration = {
        appId: 'tuxedocontrolcenter',
        artifactName: `\${productName}_\${version}${filenameAddition}.\${ext}`,
        directories: {
            output: './dist/packages',
        },
        compression: 'maximum',
        files: [`${distSrc}/**/*`],
        extraResources: [
            `${distSrc}/data/service/tccd`,
            `${distSrc}/data/service/TuxedoIOAPI.node`,
            `${distSrc}/data/dist-data/tccd.service`,
            `${distSrc}/data/dist-data/tccd-sleep.service`,
            `${distSrc}/data/dist-data/tccaquaris-keeper.service`,
            `${distSrc}/data/dist-data/tuxedo-control-center_256.svg`,
            `${distSrc}/data/dist-data/tuxedo-control-center.desktop`,
            `${distSrc}/data/dist-data/tuxedo-control-center-tray.desktop`,
            `${distSrc}/data/dist-data/com.tuxedocomputers.tccd.policy`,
            `${distSrc}/data/dist-data/com.tuxedocomputers.tccd.conf`,
            `${distSrc}/data/camera/cameractrls.py`,
            `${distSrc}/data/camera/v4l2_kernel_names.json`,
            `${distSrc}/data/dist-data/99-webcam.rules`,
            './tools/tcc',
            './tools/tccinfo',
            './tools/tccprofile',
            './tools/tccaquaris',
            './tools/tccauto',
        ],
        linux: {
            target: ['rpm'],
            category: 'System',
            icon: `${distSrc}/data/dist-data/tuxedo-control-center_256.svg`,
        },
        rpm: {
            compression: 'xz',
            depends: [
                '(tuxedo-drivers >= 4.0.0 or tuxedo-keyboard >= 3.1.2)',
                '(libayatana-appindicator3-1 or libappindicator or libappindicator3-1)',
            ],
            afterInstall: './build-src/dummy.sh',
            afterRemove: './build-src/after_remove.sh',
            fpm: [
                '--replaces=tuxedofancontrol <= 0.1.9',
                '--rpm-posttrans=./build-src/after_install.sh',
                '--inputs=build-src/package-files.txt',
                '--rpm-tag=%define _build_id_links none',
            ],
        },
    };

    console.log('\x1b[36m%s\x1b[0m', 'Create Suse RPM Package');
    console.log('config', config);
    await builder
        .build({
            targets: builder.Platform.LINUX.createTarget(),
            config,
        })
        .then((result) => {
            console.log('BUILD SUCCESS');
            console.log(result);
        })
        .catch((error: unknown): void => {
            console.error('ERROR at BUILD');
            console.error(error);
        });
}

/**
 * Execute all Builds in the buildSteps List
 */
async function startBuild() {
    console.log('Start packaging');
    console.log(`Filename addition: '${filenameAddition}'`);
    try {
        for (const step of buildSteps) {
            console.log(`Build step: ${step.name}`);
            await step(filenameAddition);
            console.log('\n');
        }
    } catch (err) {
        console.log(`Error on build => ${err}`);
        process.exit(1);
    }
}

startBuild();
