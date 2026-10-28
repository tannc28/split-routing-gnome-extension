/* Split Routing — routing engine.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Every routing change goes through NetworkManager over D-Bus (libnm): no
 * sudo, no shell scripts, no subprocesses. Changes are made to the RUNNING
 * connection via Device.reapply(), and to saved profiles IN MEMORY only, never
 * on disk, so a reboot returns the machine to its normal routing on its own.
 *
 * This module is imported by BOTH the Shell process and the preferences
 * process, so it must never import St/Clutter/Meta/Shell nor Gtk/Adw.
 *
 * Nothing here knows about any specific network: cards come from
 * NetworkManager, subnets come from the user, gateways are detected per card.
 */

import NM from 'gi://NM';

// <bits/socket.h> on Linux. GLib does not expose AF_* constants.
export const AF_INET = 2;
export const AF_INET6 = 10;

const RECORD_VERSION = 1;

/* ------------------------------------------------------------------ client */

export function getClient(cancellable = null) {
    return new Promise((resolve, reject) => {
        NM.Client.new_async(cancellable, (_obj, res) => {
            try {
                resolve(NM.Client.new_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/* ------------------------------------------------------------- CIDR values */

/**
 * Parse and canonicalise a subnet.
 *
 * Validation is delegated to libnm itself (NM.IPRoute.new throws on a bad
 * address or a bad prefix), so what this accepts is exactly what NetworkManager
 * will later accept. A bare address with no "/" means a host route.
 *
 * @param {string} text - user input, e.g. "10.0.0.0/8" or "fd00::/48"
 * @returns {?{family: number, dest: string, prefix: number}} null if invalid
 */
export function parseCidr(text) {
    const raw = String(text ?? '').trim();
    if (!raw)
        return null;

    const slash = raw.lastIndexOf('/');
    const addr = (slash < 0 ? raw : raw.slice(0, slash)).trim();
    const family = addr.includes(':') ? AF_INET6 : AF_INET;
    const prefixText = slash < 0
        ? String(family === AF_INET ? 32 : 128)
        : raw.slice(slash + 1).trim();

    if (!/^\d+$/.test(prefixText))
        return null;

    try {
        const route = NM.IPRoute.new(family, addr, parseInt(prefixText, 10), null, -1);
        return {family, dest: route.get_dest(), prefix: route.get_prefix()};
    } catch (_e) {
        return null;
    }
}

export function formatCidr(spec) {
    return `${spec.dest}/${spec.prefix}`;
}

function sameSpec(a, b) {
    return a.family === b.family && a.dest === b.dest && a.prefix === b.prefix;
}

/* --------------------------------------------------------------- read-only */

export function deviceByIface(client, iface) {
    if (!iface)
        return null;
    return client.get_devices().find(d => d.get_iface() === iface) ?? null;
}

export function isConnected(device) {
    return !!device && device.get_state() === NM.DeviceState.ACTIVATED;
}

/**
 * Whether the card can be unplugged.
 *
 * The kernel's own device path answers this: anything sitting on a USB bus is
 * removable, anything else is inside the machine. Note what is deliberately
 * NOT claimed — "onboard". Telling a soldered chip from a card in a PCIe slot
 * needs a firmware index that plenty of machines simply do not publish, so a
 * "built-in" label would quietly be wrong on those.
 *
 * @param {NM.Device} device - the card
 * @returns {'USB'|'Internal'} how it is attached
 */
function busLabel(device) {
    const udi = device.get_udi() ?? '';
    const path = device.get_path() ?? '';
    return /\/usb\d/.test(udi) || /-usb-/.test(path) ? 'USB' : 'Internal';
}

/** A short word for why a card is not usable, for the settings list. */
function stateLabel(device) {
    // An unplugged cable and a disabled card both read as unavailable, and
    // only one of them is fixed by walking over to the desk.
    if (device instanceof NM.DeviceEthernet && !device.get_carrier() &&
        device.get_state() !== NM.DeviceState.ACTIVATED)
        return 'no cable';

    switch (device.get_state()) {
    case NM.DeviceState.ACTIVATED:
        return 'connected';
    case NM.DeviceState.UNAVAILABLE:
        return 'unavailable';       // no carrier, or the radio is off
    case NM.DeviceState.DISCONNECTED:
        return 'disconnected';
    case NM.DeviceState.DEACTIVATING:
        return 'disconnecting';
    case NM.DeviceState.FAILED:
        return 'failed';
    case NM.DeviceState.UNMANAGED:
        return 'unmanaged';
    case NM.DeviceState.UNKNOWN:
        return 'unknown';
    default:
        return 'connecting';        // PREPARE through SECONDARIES
    }
}

/**
 * Managed Ethernet/Wi-Fi cards — the meaningful routing targets.
 *
 * Cards that are down are included, and said to be down. Leaving them out
 * would mean a rule could not be pointed at a card whose cable is unplugged,
 * or edited after its Wi-Fi dropped.
 *
 * @param {NM.Client} client - libnm client
 * @returns {object[]} connected cards first, then the rest, each name-sorted
 */
export function listCards(client) {
    const cards = [];
    for (const device of client.get_devices()) {
        const type = device.get_device_type();
        if (type !== NM.DeviceType.ETHERNET && type !== NM.DeviceType.WIFI)
            continue;
        if (!device.get_managed())
            continue;
        cards.push({
            iface: device.get_iface(),
            kind: type === NM.DeviceType.WIFI ? 'Wi-Fi' : 'Ethernet',
            connected: isConnected(device),
            status: stateLabel(device),
            bus: busLabel(device),
            // "Intel Wi-Fi", "Apple iPhone 5/…/XR". Not get_product(), which
            // NetworkManager leaves empty for plenty of cards.
            description: device.get_description() ?? '',
            gateway4: detectGateway(device, AF_INET),
            gateway6: detectGateway(device, AF_INET6),
            connection: device.get_active_connection()?.get_id() ?? '',
            addresses: [AF_INET, AF_INET6].flatMap(family =>
                (runtimeConfig(device, family)?.get_addresses() ?? [])
                    .map(a => `${a.get_address()}/${a.get_prefix()}`)),
            default4: hasDefaultRoute(device, AF_INET),
            default6: hasDefaultRoute(device, AF_INET6),
        });
    }
    cards.sort((a, b) =>
        Number(b.connected) - Number(a.connected) || a.iface.localeCompare(b.iface));
    return cards;
}

function runtimeConfig(device, family) {
    return family === AF_INET ? device.get_ip4_config() : device.get_ip6_config();
}

/**
 * The card's own gateway, else its DHCP router.
 *
 * The fallback matters: once a card is marked never-default NetworkManager
 * drops its gateway from the runtime config, so on a second apply the direct
 * gateway is gone while the DHCP lease still names the router.
 *
 * @param {NM.Device} device - the card
 * @param {number} family - AF_INET or AF_INET6
 * @returns {?string} gateway address, or null for an on-link route
 */
export function detectGateway(device, family) {
    const gateway = runtimeConfig(device, family)?.get_gateway();
    if (gateway)
        return gateway;

    if (family === AF_INET) {
        const routers = device.get_dhcp4_config()?.get_options()?.['routers'];
        if (routers)
            return routers.trim().split(/\s+/)[0];
    }
    return null;
}

/** Is this subnet currently routed out this card? (kernel truth, via libnm) */
export function hasRuntimeRoute(device, spec) {
    const config = runtimeConfig(device, spec.family);
    if (!config)
        return false;
    return config.get_routes().some(
        r => r.get_dest() === spec.dest && r.get_prefix() === spec.prefix);
}

/** Does this card currently carry a default route for this family? */
export function hasDefaultRoute(device, family) {
    const config = runtimeConfig(device, family);
    if (!config)
        return false;
    const zero = family === AF_INET ? '0.0.0.0' : '::';
    return config.get_routes().some(
        r => r.get_prefix() === 0 && r.get_dest() === zero);
}

/* ------------------------------------------------------------- undo record */
//
// The record is the only source of truth about what WE changed, at two levels:
//
// * devices — the RUNNING connection of each card (Device.reapply()). A card
//   that disconnects drops these on its own, so its entry is dropped too.
// * profiles — each saved profile, changed IN MEMORY only (Update2 with
//   IN_MEMORY). This is what makes a card that reconnects come up already
//   split, instead of with NetworkManager's normal default route. Nothing is
//   written to disk. NetworkManager keeps in-memory profiles under /run, so
//   they survive its restart, and a reboot drops them.
//
// It is written after every successful change, so a failure halfway through
// still leaves an exact undo list.

export function emptyRecord() {
    return {version: RECORD_VERSION, devices: [], profiles: []};
}

function parseRoutes(list) {
    return (Array.isArray(list) ? list : []).filter(
        r => r && (r.family === AF_INET || r.family === AF_INET6) &&
            typeof r.dest === 'string' && Number.isInteger(r.prefix));
}

function parseDefaults(list) {
    return (Array.isArray(list) ? list : []).filter(
        d => d && (d.family === AF_INET || d.family === AF_INET6) &&
            typeof d.prev === 'boolean' && typeof d.want === 'boolean');
}

/** Parse a stored record defensively; anything malformed becomes empty. */
export function parseRecord(text) {
    let raw;
    try {
        raw = JSON.parse(text || '{}');
    } catch (_e) {
        return emptyRecord();
    }
    if (!raw || raw.version !== RECORD_VERSION || !Array.isArray(raw.devices))
        return emptyRecord();

    const record = emptyRecord();
    for (const entry of raw.devices) {
        if (!entry || typeof entry.iface !== 'string')
            continue;
        const routes = parseRoutes(entry.routes);
        const defaults = parseDefaults(entry.defaults);
        if (routes.length || defaults.length)
            record.devices.push({iface: entry.iface, routes, defaults});
    }
    for (const entry of Array.isArray(raw.profiles) ? raw.profiles : []) {
        if (!entry || typeof entry.uuid !== 'string' || typeof entry.iface !== 'string')
            continue;
        const routes = parseRoutes(entry.routes);
        const defaults = parseDefaults(entry.defaults);
        if (routes.length || defaults.length)
            record.profiles.push({uuid: entry.uuid, iface: entry.iface, routes, defaults});
    }
    return record;
}

/* ------------------------------------------------------------------- plan */

/** "Intel Ethernet (enp0s31f6)": what the card is, then its kernel name. */
export function cardName(client, iface) {
    const description = deviceByIface(client, iface)?.get_description();
    return description ? `${description} (${iface})` : iface;
}

function planFor(plans, iface) {
    let plan = plans.get(iface);
    if (!plan) {
        plan = {routes: [], defaults: []};
        plans.set(iface, plan);
    }
    return plan;
}

/**
 * What every connected card should look like under the user's settings.
 *
 * The default route fails closed. When the default-route card is missing,
 * every other connected card is still kept off the default route: no internet
 * until it comes back is the correct outcome, traffic quietly leaving through
 * a network the user did not choose is not.
 *
 * @param {NM.Client} client - libnm client
 * @param {object} config - {rules, defaultDevice} from the settings UI
 * @returns {{plans: Map, problems: string[]}} per-card plan, and what is waiting
 */
function buildPlan(client, {rules, defaultDevice}) {
    const problems = [];
    const plans = new Map();

    for (const rule of rules ?? []) {
        const spec = parseCidr(rule.subnet);
        if (!spec) {
            problems.push(`Ignored invalid subnet "${rule.subnet}".`);
            continue;
        }
        const device = deviceByIface(client, rule.device);
        if (!isConnected(device)) {
            problems.push(`${formatCidr(spec)} is waiting for ${cardName(client, rule.device)} to connect.`);
            continue;
        }
        planFor(plans, rule.device).routes.push(spec);
    }

    if (defaultDevice) {
        const connected = listCards(client).filter(c => c.connected);
        if (!connected.some(c => c.iface === defaultDevice))
            problems.push(`${cardName(client, defaultDevice)} is not connected: the internet is blocked until it is back, no other card takes over.`);
        for (const card of connected) {
            for (const family of [AF_INET, AF_INET6])
                planFor(plans, card.iface).defaults.push({family, want: card.iface !== defaultDevice});
        }
    }

    return {plans, problems};
}

/* ----------------------------------------------------------- apply/revert */

function getAppliedConnection(device, cancellable) {
    return new Promise((resolve, reject) => {
        device.get_applied_connection_async(0, cancellable, (_d, res) => {
            try {
                const [connection, versionId] = device.get_applied_connection_finish(res);
                resolve({connection, versionId});
            } catch (e) {
                reject(e);
            }
        });
    });
}

function reapply(device, connection, versionId, cancellable) {
    return new Promise((resolve, reject) => {
        device.reapply_async(connection, versionId, 0, cancellable, (_d, res) => {
            try {
                resolve(device.reapply_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// IN_MEMORY: the profile on disk is never rewritten. On Ubuntu that file is
// generated by netplan, so a disk write would also leave a file behind in
// /etc/netplan. Secrets left out of the update are kept by NetworkManager.
function updateProfile(remote, connection, cancellable) {
    return new Promise((resolve, reject) => {
        remote.update2(connection.to_dbus(NM.ConnectionSerializationFlags.ALL),
            NM.SettingsUpdate2Flags.IN_MEMORY, null, cancellable, (_r, res) => {
                try {
                    resolve(remote.update2_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function ipSetting(connection, family) {
    const setting = family === AF_INET
        ? connection.get_setting_ip4_config()
        : connection.get_setting_ip6_config();
    if (!setting)
        return null;
    const method = setting.get_method();
    if (method === 'disabled' || method === 'ignore')
        return null;
    return setting;
}

function findRouteIndex(setting, spec) {
    for (let i = 0; i < setting.get_num_routes(); i++) {
        const route = setting.get_route(i);
        if (route.get_dest() === spec.dest && route.get_prefix() === spec.prefix)
            return i;
    }
    return -1;
}

function errorText(e) {
    return e?.message ?? String(e);
}

const has = (list, spec) => list.some(s => sameSpec(s, spec));

/**
 * Bring one connection — a running one or a profile — in line with a plan.
 *
 * @param {NM.Connection} connection - changed in place
 * @param {object} plan - {routes, defaults} wanted on it
 * @param {object[]} owned - routes we added earlier; any other route already
 *   there is the user's own and is never recorded, so never removed
 * @param {Function} prevOf - (family, current) → never-default before our
 *   first change
 * @param {?Function} gatewayOf - family → gateway; null when the card is not
 *   connected, in which case routes are kept or removed but never added
 * @returns {{changed: boolean, routes: object[], defaults: object[]}} what
 *   now differs from the user's own configuration
 */
function applyPlan(connection, plan, owned, prevOf, gatewayOf) {
    const out = {changed: false, routes: [], defaults: []};

    for (const spec of owned) {
        if (has(plan.routes, spec))
            continue;
        const setting = ipSetting(connection, spec.family);
        const index = setting ? findRouteIndex(setting, spec) : -1;
        if (index >= 0) {
            setting.remove_route(index);
            out.changed = true;
        }
    }

    for (const spec of plan.routes) {
        const setting = ipSetting(connection, spec.family);
        if (!setting)
            continue;
        const index = findRouteIndex(setting, spec);
        if (index >= 0 && !has(owned, spec))
            continue;
        if (index >= 0) {
            // Ours, but a new DHCP lease may have moved the gateway.
            const gateway = gatewayOf?.(spec.family);
            if (gatewayOf && (setting.get_route(index).get_next_hop() ?? null) !== gateway) {
                setting.remove_route(index);
                setting.add_route(NM.IPRoute.new(spec.family, spec.dest, spec.prefix, gateway, -1));
                out.changed = true;
            }
            out.routes.push(spec);
            continue;
        }
        if (!gatewayOf)
            continue;
        setting.add_route(NM.IPRoute.new(
            spec.family, spec.dest, spec.prefix, gatewayOf(spec.family), -1));
        out.routes.push(spec);
        out.changed = true;
    }

    for (const family of [AF_INET, AF_INET6]) {
        const setting = ipSetting(connection, family);
        if (!setting)
            continue;
        const current = setting.get_never_default();
        const prev = prevOf(family, current);
        const want = plan.defaults.find(d => d.family === family)?.want ?? prev;
        if (current !== want) {
            setting.set_property('never-default', want);
            out.changed = true;
        }
        if (want !== prev)
            out.defaults.push({family, prev, want});
    }

    return out;
}

const prevFrom = entry => family =>
    entry?.defaults.find(d => d.family === family)?.prev;

const isNetworkProfile = remote => {
    const type = remote.get_connection_type();
    return type === '802-3-ethernet' || type === '802-11-wireless';
};

/**
 * Make the routing match the settings, now and on the next reconnect, and keep
 * the undo record exact.
 *
 * Safe to call again and again: a connection already in line is read and left
 * alone, so this runs on every NetworkManager change while split routing is
 * on — a card that reconnects is checked, a card that appears is kept off the
 * default route, settings saved meanwhile take effect.
 *
 * Three passes:
 * 1. each connected card's profile, so a reconnect comes up already split;
 * 2. its running connection, so it is split now;
 * 3. every other Ethernet/Wi-Fi profile, so a card that connects to one later
 *    never gets a default route it should not have, not even for a moment.
 *
 * @param {NM.Client} client - libnm client
 * @param {object} config - {rules, defaultDevice} from the settings UI
 * @param {object} record - the current undo record
 * @param {Function} persist - called with the undo record after each change
 * @param {?Gio.Cancellable} cancellable - cancels in-flight D-Bus calls
 * @returns {Promise<{problems: string[]}>} non-fatal problems worth reporting
 */
export async function enforceSplit(client, config, record, persist, cancellable = null) {
    const {plans, problems} = buildPlan(client, config);
    const devices = new Map(record.devices.map(e => [e.iface, e]));
    const profiles = new Map(record.profiles.map(e => [e.uuid, e]));
    const empty = {routes: [], defaults: []};

    // Written only when it really changed: every write comes back to the
    // indicator as a settings change, which runs this again.
    let saved = JSON.stringify([record.devices, record.profiles]);
    const save = () => {
        const next = {version: RECORD_VERSION, devices: [...devices.values()], profiles: [...profiles.values()]};
        const text = JSON.stringify([next.devices, next.profiles]);
        if (text !== saved) {
            saved = text;
            persist(next);
        }
    };
    const store = (map, key, entry) => {
        if (entry.routes.length || entry.defaults.length)
            map.set(key, entry);
        else
            map.delete(key);
    };

    const handled = new Set();
    const ifaces = new Set([...plans.keys(), ...devices.keys()]);
    // A card running a profile we changed, even with nothing planned for it:
    // that is how a revert reaches a card that reconnected since.
    for (const device of client.get_devices()) {
        const uuid = device.get_active_connection?.()?.get_uuid();
        if (uuid && profiles.has(uuid))
            ifaces.add(device.get_iface());
    }

    for (const iface of ifaces) {
        const device = deviceByIface(client, iface);

        // A card that is gone or down has already dropped our runtime changes.
        if (!isConnected(device)) {
            devices.delete(iface);
            continue;
        }

        const plan = plans.get(iface) ?? empty;
        const gatewayOf = family => detectGateway(device, family);
        const remote = device.get_active_connection()?.get_connection() ?? null;
        const uuid = remote?.get_uuid() ?? null;
        const oldProfile = uuid ? profiles.get(uuid) : null;
        const oldDevice = devices.get(iface) ?? {iface, ...empty};

        if (remote && isNetworkProfile(remote)) {
            handled.add(uuid);
            try {
                const copy = NM.SimpleConnection.new_clone(remote);
                const result = applyPlan(copy, plan, oldProfile?.routes ?? [],
                    (family, current) => prevFrom(oldProfile)(family) ?? current, gatewayOf);
                if (result.changed)
                    await updateProfile(remote, copy, cancellable);
                store(profiles, uuid, {uuid, iface, routes: result.routes, defaults: result.defaults});
                save();
            } catch (e) {
                // The running connection below is still put in line.
                problems.push(`${cardName(client, iface)}, profile "${remote.get_id()}": ${errorText(e)}`);
            }
        }

        try {
            const {connection, versionId} = await getAppliedConnection(device, cancellable);
            for (const spec of plan.routes) {
                if (!ipSetting(connection, spec.family))
                    problems.push(`${cardName(client, iface)}: ${formatCidr(spec)} skipped, that address family is not configured on this card.`);
            }
            // After a reconnect the running connection is the profile we
            // changed: what came from it is ours, and its original value is
            // the one recorded with the profile.
            const owned = [...oldDevice.routes,
                ...(oldProfile?.routes ?? []).filter(s => !has(oldDevice.routes, s))];
            const result = applyPlan(connection, plan, owned,
                (family, current) => prevFrom(oldProfile)(family) ?? prevFrom(oldDevice)(family) ?? current,
                gatewayOf);
            if (result.changed)
                await reapply(device, connection, versionId, cancellable);
            store(devices, iface, {iface, routes: result.routes, defaults: result.defaults});
            save();
        } catch (e) {
            // Whatever did not go through is not recorded as changed.
            problems.push(`${cardName(client, iface)}: ${errorText(e)}`);
        }
    }

    // Profiles no card is running right now.
    const rulesFor = iface => (config.rules ?? [])
        .filter(r => r.device === iface).map(r => parseCidr(r.subnet)).filter(Boolean);
    const existing = new Set();
    for (const remote of client.get_connections()) {
        if (!isNetworkProfile(remote))
            continue;
        const uuid = remote.get_uuid();
        existing.add(uuid);
        if (handled.has(uuid))
            continue;

        const old = profiles.get(uuid);
        // The card it was last seen on, else the card it is locked to.
        const iface = old?.iface || remote.get_setting_connection()?.get_interface_name() || '';
        const plan = {
            routes: (old?.routes ?? []).filter(s => has(rulesFor(iface), s)),
            defaults: config.defaultDevice
                ? [AF_INET, AF_INET6].map(family => ({family, want: iface !== config.defaultDevice}))
                : [],
        };
        const copy = NM.SimpleConnection.new_clone(remote);
        const result = applyPlan(copy, plan, old?.routes ?? [],
            (family, current) => prevFrom(old)(family) ?? current, null);
        if (!result.changed && !old)
            continue;
        try {
            if (result.changed)
                await updateProfile(remote, copy, cancellable);
        } catch (e) {
            problems.push(`Profile "${remote.get_id()}": ${errorText(e)}`);
            continue;
        }
        store(profiles, uuid, {uuid, iface, routes: result.routes, defaults: result.defaults});
        save();
    }

    // A profile that was deleted took our changes with it.
    for (const uuid of profiles.keys()) {
        if (!existing.has(uuid))
            profiles.delete(uuid);
    }
    save();

    return {problems};
}

/**
 * Undo exactly what was applied — no more.
 *
 * Routes the user already had are not in the record, so they survive; a
 * previous never-default value is restored rather than assumed to be false.
 *
 * @param {NM.Client} client - libnm client
 * @param {object} record - the undo record
 * @param {Function} persist - called with what is still outstanding
 * @param {?Gio.Cancellable} cancellable - cancels in-flight D-Bus calls
 * @returns {Promise<{problems: string[]}>} what could not be reverted
 */
export function revertSplit(client, record, persist, cancellable = null) {
    return enforceSplit(client, {rules: [], defaultDevice: ''}, record, persist, cancellable);
}

/* ----------------------------------------------------------------- status */

/**
 * One line per rule plus one for the internet, each checked against the
 * kernel's routing table, so `ok` means "in effect now", not "was requested".
 *
 * @param {NM.Client} client - libnm client
 * @param {object} config - {rules, defaultDevice} from the settings UI
 * @returns {{text: string, ok: boolean}[]} what split routing does, line by line
 */
export function describePlan(client, {rules, defaultDevice}) {
    const lines = [];

    for (const rule of rules ?? []) {
        const spec = parseCidr(rule.subnet);
        if (!spec) {
            lines.push({text: `${rule.subnet || '(empty)'} — invalid, ignored`, ok: false});
            continue;
        }
        const name = cardName(client, rule.device);
        const device = deviceByIface(client, rule.device);
        if (!isConnected(device)) {
            lines.push({text: `${formatCidr(spec)} — waiting for ${name} to connect`, ok: false});
            continue;
        }
        const gateway = detectGateway(device, spec.family);
        lines.push({
            text: gateway
                ? `${formatCidr(spec)} → ${name} via ${gateway}`
                : `${formatCidr(spec)} → ${name}, on-link`,
            ok: hasRuntimeRoute(device, spec),
        });
    }

    if (defaultDevice) {
        const name = cardName(client, defaultDevice);
        const connected = listCards(client).filter(c => c.connected);
        const leaking = connected
            .filter(c => c.iface !== defaultDevice && (c.default4 || c.default6))
            .map(c => cardName(client, c.iface));
        if (!connected.some(c => c.iface === defaultDevice)) {
            lines.push({
                text: leaking.length
                    ? `Internet → should be ${name}, which is not connected — but ${leaking.join(', ')} is carrying it`
                    : `Internet blocked: ${name} is not connected, and no other card takes over`,
                ok: false,
            });
        } else {
            lines.push({
                text: leaking.length
                    ? `Internet → ${name} — but ${leaking.join(', ')} is carrying it too`
                    : `Internet → ${name}`,
                ok: leaking.length === 0,
            });
        }
    } else {
        lines.push({text: 'Internet — left to NetworkManager (no default-route card chosen)', ok: true});
    }

    return lines;
}
