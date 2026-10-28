/* Split Routing — preferences.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The page is built synchronously, because the caller checks that a page exists
 * as soon as fillPreferencesWindow() returns. NetworkManager is contacted
 * asynchronously and the card lists are filled in when it answers.
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Engine from './lib/engine.js';

const NO_CARDS = '(no network card found)';
const KEEP_DEFAULT = '(leave the default route untouched)';

function readRules(settings) {
    try {
        const rules = JSON.parse(settings.get_string('rules'));
        return Array.isArray(rules) ? rules : [];
    } catch (_e) {
        return [];
    }
}

export default class SplitRoutingPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(860, 860);

        const page = new Adw.PreferencesPage({
            title: 'Split Routing',
            icon_name: 'network-workgroup-symbolic',
        });
        window.add(page);

        // Filled in once NetworkManager answers.
        let ifaces = [];
        let cardLabels = [NO_CARDS];
        let client = null;
        let syncing = false;

        const ruleRows = [];


        // libadwaita ellipsises a row's subtitle and offers no property to stop
        // it, so reach the label and turn it off. With ellipsize NONE the label
        // asks for its natural width, which widens the row — and the window's
        // minimum width with it — instead of hiding what it cannot fit. Losing
        // the end of an interface name is worse than a wide window.
        const dontEllipsise = row => {
            const children = [];
            const collect = w => {
                for (let c = w.get_first_child(); c; c = c.get_next_sibling()) {
                    children.push(c);
                    collect(c);
                }
            };
            collect(row);
            for (const child of children) {
                if (child instanceof Gtk.Label && child.label === row.subtitle) {
                    child.ellipsize = Pango.EllipsizeMode.NONE;
                    child.wrap = false;
                }
            }
        };

        // The same for the drop-down list, where it is a supported factory
        // rather than a reach into someone else's widgets.
        const plainList = () => {
            const factory = new Gtk.SignalListItemFactory();
            factory.connect('setup', (_f, item) => {
                item.child = new Gtk.Label({
                    xalign: 0,
                    ellipsize: Pango.EllipsizeMode.NONE,
                    wrap: false,
                });
            });
            factory.connect('bind', (_f, item) => {
                item.child.label = item.item.string;
            });
            return factory;
        };

        const infoRow = (title, subtitle) => new Adw.ActionRow({
            title,
            subtitle,
            title_lines: 0,
            subtitle_lines: 0,
        });

        const toast = text => {
            if (typeof window.add_toast === 'function')
                window.add_toast(new Adw.Toast({title: text, timeout: 6}));
        };

        /* ------------------------------------------------------ how it works */

        const introGroup = new Adw.PreferencesGroup();
        page.add(introGroup);

        const howto = new Adw.ExpanderRow({
            title: 'How it works',
            subtitle: 'Read this first — 4 steps',
        });
        howto.add_row(infoRow('1 · Add a rule',
            'A rule is a subnet (CIDR) plus the card it should go out. IPv4 and IPv6 are both accepted, for example 10.0.0.0/8 or fd00::/48. Add as many as you need with the + button.'));
        howto.add_row(infoRow('2 · Pick the default-route card',
            'Where everything else goes. Every other connected card is marked never-default, for IPv4 and IPv6, so the default route is unambiguous. If this card drops, no other card takes over: you lose the internet rather than send it through a network you did not choose.'));
        howto.add_row(infoRow('3 · Save',
            'Saving only stores your settings. It does not change your network.'));
        howto.add_row(infoRow('4 · Switch it on from the panel menu',
            'Click the panel button: a menu opens with the Split routing switch, one line per rule and one for the default route, and Settings. While it is on, a card that reconnects gets its rules back on its own. A line that is not in effect right now is marked with a warning, and so is the icon.'));
        howto.add_row(infoRow('Gateways are automatic',
            'You never type a gateway. It is detected per card from its own gateway, or from its DHCP lease when the card is marked never-default.'));
        introGroup.add(howto);

        /* ------------------------------------------------------------- rules */

        const rulesGroup = new Adw.PreferencesGroup({
            title: 'Routing rules',
            description: 'Each subnet is routed out the chosen card while split routing is on.',
        });
        page.add(rulesGroup);

        const previewGroup = new Adw.PreferencesGroup({
            title: 'What will happen',
            description: 'A dry run against the cards that are connected right now. Nothing below has been applied.',
        });
        const previewRow = infoRow('Waiting for NetworkManager…', '');
        previewGroup.add(previewRow);

        const saveBtn = new Gtk.Button({
            label: 'Save',
            halign: Gtk.Align.END,
            css_classes: ['suggested-action', 'pill'],
            margin_top: 4,
        });

        // Created here rather than with its group below, so that the preview
        // helper can read it without depending on declaration order.
        const defaultRow = new Adw.ComboRow({
            title: 'Default-route card',
            model: Gtk.StringList.new([KEEP_DEFAULT]),
            use_subtitle: true,
            subtitle_lines: 1,
            list_factory: plainList(),
        });

        const currentRules = () => ruleRows
            .map(row => ({spec: Engine.parseCidr(row.subnetRow.text), device: row.wantIface}))
            .filter(r => r.spec && r.device)
            .map(r => ({subnet: Engine.formatCidr(r.spec), device: r.device}));

        const refreshPreview = () => {
            let invalid = 0;
            for (const row of ruleRows) {
                const text = row.subnetRow.text.trim();
                const bad = text.length > 0 && !Engine.parseCidr(text);
                if (bad) {
                    invalid++;
                    row.subnetRow.add_css_class('error');
                } else {
                    row.subnetRow.remove_css_class('error');
                }
            }
            saveBtn.sensitive = invalid === 0;

            if (invalid > 0) {
                previewRow.title = `${invalid} subnet(s) are not valid`;
                previewRow.subtitle = 'Fix them before saving. A subnet looks like 10.0.0.0/8 or fd00::/48.';
                return;
            }
            if (!client) {
                previewRow.title = 'Waiting for NetworkManager…';
                previewRow.subtitle = '';
                return;
            }
            const lines = Engine.describePlan(client, {
                rules: currentRules(),
                defaultDevice: ifaces[defaultRow.get_selected() - 1] ?? '',
            });
            previewRow.title = lines.length ? 'While split routing is on:' : 'Nothing to do yet';
            previewRow.subtitle = lines.map(line => line.text).join('\n');
        };

        const addRuleRow = (subnet = '', device = '') => {
            const subnetRow = new Adw.EntryRow({
                title: 'Subnet — 10.0.0.0/8, 192.168.5.0/24, fd00::/48',
                text: subnet,
            });

            const cardRow = new Adw.ComboRow({
                title: 'Card',
                model: Gtk.StringList.new(cardLabels),
                // Without this the chosen card is squeezed against the right
                // edge and ellipsised away; as a subtitle it gets the row's
                // full width, on one line, un-ellipsised by dontEllipsise().
                use_subtitle: true,
                subtitle_lines: 1,
                list_factory: plainList(),
            });

            const entry = {subnetRow, cardRow, wantIface: device};
            ruleRows.push(entry);

            const removeBtn = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: 'Remove this rule',
            });
            removeBtn.connect('clicked', () => {
                rulesGroup.remove(subnetRow);
                rulesGroup.remove(cardRow);
                const index = ruleRows.indexOf(entry);
                if (index >= 0)
                    ruleRows.splice(index, 1);
                refreshPreview();
            });
            subnetRow.add_suffix(removeBtn);

            subnetRow.connect('notify::text', () => refreshPreview());
            cardRow.connect('notify::selected', () => {
                dontEllipsise(cardRow);
                if (syncing)
                    return;
                entry.wantIface = ifaces[cardRow.get_selected()] ?? '';
                refreshPreview();
            });

            const index = ifaces.indexOf(device);
            if (index >= 0)
                cardRow.set_selected(index);

            rulesGroup.add(subnetRow);
            rulesGroup.add(cardRow);
        };

        const addBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Add a rule',
        });
        addBtn.connect('clicked', () => {
            addRuleRow();
            refreshPreview();
        });
        rulesGroup.set_header_suffix(addBtn);

        /* ----------------------------------------------------- default route */

        const defaultGroup = new Adw.PreferencesGroup({
            title: 'Default route',
            description: 'Which card carries the default route — all traffic that no rule matches — while split routing is on.',
        });
        page.add(defaultGroup);

        defaultRow.connect('notify::selected', () => {
            dontEllipsise(defaultRow);
            if (!syncing)
                refreshPreview();
        });
        defaultGroup.add(defaultRow);

        page.add(previewGroup);

        /* ------------------------------------------------------------ safety */

        const safetyGroup = new Adw.PreferencesGroup();
        page.add(safetyGroup);

        const safety = new Adw.ExpanderRow({
            title: 'Is this safe? Uninstall and reboot behaviour',
            subtitle: 'Short answer: yes — nothing permanent is written',
        });
        safety.add_row(infoRow('Nothing happens until you switch it on',
            'Rules saved here are only settings. The network changes when you turn on the Split routing switch in the panel menu. While it is on, saving here takes effect right away.'));
        safety.add_row(infoRow('Nothing is written to disk',
            'The running connection is changed through NetworkManager reapply(), and your Ethernet/Wi-Fi profiles are changed in NetworkManager’s memory only, so a card that reconnects comes up already split. A reboot drops all of it. The switch is remembered, so after a reboot the extension puts split routing back when you log in.'));
        safety.add_row(infoRow('Undo removes exactly what was added',
            'Routes you already had are left alone, and each card’s previous never-default value is restored rather than assumed.'));
        safety.add_row(infoRow('Uninstalling is safe',
            'Nothing is written to disk, so a reboot after removing the extension leaves no routing behind. Turn the switch off before removing it: that restores the profiles in memory right away.'));
        safetyGroup.add(safety);

        /* -------------------------------------------------------------- save */

        const actionGroup = new Adw.PreferencesGroup();
        page.add(actionGroup);

        saveBtn.connect('clicked', () => {
            const rules = currentRules();
            settings.set_string('rules', JSON.stringify(rules));
            settings.set_string('default-device', ifaces[defaultRow.get_selected() - 1] ?? '');

            toast(settings.get_boolean('split-enabled')
                ? `Saved ${rules.length} rule(s). Split routing is on, so they take effect now.`
                : `Saved ${rules.length} rule(s). Nothing changes until you turn on split routing from the panel menu.`);
        });
        actionGroup.add(saveBtn);

        /* ------------------------------------------------- populate from NM */

        const existing = readRules(settings);
        if (existing.length)
            existing.forEach(rule => addRuleRow(rule.subnet, rule.device));
        else
            addRuleRow();

        Engine.getClient(null).then(nmClient => {
            client = nmClient;
            // Cards that are down are listed too, marked as such and sorted
            // last by listCards(), so a rule can still be pointed at a card
            // whose cable is out or whose Wi-Fi has dropped.
            const cards = Engine.listCards(client);
            ifaces = cards.map(card => card.iface);
            cardLabels = cards.length
                ? cards.map(card => {
                    const what = card.description || card.kind;
                    const gateway = card.gateway4 ?? card.gateway6;
                    const tail = card.connected
                        ? (gateway ? `gateway ${gateway}` : 'connected, no gateway')
                        : card.status.toUpperCase();
                    return `${card.iface} · ${card.bus} · ${what} · ${tail}`;
                })
                : [NO_CARDS];

            syncing = true;
            for (const row of ruleRows) {
                row.cardRow.model = Gtk.StringList.new(cardLabels);
                const index = ifaces.indexOf(row.wantIface);
                row.cardRow.set_selected(index >= 0 ? index : 0);
                row.wantIface = ifaces[row.cardRow.get_selected()] ?? '';
                dontEllipsise(row.cardRow);
            }

            defaultRow.model = Gtk.StringList.new(
                ifaces.length ? [KEEP_DEFAULT, ...cardLabels] : [KEEP_DEFAULT]);
            const current = settings.get_string('default-device');
            const defaultIndex = ifaces.indexOf(current);
            defaultRow.set_selected(defaultIndex >= 0 ? defaultIndex + 1 : 0);
            dontEllipsise(defaultRow);
            syncing = false;

            refreshPreview();
        }).catch(e => {
            logError(e, 'Split Routing: cannot reach NetworkManager');
            previewRow.title = 'Cannot reach NetworkManager';
            previewRow.subtitle = e.message ?? String(e);
        });

        refreshPreview();
    }
}
