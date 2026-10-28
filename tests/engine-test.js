// Engine tests against a simulated NetworkManager: real NM setting/route
// objects, fake devices that record reapply() and update their runtime config
// the way NM would. Touches nothing on the machine.
import NM from 'gi://NM';
import * as Engine from '../lib/engine.js';

let failures = 0;
const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    const ok = a === e;
    if (!ok)
        failures++;
    print(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got      ${a}\n        expected ${e}`}`);
};

function makeConnection({routes4 = [], neverDefault4 = false, routes6 = [], neverDefault6 = false,
    id = 'profile', type = '802-3-ethernet', lockedTo = null} = {}) {
    const conn = NM.SimpleConnection.new();
    const sc = NM.SettingConnection.new();
    sc.set_property('id', id);
    sc.set_property('uuid', NM.utils_uuid_generate());
    sc.set_property('type', type);
    if (lockedTo)
        sc.set_property('interface-name', lockedTo);
    conn.add_setting(sc);
    if (type === '802-3-ethernet')
        conn.add_setting(NM.SettingWired.new());
    else
        conn.add_setting(NM.SettingWireless.new());
    const s4 = NM.SettingIP4Config.new();
    s4.set_property('method', 'auto');
    s4.set_property('never-default', neverDefault4);
    for (const r of routes4)
        s4.add_route(NM.IPRoute.new(Engine.AF_INET, r.dest, r.prefix, r.gw ?? null, -1));
    conn.add_setting(s4);
    const s6 = NM.SettingIP6Config.new();
    s6.set_property('method', 'auto');
    s6.set_property('never-default', neverDefault6);
    for (const r of routes6)
        s6.add_route(NM.IPRoute.new(Engine.AF_INET6, r.dest, r.prefix, r.gw ?? null, -1));
    conn.add_setting(s6);
    return conn;
}

function routesOf(conn, family) {
    const s = family === Engine.AF_INET ? conn.get_setting_ip4_config() : conn.get_setting_ip6_config();
    const out = [];
    for (let i = 0; i < s.get_num_routes(); i++) {
        const r = s.get_route(i);
        out.push(`${r.get_dest()}/${r.get_prefix()}`);
    }
    return out;
}

// A saved profile: a real NM.Connection plus NetworkManager's Update2, which
// replaces its settings. Only the next activation sees the change.
function makeProfile(connection, {failUpdate = false} = {}) {
    connection.updates = 0;
    connection.update2 = (settings, _flags, _args, _cancellable, callback) => {
        connection._pending = settings;
        callback(connection, 'res');
    };
    connection.update2_finish = _res => {
        if (failUpdate)
            throw new Error('simulated profile update failure');
        connection.replace_settings(connection._pending);
        connection.updates++;
        return {};
    };
    return connection;
}

const neverDefaultIn = (conn, family) => (family === Engine.AF_INET
    ? conn.get_setting_ip4_config()
    : conn.get_setting_ip6_config()).get_never_default();

class FakeDevice {
    constructor(iface, connection, {gateway4 = '198.51.100.1', gateway6 = 'fe80::1', failReapply = false} = {}) {
        this.iface = iface;
        this.profile = makeProfile(connection);
        // What NM activated: a copy of the profile at activation time.
        this.connection = NM.SimpleConnection.new_clone(this.profile);
        this.gateway4 = gateway4;
        this.gateway6 = gateway6;
        this.failReapply = failReapply;
        this.reapplyCount = 0;
        this.state = NM.DeviceState.ACTIVATED;
        this._syncRuntime();
    }

    // NM recomputes the runtime config from the applied connection.
    _syncRuntime() {
        const build = (family, gateway) => {
            const s = family === Engine.AF_INET
                ? this.connection.get_setting_ip4_config()
                : this.connection.get_setting_ip6_config();
            const routes = [];
            for (let i = 0; i < s.get_num_routes(); i++)
                routes.push(s.get_route(i));
            if (!s.get_never_default() && gateway) {
                routes.push(NM.IPRoute.new(family,
                    family === Engine.AF_INET ? '0.0.0.0' : '::', 0, gateway, -1));
            }
            return {
                get_gateway: () => (s.get_never_default() ? null : gateway),
                get_routes: () => routes,
                get_addresses: () => [],
            };
        };
        this._ip4 = build(Engine.AF_INET, this.gateway4);
        this._ip6 = build(Engine.AF_INET6, this.gateway6);
    }

    get_iface() { return this.iface; }
    // listCards() reads these to label the card in the settings list.
    get_udi() { return `/sys/devices/pci0000:00/0000:00:1f.6/net/${this.iface}`; }
    get_path() { return 'pci-0000:00:1f.6'; }
    get_description() { return `Simulated ${this.iface}`; }
    get_active_connection() {
        if (this.state !== NM.DeviceState.ACTIVATED)
            return null;
        return {
            get_uuid: () => this.profile.get_uuid(),
            get_id: () => this.profile.get_id(),
            get_connection: () => this.profile,
        };
    }
    get_state() { return this.state; }
    get_managed() { return true; }
    get_device_type() { return NM.DeviceType.ETHERNET; }
    get_ip4_config() { return this._ip4; }
    get_ip6_config() { return this._ip6; }
    get_dhcp4_config() { return {get_options: () => ({routers: this.gateway4})}; }

    get_applied_connection_async(_flags, _cancellable, callback) { callback(this, 'res'); }
    get_applied_connection_finish(_res) { return [this.connection, 7]; }

    reapply_async(connection, _versionId, _flags, _cancellable, callback) {
        this._pending = connection;
        callback(this, 'res');
    }

    reapply_finish(_res) {
        if (this.failReapply)
            throw new Error('simulated reapply failure');
        this.reapplyCount++;
        this.connection = this._pending;
        this._syncRuntime();
        return true;
    }
}

const fakeClient = (devices, idle = []) => ({
    get_devices: () => devices,
    get_connections: () => [...devices.map(d => d.profile), ...idle],
});

/* ------------------------------------------------------------ parseCidr */

check('parseCidr IPv4', Engine.parseCidr('10.0.0.0/8'), {family: 2, dest: '10.0.0.0', prefix: 8});
check('parseCidr IPv6 is canonicalised', Engine.parseCidr('FD00::/48'), {family: 10, dest: 'fd00::', prefix: 48});
check('parseCidr bare host address', Engine.parseCidr('192.168.5.7'), {family: 2, dest: '192.168.5.7', prefix: 32});
check('parseCidr rejects bad prefix', Engine.parseCidr('10.0.0.0/99'), null);
check('parseCidr rejects bad address', Engine.parseCidr('10.0.0.999/8'), null);
check('parseCidr rejects words', Engine.parseCidr('the internet'), null);
check('parseCidr rejects empty', Engine.parseCidr('   '), null);
check('parseCidr rejects negative prefix', Engine.parseCidr('10.0.0.0/-1'), null);

/* --------------------------------------------------------- parseRecord */

check('parseRecord of garbage', Engine.parseRecord('not json'), {version: 1, devices: [], profiles: []});
check('parseRecord of a future version', Engine.parseRecord('{"version":99,"devices":[]}'), {version: 1, devices: [], profiles: []});
check('parseRecord drops malformed entries',
    Engine.parseRecord('{"version":1,"devices":[{"iface":"eth0","routes":[{"family":2,"dest":"10.0.0.0","prefix":"eight"}],"defaults":[]}]}'),
    {version: 1, devices: [], profiles: []});

// A fresh record plus a persist() that keeps a copy and counts the writes.
function recorder() {
    const box = {record: Engine.emptyRecord(), writes: 0};
    box.persist = r => {
        box.record = JSON.parse(JSON.stringify(r));
        box.writes++;
    };
    return box;
}

const neverDefault = (device, family) => (family === Engine.AF_INET
    ? device.connection.get_setting_ip4_config()
    : device.connection.get_setting_ip6_config()).get_never_default();

// What NetworkManager does when a card drops and comes back: the runtime
// changes are gone and the saved profile is activated again, as it is now.
function reconnect(device) {
    device.connection = NM.SimpleConnection.new_clone(device.profile);
    device.state = NM.DeviceState.ACTIVATED;
    device._syncRuntime();
}

/* ------------------------------------------------- apply keeps user data */

print('\n--- apply/revert around a route the user already had ---');
{
    // eth0 already carries the user's own 10.0.0.0/8 route and is never-default.
    const eth0 = new FakeDevice('eth0', makeConnection({
        routes4: [{dest: '10.0.0.0', prefix: 8, gw: '198.51.100.1'}],
        neverDefault4: true,
        neverDefault6: true,
    }), {gateway4: '198.51.100.1'});
    const wlan0 = new FakeDevice('wlan0', makeConnection(), {gateway4: '203.0.113.1', gateway6: 'fe80::2'});
    const client = fakeClient([eth0, wlan0]);
    const box = recorder();

    const {problems} = await Engine.enforceSplit(client, {
        rules: [
            {subnet: '10.0.0.0/8', device: 'eth0'},      // already present
            {subnet: '172.16.0.0/12', device: 'eth0'},   // new
            {subnet: 'fd00::/48', device: 'wlan0'},      // new, IPv6
            {subnet: 'nonsense', device: 'eth0'},        // invalid
            {subnet: '10.9.0.0/16', device: 'ppp0'},     // missing card
        ],
        defaultDevice: 'eth0',
    }, box.record, box.persist);

    check('problems reported', problems, [
        'Ignored invalid subnet "nonsense".',
        '10.9.0.0/16 is waiting for ppp0 to connect.',
    ]);
    check('eth0 routes after apply', routesOf(eth0.connection, Engine.AF_INET), ['10.0.0.0/8', '172.16.0.0/12']);
    check('wlan0 IPv6 routes after apply', routesOf(wlan0.connection, Engine.AF_INET6), ['fd00::/48']);
    check('eth0 never-default is now false (it owns the default route)', neverDefault(eth0, Engine.AF_INET), false);
    check('wlan0 never-default v4 is now true', neverDefault(wlan0, Engine.AF_INET), true);
    check('wlan0 never-default v6 is now true', neverDefault(wlan0, Engine.AF_INET6), true);

    check('record only claims the route we added on eth0',
        box.record.devices.find(d => d.iface === 'eth0').routes,
        [{family: 2, dest: '172.16.0.0', prefix: 12}]);
    check('record remembers eth0 never-default was true',
        box.record.devices.find(d => d.iface === 'eth0').defaults,
        [{family: 2, prev: true, want: false}, {family: 10, prev: true, want: false}]);

    const revert = await Engine.revertSplit(client, box.record, box.persist);
    check('revert had no problems', revert.problems, []);
    check("the user's own route survived", routesOf(eth0.connection, Engine.AF_INET), ['10.0.0.0/8']);
    check('our IPv6 route is gone', routesOf(wlan0.connection, Engine.AF_INET6), []);
    check('eth0 never-default restored to true', neverDefault(eth0, Engine.AF_INET), true);
    check('wlan0 never-default restored to false', neverDefault(wlan0, Engine.AF_INET), false);
    check('record is empty again', box.record.devices, []);
}

/* ------------------------------------------------- a failing reapply */

print('\n--- a card whose reapply fails ---');
{
    const eth0 = new FakeDevice('eth0', makeConnection());
    const wlan0 = new FakeDevice('wlan0', makeConnection(), {failReapply: true});
    const client = fakeClient([eth0, wlan0]);
    const box = recorder();

    const {problems} = await Engine.enforceSplit(client, {
        rules: [
            {subnet: '172.16.0.0/12', device: 'eth0'},
            {subnet: '10.0.0.0/8', device: 'wlan0'},
        ],
        defaultDevice: '',
    }, box.record, box.persist);

    check('the failure is reported', problems, ['Simulated wlan0 (wlan0): simulated reapply failure']);
    check('only the card that really changed is recorded',
        box.record.devices.map(d => d.iface), ['eth0']);
}

/* ------------------------------------------------- enforcing again */

print('\n--- enforcing again when nothing changed ---');
{
    const eth0 = new FakeDevice('eth0', makeConnection());
    const wlan0 = new FakeDevice('wlan0', makeConnection());
    const client = fakeClient([eth0, wlan0]);
    const config = {rules: [{subnet: '10.0.0.0/8', device: 'eth0'}], defaultDevice: 'wlan0'};
    const box = recorder();

    await Engine.enforceSplit(client, config, box.record, box.persist);
    const reapplies = eth0.reapplyCount + wlan0.reapplyCount;
    const writes = box.writes;
    await Engine.enforceSplit(client, config, box.record, box.persist);
    check('no second reapply', eth0.reapplyCount + wlan0.reapplyCount, reapplies);
    // Every write comes back as a settings change that enforces again, so a
    // write without a change would never stop.
    check('no second write of the record', box.writes, writes);
}

/* ------------------------------------------------- the default card drops */

print('\n--- the default-route card disconnects ---');
{
    const eth0 = new FakeDevice('eth0', makeConnection());   // work LAN
    const usb0 = new FakeDevice('usb0', makeConnection());   // the internet
    const client = fakeClient([eth0, usb0]);
    const config = {rules: [{subnet: '10.0.0.0/8', device: 'eth0'}], defaultDevice: 'usb0'};
    const box = recorder();

    await Engine.enforceSplit(client, config, box.record, box.persist);
    check('eth0 is kept off the default route', neverDefault(eth0, Engine.AF_INET), true);

    usb0.state = NM.DeviceState.UNAVAILABLE;
    const {problems} = await Engine.enforceSplit(client, config, box.record, box.persist);
    check('eth0 is still kept off the default route', neverDefault(eth0, Engine.AF_INET), true);
    check('eth0 has no default route at all',
        Engine.hasDefaultRoute(eth0, Engine.AF_INET) || Engine.hasDefaultRoute(eth0, Engine.AF_INET6), false);
    check('the rule still holds', routesOf(eth0.connection, Engine.AF_INET), ['10.0.0.0/8']);
    check('the missing card is reported', problems,
        ['Simulated usb0 (usb0) is not connected: the internet is blocked until it is back, no other card takes over.']);
    check('the status says blocked, not rerouted',
        Engine.describePlan(client, config).map(l => l.ok), [true, false]);
}

print('\n--- switching on while the default-route card is missing ---');
{
    const eth0 = new FakeDevice('eth0', makeConnection());
    const usb0 = new FakeDevice('usb0', makeConnection());
    usb0.state = NM.DeviceState.UNAVAILABLE;
    const client = fakeClient([eth0, usb0]);
    const config = {rules: [{subnet: '10.0.0.0/8', device: 'eth0'}], defaultDevice: 'usb0'};
    const box = recorder();

    await Engine.enforceSplit(client, config, box.record, box.persist);
    check('eth0 is kept off the default route from the start', neverDefault(eth0, Engine.AF_INET), true);

    reconnect(usb0);
    await Engine.enforceSplit(client, config, box.record, box.persist);
    check('usb0 carries the default route once it is back',
        Engine.hasDefaultRoute(usb0, Engine.AF_INET), true);
    check('eth0 still does not', Engine.hasDefaultRoute(eth0, Engine.AF_INET), false);
    check('every line is in effect', Engine.describePlan(client, config).map(l => l.ok), [true, true]);
}

/* ------------------------------------------------- a card reconnects */

print('\n--- a card that reconnects comes up already split ---');
{
    const eth0 = new FakeDevice('eth0', makeConnection({id: 'Wired connection 1'}));
    const usb0 = new FakeDevice('usb0', makeConnection({id: 'Wired connection 2'}));
    const client = fakeClient([eth0, usb0]);
    const config = {rules: [{subnet: '10.0.0.0/8', device: 'eth0'}], defaultDevice: 'usb0'};
    const box = recorder();

    await Engine.enforceSplit(client, config, box.record, box.persist);
    check("eth0's profile is changed too", [neverDefaultIn(eth0.profile, Engine.AF_INET),
        routesOf(eth0.profile, Engine.AF_INET)], [true, ['10.0.0.0/8']]);
    check("usb0's profile is left alone", usb0.profile.updates, 0);

    eth0.state = NM.DeviceState.UNAVAILABLE;
    await Engine.enforceSplit(client, config, box.record, box.persist);
    check('a card that is down is dropped from the runtime record', box.record.devices.map(d => d.iface), []);
    check('its profile stays protected', box.record.profiles.map(p => p.iface), ['eth0']);

    reconnect(eth0);
    // The whole point: before this extension has done anything at all.
    check('on reconnect eth0 has no default route, with no reapply needed',
        Engine.hasDefaultRoute(eth0, Engine.AF_INET) || Engine.hasDefaultRoute(eth0, Engine.AF_INET6), false);
    check('and the rule is already there', routesOf(eth0.connection, Engine.AF_INET), ['10.0.0.0/8']);

    const reapplies = eth0.reapplyCount;
    await Engine.enforceSplit(client, config, box.record, box.persist);
    check('so enforcing finds nothing to change', eth0.reapplyCount, reapplies);
    check('and records what came from the profile as ours',
        box.record.devices.find(d => d.iface === 'eth0'),
        {iface: 'eth0', routes: [{family: 2, dest: '10.0.0.0', prefix: 8}],
            defaults: [{family: 2, prev: false, want: true}, {family: 10, prev: false, want: true}]});

    const revert = await Engine.revertSplit(client, box.record, box.persist);
    check('revert after a reconnect has no problems', revert.problems, []);
    check('the rule is gone', routesOf(eth0.connection, Engine.AF_INET), []);
    check('eth0 never-default restored to false', neverDefault(eth0, Engine.AF_INET), false);
    check("eth0's profile is back as it was", [neverDefaultIn(eth0.profile, Engine.AF_INET),
        neverDefaultIn(eth0.profile, Engine.AF_INET6), routesOf(eth0.profile, Engine.AF_INET)], [false, false, []]);
    check('record is empty again', [box.record.devices, box.record.profiles], [[], []]);
}

/* ------------------------------------------------- profiles no card runs */

print('\n--- profiles no card is running are protected too ---');
{
    const eth0 = new FakeDevice('eth0', makeConnection());
    const usb0 = new FakeDevice('usb0', makeConnection());
    const cafe = makeProfile(makeConnection({id: 'Cafe Wi-Fi', type: '802-11-wireless'}));
    const phone = makeProfile(makeConnection({id: 'Phone', lockedTo: 'usb0'}));
    const mine = makeProfile(makeConnection({id: 'Already mine', neverDefault4: true, neverDefault6: true}));
    const client = fakeClient([eth0, usb0], [cafe, phone, mine]);
    const config = {rules: [], defaultDevice: 'usb0'};
    const box = recorder();

    await Engine.enforceSplit(client, config, box.record, box.persist);
    check('an idle Wi-Fi profile can never take the default route',
        [neverDefaultIn(cafe, Engine.AF_INET), neverDefaultIn(cafe, Engine.AF_INET6)], [true, true]);
    check('a profile locked to the default card is left alone', phone.updates, 0);
    check('a profile already never-default is not touched or recorded',
        [mine.updates, box.record.profiles.some(p => p.uuid === mine.get_uuid())], [0, false]);

    const writes = box.writes;
    await Engine.enforceSplit(client, config, box.record, box.persist);
    check('enforcing again rewrites nothing', [cafe.updates, box.writes], [1, writes]);

    await Engine.revertSplit(client, box.record, box.persist);
    check('revert gives the Wi-Fi profile its default route back',
        [neverDefaultIn(cafe, Engine.AF_INET), neverDefaultIn(cafe, Engine.AF_INET6)], [false, false]);
    check('and leaves the one that was already never-default as it was',
        neverDefaultIn(mine, Engine.AF_INET), true);
    check('record is empty again', [box.record.devices, box.record.profiles], [[], []]);
}

print('\n--- a profile that cannot be updated ---');
{
    const eth0 = new FakeDevice('eth0', makeConnection());
    eth0.profile = makeProfile(eth0.profile, {failUpdate: true});
    const usb0 = new FakeDevice('usb0', makeConnection());
    const client = fakeClient([eth0, usb0]);
    const box = recorder();

    const {problems} = await Engine.enforceSplit(client, {rules: [], defaultDevice: 'usb0'}, box.record, box.persist);
    check('it is reported', problems, ['Simulated eth0 (eth0), profile "profile": simulated profile update failure']);
    check('the running connection is still split', Engine.hasDefaultRoute(eth0, Engine.AF_INET), false);
    check('and only that is recorded', [box.record.devices.map(d => d.iface), box.record.profiles], [['eth0'], []]);
}

/* ------------------------------------------------- settings change while on */

print('\n--- settings saved while split routing is on ---');
{
    const eth0 = new FakeDevice('eth0', makeConnection());
    const wlan0 = new FakeDevice('wlan0', makeConnection());
    const client = fakeClient([eth0, wlan0]);
    const box = recorder();

    await Engine.enforceSplit(client, {
        rules: [{subnet: '10.0.0.0/8', device: 'eth0'}],
        defaultDevice: 'wlan0',
    }, box.record, box.persist);

    await Engine.enforceSplit(client, {
        rules: [{subnet: '172.16.0.0/12', device: 'eth0'}],
        defaultDevice: 'eth0',
    }, box.record, box.persist);
    check('the dropped rule is removed, the new one added',
        routesOf(eth0.connection, Engine.AF_INET), ['172.16.0.0/12']);
    check('the new default card owns the default route', neverDefault(eth0, Engine.AF_INET), false);
    check('the old one no longer does', neverDefault(wlan0, Engine.AF_INET), true);
    check('wlan0 remembers its original value, not the one we set',
        box.record.devices.find(d => d.iface === 'wlan0').defaults[0], {family: 2, prev: false, want: true});
}

print(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
