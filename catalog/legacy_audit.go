package catalog

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

// This closed legacy shape exists only to validate audit evidence and preserve
// pre-schema-4 hashes. It is never returned as an executable AppManifest.
type legacyManifest struct {
	ID          string           `json:"id"`
	Version     string           `json:"version"`
	Name        LocalizedText    `json:"name"`
	Description LocalizedText    `json:"description"`
	License     string           `json:"license"`
	Images      []Image          `json:"images,omitempty"`
	Artifacts   []legacyArtifact `json:"artifacts,omitempty"`
	Services    []Service        `json:"services,omitempty"`
	Homepage    *Homepage        `json:"homepage,omitempty"`
	Config      []ConfigField    `json:"config"`
	HostAccess  bool             `json:"hostAccess,omitempty"`
}

type legacyArtifact struct {
	Name            string `json:"name"`
	OperatingSystem string `json:"operatingSystem"`
	Architecture    string `json:"architecture"`
	URL             string `json:"url"`
	SHA256          string `json:"sha256"`
}

type LegacyManifestEvidence struct {
	ID      string
	Version string
	SHA256  string
	Raw     json.RawMessage
}

// LegacyManifestDigest reproduces the schema 3 canonical digest exactly. It
// intentionally cannot be used by ParseCatalog or runtime admission.
func LegacyManifestDigest(rawApp json.RawMessage) (string, error) {
	if len(rawApp) == 0 || int64(len(rawApp)) > MaxEnvelopeBytes {
		return "", errors.New("catalog: invalid legacy manifest size")
	}
	var legacy legacyManifest
	if err := decodeStrictJSON(rawApp, &legacy); err != nil {
		return "", err
	}
	shape := append([]byte(`{"schemaVersion":3,"generatedAt":"2026-01-01T00:00:00Z","apps":[`), rawApp...)
	shape = append(shape, ']', '}')
	if err := validateCatalogJSONShape(shape); err != nil {
		return "", err
	}
	metadata := AppManifest{ID: legacy.ID, Version: legacy.Version, Name: legacy.Name, Description: legacy.Description, License: legacy.License, Images: legacy.Images, Services: legacy.Services, Homepage: legacy.Homepage, Config: legacy.Config, HostAccess: legacy.HostAccess}
	for _, artifact := range legacy.Artifacts {
		metadata.Artifacts = append(metadata.Artifacts, Artifact{Name: artifact.Name, OperatingSystem: artifact.OperatingSystem, Architecture: artifact.Architecture, URL: artifact.URL, SHA256: artifact.SHA256})
	}
	if err := validateAppMetadata(metadata); err != nil {
		return "", err
	}
	canonical, err := canonicalAppMetadata(metadata)
	if err != nil {
		return "", err
	}
	legacy.Config = canonical.Config
	encoded, err := json.Marshal(legacy)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:]), nil
}

// AuditLegacyEnvelope verifies historical signatures and returns only immutable
// evidence. An envelope, even correctly signed, is never an installable v4 catalog.
func AuditLegacyEnvelope(raw []byte, publicKey ed25519.PublicKey) ([]LegacyManifestEvidence, error) {
	if len(raw) == 0 || int64(len(raw)) > MaxEnvelopeBytes || len(publicKey) != ed25519.PublicKeySize {
		return nil, errors.New("catalog: invalid legacy envelope bounds or key")
	}
	var envelope Envelope
	if err := decodeStrictJSON(raw, &envelope); err != nil {
		return nil, err
	}
	if envelope.SchemaVersion != 3 {
		return nil, errors.New("catalog: legacy audit accepts only schema 3")
	}
	if err := validateKeyID(envelope.KeyID); err != nil {
		return nil, err
	}
	payload, err := base64.RawURLEncoding.Strict().DecodeString(envelope.Payload)
	if err != nil {
		return nil, err
	}
	signature, err := base64.RawURLEncoding.Strict().DecodeString(envelope.Signature)
	if err != nil {
		return nil, err
	}
	if !ed25519.Verify(publicKey, payload, signature) {
		return nil, errors.New("catalog: invalid legacy signature")
	}
	var value struct {
		SchemaVersion int               `json:"schemaVersion"`
		GeneratedAt   time.Time         `json:"generatedAt"`
		Apps          []json.RawMessage `json:"apps"`
	}
	if err := decodeStrictJSON(payload, &value); err != nil {
		return nil, err
	}
	if value.SchemaVersion != 3 {
		return nil, errors.New("catalog: invalid legacy payload version")
	}
	if err := validateCatalogJSONShape(payload); err != nil {
		return nil, err
	}
	var result []LegacyManifestEvidence
	seen := map[string]bool{}
	for _, app := range value.Apps {
		digest, err := LegacyManifestDigest(app)
		if err != nil {
			return nil, err
		}
		var identity struct {
			ID      string `json:"id"`
			Version string `json:"version"`
		}
		if err := json.Unmarshal(app, &identity); err != nil {
			return nil, err
		}
		if seen[identity.ID] {
			return nil, errors.New("catalog: duplicate legacy app identity")
		}
		seen[identity.ID] = true
		result = append(result, LegacyManifestEvidence{ID: identity.ID, Version: identity.Version, SHA256: digest, Raw: append(json.RawMessage(nil), app...)})
	}
	return result, nil
}
