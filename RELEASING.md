# Version releases

Release Please v5 is pinned to 45996ed1f6d02564a971a2fa1b5860e934307cf7.
Version PR creation and updates mint a short-lived installation token from the
minimal-permission organization GitHub App (`petauron-nova`: `contents: write`
and `pull-requests: write` via `RELEASE_APP_CLIENT_ID` and
`RELEASE_APP_PRIVATE_KEY`) so normal `pull_request` CI and CodeQL checks run
automatically without a personal PAT. Actual release creation and publication
continue using the built-in `GITHUB_TOKEN`. Existing branch protection and
required CI remain mandatory.

After a push to main, the release workflow waits (at most 30 minutes) for the
exact commit's normal CI to succeed. It then creates the release, finishes
publication, and maintains the next version PR. Review and merge that PR rather
than bumping versions or creating tags manually.

`GITHUB_TOKEN`-created tags do not start another release workflow; publication
runs in the same release workflow from the checked `main` commit.

These are source-code releases, not automatic production deployments.

SemVer code releases are independent of signed catalog-rN revisions. Manual
catalog publication, signing protections and monotonic revision allocation remain
unchanged. Source attestations are verified against the actual trusted push ref
(main for the new Pulse release pipeline), plus exact source and signer digests.
An explicitly reviewed recovery policy also admits completed manual recovery on
protected main. Its attestation pins the workflow commit while the verified
predicate separately pins the original product commit and exact recovery attempt;
both commits need successful real CI. See `docs/PUBLISHING.md` for the gates.

The next source version PR is maintained only when the checked main tree has
source changes since the last source release tag. Catalog manifests, reviewed
runtime recipes, existing recipe-pin assertions and a
Glivela UI checkout-ref-only change are catalog inputs, not source releases.
A mixed change or an unrecognized path still requests a source version PR. If
the release tag or comparison cannot be verified, the usual release flow runs.
This selection does not change CI or the separately dispatched signed catalog.

Local workflow edits alone do not activate releases. Push/review the changes,
then verify the first version PR CI and release run before calling the migration
complete. No local builds or tests are implied by this configuration change.
