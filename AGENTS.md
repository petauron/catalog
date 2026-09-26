# Catalog contributor rules

- Never commit private signing keys, tokens, credentials, or private infrastructure data.
- The catalog never deploys applications. Preserve immutable package identities,
  trusted roots, revision high-water marks, and conditional publication writes.
- No arbitrary host scripts, executable templates, unpinned images, or unsafe archives.
- Change code through feature branches and pull requests, not direct main pushes.
- Tests must not contact production storage, execute downloaded application binaries,
  or use production signing credentials. Use isolated fixtures and temporary directories.
- Production publication requires an explicit completed migration and operator-provisioned
  credentials. Never reset trust, replace old release assets, or bypass failed checks.
