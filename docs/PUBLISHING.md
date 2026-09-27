# Independent signed catalog publication

The catalog is a release product, not a deployment controller. Its pipeline never
contacts a Center or Agent. Clients retain the `vastora-official` identity,
`stable` channel and `https://downloads.petauron.com/vastora/catalog/` origin.
Installing/upgrading an application still requires an administrator's action.

## Release request contract

The protected `publish.yml` workflow runs only through manual `workflow_dispatch`.
After the application's release publishing job succeeds, an administrator selects
`kind=release` and supplies `application`, `tag`, the tag's exact source `sha`, and
the successful source release `run_id`. The GitHub Actions page exposes these
fields; the equivalent CLI call is:

```sh
gh workflow run publish.yml --repo petauron/catalog --ref main \
  -f kind=release -f application=pulse -f tag=v0.1.0-alpha.5 \
  -f sha=87316579282f6d1b874dd37e55bea5038d1ec6d7 -f run_id=36220147813
```

This example identifies an already published Pulse release; it is not a cutover
command while the migration gates remain closed. Check the resulting catalog
workflow run and public signed revision before claiming publication. `kind=reviewed`
handles a reviewed recipe change.
Neither an application release nor a catalog source change triggers publication
automatically. No periodic workflow is configured.

`catalog/sources.json` is the reviewed source registry. Pulse is the first
registered source, including its Alpha releases. The publisher derives its repository,
workflow, image repository and attachment names from that registry, not request
URLs or checksums. It independently checks:

- The exact tag commit belongs to protected source `main`; the identified push
  run and its publishing job succeeded.
- Both public native archives match their release inventory and `SHA256SUMS`.
  GitHub attestations must match the repository, release workflow, tag ref and
  exact source/signer commit, with GitHub-hosted runners.
- The OCI index contains exactly one Linux amd64 and arm64 entry, is pinned by
  its independently computed digest and passes the same attestation policy.
- `catalog-check --artifacts` then independently validates both OCI platform
  configs and declared native archive members / ELF headers. No downloaded
  application binary or archive script is executed.

Pulse does not notify the catalog and needs no cross-repository credentials.
The administrator chooses a specific completed release. The catalog verifies its
tag commit, release job, and artifacts against the reviewed source rule. Drafts,
unapproved prereleases and older versions are rejected. A pending publication
can resume only with its original request, commit, recipe and exact signed bytes;
otherwise operator recovery is required. Existing releases need not be re-released.

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
- Keep `CATALOG_PRODUCTION_ENABLED` unset/false until the maintenance acceptance
  in [MIGRATION.md](MIGRATION.md) is complete. The committed migration record is
  an independent second gate. Neither gate is an operational bypass.

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
New upstream versions keep the reviewed `packageRevision`; a recipe change for
an already published application version requires a higher revision.

Meridian's application-owned workspace remains a product integration, not an
installation allowlist. For each publication the workflow checks out the reviewed,
full source commits pinned in `publish.yml` for Meridian UI and its Vastora web
contract, builds the version-matched JS/CSS pair before loading signing credentials,
and signs both exact assets as TUF targets. A new Meridian UI version requires a
reviewed update to those pins. Retrying a pending publication must reproduce the
saved bytes; changing UI bytes at the same application version or omitting an
already-signed UI pair is rejected.

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
