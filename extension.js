/* Split Routing — panel indicator.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * State is read from NetworkManager and refreshed from NetworkManager signals,
 * never polled. Every main loop source and every signal connection made here is
 * tracked and torn down in destroy(), which disable() calls.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Engine from './lib/engine.js';
import * as NetInfo from './lib/netinfo.js';

// NetworkManager reports a reapply as several property changes in a row;
// coalesce them into one refresh.
const REFRESH_DEBOUNCE_MS = 400;

// How long after a switch the routing table is allowed to lag behind the
// settings before a gap is reported as a problem (microseconds).
const GRACE_US = 5 * 1000 * 1000;

// reapply() returns when NetworkManager accepts the change, not when the
// routing table reflects it, and libnm may update a device's IP config in
// place — in which case notify::ip4-config never fires and nothing would ever
// look again. So after a switch, look again a few times, then stop.
const SETTLE_MS = [1000, 3000, 6000];

// Live traffic rates are sampled only while the menu is open.
const RATE_MS = 1000;

const STATE_UI = {
    'direct': {
        label: 'DIRECT',
        icon: 'network-workgroup-symbolic',
        status: 'Normal routing.',
    },
    'split': {
        label: 'SPLIT',
        icon: 'network-transmit-receive-symbolic',
        status: 'Split routing is active.',
    },
    // Same label as 'split' on purpose: the switch is either on or off.
    // What is different is the icon, and the menu lines marked with a warning.
    'partial': {
        label: 'SPLIT',
        icon: 'dialog-warning-symbolic',
        status: 'Split routing is on, but part of it is not in effect right now.',
    },
};

function isCancelled(e) {
    return e instanceof GLib.Error &&
        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function errorText(e) {
    if (e instanceof GLib.Error)
        Gio.DBusError.strip_remote_error(e);
    return e?.message ?? String(e);
}

// A menu line is never cut short with "…": it wraps instead, so an interface
// name, an address or an error message is always there in full.
function fullLabel(text, style = '') {
    const label = new St.Label({text, style, x_expand: true});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    return label;
}

// Lines of text that are information, not actions.
const InfoItem = GObject.registerClass(
class SplitRoutingInfoItem extends PopupMenu.PopupBaseMenuItem {
    _init(lines) {
        super._init({reactive: false, can_focus: false});
        this._box = new St.BoxLayout({vertical: true, x_expand: true});
        this.add_child(this._box);
        this.labels = lines.map(([text, style]) => {
            const label = fullLabel(text, style);
            this._box.add_child(label);
            return label;
        });
    }
});

// An action that keeps the menu open, so its result shows up in place.
const StayOpenItem = GObject.registerClass(
class SplitRoutingStayOpenItem extends PopupMenu.PopupBaseMenuItem {
    _init(text, callback) {
        super._init();
        this.label = fullLabel(text);
        this.add_child(this.label);
        this._callback = callback;
    }

    // Not emitting 'activate' is what keeps the menu from closing.
    activate(_event) {
        this._callback();
    }
});

const Indicator = GObject.registerClass(
class SplitRoutingIndicator extends PanelMenu.Button {
    _init(extension) {
        // A click opens the menu under the icon; the switch inside it is
        // what changes the routing.
        super._init(0.5, 'Split Routing');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._cancellable = new Gio.Cancellable();

        this._sourceIds = new Set();
        this._settingsIds = [];
        this._clientIds = [];
        this._deviceIds = new Map();

        this._client = null;
        this._destroyed = false;
        this._busy = false;
        this._enforceAgain = false;
        this._reportAgain = false;
        this._state = 'direct';
        this._lines = [];
        this._refreshId = 0;
        this._graceUntil = 0;
        this._rateId = 0;
        this._samples = new Map();      // iface → {rx, tx, at}
        this._rateLabels = new Map();   // iface → St.Label
        this._tests = new Map();        // iface → {running, text}

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: STATE_UI['direct'].icon,
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-left: 4px;',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._switch = new PopupMenu.PopupSwitchMenuItem('Split routing', false);
        this._switch.connect('toggled', (_item, on) => this._setEnabled(on));
        this.menu.addMenuItem(this._switch);

        this._statusSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._statusSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Networks'));
        this._cardsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._cardsSection);

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._startRates();
            else
                this._stopRates();
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Settings…', () => this._openPreferences());

        for (const key of ['rules', 'default-device', 'undo-record', 'split-enabled']) {
            this._settingsIds.push(
                this._settings.connect(`changed::${key}`, () => this._refresh()));
        }

        this._updateUi();
        this._connectClient();
    }

    /* ---------------------------------------------------------- lifecycle */

    _addTimeout(intervalMs, callback) {
        let id = 0;
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
            const result = callback();
            if (result === GLib.SOURCE_REMOVE)
                this._sourceIds.delete(id);
            return result;
        });
        this._sourceIds.add(id);
        return id;
    }

    _connectClient() {
        Engine.getClient(this._cancellable).then(client => {
            if (this._destroyed)
                return;
            this._client = client;
            this._clientIds.push(client.connect('device-added', (_c, device) => {
                this._watchDevice(device);
                this._queueRefresh();
            }));
            this._clientIds.push(client.connect('device-removed', (_c, device) => {
                this._unwatchDevice(device);
                this._queueRefresh();
            }));
            // A new profile is protected the moment it appears, not when a
            // card first connects with it.
            for (const signal of ['connection-added', 'connection-removed'])
                this._clientIds.push(client.connect(signal, () => this._queueRefresh()));
            for (const device of client.get_devices())
                this._watchDevice(device);
            this._refresh();
        }).catch(e => {
            if (isCancelled(e))
                return;
            logError(e, 'Split Routing: cannot reach NetworkManager');
        });
    }

    _watchDevice(device) {
        if (this._deviceIds.has(device))
            return;
        this._deviceIds.set(device, [
            device.connect('state-changed', () => this._queueRefresh()),
            device.connect('notify::ip4-config', () => this._queueRefresh()),
            device.connect('notify::ip6-config', () => this._queueRefresh()),
        ]);
    }

    _unwatchDevice(device) {
        const ids = this._deviceIds.get(device);
        if (!ids)
            return;
        // NOT device.disconnect(id): NM.Device has its own disconnect() method,
        // which takes down the card. Always disconnect signals explicitly.
        for (const id of ids)
            GObject.signal_handler_disconnect(device, id);
        this._deviceIds.delete(device);
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();

        for (const id of this._sourceIds)
            GLib.source_remove(id);
        this._sourceIds.clear();
        this._refreshId = 0;

        for (const id of this._settingsIds)
            GObject.signal_handler_disconnect(this._settings, id);
        this._settingsIds = [];

        if (this._client) {
            for (const id of this._clientIds)
                GObject.signal_handler_disconnect(this._client, id);
            for (const device of [...this._deviceIds.keys()])
                this._unwatchDevice(device);
        }
        this._clientIds = [];
        this._deviceIds.clear();
        this._client = null;
        // _settings is kept: every signal on it is disconnected above, and a
        // change that lands during teardown must still reach the undo record.
        // It is released with the indicator itself.

        super.destroy();
    }

    /* --------------------------------------------------------------- state */

    _readConfig() {
        let rules = [];
        try {
            const parsed = JSON.parse(this._settings.get_string('rules'));
            rules = Array.isArray(parsed) ? parsed : [];
        } catch (_e) {}
        return {rules, defaultDevice: this._settings.get_string('default-device')};
    }

    _isConfigured() {
        const {rules, defaultDevice} = this._readConfig();
        return rules.length > 0 || defaultDevice !== '';
    }

    _readRecord() {
        return Engine.parseRecord(this._settings.get_string('undo-record'));
    }

    // Deliberately not gated on _destroyed: if a change lands while the
    // extension is being disabled, the undo record still has to describe it,
    // or the change could never be undone from here again.
    _writeRecord(record) {
        this._settings?.set_string('undo-record', JSON.stringify(record));
    }

    // NetworkManager updates a device's runtime config slightly after reapply()
    // returns, so for a moment after a switch the routing table legitimately
    // does not match the settings yet. Never report that window as a problem.
    _inGracePeriod() {
        return GLib.get_monotonic_time() < this._graceUntil;
    }

    // Bounded, and only after the user switched. Not polling: once the last
    // one fires, nothing is scheduled again until NetworkManager changes.
    _scheduleSettleChecks() {
        for (const delay of SETTLE_MS) {
            this._addTimeout(delay, () => {
                this._refresh();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _queueRefresh() {
        if (this._destroyed || this._refreshId)
            return;
        this._refreshId = this._addTimeout(REFRESH_DEBOUNCE_MS, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        if (this._destroyed || !this._client)
            return;

        const enabled = this._settings.get_boolean('split-enabled');
        const previous = this._state;

        if (enabled) {
            this._lines = Engine.describePlan(this._client, this._readConfig());
            const allOk = this._lines.every(line => line.ok);
            // Right after a switch a gap is NetworkManager catching up, not a
            // failure: keep showing what was there and let the settle checks
            // decide.
            if (allOk || !this._inGracePeriod())
                this._state = allOk ? 'split' : 'partial';
        } else {
            this._lines = [];
            this._state = 'direct';
        }
        this._updateUi();

        // A card that reconnected, a card that appeared, settings saved while
        // on: all of them are put back in line here, without a click.
        this._enforce(false);

        if (this._state === 'partial' && previous !== 'partial')
            this._notifyPartial();
    }

    _notifyPartial() {
        const bad = this._lines.filter(line => !line.ok).map(line => line.text);
        Main.notify('Split Routing', `Not in effect right now:\n${bad.join('\n')}`);
    }

    _updateUi() {
        const ui = STATE_UI[this._state] ?? STATE_UI['direct'];
        const enabled = this._settings.get_boolean('split-enabled');

        this._icon.icon_name = ui.icon;
        // Without notifying: 'toggled' only comes from the user.
        this._switch.setToggleState(enabled);
        this._switch.setSensitive(enabled || this._isConfigured());

        this._statusSection.removeAll();
        if (!this._isConfigured())
            this._statusSection.addMenuItem(new InfoItem([['No rules yet — open Settings to add one']]));
        for (const line of this._lines)
            this._statusSection.addMenuItem(new InfoItem([[`${line.ok ? '✓' : '⚠'}  ${line.text}`]]));

        this._updateCards();

        if (this._busy) {
            this._label.text = '…';
            this.accessible_name =
                'Split Routing: asking NetworkManager to apply the change';
            return;
        }

        if (!this._isConfigured() && this._state === 'direct') {
            this._label.text = 'SET UP';
            this.accessible_name =
                'Split Routing: no routing rules yet. Open the menu for the settings.';
            return;
        }

        this._label.text = ui.label;
        this.accessible_name = `Split Routing: ${ui.status}`;
    }

    /* ------------------------------------------------------------ networks */

    _updateCards() {
        this._cardsSection.removeAll();
        this._rateLabels.clear();
        if (!this._client)
            return;

        const cards = Engine.listCards(this._client);
        if (!cards.length)
            this._cardsSection.addMenuItem(new InfoItem([['No Ethernet or Wi-Fi card found']]));

        for (const card of cards) {
            const defaults = [card.default4 && 'IPv4', card.default6 && 'IPv6'].filter(Boolean);
            let rateIndex = -1;
            const lines = [
                [Engine.cardName(this._client, card.iface), 'font-weight: bold;'],
                [`${card.kind} · ${card.bus} · ${card.status}`],
            ];
            if (card.connection)
                lines.push([`Connection: ${card.connection}`]);
            if (card.addresses.length)
                lines.push([`Addresses: ${card.addresses.join(', ')}`]);
            if (card.gateway4 || card.gateway6)
                lines.push([`Gateway: ${[card.gateway4, card.gateway6].filter(Boolean).join(', ')}`]);
            if (card.connected) {
                lines.push([defaults.length
                    ? `Carries the default route (${defaults.join(', ')}): the internet goes out here`
                    : 'No default route: only its own subnets and the rules go out here']);
                rateIndex = lines.push([this._rateText(card.iface)]) - 1;
            }
            const test = this._tests.get(card.iface);
            if (test?.text)
                lines.push([test.text]);

            const info = new InfoItem(lines);
            if (rateIndex >= 0)
                this._rateLabels.set(card.iface, info.labels[rateIndex]);
            this._cardsSection.addMenuItem(info);

            if (card.connected)
                this._cardsSection.addMenuItem(this._speedTestItem(card));
        }
    }

    _rateText(iface) {
        const sample = this._samples.get(iface);
        if (!sample?.rate)
            return 'Traffic: measuring…';
        return `Traffic now: ↓ ${NetInfo.formatRate(sample.rate.rx)}  ↑ ${NetInfo.formatRate(sample.rate.tx)}` +
            `  ·  since connected: ↓ ${NetInfo.formatBytes(sample.rx)}  ↑ ${NetInfo.formatBytes(sample.tx)}`;
    }

    _sampleRates() {
        const now = GLib.get_monotonic_time();
        for (const [iface, label] of this._rateLabels) {
            const counters = NetInfo.readCounters(iface);
            if (!counters)
                continue;
            const last = this._samples.get(iface);
            const seconds = last ? (now - last.at) / 1e6 : 0;
            // A counter that went backwards means the card was re-created.
            const rate = last && seconds > 0 && counters.rx >= last.rx && counters.tx >= last.tx
                ? {rx: (counters.rx - last.rx) / seconds, tx: (counters.tx - last.tx) / seconds}
                : null;
            this._samples.set(iface, {...counters, at: now, rate});
            label.text = this._rateText(iface);
        }
    }

    _startRates() {
        this._updateCards();
        this._sampleRates();
        if (this._rateId)
            return;
        this._rateId = this._addTimeout(RATE_MS, () => {
            this._sampleRates();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopRates() {
        if (this._rateId) {
            GLib.source_remove(this._rateId);
            this._sourceIds.delete(this._rateId);
            this._rateId = 0;
        }
        // A rate across a closed menu would be an average over minutes.
        this._samples.clear();
    }

    _speedTestItem(card) {
        const {downBytes, upBytes, maxSeconds} = NetInfo.LIMITS;
        const running = this._tests.get(card.iface)?.running;
        const text = running
            ? `Testing ${Engine.cardName(this._client, card.iface)}…`
            : `Speed test through ${Engine.cardName(this._client, card.iface)} (up to ${NetInfo.formatBytes(downBytes)} down + ${NetInfo.formatBytes(upBytes)} up, ${maxSeconds} s each)`;
        const item = new StayOpenItem(text, () => this._runSpeedTest(card));
        item.setSensitive(!running);
        return item;
    }

    async _runSpeedTest(card) {
        const iface = card.iface;
        if (this._tests.get(iface)?.running)
            return;

        // Bound to the card, curl can only use that card's own routes: with no
        // default route there is no way to the internet, and it would only
        // wait for the timeout.
        if (!card.default4 && !card.default6) {
            this._tests.set(iface, {running: false,
                text: 'Speed test: not run — this card has no default route, so it has no way to the internet right now'});
            this._updateCards();
            return;
        }

        this._tests.set(iface, {running: true, text: 'Speed test: running…'});
        this._updateCards();

        let text;
        try {
            const {down, up} = await NetInfo.speedTest(iface, this._cancellable);
            const part = r => `${NetInfo.formatRate(r.rate)} (${NetInfo.formatBytes(r.bytes)}${r.cutShort ? ', stopped at the time limit' : ''})`;
            const ms = seconds => `${(seconds * 1000).toFixed(seconds < 0.01 ? 1 : 0)} ms`;
            const time = GLib.DateTime.new_now_local().format('%H:%M:%S');
            text = `Speed test ${time}: ↓ ${part(down)}  ↑ ${part(up)}  ·  TCP connect ${ms(down.handshake)} (to the first host that answers: a proxy, if this network has one)`;
        } catch (e) {
            if (isCancelled(e) || this._destroyed)
                return;
            text = `Speed test failed: ${errorText(e)}`;
        }
        if (this._destroyed)
            return;
        this._tests.set(iface, {running: false, text});
        this._updateCards();
    }

    /* -------------------------------------------------------------- action */

    // Extension.openPreferences() makes this exact D-Bus call and then throws
    // the result away, so when the Shell refuses — most often "Already showing
    // a prefs dialog", because a preferences window is open somewhere, perhaps
    // on another workspace — the menu item silently does nothing. Same call,
    // with the answer actually read.
    _openPreferences() {
        Gio.DBus.session.call(
            'org.gnome.Shell.Extensions',
            '/org/gnome/Shell/Extensions',
            'org.gnome.Shell.Extensions',
            'OpenExtensionPrefs',
            new GLib.Variant('(ssa{sv})', [this._extension.uuid, '', {}]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (bus, res) => {
                try {
                    bus.call_finish(res);
                } catch (e) {
                    if (isCancelled(e))
                        return;
                    Main.notifyError('Split Routing',
                        `Cannot open the settings window: ${errorText(e)}`);
                }
            });
    }

    _setEnabled(on) {
        if (!this._client)
            return;
        this._graceUntil = GLib.get_monotonic_time() + GRACE_US;
        // The write itself triggers _refresh(), which also enforces; this call
        // only makes sure the problems of a switch the user made are shown.
        this._settings.set_boolean('split-enabled', on);
        this._enforce(true);
        this._scheduleSettleChecks();
    }

    // One run at a time. A request that arrives mid-run is folded into one
    // more run afterwards, which reads the newest settings and the newest
    // NetworkManager state.
    _enforce(report) {
        if (this._destroyed || !this._client)
            return;
        if (this._busy) {
            this._enforceAgain = true;
            this._reportAgain ||= report;
            return;
        }
        this._busy = true;
        // Fire and forget: _runEnforce() handles every outcome itself.
        this._runEnforce(report);
    }

    async _runEnforce(report) {
        const persist = record => this._writeRecord(record);
        let problems = [];

        try {
            const record = this._readRecord();
            if (this._settings.get_boolean('split-enabled')) {
                ({problems} = await Engine.enforceSplit(
                    this._client, this._readConfig(), record, persist, this._cancellable));
            } else if (record.devices.length) {
                ({problems} = await Engine.revertSplit(
                    this._client, record, persist, this._cancellable));
            }
        } catch (e) {
            if (isCancelled(e))
                return;
            logError(e, 'Split Routing');
            Main.notifyError('Split Routing', errorText(e));
        } finally {
            if (!this._destroyed) {
                this._busy = false;
                this._updateUi();
            }
        }

        if (this._destroyed)
            return;
        if (report && problems.length)
            Main.notify('Split Routing', problems.join('\n'));

        if (this._enforceAgain) {
            const again = this._reportAgain;
            this._enforceAgain = false;
            this._reportAgain = false;
            this._enforce(again);
        }
    }
});

export default class SplitRoutingExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
