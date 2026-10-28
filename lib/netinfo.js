/* Split Routing — traffic counters and per-card speed test.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Read-only: nothing here changes routing. Counters come from the kernel
 * (/sys/class/net/<iface>/statistics), the speed test from curl bound to one
 * card with --interface (SO_BINDTODEVICE), so each card is measured on its own
 * whatever the routing table prefers.
 *
 * Imported by the Shell process only.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Cloudflare's speed test endpoints: __down?bytes=N sends N bytes, __up takes
// whatever is posted.
const DOWN_URL = 'https://speed.cloudflare.com/__down?bytes=25000000';
const UP_URL = 'https://speed.cloudflare.com/__up';
const DOWN_BYTES = 25000000;
const UP_BYTES = 5000000;
const MAX_SECONDS = 15;

// curl exits 28 when --max-time is reached. What it moved until then is
// still a valid measurement of the rate.
const CURL_TIMEOUT = 28;

const decoder = new TextDecoder();

/**
 * Bytes received and sent by a card since it appeared, from the kernel.
 *
 * @param {string} iface - interface name
 * @returns {?{rx: number, tx: number}} null when the card has no counters
 */
export function readCounters(iface) {
    const read = name => {
        try {
            const [, bytes] = GLib.file_get_contents(
                `/sys/class/net/${iface}/statistics/${name}`);
            return Number(decoder.decode(bytes).trim());
        } catch (_e) {
            return NaN;
        }
    };
    const rx = read('rx_bytes');
    const tx = read('tx_bytes');
    return Number.isFinite(rx) && Number.isFinite(tx) ? {rx, tx} : null;
}

/** Bytes per second as bits per second, the unit speed tests are quoted in. */
export function formatRate(bytesPerSecond) {
    const bits = bytesPerSecond * 8;
    if (bits >= 1e9)
        return `${(bits / 1e9).toFixed(2)} Gbit/s`;
    if (bits >= 1e6)
        return `${(bits / 1e6).toFixed(1)} Mbit/s`;
    if (bits >= 1e3)
        return `${(bits / 1e3).toFixed(0)} kbit/s`;
    return `${bits.toFixed(0)} bit/s`;
}

export function formatBytes(bytes) {
    if (bytes >= 1e9)
        return `${(bytes / 1e9).toFixed(2)} GB`;
    if (bytes >= 1e6)
        return `${(bytes / 1e6).toFixed(1)} MB`;
    if (bytes >= 1e3)
        return `${(bytes / 1e3).toFixed(0)} kB`;
    return `${bytes} B`;
}

function runCurl(argv, stdinBytes, cancellable) {
    const flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE |
        (stdinBytes ? Gio.SubprocessFlags.STDIN_PIPE : Gio.SubprocessFlags.NONE);
    const proc = Gio.Subprocess.new(argv, flags);
    // Cancelling communicate() only stops waiting; the process has to be
    // stopped too, or it would keep the card busy after the extension is gone.
    const cancelId = cancellable?.connect(() => proc.force_exit()) ?? 0;

    return new Promise((resolve, reject) => {
        proc.communicate_async(stdinBytes, null, (_p, res) => {
            if (cancelId)
                cancellable.disconnect(cancelId);
            try {
                const [, stdout, stderr] = proc.communicate_finish(res);
                resolve({
                    status: proc.get_exit_status(),
                    stdout: stdout ? decoder.decode(stdout.toArray()).trim() : '',
                    stderr: stderr ? decoder.decode(stderr.toArray()).trim() : '',
                });
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function measure(iface, direction, cancellable) {
    const common = ['curl', '-sS', '-o', '/dev/null', '--interface', iface,
        '--max-time', String(MAX_SECONDS)];
    const argv = direction === 'down'
        ? [...common, '-w', '%{http_code} %{time_namelookup} %{time_connect} %{speed_download} %{size_download}', DOWN_URL]
        : [...common, '-X', 'POST', '--data-binary', '@-',
            '-H', 'Content-Type: application/octet-stream',
            '-w', '%{http_code} %{time_namelookup} %{time_connect} %{speed_upload} %{size_upload}', UP_URL];
    const stdin = direction === 'up' ? new GLib.Bytes(new Uint8Array(UP_BYTES)) : null;

    const {status, stdout, stderr} = await runCurl(argv, stdin, cancellable);
    const [code, lookup, connect, speed, size] = stdout.split(' ').map(Number);

    if ((status !== 0 && status !== CURL_TIMEOUT) || !(size > 0) || code !== 200)
        throw new Error(stderr.replace(/^curl: \(\d+\) /, '') || `HTTP ${code}, curl exit ${status}`);

    return {
        rate: speed,
        bytes: size,
        // DNS excluded: connect - lookup is one TCP handshake, one round trip.
        handshake: connect - lookup,
        cutShort: status === CURL_TIMEOUT,
    };
}

/**
 * Download then upload through one card only.
 *
 * @param {string} iface - interface name
 * @param {?Gio.Cancellable} cancellable - stops the test and kills curl
 * @returns {Promise<{down: object, up: object}>} rate in bytes/s, bytes moved,
 *   TCP handshake time in seconds, whether --max-time cut it short
 */
export async function speedTest(iface, cancellable = null) {
    const down = await measure(iface, 'down', cancellable);
    const up = await measure(iface, 'up', cancellable);
    return {down, up};
}

export const LIMITS = {downBytes: DOWN_BYTES, upBytes: UP_BYTES, maxSeconds: MAX_SECONDS};
