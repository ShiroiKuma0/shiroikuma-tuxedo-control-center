#!/bin/bash

# In case TFC service is active, deactivate
systemctl stop tuxedofancontrol > /dev/null 2>&1 || true
systemctl disable tuxedofancontrol > /dev/null 2>&1 || true

DIST_DATA=/opt/shiroikuma-tuxedo-control-center/resources/dist/tuxedo-control-center/data/dist-data

rm /usr/share/applications/tuxedo-control-center.desktop || true
cp ${DIST_DATA}/tuxedo-control-center.desktop /usr/share/applications/tuxedo-control-center.desktop || true

mkdir -p /etc/skel/.config/autostart || true
cp ${DIST_DATA}/tuxedo-control-center-tray.desktop /etc/skel/.config/autostart/tuxedo-control-center-tray.desktop || true

cp ${DIST_DATA}/com.tuxedocomputers.tccd.policy /usr/share/polkit-1/actions/com.tuxedocomputers.tccd.policy || true
cp ${DIST_DATA}/com.tuxedocomputers.tccd.conf /usr/share/dbus-1/system.d/com.tuxedocomputers.tccd.conf || true

cp ${DIST_DATA}/com.tuxedocomputers.tomte.policy /usr/share/polkit-1/actions/com.tuxedocomputers.tomte.policy || true

# Copy and enable services
cp ${DIST_DATA}/tccd.service /etc/systemd/system/tccd.service || true
cp ${DIST_DATA}/tccd-sleep.service /etc/systemd/system/tccd-sleep.service || true
systemctl daemon-reload
systemctl enable tccd tccd-sleep
systemctl restart tccd

# Aquaris keeper — per-user service that holds the BLE link, keeps the LED dark,
# and applies the desired LED/pump/fan state (yielding to the GUI while it runs).
install -D -m 0644 ${DIST_DATA}/tccaquaris-keeper.service /usr/lib/systemd/user/tccaquaris-keeper.service || true
systemctl --global enable tccaquaris-keeper.service || true
# Run headless across logouts for the primary desktop user (this fork's owner).
loginctl enable-linger shiroikuma || true

# set up udev rules
mv ${DIST_DATA}/99-webcam.rules /etc/udev/rules.d/99-webcam.rules
udevadm control --reload-rules && udevadm trigger

# Headless CLI front-ends — symlink onto PATH (canonical copies live in resources/tools).
# NB: loop var is referenced as $t (no braces) on purpose — electron-builder
# macro-expands this whole install script, and a lowercase brace-token would be
# read as an undefined macro and abort the build (UPPER_SNAKE names are ignored).
TOOLS_DIR=/opt/shiroikuma-tuxedo-control-center/resources/tools
for t in tcc tccinfo tccprofile tccaquaris tccauto; do
    if [ -f "$TOOLS_DIR/$t" ]; then
        chmod 0755 "$TOOLS_DIR/$t" || true
        ln -sf "$TOOLS_DIR/$t" "/usr/bin/$t" || true
    fi
done

# ---
# Original electron-builder after-install.tpl
# ---
ln -sf '/opt/shiroikuma-tuxedo-control-center/tuxedo-control-center' '/usr/bin/tuxedo-control-center' || true

# SUID chrome-sandbox for Electron 5+
chmod 4755 '/opt/shiroikuma-tuxedo-control-center/chrome-sandbox' || true

update-mime-database /usr/share/mime || true
update-desktop-database /usr/share/applications || true
