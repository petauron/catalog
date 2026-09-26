# Petauron Catalog

Independent, signed application packages for declarative container and systemd runtimes.

The catalog is a release product, not a deployment service. Publishing a package
never installs or upgrades applications on connected machines.

The Go module `github.com/petauron/catalog` contains schema 4 package contracts,
declarative runtime validation, native artifact verification, and TUF trust and
publication tools. Vastora consumes a pinned release of this module; the catalog
pipeline does not update Vastora source or deploy applications.

Application releases submit hints to the reviewed source registry. The publisher
independently verifies source provenance and both platform artifacts, records
immutable signed bytes, and activates the catalog with a conditional write.
Normal updates do not create source commits. Pulse is the first registered source.

- [Publication, credentials, and recovery](docs/PUBLISHING.md)
- [Maintenance-window migration and acceptance](docs/MIGRATION.md)
- [Reviewed application recipes](catalog/catalog.json)
- [Reviewed release sources](catalog/sources.json)

Development is through feature branches and PRs. Run `npm ci --ignore-scripts`,
`npm test`, and `go test ./...` for isolated protocol and publishing checks.
`go run ./cmd/catalog-check --catalog catalog/catalog.json --root-directory
catalog/trust` validates reviewed recipes and roots without fetching app binaries;
`--artifacts` additionally downloads and checks artifacts but never executes them.

Production publishing remains disabled until the schema 4 maintenance migration,
trust-chain/history import, and operator-provisioned signing environment have
passed acceptance checks. The committed legacy ledger is a read-only initial
capture, not evidence of a live cutover. See the migration checklist before
changing either production gate.

## License and provenance

Apache-2.0; see [LICENSE](LICENSE). The catalog protocol, platform helpers, and
original TUF signing / conditional R2 upload tools were extracted from
[Petauron Vastora](https://github.com/petauron/vastora) under the same license.
Original source notices and signed historical metadata are preserved. The
publisher's pinned `semver` dependency is ISC-licensed; its license is included
in the installed npm package.
