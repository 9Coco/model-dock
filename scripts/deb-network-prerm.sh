#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Also embedded in postinst to reconcile 0.4.0 offline upgrades.
set -eu

case "$1" in
    configure|remove|deconfigure) ;;
    *) exit 0 ;;
esac

template=/usr/lib/systemd/system/modeldock-network-access@.socket
wants=/etc/systemd/system/sockets.target.wants
state=/var/lib/modeldock-network-access

stop_instance() {
    if [ -d /run/systemd/system ]; then
        /usr/bin/systemctl stop "modeldock-network-access@$1.socket" "modeldock-network-access@$1.service"
    fi
}

# The old helper's offline prerm removed its markers but left socket symlinks.
# Only unlink numeric instances pointing to the template installed by this deb.
for link in "$wants"/modeldock-network-access@*.socket; do
    [ -L "$link" ] && [ "$link" -ef "$template" ] || continue
    uid=${link##*@}
    uid=${uid%.socket}
    case "$uid" in ''|*[!0-9]*) continue ;; esac
    marker="$state/$uid.enabled"
    if [ "$1" = configure ] && [ -f "$marker" ]; then continue; fi
    stop_instance "$uid"
    rm -f -- "$link"
    if [ "$1" != configure ]; then rm -f -- "$marker"; fi
done

if [ "$1" != configure ]; then
    for marker in "$state"/*.enabled; do
        [ -f "$marker" ] || continue
        uid=${marker##*/}
        uid=${uid%.enabled}
        case "$uid" in ''|*[!0-9]*) continue ;; esac
        # An authorized instance may still be active after it was disabled.
        stop_instance "$uid"
        rm -f -- "$marker"
    done
fi
