package catalog

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// OfficialManifestHistory is retained by the protected publication ledger, not
// reconstructed from whatever entries the CDN currently serves. Removed app
// versions remain here and cannot be reintroduced with different content.
type OfficialManifestHistory map[string]map[string]string

// PackageHistoryKey binds the upstream version to an immutable recipe revision.
func PackageHistoryKey(version string, revision int) string {
	return version + "#" + strconv.Itoa(revision)
}

// ImportLegacyManifestHistory is a one-way ledger migration. Legacy digests are
// retained verbatim as revision zero; no legacy manifest becomes executable.
func ImportLegacyManifestHistory(previous OfficialManifestHistory) (OfficialManifestHistory, error) {
	result := make(OfficialManifestHistory)
	for id, versions := range previous {
		if !identifierPattern.MatchString(id) {
			return nil, fmt.Errorf("catalog: invalid protected manifest identity")
		}
		result[id] = make(map[string]string)
		for version, hash := range versions {
			if !sha256Pattern.MatchString(hash) {
				return nil, fmt.Errorf("catalog: invalid protected manifest history")
			}
			key := version
			if !strings.Contains(version, "#") {
				if !semverPattern.MatchString(version) {
					return nil, fmt.Errorf("catalog: invalid legacy version")
				}
				key = PackageHistoryKey(version, 0)
			} else {
				parts := strings.Split(version, "#")
				if len(parts) != 2 || !semverPattern.MatchString(parts[0]) {
					return nil, fmt.Errorf("catalog: invalid package history key")
				}
				revision, err := strconv.Atoi(parts[1])
				if err != nil || revision < 0 || int64(revision) > maxPortableInteger || strconv.Itoa(revision) != parts[1] {
					return nil, fmt.Errorf("catalog: invalid recipe revision")
				}
			}
			if existing := result[id][key]; existing != "" && existing != hash {
				return nil, fmt.Errorf("catalog: conflicting legacy package digest")
			}
			result[id][key] = hash
		}
	}
	return result, nil
}

func ExtendOfficialManifestHistory(previous OfficialManifestHistory, value Catalog) (OfficialManifestHistory, error) {
	result, err := ImportLegacyManifestHistory(previous)
	if err != nil {
		return nil, err
	}
	for _, app := range value.Apps {
		canonical, err := CanonicalAppManifest(app)
		if err != nil {
			return nil, err
		}
		raw, err := json.Marshal(canonical)
		if err != nil {
			return nil, err
		}
		digest := sha256.Sum256(raw)
		hash := hex.EncodeToString(digest[:])
		if result[app.ID] == nil {
			result[app.ID] = make(map[string]string)
		}
		key := PackageHistoryKey(app.Version, app.PackageRevision)
		if existing := result[app.ID][key]; existing != "" && existing != hash {
			return nil, fmt.Errorf("catalog: published content changed for %s@%s", app.ID, app.Version)
		}
		result[app.ID][key] = hash
	}
	return result, nil
}
