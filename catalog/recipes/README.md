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
