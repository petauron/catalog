package catalog

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOfficialStagedRepositoryUsesIndependentVerification(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	root, signers := officialTestRoot(t, now)
	payload, err := os.ReadFile("testdata/v4/valid-catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(OfficialTarget{Source: OfficialSourceIdentity, Channel: "stable", Revision: 1, GeneratedAt: now, ExpiresAt: now.Add(time.Hour), Catalog: payload})
	if err != nil {
		t.Fatal(err)
	}
	files, err := BuildOfficialRepository(root, raw, nil, "stable", OfficialAcceptance{}, now, signers)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for name, content := range files {
		location := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(location), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(location, content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	result, err := VerifyOfficialRepository(context.Background(), dir, "stable", root)
	if err != nil || result.State.Acceptance.Revision != 1 {
		t.Fatalf("staged verification: %v", err)
	}
	otherRoot, _ := officialTestRoot(t, now)
	if _, err := VerifyOfficialRepository(context.Background(), dir, "stable", otherRoot); err == nil {
		t.Fatal("same-directory root substitution accepted")
	}
	if err := os.WriteFile(filepath.Join(dir, "timestamp.json"), []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyOfficialRepository(context.Background(), dir, "stable", root); err == nil {
		t.Fatal("damaged timestamp accepted")
	}
}

func TestOfficialUIAssetsAreVersionBoundAndIndependentlyVerified(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	root, signers := officialTestRoot(t, now)
	payload, err := os.ReadFile("testdata/v4/valid-catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var value Catalog
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatal(err)
	}
	value.Apps[0].ID = "meridian"
	payload, err = json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(OfficialTarget{Source: OfficialSourceIdentity, Channel: "stable", Revision: 1, GeneratedAt: now, ExpiresAt: now.Add(time.Hour), Catalog: payload})
	if err != nil {
		t.Fatal(err)
	}
	script, err := OfficialUITargetName("meridian", value.Apps[0].Version)
	if err != nil {
		t.Fatal(err)
	}
	style, err := OfficialUIStylesheetTargetName("meridian", value.Apps[0].Version)
	if err != nil {
		t.Fatal(err)
	}
	assets := map[string][]byte{script: []byte("export const version = '1.2.3';"), style: []byte("body{color:green}")}
	if _, err := BuildOfficialRepository(root, raw, map[string][]byte{script: assets[script]}, "stable", OfficialAcceptance{}, now, signers); err == nil {
		t.Fatal("unpaired UI script accepted")
	}
	if _, err := BuildOfficialRepository(root, raw, map[string][]byte{"ui-meridian-9.9.9.js": assets[script]}, "stable", OfficialAcceptance{}, now, signers); err == nil {
		t.Fatal("UI for another version accepted")
	}
	if _, err := BuildOfficialRepository(root, raw, map[string][]byte{script: make([]byte, MaxOfficialUIBytes+1), style: assets[style]}, "stable", OfficialAcceptance{}, now, signers); err == nil {
		t.Fatal("oversized UI script accepted")
	}
	files, err := BuildOfficialRepository(root, raw, assets, "stable", OfficialAcceptance{}, now, signers)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for name, content := range files {
		location := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(location), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(location, content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	result, err := VerifyOfficialRepository(context.Background(), dir, "stable", root)
	if err != nil || string(result.UIBundles[script]) != string(assets[script]) || string(result.UIBundles[style]) != string(assets[style]) {
		t.Fatalf("verified UI bundle mismatch: %v", err)
	}
	for name := range files {
		if strings.HasSuffix(name, "."+script) {
			if err := os.WriteFile(filepath.Join(dir, name), []byte("tampered"), 0600); err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	if _, err := VerifyOfficialRepository(context.Background(), dir, "stable", root); err == nil {
		t.Fatal("tampered signed UI accepted")
	}
}
