# Glivela native node recipe

`glivela-node.runtime.json` is the node-role runtime declaration for the native
Glivela distribution. It is not included in a published catalog yet. Publication
must supply the exact Glivela release version and both platform artifact URLs,
sizes/limits where applicable, and SHA256 identities from verified release assets;
no placeholder digest or floating URL is permitted.

The surrounding app manifest declares the `bundle` artifact and five required
string inputs: `controller_url`, `network_interface`, and secret inputs
`certificate_pem`, `private_key_pem`, `ca_pem`. Enrollment certificates must already
belong to the preserved Glivela node identity. The installer only initializes
these inputs on first installation; upgrades preserve the application-owned
configuration and state.

The root node process owns `node-state`. The manual non-root Xray service only
receives a read-only systemd credential snapshot of `config.json`; it cannot read
the node's journal or private credentials. The node discovers the distribution
beside its own executable and obtains concrete service/account identity from the
generic installation inventory. No hardcoded host path or unit digest is needed.

This declaration requires the approved systemd v2 executor and existing systemd,
iproute2 and nftables host tools. It does not install OS packages or run scripts.
It creates neither a public service endpoint nor proxy business commands in the
host. Application startup is not end-to-end route acceptance.

This node recipe alone does not replace the controller/UI installation or migrate
an existing instance. Live publication remains blocked on complete controller
packaging, legacy-writer fencing, data transfer and tested first Dante recovery.

## Controller and retained Docker entry

`glivela-controller.runtime.json` declares the controller process, separate private
state and existing mTLS credentials. Additional string inputs are
`controller_listen`, `administrator_certificate_id`, `business_key_path` and
`subscriptions_listen`. A new transport-only controller leaves the last two
empty. An imported controller must use its actual preserved 32-byte storage key
file and owned business checkpoint; missing owned data/key is never silently
initialized. Subscription publication is enabled only after authority transfer.
The controller enables its bundled management UI on the same private mTLS
listener. Only the enrolled administrator certificate can open that page or
its API. The browser must trust the controller CA and present that certificate;
no Vastora proxy commands, cookies, credentials in JavaScript or new login
system are involved. Subscription publication remains a separate listener.
The recipe is not yet wired into a signed manifest.

`glivela-entry.runtime.json` installs only the Glivela node process. Glivela, not
the installer, provisions and inspects the fixed Docker Xray worker. Inputs are
`controller_url`, the three existing TLS secret inputs, secret `entry_scope`,
boolean `entry_provision`, and string `legacy_entry_checkpoint` (empty only for
explicitly fresh resources). The scope is opaque private JSON to the host; only
Glivela interprets application identity, retained UID/GID, bridge identity/address,
aliases and environment. It cannot select container IDs, image IDs, host mounts,
scripts or a custom image. The worker configuration is a separate private child
of the installed application state; the journal is never mounted into Docker.

For a legacy entry, freeze the old writer, create the Glivela private source
checkpoint, and configure that exact checkpoint before authorizing provisioning.
Original application/protocol identities and ingress geometry must match.
The source container/config remains available for failed-switch recovery; a
successful provision still awaits independent route verification. Retiring the
old writer and restoring the generic Agent remain required migration steps.

All three runtime files are development recipes, not publication artifacts.
They introduce no placeholder release hashes or automatic signing/deployment.
