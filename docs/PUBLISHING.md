# Independent signed catalog publication

The catalog is a release product, not a deployment controller. Its pipeline never
contacts a Center or Agent. Clients retain the `vastora-official` identity,
`stable` channel and `https://downloads.petauron.com/vastora/catalog/` origin.
Installing/upgrading an application still requires an administrator's action.

## Release request contract

The protected `publish.yml` workflow accepts `kind=release` with `application`,
`tag`, `sha`, and `run_id`. It also accepts `kind=reviewed` after a recipe PR or
`kind=renew` to renew signed metadata. A daily run requests renewal automatically.

`catalog/sources.json` is the reviewed source registry. Initially only Pulse is
automated, including its Alpha releases. The publisher derives its repository,
workflow, image repository and attachment names from that registry, not request
URLs or checksums. It independently checks:

- The exact tag commit belongs to protected source `main`; the identified push
  run and its publishing job succeeded. The overall run may still be notifying
  the catalog, or may previously have failed in notification only.
- Both public native archives match their release inventory and `SHA256SUMS`.
  GitHub attestations must match the repository, release workflow, tag ref and
  exact source/signer commit, with GitHub-hosted runners.
- The OCI index contains exactly one Linux amd64 and arm64 entry, is pinned by
  its independently computed digest and passes the same attestation policy.
- `catalog-check --artifacts` then independently validates both OCI platform
  configs and declared native archive members / ELF headers. No downloaded
  application binary or archive script is executed.

The Pulse release workflow has a separate `notify-catalog` job after `publish`.
A failure to notify cannot delete a public release; dispatch only submits a
request, it does not wait for signing or claim that the package was published.
For an existing release, dispatch the same contract using its original release
run (including `v0.1.0-alpha.5`); do not re-release or mutate its tag.

## Credentials and GitHub settings

Use a GitHub App installed **only** on `petauron/catalog`, with `Actions: write`
and implicit metadata read. Its private key belongs in Pulse's `catalog-notify`
environment as `CATALOG_NOTIFY_APP_PRIVATE_KEY`; set `CATALOG_NOTIFY_APP_ID` as a
variable. The token action restricts the installation token to this repository
and the Actions permission. This permission is not limited to one workflow, so
all dispatchable catalog workflows must treat inputs as untrusted hints.
Missing credentials fail notification visibly; no PAT or broader-token fallback.

In the catalog repository:

- Protect `main`, require PRs and the `verify` CI check, require the branch to be
  up to date, disallow force pushes/deletion and keep bypass disabled. Changes
  to recipes, permissions, source registry, trust or workflows require review.
- Configure `catalog-signing` for protected branches only, without required
  reviewers for routine releases. Provision only online role keys in
  `CATALOG_SIGNERS` (`targets`, `snapshot`, `timestamp`, each an array of PKCS#8
  PEM strings). Never place the offline root key in CI.
- Provision dedicated scoped `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` and
  `CATALOG_R2_BUCKET_NAME` / `CATALOG_CLOUDFLARE_ACCOUNT_ID`. Do not revoke a
  credential used by another project. Keys are materialized only for signing
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
A different request cannot jump over a pending publication. Expired signatures,
missing draft assets or unclear publication state stop automatic progress and
require operator investigation; drafts are never deleted to reset the counter.
The lower-level publisher retains an explicit supersession operation for a
separately reviewed recovery; automated dispatch never enables it.

All versioned metadata and target objects are put with `If-None-Match: *`, and
existing bytes must be identical. `timestamp.json` is activated last using the
observed prior ETag (`If-Match`), never an unconditional overwrite. A separate
public-origin verifier confirms the accepted revision before the release record
is finalized. Original storage layout remains unchanged.

Ordinary duplicates are no-ops. Older version hints are rejected, not installed.
New upstream versions keep the reviewed `packageRevision`; a recipe change for
an already published application version requires a higher revision. Refreshing
metadata keeps package identities unchanged. Default validity is seven days;
the daily job renews below 48 hours and warns below 30 days of root expiry.
Workflow failure is actionable: preserve logs/ledger and inspect the failed run.
Subscribe operators to repository workflow failure notifications; no third-party
alert channel is silently added.

## External API references

- [GitHub App workflow dispatch permissions](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
- [GitHub concurrency queues](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [GitHub attestation verification and source policy](https://cli.github.com/manual/gh_attestation_verify)
- [R2 S3 conditional PutObject support](https://developers.cloudflare.com/r2/api/s3/api/)
