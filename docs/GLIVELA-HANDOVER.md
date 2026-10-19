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

The released `switch-legacy-landing` helper requires the old Vastora Agent to be
stopped and persistently masked; its recovery journal also checks that condition.
Do not use it as a routine migration step and then assume the management Agent
can immediately resume. The deployment owner must select and verify a cutover
sequence compatible with the new native installation before switching traffic.
No production cutover is established by source CI or catalog publication alone.

Uninstall is two-step: retire the proxy instance inside Glivela and confirm its
owned runtime is stopped, then uninstall its package through Vastora.
