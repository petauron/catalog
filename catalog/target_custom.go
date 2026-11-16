package catalog

import (
	"errors"

	"golang.org/x/mod/semver"
)

// VersionIdentity identifies an immutable application package and recipe.
type VersionIdentity struct {
	Version         string `json:"version"`
	PackageRevision int    `json:"packageRevision"`
}

// VersionEquivalence is an audited, exact equivalence for a signed target.
// It does not change the recorded installed version or authorize an upgrade.
type VersionEquivalence struct {
	AppID      string            `json:"appId"`
	Target     VersionIdentity   `json:"target"`
	Equivalent []VersionIdentity `json:"equivalent"`
}

type TargetCustom struct {
	VersionEquivalences []VersionEquivalence `json:"versionEquivalences"`
}

// ParseTargetCustom validates the reviewed TUF target custom metadata before signing.
func ParseTargetCustom(raw []byte) (TargetCustom, error) {
	var value TargetCustom
	if len(raw) == 0 || len(raw) > 16384 {
		return value, errors.New("catalog: invalid target custom size")
	}
	if err := decodeStrictJSON(raw, &value); err != nil {
		return value, errors.New("catalog: invalid target custom metadata")
	}
	if value.VersionEquivalences == nil || len(value.VersionEquivalences) > 32 {
		return value, errors.New("catalog: invalid target custom metadata")
	}
	seen := make(map[string]bool)
	for _, entry := range value.VersionEquivalences {
		if !identifierPattern.MatchString(entry.AppID) || !validVersionIdentity(entry.Target) || len(entry.Equivalent) == 0 || len(entry.Equivalent) > 32 {
			return value, errors.New("catalog: invalid version equivalence")
		}
		key := entry.AppID + "\x00" + entry.Target.Version
		if seen[key] {
			return value, errors.New("catalog: duplicate version equivalence")
		}
		seen[key] = true
		installed := make(map[VersionIdentity]bool)
		for _, old := range entry.Equivalent {
			if !validVersionIdentity(old) || semver.Compare("v"+old.Version, "v"+entry.Target.Version) >= 0 || installed[old] {
				return value, errors.New("catalog: invalid equivalent version")
			}
			installed[old] = true
		}
	}
	return value, nil
}

func validVersionIdentity(value VersionIdentity) bool {
	return value.PackageRevision > 0 && int64(value.PackageRevision) <= maxPortableInteger && semverPattern.MatchString(value.Version) && semver.IsValid("v"+value.Version)
}

// ValidateTargetCustomForApps prevents signing an equivalence for a package
// newer than the verified catalog. Older anchors remain harmless and inactive.
func ValidateTargetCustomForApps(value TargetCustom, apps []AppManifest) error {
	for _, entry := range value.VersionEquivalences {
		found := false
		for _, app := range apps {
			if app.ID != entry.AppID {
				continue
			}
			found = true
			comparison := semver.Compare("v"+entry.Target.Version, "v"+app.Version)
			if comparison > 0 || (comparison == 0 && entry.Target.PackageRevision > app.PackageRevision) {
				return errors.New("catalog: target equivalence is newer than the catalog package")
			}
			break
		}
		if !found {
			return errors.New("catalog: target equivalence references an absent app")
		}
	}
	return nil
}
