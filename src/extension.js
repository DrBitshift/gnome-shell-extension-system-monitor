/* extension.js
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const ByteArray = imports.byteArray;

import * as Settings from './settings.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const netSpeedUnits = ['B', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];

let lastTotalNetDownBytes = 0;
let lastTotalNetUpBytes = 0;
let lastCPUUsed = 0;
let lastCPUTotal = 0;

/* --- Utility Stats Functions --- */

const getCurrentNetSpeed = (refreshInterval) => {
    const netSpeed = { down: 0, up: 0 };
    try {
        const inputFile = Gio.File.new_for_path('/proc/net/dev');
        const [, content] = inputFile.load_contents(null);
        const contentStr = ByteArray.toString(content);
        const contentLines = contentStr.split('\n');
        let totalDownBytes = 0,
            totalUpBytes = 0;

        for (let line of contentLines) {
            const fields = line.trim().split(/\W+/);
            if (fields.length <= 2) continue;
            const iface = fields[0];
            const down = Number.parseInt(fields[1]);
            const up = Number.parseInt(fields[9]);
            if (
                iface === 'lo' ||
                iface.match(/^(ifb|lxdbr|virbr|br|vnet|tun|tap)[0-9]+/) ||
                isNaN(down) ||
                isNaN(up)
            )
                continue;
            totalDownBytes += down;
            totalUpBytes += up;
        }

        if (lastTotalNetDownBytes !== 0)
            netSpeed.down = (totalDownBytes - lastTotalNetDownBytes) / refreshInterval;
        if (lastTotalNetUpBytes !== 0)
            netSpeed.up = (totalUpBytes - lastTotalNetUpBytes) / refreshInterval;
        lastTotalNetDownBytes = totalDownBytes;
        lastTotalNetUpBytes = totalUpBytes;
    } catch (e) {
        console.error(e);
    }
    return netSpeed;
};

const getCurrentCPUUsage = () => {
    let usage = 0;
    try {
        const inputFile = Gio.File.new_for_path('/proc/stat');
        const [, content] = inputFile.load_contents(null);
        const contentStr = ByteArray.toString(content);
        const firstLine = contentStr.split('\n')[0];
        const fields = firstLine.trim().split(/\W+/);
        if (fields[0] === 'cpu' && fields.length >= 5) {
            const user = Number.parseInt(fields[1]),
                nice = Number.parseInt(fields[2]),
                sys = Number.parseInt(fields[3]),
                idle = Number.parseInt(fields[4]);
            const used = user + nice + sys,
                total = used + idle;
            if (total - lastCPUTotal !== 0) usage = (used - lastCPUUsed) / (total - lastCPUTotal);
            lastCPUTotal = total;
            lastCPUUsed = used;
        }
    } catch (e) {
        console.error(e);
    }
    return usage;
};

const getMemoryInfo = () => {
    let mem = { total: 0, avail: 0, swTotal: 0, swFree: 0 };
    try {
        const inputFile = Gio.File.new_for_path('/proc/meminfo');
        const [, content] = inputFile.load_contents(null);
        const lines = ByteArray.toString(content).split('\n');
        for (let line of lines) {
            const f = line.trim().split(/\W+/);
            if (f.length < 2) continue;
            const v = Number.parseInt(f[1]);
            if (f[0] === 'MemTotal') mem.total = v;
            else if (f[0] === 'MemAvailable') mem.avail = v;
            else if (f[0] === 'SwapTotal') mem.swTotal = v;
            else if (f[0] === 'SwapFree') mem.swFree = v;
        }
    } catch (e) {
        console.error(e);
    }
    return mem;
};

const formatNetSpeed = (amount, full) => {
    let ui = 0;
    while (amount >= 1000 && ui < netSpeedUnits.length - 1) {
        amount /= 1000;
        ui++;
    }
    let d = amount >= 100 || amount < 0.01 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toFixed(d).padStart(4)} ${netSpeedUnits[ui]}${full ? '/s' : ''}`;
};

const formatUsage = (val, extra, perc) =>
    Math.round(val * 100)
        .toString()
        .padStart(extra ? 3 : 2) + (perc ? '%' : '');

/* --- Indicator Class --- */

const Indicator = GObject.registerClass(
    class Indicator extends PanelMenu.Button {
        _init(extension) {
            super._init(0.5, 'Simple System Monitor');
            this._extension = extension;

            this._label = new St.Label({
                text: _('Initializing...'),
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'panel-label', // This is the magic class for theme inheritance
            });

            this.add_child(this._label);
            this._buildMenu();
        }

        _buildMenu() {
            const monitorItem = new PopupMenu.PopupMenuItem(_('Open System Monitor'));
            monitorItem.connect('activate', () => {
                const appSys = Shell.AppSystem.get_default();
                const ids = [
                    'org.gnome.SystemMonitor.desktop',
                    'gnome-system-monitor.desktop',
                    'org.gnome.Usage.desktop',
                ];
                for (let id of ids) {
                    let app = appSys.lookup_app(id);
                    if (app) {
                        app.activate();
                        return;
                    }
                }
            });
            this.menu.addMenuItem(monitorItem);

            const settingsItem = new PopupMenu.PopupMenuItem(_('Settings'));
            settingsItem.connect('activate', () => this._extension.openPreferences());
            this.menu.addMenuItem(settingsItem);
        }

        updateStyle(family, size, color, weight) {
            // Start with a clean slate (removes all inline style overrides)
            this._label.set_style(null);

            let styleParts = [
                `font-family: "${family}"`,
                `font-size: ${size}px`,
                `font-weight: ${weight}`,
            ];

            // Only add the color property if the user didn't choose "default"
            // If we omit "color:", it perfectly inherits from your Pink Panel or Light/Dark theme
            if (color && color !== '' && color.toLowerCase() !== 'default') {
                styleParts.push(`color: ${color}`);
            }

            this._label.set_style(styleParts.join('; ') + ';');
        }

        setText(text) {
            this._label.set_text(text);
        }
    },
);

/* --- Extension Entry Point --- */

export default class SSMExtension extends Extension {
    enable() {
        lastTotalNetDownBytes = 0;
        lastTotalNetUpBytes = 0;
        lastCPUUsed = 0;
        lastCPUTotal = 0;

        this._prefs = new Settings.Prefs(this.getSettings(Settings.SETTING_SCHEMA));
        this._indicator = new Indicator(this);

        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator,
            this._prefs.EXTENSION_ORDER.get(),
            this._prefs.EXTENSION_POSITION.get(),
        );

        // Watch for any setting changes and update
        const keys = [
            'FONT_FAMILY',
            'FONT_SIZE',
            'TEXT_COLOR',
            'FONT_WEIGHT',
            'SHOW_EXTRA_SPACES',
            'SHOW_PERCENT_SIGN',
            'IS_CPU_USAGE_ENABLE',
            'IS_MEMORY_USAGE_ENABLE',
            'IS_DOWNLOAD_SPEED_ENABLE',
            'IS_UPLOAD_SPEED_ENABLE',
            'IS_SWAP_USAGE_ENABLE',
            'CPU_USAGE_TEXT',
            'MEMORY_USAGE_TEXT',
            'DOWNLOAD_SPEED_TEXT',
            'UPLOAD_SPEED_TEXT',
            'SWAP_USAGE_TEXT',
            'ITEM_SEPARATOR',
            'SHOW_FULL_NET_SPEED_UNIT',
        ];
        keys.forEach((k) =>
            this._prefs[k].changed(() => {
                this._updateStyles();
                this._refresh();
            }),
        );

        this._prefs.REFRESH_INTERVAL.changed(() => this._setupTimer());

        this._updateStyles();
        this._setupTimer();
    }

    disable() {
        if (this._timeout) GLib.source_remove(this._timeout);
        this._indicator?.destroy();
        this._timeout = null;
        this._indicator = null;
        this._prefs = null;
    }

    _setupTimer() {
        if (this._timeout) GLib.source_remove(this._timeout);
        this._refresh_interval = this._prefs.REFRESH_INTERVAL.get();
        this._timeout = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT_IDLE,
            this._refresh_interval,
            () => this._refresh(),
        );
    }

    _updateStyles() {
        this._indicator.updateStyle(
            this._prefs.FONT_FAMILY.get(),
            this._prefs.FONT_SIZE.get(),
            this._prefs.TEXT_COLOR.get(),
            this._prefs.FONT_WEIGHT.get(),
        );
    }

    _refresh() {
        if (!this._indicator) return GLib.SOURCE_REMOVE;

        const mem = getMemoryInfo();
        const items = [];
        const extra = this._prefs.SHOW_EXTRA_SPACES.get();
        const perc = this._prefs.SHOW_PERCENT_SIGN.get();

        if (this._prefs.IS_CPU_USAGE_ENABLE.get())
            items.push(
                `${this._prefs.CPU_USAGE_TEXT.get()} ${formatUsage(
                    getCurrentCPUUsage(),
                    extra,
                    perc,
                )}`,
            );

        if (this._prefs.IS_MEMORY_USAGE_ENABLE.get() && mem.total > 0)
            items.push(
                `${this._prefs.MEMORY_USAGE_TEXT.get()} ${formatUsage(
                    (mem.total - mem.avail) / mem.total,
                    extra,
                    perc,
                )}`,
            );

        if (this._prefs.IS_SWAP_USAGE_ENABLE.get() && mem.swTotal > 0)
            items.push(
                `${this._prefs.SWAP_USAGE_TEXT.get()} ${formatUsage(
                    (mem.swTotal - mem.swFree) / mem.swTotal,
                    extra,
                    perc,
                )}`,
            );

        if (
            this._prefs.IS_DOWNLOAD_SPEED_ENABLE.get() ||
            this._prefs.IS_UPLOAD_SPEED_ENABLE.get()
        ) {
            const net = getCurrentNetSpeed(this._refresh_interval);
            const full = this._prefs.SHOW_FULL_NET_SPEED_UNIT.get();
            if (this._prefs.IS_DOWNLOAD_SPEED_ENABLE.get())
                items.push(
                    `${this._prefs.DOWNLOAD_SPEED_TEXT.get()} ${formatNetSpeed(net.down, full)}`,
                );
            if (this._prefs.IS_UPLOAD_SPEED_ENABLE.get())
                items.push(
                    `${this._prefs.UPLOAD_SPEED_TEXT.get()} ${formatNetSpeed(net.up, full)}`,
                );
        }

        this._indicator.setText(items.join(this._prefs.ITEM_SEPARATOR.get()));
        return GLib.SOURCE_CONTINUE;
    }
}
