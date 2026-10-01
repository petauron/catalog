# Petauron Catalog

Independent, signed application packages for declarative container and systemd runtimes.

The catalog is a release product, not a deployment service. Publishing a package
never installs or upgrades applications on connected machines.

The Go module `github.com/petauron/catalog` contains schema 4 package contracts,
declarative runtime validation, native artifact verification, and TUF trust and
publication tools. Vastora consumes a pinned release of this module; the catalog
pipeline does not update Vastora source or deploy applications.

After an application's release build succeeds, an administrator manually starts
the catalog publication workflow with its tag, source SHA, and release run ID.
Applications need no notification App or cross-repository credentials. The publisher
independently verifies source provenance and both platform artifacts, records
immutable signed bytes, and activates the catalog with a conditional write.
Normal version updates do not create source commits. Pulse is the first registered
source. Signed metadata uses a long-lived expiry, so an unchanged catalog remains
installable without scheduled or manual renewal. Previously accepted clients
reject older revisions; a new client cannot detect a mirror hiding newer releases.

- [Publication, credentials, and recovery](docs/PUBLISHING.md)
- [Maintenance-window migration and acceptance](docs/MIGRATION.md)
- [Production schema 3 recipes](catalog/catalog-v3.json)
- [Deferred schema 4 recipes](catalog/catalog.json)
- [Reviewed release sources](catalog/sources.json)

Development is through feature branches and PRs. Run `npm ci --ignore-scripts`,
`npm test`, and `go test ./...` for isolated protocol and publishing checks.
`go run ./cmd/catalog-check --catalog catalog/catalog.json --root-directory
catalog/trust` validates reviewed recipes and roots without fetching app binaries;
`--artifacts` additionally downloads and checks artifacts but never executes them.

The production publisher uses the existing schema 3 wire format. Its completed
cutover is recorded in `catalog/migration.json`; [catalog-r8](https://github.com/petauron/catalog/releases/tag/catalog-r8)
delivered Pulse Service and Agent alpha.5 through the verified release-input path.
Schema 4 recipes and the runtime migration remain deferred. Publication still
requires both the reviewed cutover record and the protected environment gate;
neither may be bypassed to recover a failed publication.

## License and provenance

Apache-2.0; see [LICENSE](LICENSE). The catalog protocol, platform helpers, and
original TUF signing / conditional R2 upload tools were extracted from
[Petauron Vastora](https://github.com/petauron/vastora) under the same license.
Original source notices and signed historical metadata are preserved. The
publisher's pinned `semver` dependency is ISC-licensed; its license is included
in the installed npm package.
