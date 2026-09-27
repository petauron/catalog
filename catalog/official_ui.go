package catalog

import (
	"errors"
	"strings"
)

// Official UI assets are signed TUF targets owned by an application version.
// This is an application UI integration, not an installation allowlist.
const MaxOfficialUIBytes = 4 << 20

func OfficialUITargetName(appID, version string) (string, error) {
	if appID != "meridian" || !semverPattern.MatchString(version) {
		return "", errors.New("catalog: unsupported official UI identity")
	}
	return "ui-" + appID + "-" + version + ".js", nil
}

func OfficialUIStylesheetTargetName(appID, version string) (string, error) {
	name, err := OfficialUITargetName(appID, version)
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(name, ".js") + ".css", nil
}
