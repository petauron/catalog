package catalog

import (
	"os"
	"testing"
)

func TestOfficialPublicationHistoryRetainsRemovedVersions(t *testing.T) {
	raw, err := os.ReadFile("testdata/v4/valid-catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	value, err := ParseCatalog(raw)
	if err != nil {
		t.Fatal(err)
	}
	first, err := ExtendOfficialManifestHistory(nil, value)
	if err != nil {
		t.Fatal(err)
	}
	removed, err := ExtendOfficialManifestHistory(first, Catalog{})
	if err != nil {
		t.Fatal(err)
	}
	value.Apps[0].Description.English += " altered"
	if _, err := ExtendOfficialManifestHistory(removed, value); err == nil {
		t.Fatal("removed version was republished with altered content")
	}
	value.Apps[0].Version = "99.0.0"
	if _, err := ExtendOfficialManifestHistory(removed, value); err != nil {
		t.Fatal(err)
	}
}

func TestSenlunIdentityPreservesPublishedPulseHistory(t *testing.T) {
	raw, err := os.ReadFile("testdata/v4/valid-catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := ParseCatalog(raw)
	if err != nil {
		t.Fatal(err)
	}
	legacy.Apps[0].ID = "pulse"
	published, err := ExtendOfficialManifestHistory(nil, legacy)
	if err != nil {
		t.Fatal(err)
	}
	key := PackageHistoryKey(legacy.Apps[0].Version, legacy.Apps[0].PackageRevision)
	oldDigest := published["pulse"][key]
	current := legacy
	current.Apps = append([]AppManifest(nil), legacy.Apps...)
	current.Apps[0].ID = "senlun"
	next, err := ExtendOfficialManifestHistory(published, current)
	if err != nil {
		t.Fatal(err)
	}
	if next["pulse"][key] != oldDigest || published["pulse"][key] != oldDigest || next["senlun"][key] == "" {
		t.Fatal("new identity did not retain the original signed history")
	}
	legacy.Apps[0].Description.English += " changed"
	if _, err := ExtendOfficialManifestHistory(next, legacy); err == nil {
		t.Fatal("rewriting a published old identity must fail")
	}
}
