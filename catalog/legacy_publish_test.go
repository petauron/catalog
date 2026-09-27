package catalog

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/theupdateframework/go-tuf/v2/metadata/trustedmetadata"
)

func TestLegacyRevisionSevenCanBeExtendedWithoutChangingHistory(t *testing.T) {
	encoded, err := os.ReadFile("legacy-ledger/catalog-r7.base64")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(strings.TrimSpace(string(encoded)))
	if err != nil {
		t.Fatal(err)
	}
	var bundle struct {
		Files map[string]string `json:"files"`
	}
	if err := json.Unmarshal(raw, &bundle); err != nil {
		t.Fatal(err)
	}
	var history OfficialManifestHistory
	priorHistory, err := base64.StdEncoding.Strict().DecodeString(bundle.Files["manifest-history.json"])
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(priorHistory, &history); err != nil {
		t.Fatal(err)
	}
	var acceptance OfficialAcceptance
	state, err := base64.StdEncoding.Strict().DecodeString(bundle.Files["publication-state.json"])
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(state, &acceptance); err != nil {
		t.Fatal(err)
	}
	target, err := base64.StdEncoding.Strict().DecodeString(bundle.Files["targets/"+acceptance.SHA256+".stable.json"])
	if err != nil {
		t.Fatal(err)
	}
	var official OfficialTarget
	if err := json.Unmarshal(target, &official); err != nil {
		t.Fatal(err)
	}
	value, err := ParseLegacyCatalog(official.Catalog)
	if err != nil {
		t.Fatal(err)
	}
	if len(value.Apps) != 6 {
		t.Fatalf("unexpected legacy apps: %d", len(value.Apps))
	}
	if _, err := ExtendLegacyManifestHistory(history, value); err != nil {
		t.Fatal(err)
	}
	value.Apps[0].Version = "8.0.0"
	if _, err := ExtendLegacyManifestHistory(history, value); err != nil {
		t.Fatal(err)
	}
	value.Apps[0].Version = "7.2.130"
	value.Apps[0].License = "changed"
	if _, err := ExtendLegacyManifestHistory(history, value); err == nil {
		t.Fatal("same-version mutation accepted")
	}
}

func TestLegacyPublisherSignsAValidTUFChain(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	root, signers := officialTestRoot(t, now)
	payload, err := os.ReadFile("catalog-v3.json")
	if err != nil {
		t.Fatal(err)
	}
	target, err := json.Marshal(OfficialTarget{
		Source: OfficialSourceIdentity, Channel: "stable", Revision: 8,
		GeneratedAt: now, ExpiresAt: now.Add(36 * time.Hour), Catalog: payload,
	})
	if err != nil {
		t.Fatal(err)
	}
	files, err := BuildLegacyOfficialRepository(root, target, nil, "stable", OfficialAcceptance{Channel: "stable", Revision: 7}, now, signers)
	if err != nil {
		t.Fatal(err)
	}
	trusted, err := trustedmetadata.New(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := trusted.UpdateTimestamp(files["timestamp.json"]); err != nil {
		t.Fatal(err)
	}
	if _, err := trusted.UpdateSnapshot(files["8.snapshot.json"], false); err != nil {
		t.Fatal(err)
	}
	if _, err := trusted.UpdateTargets(files["8.targets.json"]); err != nil {
		t.Fatal(err)
	}
	if err := trusted.Targets["targets"].Signed.Targets["stable.json"].VerifyLengthHashes(target); err != nil {
		t.Fatal(err)
	}
	if _, acceptance, err := ValidateLegacyOfficialTarget(target, "stable", OfficialAcceptance{Channel: "stable", Revision: 7}, now); err != nil || acceptance.Revision != 8 {
		t.Fatalf("legacy target rejected: %v", err)
	}
	if _, _, err := ValidateOfficialTarget(target, "stable", OfficialAcceptance{}, now); err == nil {
		t.Fatal("schema 4 consumer accepted legacy catalog")
	}
}
