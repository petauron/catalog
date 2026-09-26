package catalog

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

const legacyAuditManifest = `{"id":"legacy-app","version":"1.0.0","name":{"en":"Legacy","zh-CN":"旧应用"},"description":{"en":"Audit only","zh-CN":"仅审计"},"license":"MIT","images":[{"name":"main","reference":"example.invalid/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"config":[{"key":"count","type":"integer","label":{"en":"Count","zh-CN":"数量"},"description":{"en":"Count","zh-CN":"数量"},"required":false,"secret":false,"default":1e0}]}`

func TestLegacyAuditDigestMatchesOriginalCanonicalBytes(t *testing.T) {
	expected := strings.Replace(legacyAuditManifest, `"default":1e0`, `"default":1`, 1)
	hash := sha256.Sum256([]byte(expected))
	digest, err := LegacyManifestDigest([]byte(legacyAuditManifest))
	if err != nil {
		t.Fatal(err)
	}
	if digest != hex.EncodeToString(hash[:]) {
		t.Fatalf("legacy identity changed: %s", digest)
	}
	for _, field := range []string{`"packageRevision":1`, `"runtime":{"kind":"docker","version":1}`} {
		raw := strings.Replace(legacyAuditManifest, `"id":"legacy-app"`, `"id":"legacy-app",`+field, 1)
		if _, err := LegacyManifestDigest([]byte(raw)); err == nil {
			t.Fatal("new runtime field accepted in legacy evidence")
		}
	}
}

func TestLegacyAuditVerifiesBytesWithoutEnablingExecution(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{"schemaVersion":3,"generatedAt":"2026-01-01T00:00:00Z","apps":[` + legacyAuditManifest + `]}`)
	envelope := Envelope{SchemaVersion: 3, KeyID: "legacy-fixture", Payload: base64.RawURLEncoding.EncodeToString(payload), Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, payload))}
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	evidence, err := AuditLegacyEnvelope(raw, public)
	if err != nil {
		t.Fatal(err)
	}
	if len(evidence) != 1 || evidence[0].ID != "legacy-app" || string(evidence[0].Raw) != legacyAuditManifest {
		t.Fatal("legacy bytes or identity were not retained")
	}
	if _, err := ParseCatalog(payload); err == nil {
		t.Fatal("audit enabled legacy execution")
	}
	if _, _, err := Verify(envelope, public); err == nil {
		t.Fatal("legacy envelope accepted by execution verifier")
	}
	altered := strings.Replace(string(raw), `"schemaVersion":3`, `"schemaVersion":2,"schemaVersion":3`, 1)
	if _, err := AuditLegacyEnvelope([]byte(altered), public); err == nil {
		t.Fatal("ambiguous envelope accepted")
	}
	public[0] ^= 1
	if _, err := AuditLegacyEnvelope(raw, public); err == nil {
		t.Fatal("invalid legacy signature accepted")
	}
}
