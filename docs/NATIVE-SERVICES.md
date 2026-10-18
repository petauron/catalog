# Native service bundles (systemd version 2)

This contract describes installation resources, not application features. It
does not define proxy routing, application RPC, firewall rules, or executable
installation hooks. It does not publish or deploy an application by itself.

`runtime.kind: systemd`, `runtime.version: 2` uses `nativeServices` instead of
the version 1 `systemd` object. Unknown/unsupported contracts remain readable
but must not be executed. Executors must explicitly advertise support for both
this version and the `native-services` capability before accepting a task.

An executor advertising systemd version 2 explicitly supports the still-used
released version 1 contract as well. This promise does not extend to unknown
future versions. It is not an instance migration: an installed version 1 receipt
cannot be upgraded into version 2 implicitly. Executors select uninstall and
maintenance behavior from the installed receipt, and validate the supplied
manifest against that receipt before mutation. Older single-service receipts
without an explicit runtime version represent version 1 only.

## Declarations

- `users` is an explicit array of logical application-owned account identifiers
  (empty is allowed). It cannot select existing host users. Executors derive
  stable, application-scoped system accounts with no login shell or home.
- `services` contains 1–16 named services. Each has an explicit `start` policy:
  `automatic` installs/enables/starts it; `manual` installs it without enabling
  or starting it. Application-managed worker activation remains the application's
  responsibility. A stopped manual worker is not an installation health failure.
- Each service selects a declared `managedUser`, or an explicitly authorized
  `process.user: root`. Root still requires the independent `root` capability.
  Selecting any other host account, or both account mechanisms, is rejected.
- `process` reuses the existing signed native artifact, executable, arguments,
  environment, configuration, credentials, state, health, and limits contract.
  It cannot contain shell hooks or arbitrary systemd directives.
- State directories may be shared only by services with the same owner. The
  executor must not change ownership recursively to resolve conflicting claims.
- `writableState` permits a service to write another declared, owned state
  directory without changing its owner. It grants no arbitrary host paths and
  does not bypass normal Unix file permissions. A root controller can use this
  for worker configuration without claiming the worker's state ownership.
- `native-unit` and `managed-user` runtime references resolve only declared
  resources in this application. They are not selectors for existing host
  services/accounts and are rejected in version 1 contracts.
- Services referencing the same artifact share one authenticated extraction
  allowlist. Conflicting executable modes, unsafe paths and oversized combined
  allowlists are rejected before extraction.

`native-installation` (no name or suffix) resolves to this application's local,
read-only installation inventory. It is executor-owned, not application
configuration: it is regenerated with installed units on each upgrade and must
not be restored from an older application-data backup. JSON version 1 contains
`version: 1` and `services`, a map keyed by declared logical service name. Each
entry contains `unit` (concrete unit name), `user` (concrete account name) and
`sha256` (digest of the installed unit bytes). No credentials, configuration
contents, other instances, business fields or command channel are included.
Applications can verify their own worker units without duplicating the unit
generator or requiring manually entered hashes. The executor tracks this file
as an immutable owned resource and removes it on uninstall, including retained
uninstall; retained application configuration references its stable path.

## Executor obligations

The implementation must inspect application ownership before mutation, reject
unowned account/unit/file collisions, and persist recoverable resource receipts.
Account names and unit paths must be derived from application identity rather
than taken from the manifest. Credentials/runtime directories must be separate
between services. Upgrades preserve application-owned configuration and data;
initialization is for first installation only.

All writers must stop before consistent backups or binary replacement. Partial
failure must retain accurate failure and ownership records, not claim health.
Removal may touch only receipt-verified resources; persistent state and its
account ownership cannot be discarded merely because a unit was removed.

The catalog validates declarations and artifact identities only. Concrete host
installation, recovery, resource ownership inspection and Linux integration
tests belong to the executor implementation and are required before any catalog
entry starts using this contract. No current application recipe is migrated by
this change.
