package catalog

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// BuildOfficialRepository produces immutable objects and the final timestamp
// pointer. It cannot generate/rotate roots or upload content. Publish all other
// files before timestamp.json, under an exclusive channel publication lock.
func BuildOfficialRepository(rootBytes, targetBytes []byte, uiBundles map[string][]byte, channel string, previous OfficialAcceptance, now time.Time, signers map[string][]signature.Signer) (map[string][]byte, error) {
	value, acceptance, err := ValidateOfficialTarget(targetBytes, channel, previous, now)
	if err != nil {
		return nil, err
	}
	return buildOfficialRepository(rootBytes, targetBytes, uiBundles, channel, value.Apps, acceptance, previous, now, signers)
}

// BuildLegacyOfficialRepository signs the deployed schema 3 wire format while
// retaining the same TUF root, channel, monotonic revision, and expiry policy.
func BuildLegacyOfficialRepository(rootBytes, targetBytes []byte, uiBundles map[string][]byte, channel string, previous OfficialAcceptance, now time.Time, signers map[string][]signature.Signer) (map[string][]byte, error) {
	value, acceptance, err := ValidateLegacyOfficialTarget(targetBytes, channel, previous, now)
	if err != nil {
		return nil, err
	}
	return buildOfficialRepository(rootBytes, targetBytes, uiBundles, channel, value.appReferences(), acceptance, previous, now, signers)
}

func buildOfficialRepository(rootBytes, targetBytes []byte, uiBundles map[string][]byte, channel string, apps []AppManifest, acceptance, previous OfficialAcceptance, now time.Time, signers map[string][]signature.Signer) (map[string][]byte, error) {
	if acceptance.Revision <= previous.Revision {
		return nil, errors.New("catalog: publication requires a new revision")
	}
	root, err := metadata.Root().FromBytes(rootBytes)
	if err != nil {
		return nil, err
	}
	if err := root.VerifyDelegate("root", root); err != nil {
		return nil, err
	}
	if !root.Signed.ConsistentSnapshot || !root.Signed.Expires.After(now) {
		return nil, errors.New("catalog: publication requires an unexpired consistent-snapshot root")
	}
	if root.Signed.Expires.Before(acceptance.ExpiresAt) {
		return nil, errors.New("catalog: root expires before published catalog metadata")
	}
	// An online publication role must not share a key with the offline root.
	// Otherwise compromise of the routine publisher also permits trust rotation.
	rootKeys := make(map[string]bool)
	for _, key := range root.Signed.Roles["root"].KeyIDs {
		rootKeys[key] = true
	}
	for _, role := range []string{"targets", "snapshot", "timestamp"} {
		entry, ok := root.Signed.Roles[role]
		if !ok {
			return nil, fmt.Errorf("catalog: root is missing %s authorization", role)
		}
		for _, key := range entry.KeyIDs {
			if rootKeys[key] {
				return nil, errors.New("catalog: publication keys must be separate from root keys")
			}
		}
	}
	version := int64(acceptance.Revision)
	files := map[string][]byte{fmt.Sprintf("%d.root.json", root.Signed.Version): rootBytes}
	target, err := metadata.TargetFile().FromBytes(channel+".json", targetBytes, "sha256")
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(targetBytes)
	files["targets/"+hex.EncodeToString(hash[:])+"."+channel+".json"] = targetBytes
	targets := metadata.Targets(acceptance.ExpiresAt)
	targets.Signed.Version = version
	targets.Signed.Targets[channel+".json"] = target
	allowedUI := make(map[string]struct{})
	for _, app := range apps {
		script, err := OfficialUITargetName(app.ID, app.Version)
		if err != nil {
			continue
		}
		style, _ := OfficialUIStylesheetTargetName(app.ID, app.Version)
		allowedUI[script] = struct{}{}
		allowedUI[style] = struct{}{}
		_, scriptPresent := uiBundles[script]
		_, stylePresent := uiBundles[style]
		if scriptPresent != stylePresent {
			return nil, fmt.Errorf("catalog: incomplete official UI bundle for %q", app.ID)
		}
	}
	for name, raw := range uiBundles {
		if _, ok := allowedUI[name]; !ok || len(raw) == 0 || len(raw) > MaxOfficialUIBytes {
			return nil, fmt.Errorf("catalog: invalid official UI target %q", name)
		}
		file, err := metadata.TargetFile().FromBytes(name, raw, "sha256")
		if err != nil {
			return nil, err
		}
		targets.Signed.Targets[name] = file
		bundleHash := sha256.Sum256(raw)
		files["targets/"+hex.EncodeToString(bundleHash[:])+"."+name] = raw
	}
	targetsBytes, err := signOfficialRole(root, "targets", targets, signers["targets"])
	if err != nil {
		return nil, err
	}
	files[fmt.Sprintf("%d.targets.json", version)] = targetsBytes
	snapshot := metadata.Snapshot(acceptance.ExpiresAt)
	snapshot.Signed.Version = version
	snapshot.Signed.Meta["targets.json"] = officialMetaFile(version, targetsBytes)
	snapshotBytes, err := signOfficialRole(root, "snapshot", snapshot, signers["snapshot"])
	if err != nil {
		return nil, err
	}
	files[fmt.Sprintf("%d.snapshot.json", version)] = snapshotBytes
	// Every role shares the reviewed long-lived publication expiry. New clients
	// cannot detect a mirror that withholds later revisions; accepted clients
	// still enforce their local revision high-water mark.
	timestamp := metadata.Timestamp(acceptance.ExpiresAt)
	timestamp.Signed.Version = version
	timestamp.Signed.Meta["snapshot.json"] = officialMetaFile(version, snapshotBytes)
	files["timestamp.json"], err = signOfficialRole(root, "timestamp", timestamp, signers["timestamp"])
	if err != nil {
		return nil, err
	}
	return files, nil
}

func officialMetaFile(version int64, raw []byte) *metadata.MetaFiles {
	hash := sha256.Sum256(raw)
	return &metadata.MetaFiles{Version: version, Length: int64(len(raw)), Hashes: metadata.Hashes{"sha256": hash[:]}}
}

func signOfficialRole[T metadata.Roles](root *metadata.Metadata[metadata.RootType], role string, value *metadata.Metadata[T], signers []signature.Signer) ([]byte, error) {
	for _, signer := range signers {
		if _, err := value.Sign(signer); err != nil {
			return nil, err
		}
	}
	if err := root.VerifyDelegate(role, value); err != nil {
		return nil, fmt.Errorf("catalog: unauthorized %s signing keys: %w", role, err)
	}
	return json.Marshal(value)
}
