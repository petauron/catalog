# Glivela native handover

This catalog change publishes installation recipes; it does not deploy or migrate
an installed instance. The controller remains Docker. Entry and landing hosts
run Glivela and Xray as separately owned systemd services. Vastora performs
installation, update and uninstall; Glivela owns communication and proxy state.

## Deployment order

1. Back up the Center database, encryption keys, application configuration and
   native installation receipts. Capture the old proxy configuration and business
   export while its writers are stopped. Retain these backups and source data.
2. Prepare the controller's mTLS identities and privately import the frozen
   business data using the released offline migration tool. Preserve account,
   node, route, subscription and protocol identities, usage and historical data.
   Credentials and exports must never enter Git or public logs.
3. Stage the controller with its signed Docker recipe. Its management endpoint
   requires administrator mTLS; it is not an unauthenticated public dashboard.
   Activate business storage and the separate subscription listener using
   Glivela's application-owned activation command after import verification.
4. Coordinate the compatible Vastora Agent upgrade and Glivela handover per
   node. The replacement Agent stops invoking the former proxy reconcilers and
   rejects their commands. Do not bulk-upgrade Agents in advance of a prepared
   takeover: old proxy leases may expire before the new node starts managing them.
5. Use the backed-up, receipt-bound native installation handover for an existing
   entry. Retain its application/service/publication IDs. The private backend
   port must match the imported Xray configuration; do not invent a replacement
   public port. Retain the shared gateway and its existing access restrictions.
6. Obtain fresh Glivela runtime and route evidence, then transfer the existing
   subscription service binding. Keep the existing hostname, path, token, TLS
   and access boundary. A successful installation or binding update is not an
   end-to-end health result. Verify the original subscription URL and each route.

Existing configuration files are initialized only on first component creation.
Subsequent application changes belong to Glivela. Do not delete old data,
receipts or backups as part of this release, and do not downgrade a migrated
Center database in place.

## Legacy landing switch constraint

Glivela alpha.39 and Vastora alpha.349 provide the retained landing completion
sequence. Back up first and preserve the complete original source inventory,
DNS, exit, identities and entry-side accounting authority. The
`switch-legacy-landing` helper still requires the old Agent persistently masked
and stopped. Do not resume it immediately after switching.

Collect fresh successful route evidence from every required entry in one
snapshot. With only the Glivela node daemon stopped (Xray remains running), use
`complete-legacy-landing` with its private bootstrap and verified snapshot ID.
The node authenticates to its controller and rejects partial, stale or failed
evidence. An offline required entry blocks completion; do not remove it from
the inventory to make acceptance pass.

Restart the Glivela node daemon, then, while the old Agent remains masked, use
Vastora's `agent retire-landing-execution --native-state <owned-state>`. This
checks the accepted proof, retained checkpoint, owned running native services
and stopped old runtime before fencing the old execution journal. Only after
success may the Agent be unmasked and started. Retain all old data and recovery
material. Verify subscription identities, every double hop and accounting
continuity before proceeding to another landing.

Older journals without an explicit exit may adopt only the single fixed IPv4
from their hash-verified retained Dante configuration, not a discovered or
fallback exit. Follow Glivela's released `docs/landing-handover.md` for the
operation details. Source CI and catalog publication prove no production cutover.

Uninstall is two-step: retire the proxy instance inside Glivela and confirm its
owned runtime is stopped, then uninstall its package through Vastora.
