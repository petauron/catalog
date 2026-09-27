# Schema 3 publisher-only cutover

This operation changes only who publishes the existing signed catalog. It does
not upgrade Center, Agent, or an installed application; it does not migrate
databases, adopt resources, or require application-volume backups. Schema 4
recipes and runtime implementation remain deferred.

1. Keep the public origin, `vastora-official` identity, `stable` channel,
   trusted root chain, and every accepted revision/high-water mark unchanged.
   Confirm the public catalog is still revision 7 and that neither publisher
   has a pending or uncertain draft. Confirm the imported ledger includes the
   complete historical releases, including drafts.
2. On the catalog PR, validate `catalog/catalog-v3.json` with the pinned
   deployed Vastora schema 3 checker. Build the candidate for Pulse Service
   and Pulse Agent `v0.1.0-alpha.5` from the authenticated Pulse Release,
   source run, checksums, attestations, and multiarch OCI manifest. The old
   consumer must verify the staged signed repository, including UI targets.
3. Merge the reviewed catalog publisher PR with `catalog/migration.json`
   still disabled. Stop the old Vastora catalog publishing workflow and verify
   no old signing or upload job is in progress. Do not revoke shared R2
   credentials or alter Center/Agent/application state.
4. In a second reviewed catalog change, record the observed last legacy
   revision, imported ledger index hash, initial trusted root hash, old-writer
   disabled evidence, and schema 3 consumer compatibility. Mark
   `publisherCutoverCompleted` only after those checks. Enable
   `CATALOG_PRODUCTION_ENABLED=true`
   in the protected catalog signing environment.
5. Manually dispatch `kind=release` for Pulse alpha.5 with exact tag, source
   SHA, and successful release run ID from [PUBLISHING.md](PUBLISHING.md).
   The workflow allocates revision 8 or higher from the immutable ledger,
   persists the signed bytes before storage upload, writes `timestamp.json`
   last, and verifies the public origin with the deployed schema 3 verifier.
6. Confirm the public revision and both Pulse entries in the Center catalog.
   Confirm A1's installed Pulse Service and Agent versions and process start
   identities did not change. Installation or upgrade remains a separate
   administrator action.

If any verification fails or publication state is uncertain, stop at that
boundary. Preserve drafts and the last trusted public timestamp; inspect the
ledger and storage state before retrying the exact request. Never reset trust,
reuse a revision with different bytes, or silently switch to schema 4.
