# Glivela and Senulun

Meridian is renamed Glivela; Pulse is renamed Senulun. This change updates only
reviewed display metadata. Recipe revision 2 records the changed manifest bytes
for `meridian`, `pulse` and `pulse-agent`; their machine IDs and versions are not
renumbered. Publication still needs a new monotonic signed catalog revision.

Keep source identities, module paths, binary names, units, environment keys,
storage mounts, image references, artifact URLs/digests and UI target names
unchanged. Do not create duplicate `glivela` or `senulun` installations. Historic
catalogs, trust roots, release metadata and signed targets are immutable. There
is one app per stable ID, with no runtime alias or fallback implementation.

This PR does **not** publish new application binaries or UI. Before an actual
rollout, complete the corresponding source Release Please PRs and CI. Then
update the reviewed Glivela UI source pin and recipe version to that released
commit in a separate review, and use the verified Senulun source-release flow.
Never build renamed UI bytes at an already-published UI version. The source
repositories keep their current URLs while their consumers remain pinned there.
Any later GitHub repository rename must update verified source/provenance
identities together; do not rely on redirects for those checks.

The publication planner preserves newer active upstream versions and coordinates
when the reviewed base recipe is older, and rejects a package revision rollback.
If active recipe revisions have advanced beyond this PR, reconcile against the
latest immutable ledger before signing; do not weaken that guard.

Center and Senulun have their own forward-only display-name migrations with
backups. Changing catalog metadata alone does not perform those migrations,
enroll agents, restart nodes or upgrade managed instances. Catalog signing and
production upgrades require separate authorization.
