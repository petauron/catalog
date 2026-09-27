# Maintenance-window cutover checklist

Production is intentionally disabled in the checked-in state. This document is
not permission to replace production containers, erase trust state, or export
GitHub Secrets. A source/CI pass does not prove a live migration succeeded.

1. Finish the schema 4 Center/Agent implementation and rehearsal, protect this
   repository's `main`, then merge the reviewed protocol/recipes/publisher PR.
   Verify the unknown-application Docker and systemd lifecycle acceptance tests.
2. Schedule a maintenance window. Freeze application changes and both catalog
   writers. Resolve pending/uncertain jobs before continuing. Back up Center
   database and encryption keys, Agent state, and each application's volumes or
   host data separately; test restoration on copies.
3. After freezing the old writer, export the **complete paginated** historical
   release inventory with `node scripts/export-legacy-ledger.mjs <new-directory>`.
   The authenticated read includes drafts. Import those generated files through
   a reviewed catalog PR into `catalog/legacy-ledger/`; retain original base64
   bytes, release commits, hashes and status. The checked-in initial capture is
   only a rehearsal baseline, not evidence that the old writer has been stopped.
   A draft with absent assets is retained as an incomplete reserved revision and
   blocks production acceptance rather than being discarded.
4. Upgrade Center and all Agents together. Adopt existing resource identities
   without recreating/restarting containers or units, pulling images, changing
   ownership, running app migrations, or deploying current recipes. Compare
   container IDs/StartedAt and systemd MainPID/InvocationID before/after, plus
   volume names, paths, users, private addresses, config hashes and pairing.
   Ambiguous ownership stops adoption. Do not mix 3x-ui-to-Meridian migration into
   this maintenance window.
5. Verify the independent online-role signing environment and the operator-approved
   selected-repository organization R2 credentials. Disable the old workflow
   and its ability to write the catalog prefix before enabling the new writer;
   confirm credentials shared by unrelated projects remain usable. Never try to
   read an existing GitHub Secret value back out of the old repository.
6. Record verified acceptance in `catalog/migration.json` through a reviewed PR:
   `completed`, `oldWriterDisabled`, `consumersUpgraded` become true; set the
   captured `lastLegacyRevision`, SHA256 of `legacy-ledger/index.json`, and SHA256
   of the byte-identical initial trusted `1.root.json`. Preserve the original
   offline trusted root/rotation chain and all TUF high-water marks. Review the
   v2 public root extension separately; the first schema 4 publication uploads
   it before the timestamp pointer. The first
   new revision is allocated above every historical reservation.
7. Enable `CATALOG_PRODUCTION_ENABLED=true`. Dispatch `kind=reviewed` for the first
   schema 4 snapshot, or a verified Pulse release hint to include alpha.5 in that
   snapshot. Inspect the complete public verification and new immutable ledger.
   Old application versions remain running until a separate managed upgrade is
   requested. A catalog publication alone is never an A1 upgrade.
8. Release maintenance only after operational acceptance. On failure preserve
   state and remain in maintenance. Database migrations are forward-only: a
   binary downgrade requires restoring its matching tested backup; never let an
   old binary open migrated data. No automatic application-data rollback.

## Initial recipes and product adapters

The six existing catalog entries retain their upstream versions and become
`packageRevision: 1`. Historical records remain revision 0 audit evidence; their
original manifests/signatures are never rewritten into schema 4.

CPA receives `timezone`, `management_key`, and `api_key` from its integration;
Keeper receives `cpa_base_url` and `cpa_management_key`. Secret environment
variables remain necessary for Keeper's existing upstream API: they must not
enter logs, UI or execution receipts, but an authorized Docker daemon operator
can inspect container environment. CPA uses a structured nested JSON config.
Root for CPA is an explicitly declared capability, not an implicit privilege.

Pulse Service uses a private credential file for the setup token. Pulse Agent
receives `service_url`, `node_name`, `node_group`, and `enrollment_token` from the
pairing integration; its retained state contains agent credentials. Komari uses
its actual JSON config interface with remote shell and auto-update disabled.
Meridian declares `meridian-runtime`, so an executor without the product's
dynamic Xray configuration integration cannot accidentally start an unconfigured
runtime. This capability is not a substitute for implementing that integration.

These recipes are installation intent for the new runtime, **not** adoption
instructions. Existing resource names and deployment identities must be taken
from observed historical installation state, never synthesized from this file.
