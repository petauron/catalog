# Glivela deployment recipes

The controller is Docker; both entry and landing nodes use native Glivela and
official Xray systemd services. These development recipes are not a published
signed catalog and contain no placeholder release identities.

## Controller

`glivela-controller.runtime.json` remains a nonroot bridge-network container,
without a Docker socket, host mounts or host-network privilege. Retained volumes
hold private state, bootstrap and TLS credentials. The private control endpoint
uses administrator/node mutual TLS; subscription downloads use a separate origin.
A transport-only first installation does not initialize or replace owned data.

## Native nodes

`glivela-entry.runtime.json` and `glivela-node.runtime.json` use the same native
node/core bundle and installation contract. The role in the application-owned
bootstrap is `entry` or `landing`; Vastora does not interpret it. Both declare:

- `vastora-pkg-glivela-node.service`: root Glivela management process, automatic.
- `vastora-pkg-glivela-xray.service`: dedicated nonroot worker, manual.

The signed namespace makes unit names readable; application IDs still isolate
program/configuration/state paths, managed user identities and ownership
receipts. A conflicting unit must fail inspection before any service is stopped
or file overwritten. No runtime aliases or automatic collision suffixes.

Inputs are `controller_url`, `network_interface`, and private TLS inputs
`certificate_pem`, `private_key_pem`, `ca_pem`. The entry worker alone declares
`bindService` for CAP_NET_BIND_SERVICE so preserved low-port HY2 listeners do not
require root. It does not receive NET_ADMIN. The Glivela node manages firewall
policy and the worker through its immutable local installation inventory; no
Vastora proxy commands, lifecycle RPC, component matrix or Docker socket.

The root node owns the private persistent state. The manual worker receives
only a read-only systemd credential snapshot named `configuration.json` and
cannot read controller credentials or the node journal. Upgrades retain
application-owned configuration and data rather than rerun initialization.
Generic uninstall backs up and stops both declared native services, retaining
persistent data unless a separate purge is explicitly authorized.

Required existing host tools are systemd, iproute2 and nftables. The next
Glivela release bundles its pinned iperf3 diagnostic and license with the
node distribution; the current published catalog keeps its existing allowlist
until that release is verified. No OS-package installation or arbitrary scripts
are introduced.
Platform process readiness is not actual proxy-route acceptance.

## Same-host entry and landing

`glivela-dual.runtime.json` is a fresh-install profile for both roles on one host.
It uses the same verified release bundle. One root `node` manager starts two
independently authenticated runtimes, with distinct entry/landing certificates,
state directories and nonroot `entry-xray`/`landing-xray` workers. Only the entry
worker has `bindService`; neither worker receives NET_ADMIN. No Vastora proxy
service or new platform public ingress is declared. Glivela owns the explicitly
configured listeners, source authorization and exit-family policy.

The profile uses `controller_url`, `network_interface`, `ca_pem`, plus separate
`entry_certificate_pem`/`entry_private_key_pem` and
`landing_certificate_pem`/`landing_private_key_pem`. It cannot be stacked with
an existing single-role installation in the same namespace. Existing installs
are unchanged; no identity migration, account reset or automatic upgrade is
performed by publishing this profile. See [Glivela #227](https://github.com/petauron/glivela/issues/227).

## Migration and publication gates

Existing Docker entries require a backup-first, explicit native ownership and
backend-binding handover. Preserve application/node/subscription identities,
keys, public ports, quotas and historical data. Do not boot a native candidate
alongside an old writer or assume a source-level recipe is installed acceptance.
Retain stopped old Docker resources only as private failure-recovery evidence;
there is no normal Docker node runtime or provisioning fallback in the new CLI.

Publication must bind exact checked Glivela release versions, immutable
controller image digest, both platform bundle URLs/sizes/SHA256 values and the
separately published UI asset identities. Complete installed data handover,
failure recovery and real route/reporting verification before claiming #54
complete. Source releases, signed catalog publication and deployment are
separate operations.

The JSON credential filename requires the matching Glivela alpha.63 or later
entry process verifier. Persistent state stays `config.json`; runtime identities,
source permissions and accounting are retained. This fixes the actual installed
Xray 26.10.21 startup path, not just temporary config-test filenames.
