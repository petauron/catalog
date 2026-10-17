package catalog

import (
	"errors"
	"strings"

	"golang.org/x/mod/semver"
)

// Official UI assets are signed TUF targets owned by an application version.
// This is an application UI integration, not an installation allowlist.
const MaxOfficialUIBytes = 4 << 20

func OfficialUITargetName(appID, version string) (string, error) {
	if appID != "meridian" || !semverPattern.MatchString(version) {
		return "", errors.New("catalog: unsupported official UI identity")
	}
	// Released targets through alpha.21 are immutable. This is a versioned
	// signing contract, not a fallback lookup under a second asset name.
	brand := "glivela"
	if semver.Compare("v"+version, "v0.1.0-alpha.21") <= 0 {
		brand = "meridian"
	}
	return "ui-" + brand + "-" + version + ".js", nil
}

func OfficialUIStylesheetTargetName(appID, version string) (string, error) {
	name, err := OfficialUITargetName(appID, version)
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(name, ".js") + ".css", nil
}
