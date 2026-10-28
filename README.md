# Split Routing

A GNOME Shell extension for split routing: send chosen subnets out chosen
network cards, and pick which card carries the default route, so two networks
can be used at the same time.

Typical use: a work LAN on Ethernet that owns `10.0.0.0/8`, while Wi-Fi keeps
the internet — without dropping either.

## How it works

* A **rule** is a subnet (CIDR) plus the card it should go out. IPv4 and IPv6
  are both supported. Gateways are never typed in: they are detected per card,
  from the card's own gateway or from its DHCP lease.
* The **default-route card** carries everything no rule matches. Every other
  connected card is marked `never-default`, for IPv4 and IPv6, so the default
  route is unambiguous. This fails closed: if the default-route card drops, no
  other card takes the default route over. You lose the internet until it is
  back, instead of sending it through a network you did not choose.
* **Clicking the panel button** opens a menu under it: the *Split routing*
  switch, one line per rule and one for the default route, each marked by
  whether it is in effect right now, and *Settings…*. Nothing happens until
  the switch is turned on.
* While it is on, the routing is **kept** in line with the settings. A card
  that reconnects gets its rules back, a card that appears is kept off the
  default route, and settings saved meanwhile take effect immediately.

## Networks: traffic and speed test

The menu lists every Ethernet and Wi-Fi card in full: state, connection name,
addresses, gateway, and whether it carries the default route, so it is
visible where the internet goes out. Lines wrap rather than being cut short.

* **Traffic now** is the card's live ↓/↑ rate, from the kernel's counters in
  `/sys/class/net/<iface>/statistics`. It is sampled once a second, and only
  while the menu is open.
* **Speed test** measures one card on its own: `curl --interface <iface>`
  (`SO_BINDTODEVICE`, no root needed) downloads up to 25 MB from and uploads
  5 MB to `speed.cloudflare.com`, at most 15 s each. On a metered connection
  that is up to 30 MB per test. A card with no default route has no way to
  the internet, so the test is not run on it and the menu says why.

Check the same thing from a terminal:

```sh
curl -o /dev/null --interface enp0s31f6 -w '%{speed_download} B/s\n' \
    'https://speed.cloudflare.com/__down?bytes=25000000'
```

## Safety

* Every routing change goes through NetworkManager over D-Bus. No root, no
  scripts, no subprocesses. The one subprocess is the speed test below, and
  it runs only when you click it.
* The **running** connection is changed via `Device.reapply()`, and every
  Ethernet/Wi-Fi profile is changed **in NetworkManager's memory only**
  (`Update2` with `IN_MEMORY`). Nothing is written to disk — on Ubuntu that
  would also leave a file in `/etc/netplan`. NetworkManager keeps in-memory
  profiles under `/run`, so they survive its restart; a reboot drops them.
* Because the profiles carry the split, a card that reconnects comes up
  already split: NetworkManager never gives it a default route it should not
  have, not even for a moment. Profiles no card is running are covered too,
  so a Wi-Fi network you join later is kept off the default route from its
  first second. The one exception is a profile NetworkManager creates on the
  spot, for an adapter it has never seen: its first connection carries
  NetworkManager's normal routing until the extension reapplies (it waits
  400 ms for NetworkManager's signals to settle).
* The switch is remembered, so after a reboot split routing is put back when
  you log in. Between boot and login, routing is NetworkManager's normal one.
* Switching back undoes **exactly** what was applied. Routes you already had
  are left alone, and each card's previous `never-default` value is restored
  rather than assumed.
* If part of the configuration is not in effect — a reapply failed, or a card
  is down — the icon turns into a warning, the menu marks the line, and a
  notification names it, rather than the panel claiming everything is fine.
  The undo list still covers whatever did change.

## Requirements

GNOME Shell 45 – 51 (Ubuntu 23.10 through 26.04 LTS) and NetworkManager.

`reapply` needs the polkit action
`org.freedesktop.NetworkManager.network-control`, which is granted to local
active sessions by default on most distributions. Check yours with:

```sh
nmcli general permissions | grep network-control
```

## Manual install

```sh
git clone https://github.com/tannc28/split-routing.git \
    ~/.local/share/gnome-shell/extensions/split-routing@tannc28
glib-compile-schemas ~/.local/share/gnome-shell/extensions/split-routing@tannc28/schemas
```

Log out and back in — the Shell only scans for new extension directories at
start-up — then enable it:

```sh
gnome-extensions enable split-routing@tannc28
```

## Download

The newest build is always at the same address:

    https://github.com/tannc28/split-routing/releases/latest/download/split-routing@tannc28.shell-extension.zip

## Releasing

Every push to `main` is checked, tested and packaged. CI then makes sure a
release exists for whatever `version-name` says in `metadata.json`: if there
is no `v<version-name>` tag yet it creates the tag, the release and attaches
the zip. So releasing is one edit:

```jsonc
// metadata.json
"version-name": "2.1"
```

Push that, and `v2.1` appears with its zip. Nothing else is tagged or
published by hand. `"version"` is left alone — extensions.gnome.org assigns
that number itself.

## Submitting to extensions.gnome.org

The upload page is a shell whose form has no action: the browser posts the
fields to the endpoint the page names in `data-upload-api-url`, which answers
in JSON. CI does the same, signed in with `EGO_USERNAME` and `EGO_PASSWORD`
from the `extensions.gnome.org` environment. Submitting is not publishing:
every version waits in the human review queue either way.

`tools/publish-ego.py --dry-run` signs in and reads the form without sending
anything, which is the way to check the site has not moved underneath it.

It does not happen on its own unless asked for:

* **Actions → CI → Run workflow**, tick *Also submit this build*, to send
  whatever `main` currently builds.
* Set the repository variable `AUTO_SUBMIT` to `true` to also send every new
  release the moment it is made.

Submitting cannot be undone, so the default is neither.

## Undo from a terminal

Turn the switch off from a terminal; the extension then undoes exactly what
it changed, running connections and profiles alike:

```sh
gsettings --schemadir ~/.local/share/gnome-shell/extensions/split-routing@tannc28/schemas \
    set org.gnome.shell.extensions.split-routing split-enabled false
```

Without the extension running, a reboot does it: nothing was written to disk.
`nmcli device reapply` does not: it re-applies the profile, which still
carries the split.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
