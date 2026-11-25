# Independent signed catalog publication

The catalog is a release product, not a deployment controller. Its pipeline never
contacts a Center or Agent. Clients retain the `vastora-official` identity,
`stable` channel and `https://downloads.petauron.com/vastora/catalog/` origin.
Installing/upgrading an application still requires an administrator's action.

## Release request contract

The protected `publish.yml` workflow supports manual `workflow_dispatch` (`release`,
`reviewed`, or `reconcile`) as well as automatic pull-only reconciliation
(`repository_dispatch` type `catalog-reconcile` for instant wakeup and an off-peak
6-hour `schedule` fallback `17 */6 * * *`).

For manual dispatch, after an application's release publishing job succeeds, an
administrator selects `kind=release` and supplies `application`, `tag`, the tag's exact
source `sha`, and the successful source release `run_id`. The equivalent CLI call for a
completed, reviewed Senlun release is:

```sh
gh workflow run publish.yml --repo petauron/catalog --ref main \
  -f kind=release -f application=senlun -f tag="$RELEASE_TAG" \
  -f sha="$RELEASE_SHA" -f run_id="$RELEASE_RUN_ID"
```

For automatic publication, an unprivileged `discover` job (running outside the
`catalog-signing` environment with no signing keys or storage credentials) runs
`scripts/catalog-reconcile.mjs` against `catalog/sources.json`:

- Upstream wakeup events (`repository_dispatch` `catalog-reconcile`) carry no trust
  payload; `discover` ignores `client_payload` and resolves all release identities from
  the reviewed registry and authenticated GitHub APIs.
- Only sources with `autoPublish.enabled: true` are automatically published, subject to
  their per-source `autoPublish.allowPrerelease` policy (`senlun` and `glivela`
  auto-publish stable SemVer releases; prereleases and manual recoveries remain explicit
  `workflow_dispatch`).
- When a `senlun` upstream commit advances the independent Agent version, `discover` waits
  until `senlun-agent-v<version>` is also published at the same commit SHA before handing
  off to `publish`.
- When a `glivela` release is selected (automatically or via `workflow_dispatch`
  `kind=release`, `application=glivela`), an isolated `mirror-glivela` job verifies the
  exact protected commit, push CI gate (`CI / gate`), SLSA attestations, pinned `iperf3`
  digests, `hostTCPBudget` contract and UI digest consistency before using R2 storage
  credentials (never `CATALOG_SIGNERS`) to copy both immutable native bundles to
  `downloads.petauron.com`. The subsequent `publish` job re-verifies provenance and the
  public mirror, checks out the verified protected-main Glivela commit for `meridian-ui`,
  asserts the freshly built UI bundles match the attested `runtime.json` SHA256 digests,
  and updates all four Glivela recipes (`meridian`, `glivela-entry`, `glivela-node`,
  `glivela-dual`) together.
- Pending draft `catalog-rN` releases block automatic publication fail-closed, two
  consecutive failed automated `mirror-glivela` or `publish` runs trip a circuit breaker
  until a manual recovery run succeeds, and setting Repository Variable
  `CATALOG_AUTOPUBLISH_DISABLED=true` pauses all automatic runs without affecting manual
  `workflow_dispatch`.
- `publish` still independently re-verifies every request through `catalog-plan.mjs`,
  SLSA attestations and `catalog-check --artifacts` before entering `catalog-signing`.
- Reviewed recipe changes (`kind=reviewed`) remain manual by default
  (`autoPublishReviewed: false`).

The historical Pulse alpha.5 release was delivered by
[catalog-r8](https://github.com/petauron/catalog/releases/tag/catalog-r8).
The completed schema 3 publisher cutover is recorded in `catalog/migration.json`;
[CUTOVER-V3.md](CUTOVER-V3.md) preserves its acceptance procedure. Check the resulting catalog
workflow run and public signed revision before claiming publication. `kind=reviewed`
handles a reviewed recipe change.

`catalog/sources.json` is the reviewed source registry. Senlun is the first
registered source, including its Alpha releases. The publisher derives its repository,
workflow, image repository and attachment names from that registry, not request
URLs or checksums. It independently checks:

- The exact tag commit belongs to protected source `main`; the identified release
  run and its publishing job succeeded. Manual recovery requires an explicit
  reviewed `recovery` policy and the additional checks below.
- Both public native archives match their release inventory and `SHA256SUMS`.
  GitHub attestations must match the repository, release workflow, authenticated
  execution ref and exact workflow commit, with GitHub-hosted runners.
- The OCI index contains exactly one Linux amd64 and arm64 entry, is pinned by
  its independently computed digest and passes the same attestation policy.
- The pinned deployed Vastora schema 3 `catalog-check --artifacts` then independently validates both OCI platform
  configs and declared native archive members / ELF headers. No downloaded
  application binary or archive script is executed.

### Canonical product repositories

The `senlun` source key resolves only to `petauron/senlun`, with images at
`ghcr.io/petauron/senlun`. New release requests and attestations must match
that repository exactly. Active recipes use `senlun` and `senlun-agent` IDs;
the old `pulse` identities remain in immutable signed history only. Existing
instances require the reviewed Vastora identity migration before publication.
Verified releases use `senlun-<tag>-linux-<arch>.tar.gz`, canonical binaries and
`SENLUN_*` configuration. Do not publish this catalog change until the
consumer migration is ready and checked against the same signed release.

Glivela UI checkout uses `petauron/glivela`. Published versions through alpha.21
retain `ui-meridian-<version>` names. Subsequent versions use
`ui-glivela-<version>`; the publisher and Center derive exactly one name from
the version. They do not retry another name on a failed verification. Historical
ledger validation retains both signed formats without rewriting either.

The protected workflow resolves the exact verified protected-main Glivela commit
for the candidate `meridian` version in `catalog-plan.mjs` and builds its
application-owned UI with its own lockfile. No Vastora web checkout, npm install,
source symlink or `VASTORA_WEB_SOURCE` is needed. The Center consumer used for
recipe validation is a separate integration gate and remains pinned.
Routine stable Glivela releases auto-publish through `catalog/sources.json`
without requiring a manual catalog PR; keep canonical `ui-glivela` output paths
and never alter existing signed bytes. When a Glivela release changes pinned
`iperf3` supplier digests, runtime templates or host capabilities, automatic
publication fails closed and requires a reviewed catalog PR first.

### Glivela manual baseline handoff (optional / capability changes)

From a clean catalog feature worktree based on current protected `main`, use the
existing authenticated GitHub CLI and installed lockfile dependencies:

```sh
node scripts/prepare-glivela-release.mjs "$RELEASE_TAG" "$RELEASE_SHA" "$RELEASE_RUN_ID"
```

This operator-run helper waits for nothing and fails if the exact Glivela release
or its newest exact-source push CI has not succeeded. It checks the protected
source/tag identity, authenticated release inventory, `SHA256SUMS`, both downloaded
native archives and the immutable two-platform controller image index. Release
assets use the exact authenticated GitHub asset ID through the existing CLI,
with bounded output and unchanged inventory, size and digest checks; browser
download URLs remain the published recipe coordinates. It never executes
downloaded files. It then updates only the four Glivela recipe versions
and release coordinates, verifies that `.github/workflows/publish.yml` retains
the dynamic verified UI checkout pin, and updates the UI baseline test contract.
It also advances only Glivela's machine-identity digest and version comment in
the existing brand contract. The current recipe must first match its old digest;
only then may verified version/image coordinates produce the new Glivela digest.
The brand assertions, installation identities, runtime/config fields and both
Senulun baseline hashes remain unchanged. A mismatched old baseline stops the
handoff instead of silently accepting an unrelated identity change.
It requires a clean non-main branch and refuses same-version or older hints.

Review the generated diff and submit it through the normal catalog PR flow.
The helper does not commit, push, open or merge a PR, dispatch a workflow, sign,
publish a catalog or upgrade an application. It needs no new dependency, PAT,
cross-repository secret or Actions permission. Source release checks are not a
replacement for the catalog PR's exact-head CI or the protected publisher's
artifact validation, UI checks/build, signatures and conditional activation.
After that PR is approved and merged, catalog publication remains a separately
authorized `kind=reviewed` request. Do not dispatch it just because a PR passed.

Historical recipes, release ledgers, image digests, download coordinates and
attestations stay unchanged. Previously accepted releases need no re-publication;
their original signer is not rewritten as Senulun. The example alpha.5 publication
above is historical, not an input to rerun against the new source policy. Do not
rename or delete the existing GHCR package. Merging this policy changes future
verification only: it neither signs a catalog nor upgrades installed apps.

Senlun does not notify the catalog and needs no cross-repository credentials.
The administrator chooses a specific completed release. The catalog verifies its
tag commit, release job, and artifacts against the reviewed source rule. Drafts,
unapproved prereleases and older versions are rejected. A pending publication
can resume only with its original request, commit, recipe and exact signed bytes;
otherwise operator recovery is required. Existing releases need not be re-released.

### Recovering a source release without changing its tag

For a source registry that explicitly enables `recovery`, a successful
`workflow_dispatch` on protected `main` may publish an existing immutable draft
using a repaired workflow. Supply the original tag's product `sha` and the new,
completed recovery `run_id`; never substitute the workflow SHA for the product SHA.
The publisher requires:

- The tag and release target still equal the product SHA. Both product and
  workflow commits belong to protected `main`, with product ancestral to workflow.
- The recovery run and its source-verification and publishing jobs succeeded.
  The newest push CI for each exact commit succeeded, including the registry's
  real required CI gate (a skipped gate is not success).
- Cryptographic attestation verification pins the actual workflow commit and
  `refs/heads/main`. Only the CLI's verified statement output is accepted.
- The standard SLSA workflow predicate binds the original `release-source` SHA,
  workflow SHA, exact `release_tag` input, repository IDs, GitHub-hosted runner,
  builder identity, run ID and latest attempt. Both native archives and the
  immutable multiarchitecture image must pass independently.

A generic manual workflow, stale attempt, fork, unchecked commit or mismatched
provenance is rejected. No bypass, source re-release, moved tag, rewritten asset,
extra workflow credential or relaxed signing environment is needed.

## Senlun upgrade handoff

`catalog/target-custom.json` contains reviewed exact package-version
equivalences. It is signed as custom metadata on the stable TUF target, without
changing application manifests or installed receipts. An equivalence applies
only to the named app, target version and recipe revision, and the explicitly
listed installed version and recipe revision. A later version or revision is
not equivalent unless separately reviewed. This preserves update notifications
for real later changes, and existing clients can ignore TUF custom metadata.
Review the source, dependency lock and build inputs before adding an entry.
The input is included in the protected publication plan and signed ledger.

`senlun` pins the verified Service image and its Service version. The Agent
version is read from the checked release commit and its Release Please manifest,
independently of the Service tag. When that Agent version is unchanged, the
previously signed Agent artifact coordinates remain unchanged. To advance it,
the separate `senlun-agent-v...` release must be public at the same checked
source, and contain both verified archive digests. The Service release's
source, native archives, checksums and attestations still pass the existing
verification. The completed release ledger retains the exact candidate and
source request for review.
Normal version changes use this manual release-input workflow; PRs review changes
to source policy, recipes and publishing code rather than copy release coordinates
into source. A later reviewed recipe publication preserves newer accepted release
coordinates and cannot silently revert the application version.

After publication, refresh the official catalog in Vastora Settings and verify
its revision and signature status. Open the installed applications to see available
updates. Senlun Service and Senlun Agent are separate upgrade targets: upgrading
the Service does not upgrade any collector, and refreshing the catalog upgrades
neither. Use each application's managed upgrade flow and verify its completed
task and installed version. Check collector connectivity and reported version in
Senlun as well; a saved target version alone is not runtime evidence.

The standalone Senlun recipes require a compatible Center/Agent before catalog
publication. Service administrator setup happens inside Senlun, without a package
bootstrap token. For a new Agent, create an enrollment token in Senlun and supply
the Service HTTPS URL, node name, optional group and token in the install form.
The Service can run outside Vastora. Existing identities and resource names are
preserved; this recipe update does not reenroll or restart installed Agents.

Collectors alpha.3 and later support country discovery. With no manual country,
the default GeoJS request shares the node's public egress IP and Agent version
with GeoJS, never Senlun credentials or metrics. In the collector configuration,
`node_region` sets the manual country (which takes precedence) and
`geoip_provider=disabled` disables discovery. Upgrading an existing collector
retains its identity, credentials, manual region and explicit disabled setting;
do not reenroll it to obtain location support. See the
[Vastora collector contract](https://github.com/petauron/vastora/blob/main/docs/senulun-collector-config.md)
and [Senlun operations guide](https://github.com/petauron/senlun/blob/main/docs/OPERATIONS.md)
for the supported settings and privacy behavior.

If publication or upgrade fails, inspect that operation before retrying. A failed
catalog publication cannot be bypassed with manually edited installed manifests;
an unavailable collector remains an independent deployment problem. Keep its
existing credentials and recovery evidence intact.

## Credentials and GitHub settings

The catalog uses its own workflow token to read public release metadata and
maintain its release ledger. No notification GitHub App or PAT is required.
Manual dispatch inputs remain untrusted hints, not download authority.

In the catalog repository:

- Protect `main`, require PRs and the `verify` CI check, require the branch to be
  up to date, disallow force pushes/deletion and keep bypass disabled. Changes
  to recipes, permissions, source registry, trust or workflows require review.
- Configure `catalog-signing` for protected branches only, without required
  reviewers for routine releases. Provision only online role keys in
  `CATALOG_SIGNERS` (`targets`, `snapshot`, `timestamp`, each an array of PKCS#8
  PEM strings). Never place the offline root key in CI.
- The operator approved reuse of organization `R2_ACCESS_KEY_ID` /
  `R2_SECRET_ACCESS_KEY`, with selected-repository access including this repository.
  These shared credentials are not restricted to the signing environment or
  catalog prefix. Preserve other repositories' access and never revoke shared
  credentials for this migration. Configure environment variables
  `CATALOG_R2_BUCKET_NAME` / `CATALOG_CLOUDFLARE_ACCOUNT_ID`.
  Signing keys are materialized only for signing
  into 0700/0600 runner-temporary paths and removed on success or failure.
- Keep `CATALOG_PRODUCTION_ENABLED` unset/false until the publisher-only acceptance
  in [CUTOVER-V3.md](CUTOVER-V3.md) is complete. The committed cutover record is
  an independent second gate. Neither gate is an operational bypass.

## Schema 4 consumer rollout

Production planning now uses `catalog/catalog.json` and the reviewed schema 4
consumer pinned in CI. Follow [CUTOVER-V4.md](CUTOVER-V4.md) for the coordinated
consumer upgrade. The completed publisher-only schema 3 cutover remains history.

## Immutable publication and recovery

The workflow queues up to GitHub's supported pending limit with `queue: max` and
does not cancel a running publication. Within that lock the next revision is
allocated from all imported and current records, including drafts. No source
commit is created for normal version updates. Dynamic catalog input, request,
reviewed recipe hash, signatures, manifest history and acceptance state are
persisted together in the draft release before any R2 upload.
Every live ledger read, including the post-upload confirmation and signing-stage
retry, must match GitHub's authenticated attachment size and SHA256 inventory.
Historical imports additionally pin their original bytes in the reviewed
migration index; a changed or missing live digest blocks publication.

The immediate draft write/read-back is confirmed at most three times, with one
and two seconds between reads. A lost write acknowledgement is not permission to
repeat the write: confirmation may recover only the original commit, draft and
exact signed ledger bytes. Only missing/not-yet-ready inventory and failed read
commands are retried. Identity, digest, signature or content mismatch fails
closed immediately. No R2 write occurs without durable confirmation; exhaustion
keeps the draft and requires the original-request recovery below. Fixed diagnostic
substage names distinguish draft creation, inventory and byte confirmation without
printing child-process stderr or credentials.

Retries use the original catalog commit, input request and exact signed bytes.
A different request cannot jump over a pending publication. Missing draft assets
or unclear publication state stop publication and
require operator investigation; drafts are never deleted to reset the counter.
The lower-level publisher retains an explicit supersession operation for a
separately reviewed recovery; the manual workflow never enables it.

All versioned metadata and target objects are put with `If-None-Match: *`, and
existing bytes must be identical. `timestamp.json` is activated last using the
observed prior ETag (`If-Match`), never an unconditional overwrite. A separate
public-origin verifier confirms the accepted revision before the release record
is finalized. Original storage layout remains unchanged.

Ordinary duplicates are no-ops. Older version hints are rejected, not installed.
The schema 3 publisher retains version-only manifest identity: changing an
already published application version's recipe is rejected. Schema 4
`packageRevision` remains deferred with the runtime migration.

Glivela's application-owned workspace remains a product integration, not an
installation allowlist. For each publication `catalog-plan.mjs` resolves and
verifies the immutable protected-main Glivela commit for the candidate `meridian`
version (using the attested release SHA on `glivela` releases or the published
protected-main tag commit otherwise), `publish.yml` checks out that exact commit,
builds and tests the version-matched JS/CSS pair before loading signing
credentials, cross-checks both digests against attested `runtime.json` on
`glivela` releases, and signs both exact assets as TUF targets. Retrying a
pending publication must reproduce the saved bytes; changing UI bytes at the same
application version or omitting an already-signed UI pair is rejected.

Signed target, timestamp, snapshot, targets and reviewed root v2 expire at the
end of year 9999.
There is no renewal workflow: an unchanged catalog remains installable for the
practical lifetime of the system. Root v1 remains byte-for-byte unchanged and
still anchors the authorized v2 rotation. Existing clients retain their accepted
revision high-water mark; a fresh client cannot detect a mirror that withholds
newer revisions. This explicitly trades TUF's bounded freeze detection for
long-lived availability. Signature verification, release provenance, immutable
ledger and digest checks remain mandatory. Root key revocation still requires a
reviewed root rotation and publication. If a publication remains pending or fails,
investigate its ledger before retrying.
Workflow failure is actionable: preserve logs/ledger and inspect the failed run.
Subscribe operators to repository workflow failure notifications; no third-party
alert channel is silently added.

## External API references

- [GitHub manual workflow dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
- [GitHub concurrency queues](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [GitHub attestation verification and source policy](https://cli.github.com/manual/gh_attestation_verify)
- [R2 S3 conditional PutObject support](https://developers.cloudflare.com/r2/api/s3/api/)

### Existing Glivela controller handover

Glivela alpha.52 controller recipe revision 4 retains host port 19443 so enrolled
workers keep their existing private mTLS controller address. The rootless Docker
controller still listens on container port 9443. The subscription service keeps
its existing service/publication identity during a managed upgrade. This recipe
does not itself import data or upgrade installations: complete the final
stopped-writer handover, preserve the existing certificates and node state, then
activate the persistent installed bootstrap. Never re-enroll nodes or fabricate
installation receipts to expose the UI.

### Glivela native delivery on IPv6-only nodes

`mirror-glivela-native.yml` copies an already published, immutable Glivela release
into the existing official download origin. It does not create tags or Releases,
sign/activate a catalog, contact nodes, change DNS/routes or grant access. Supply
the existing release tag, exact source SHA and successful source release run ID.
The job requires successful exact-head protected catalog CI and reuses the normal
Glivela handoff's source/main/tag/run, GitHub asset inventory, SHA256SUMS,
two-platform image, bundled iperf3 and native runtime version/commit checks before
storage credentials are available. Distributions are never executed.

Only the amd64 and arm64 archives are written, under
`https://downloads.petauron.com/vastora/catalog/artifacts/glivela/vVERSION/`. Writes use `If-None-Match: *`;
retry accepts existing objects only when their bytes are identical. Storage and
public-origin readback must match the source digest. Temporary files are removed,
no Actions artifacts or additional release tags are retained, and no signing keys
are exposed to this job. Failed copies retain the original source and must be
retried with the same release identity; never overwrite an object.

After mirroring, the normal `prepare-glivela-release.mjs TAG SHA RUN_ID` handoff
also verifies the official mirror and prepares those fixed HTTPS URLs in the
signed recipe. The protected catalog publication and explicit per-node upgrade
remain separate operations. The normal Agent HTTPS/archive/digest validation
is unchanged; there is no fallback to another origin. Historical signed recipes
are not rewritten. Actual IPv6 download and runtime acceptance are checked on
the authorized IPv6-only nodes during rollout.
