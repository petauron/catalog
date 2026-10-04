# Schema 4 consumer rollout

The publisher-only schema 3 cutover is complete. The schema 4 consumer is
Vastora commit `42326414cf787fb3031aa8334317e974e14941ae` (PR #716), pinned in consumer CI. Publication keeps the existing released Meridian UI
build dependency so that the same UI version retains identical bytes. The production recipe input is `catalog/catalog.json`.
The old schema 3 fixture remains historical evidence, not a production input.

1. Require the pinned consumer and catalog PR checks to pass. Preserve the
   imported ledger, trusted roots, origin, source identity and revision high-water
   marks. Resolve any pending publication using its original request first.
2. Prepare the Center/Agent release. Preserve database/key and application data
   backups before the coordinated upgrade. Center migration 109 rejects unresolved
   application work and records old installations pending explicit adoption.
3. Use the maintenance window to update consumers and publish `kind=reviewed`.
   Old schema 3 consumers cannot read the new catalog; do not present the interval
   as a completed rollout. Candidate planning keeps newer published application
   versions and artifact coordinates while adding the reviewed runtime recipes.
4. The protected publication workflow checks artifacts and the pinned consumer,
   builds the reviewed Meridian UI, persists exact signed bytes in the ledger,
   and activates timestamp metadata last. A failed or uncertain publication stops
   the rollout; do not allocate a replacement revision or reset trust.
5. Refresh the upgraded Center, verify UI and package visibility, then explicitly
   adopt historical resources. Compare container/unit identities and start times;
   catalog refresh and metadata adoption must not restart an application.
6. Verify a bounded install/uninstall with data retention and the existing
   Meridian/Pulse paths before declaring the deployment complete. Do not claim
   fleet acceptance from the sampled historical Pulse rehearsal alone.

Source and copy-rehearsal evidence is recorded in Vastora's
`docs/catalog-runtime-acceptance.md`. Publishing or merging this repository does
not deploy Center, Agent or an application.
