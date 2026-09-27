// catalog-publish builds a signed immutable repository for separate publication.
package main

import (
	"crypto"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/petauron/catalog/catalog"
	"github.com/sigstore/sigstore/pkg/signature"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	f := flag.NewFlagSet("catalog-publish", flag.ContinueOnError)
	input := f.String("catalog", "catalog/catalog.json", "reviewed catalog JSON")
	legacyV3 := f.Bool("legacy-v3", false, "publish schema 3 for the deployed Vastora consumer")
	rootPath := f.String("root", "", "independently approved root JSON")
	previousPath := f.String("previous", "", "previous accepted publication state JSON")
	historyPath := f.String("history", "", "protected complete manifest history (required with previous)")
	bootstrap := f.Bool("bootstrap", false, "explicit first publication; incompatible with --previous")
	channel := f.String("channel", "stable", "catalog channel")
	revision := f.Uint64("revision", 0, "strictly increasing publication revision")
	output := f.String("output", "", "new output directory; must not exist")
	uiBundlePath := f.String("ui-bundle", "", "reviewed Meridian UI script")
	uiStylePath := f.String("ui-style", "", "reviewed Meridian UI stylesheet")
	keyFiles := map[string]*string{}
	for _, role := range []string{"targets", "snapshot", "timestamp"} {
		keyFiles[role] = f.String(role+"-keys", "", "comma-separated protected PKCS8 Ed25519 key files")
	}
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 || *output == "" || *rootPath == "" || *bootstrap == (*previousPath != "") {
		return errors.New("catalog-publish: root, new output, and exactly one of bootstrap/previous are required")
	}
	var previous catalog.OfficialAcceptance
	var history catalog.OfficialManifestHistory
	if (*previousPath != "") != (*historyPath != "") {
		return errors.New("catalog-publish: previous acceptance and complete history must be supplied together")
	}
	if *previousPath != "" {
		raw, err := os.ReadFile(*previousPath)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &previous); err != nil {
			return err
		}
		if previous.Revision == 0 || previous.SHA256 == "" {
			return errors.New("catalog-publish: invalid previous acceptance")
		}
		raw, err = os.ReadFile(*historyPath)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &history); err != nil {
			return err
		}
		if len(history) == 0 {
			return errors.New("catalog-publish: protected history is empty")
		}
	}
	payload, err := os.ReadFile(*input)
	if err != nil {
		return err
	}
	var apps []catalog.AppManifest
	if *legacyV3 {
		value, err := catalog.ParseLegacyCatalog(payload)
		if err != nil {
			return err
		}
		history, err = catalog.ExtendLegacyManifestHistory(history, value)
		if err != nil {
			return err
		}
		for _, app := range value.Apps {
			apps = append(apps, catalog.AppManifest{ID: app.ID, Version: app.Version})
		}
	} else {
		value, err := catalog.ParseCatalog(payload)
		if err != nil {
			return err
		}
		history, err = catalog.ExtendOfficialManifestHistory(history, value)
		if err != nil {
			return err
		}
		apps = value.Apps
	}
	root, err := os.ReadFile(*rootPath)
	if err != nil {
		return err
	}
	now := time.Now().UTC().Truncate(time.Second)
	expires, err := time.Parse(time.RFC3339, catalog.OfficialLongLivedExpiry)
	if err != nil {
		return err
	}
	target, err := json.Marshal(catalog.OfficialTarget{Source: catalog.OfficialSourceIdentity, Channel: *channel, Revision: *revision, GeneratedAt: now, ExpiresAt: expires, Catalog: payload})
	if err != nil {
		return err
	}
	signers := map[string][]signature.Signer{}
	for role, paths := range keyFiles {
		for _, path := range strings.Split(*paths, ",") {
			signer, err := loadSigner(path)
			if err != nil {
				return fmt.Errorf("catalog-publish: could not load protected %s signer", role)
			}
			signers[role] = append(signers[role], signer)
		}
	}
	if (*uiBundlePath == "") != (*uiStylePath == "") {
		return errors.New("catalog-publish: UI script and stylesheet must be supplied together")
	}
	var uiBundles map[string][]byte
	if *uiBundlePath != "" {
		for _, app := range apps {
			if app.ID != "meridian" {
				continue
			}
			script, err := catalog.OfficialUITargetName(app.ID, app.Version)
			if err != nil {
				return err
			}
			style, _ := catalog.OfficialUIStylesheetTargetName(app.ID, app.Version)
			if filepath.Base(*uiBundlePath) != script || filepath.Base(*uiStylePath) != style {
				return errors.New("catalog-publish: reviewed UI version differs from catalog")
			}
		}
		uiBundles = make(map[string][]byte, 2)
		for _, path := range []string{*uiBundlePath, *uiStylePath} {
			info, err := os.Lstat(path)
			if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 || info.Size() > catalog.MaxOfficialUIBytes {
				return errors.New("catalog-publish: invalid reviewed UI asset")
			}
			bundle, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			uiBundles[filepath.Base(path)] = bundle
		}
	}
	var files map[string][]byte
	if *legacyV3 {
		files, err = catalog.BuildLegacyOfficialRepository(root, target, uiBundles, *channel, previous, now, signers)
	} else {
		files, err = catalog.BuildOfficialRepository(root, target, uiBundles, *channel, previous, now, signers)
	}
	if err != nil {
		return err
	}
	var acceptance catalog.OfficialAcceptance
	if *legacyV3 {
		_, acceptance, err = catalog.ValidateLegacyOfficialTarget(target, *channel, previous, now)
	} else {
		_, acceptance, err = catalog.ValidateOfficialTarget(target, *channel, previous, now)
	}
	if err != nil {
		return err
	}
	files["publication-state.json"], err = json.Marshal(acceptance)
	if err != nil {
		return err
	}
	files["manifest-history.json"], err = json.Marshal(history)
	if err != nil {
		return err
	}
	if err := os.Mkdir(*output, 0700); err != nil {
		return err
	}
	for name, raw := range files {
		path := filepath.Join(*output, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		if err := os.WriteFile(path, raw, 0600); err != nil {
			return err
		}
	}
	fmt.Printf("Prepared catalog revision %d; publish immutable objects before timestamp.json.\n", *revision)
	return nil
}

func loadSigner(path string) (signature.Signer, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("invalid key file permissions")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	defer clear(raw)
	block, rest := pem.Decode(raw)
	if block == nil || block.Type != "PRIVATE KEY" || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, errors.New("invalid PKCS8 PEM")
	}
	defer clear(block.Bytes)
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	private, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("expected Ed25519 key")
	}
	return signature.LoadSigner(private, crypto.Hash(0))
}
