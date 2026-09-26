package catalog

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"debug/elf"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const MaxArtifactBytes int64 = 512 << 20
const MaxArtifactFileBytes int64 = 128 << 20
const MaxArtifactEntries = 4096

func validateArtifactFiles(files []ArtifactFile) error {
	if len(files) < 1 || len(files) > 128 {
		return errors.New("catalog: artifact must declare 1 to 128 files")
	}
	seen := map[string]bool{}
	for _, file := range files {
		if !safeRelative(file.Path) || seen[file.Path] {
			return errors.New("catalog: invalid or duplicate artifact member")
		}
		seen[file.Path] = true
	}
	for name := range seen {
		for other := range seen {
			if strings.HasPrefix(other, name+"/") {
				return errors.New("catalog: artifact file cannot contain another file")
			}
		}
	}
	return nil
}

// ExtractArtifact never executes artifacts. The complete archive is validated
// before creating destination, which must not exist. Only declared regular files
// are written with owner-only permissions; archive ownership/modes are ignored.
func ExtractArtifact(reader io.Reader, destination string, artifact Artifact, files []ArtifactFile) ([]string, error) {
	if err := validateArtifactFiles(files); err != nil {
		return nil, err
	}
	if artifact.StripComponents < 0 || artifact.StripComponents > 8 {
		return nil, errors.New("catalog: invalid stripComponents")
	}
	contents := map[string][]byte{}
	declared := map[string]ArtifactFile{}
	for _, file := range files {
		declared[file.Path] = file
	}
	if artifact.Format == "raw" {
		if len(files) != 1 || artifact.StripComponents != 0 {
			return nil, errors.New("catalog: raw artifact requires one file and no path stripping")
		}
		raw, err := io.ReadAll(io.LimitReader(reader, MaxArtifactFileBytes+1))
		if err != nil {
			return nil, err
		}
		if len(raw) == 0 || int64(len(raw)) > MaxArtifactFileBytes {
			return nil, errors.New("catalog: raw artifact exceeds bounds")
		}
		contents[files[0].Path] = raw
	} else {
		if artifact.Format != "" && artifact.Format != "tar.gz" {
			return nil, errors.New("catalog: unsupported artifact encoding")
		}
		compressed := &io.LimitedReader{R: reader, N: MaxArtifactBytes + 1}
		gzipReader, err := gzip.NewReader(compressed)
		if err != nil {
			return nil, err
		}
		defer gzipReader.Close()
		uncompressed := &io.LimitedReader{R: gzipReader, N: MaxArtifactBytes + 1}
		archive := tar.NewReader(uncompressed)
		seen := map[string]bool{}
		for entries := 0; ; entries++ {
			header, nextErr := archive.Next()
			if nextErr == io.EOF {
				break
			}
			if nextErr != nil {
				return nil, nextErr
			}
			if entries >= MaxArtifactEntries {
				return nil, errors.New("catalog: archive has too many entries")
			}
			name := strings.TrimSuffix(header.Name, "/")
			if !safeRelative(name) || seen[name] {
				return nil, errors.New("catalog: unsafe or duplicate archive member")
			}
			seen[name] = true
			if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA && header.Typeflag != tar.TypeDir {
				return nil, errors.New("catalog: archive links and special files are forbidden")
			}
			if header.Size < 0 || header.Size > MaxArtifactFileBytes {
				return nil, errors.New("catalog: archive member exceeds bounds")
			}
			parts := strings.Split(name, "/")
			if len(parts) <= artifact.StripComponents {
				if header.Typeflag == tar.TypeDir {
					continue
				}
				return nil, errors.New("catalog: path stripping removes a file")
			}
			name = strings.Join(parts[artifact.StripComponents:], "/")
			if _, wanted := declared[name]; wanted && header.Typeflag != tar.TypeDir {
				if _, exists := contents[name]; exists {
					return nil, errors.New("catalog: path stripping collides")
				}
				raw, err := io.ReadAll(io.LimitReader(archive, MaxArtifactFileBytes+1))
				if err != nil {
					return nil, err
				}
				contents[name] = raw
			}
		}
		// Read through the gzip footer to verify CRC and enforce the total bound.
		buffer := make([]byte, 32768)
		for {
			n, readErr := uncompressed.Read(buffer)
			for _, b := range buffer[:n] {
				if b != 0 {
					return nil, errors.New("catalog: unexpected archive trailing data")
				}
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				return nil, readErr
			}
		}
		if uncompressed.N <= 0 || compressed.N <= 0 {
			return nil, errors.New("catalog: archive exceeds total size bound")
		}
	}
	for _, file := range files {
		if _, ok := contents[file.Path]; !ok {
			return nil, fmt.Errorf("catalog: declared artifact member %s is missing", file.Path)
		}
	}
	if err := os.Mkdir(destination, 0700); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(destination)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	var result []string
	for name, raw := range contents {
		if err := root.MkdirAll(filepath.Dir(name), 0700); err != nil {
			return nil, err
		}
		mode := os.FileMode(0600)
		if declared[name].Executable {
			mode = 0700
		}
		file, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if err != nil {
			return nil, err
		}
		_, writeErr := file.Write(raw)
		closeErr := file.Close()
		if writeErr != nil {
			return nil, writeErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		result = append(result, filepath.Join(destination, name))
	}
	sort.Strings(result)
	return result, nil
}

func VerifyELF(path, architecture string) error {
	value, err := elf.Open(path)
	if err != nil {
		return errors.New("catalog: native artifact is not a valid ELF executable")
	}
	defer value.Close()
	expected := map[string]elf.Machine{"amd64": elf.EM_X86_64, "arm64": elf.EM_AARCH64}[architecture]
	if expected == elf.EM_NONE || value.Machine != expected || value.Class != elf.ELFCLASS64 || value.Data != elf.ELFDATA2LSB || (value.Type != elf.ET_EXEC && value.Type != elf.ET_DYN) {
		return errors.New("catalog: native artifact platform mismatch")
	}
	return nil
}

// VerifyNativeArtifact verifies a public asset's complete digest and declared
// executable architecture. It has no signing, installation, or execution side effects.
func VerifyNativeArtifact(ctx context.Context, app AppManifest, artifact Artifact) error {
	if err := ValidateApp(app); err != nil {
		return err
	}
	if app.Runtime == nil || app.Runtime.Kind != "systemd" || app.Runtime.Version != 1 || app.Runtime.Systemd == nil {
		return errors.New("catalog: native verification requires supported systemd recipe")
	}
	declared := false
	for _, candidate := range app.Artifacts {
		if candidate == artifact {
			declared = true
		}
	}
	if !declared || artifact.Name != app.Runtime.Systemd.Artifact {
		return errors.New("catalog: undeclared artifact")
	}
	raw, err := DownloadArtifact(ctx, nil, artifact)
	if err != nil {
		return err
	}
	directory, err := os.MkdirTemp("", "catalog-artifact-verification-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	_, err = ExtractArtifact(bytes.NewReader(raw), filepath.Join(directory, "files"), artifact, app.Runtime.Systemd.Files)
	if err != nil {
		return err
	}
	for _, file := range app.Runtime.Systemd.Files {
		if file.Executable {
			if err := VerifyELF(filepath.Join(directory, "files", file.Path), artifact.Architecture); err != nil {
				return err
			}
		}
	}
	return nil
}

// DownloadArtifact authenticates every byte before returning it to extraction.
// A supplied client may provide an isolated test transport, but cannot weaken
// the HTTPS, redirect, content length, or hash checks.
func DownloadArtifact(ctx context.Context, client *http.Client, artifact Artifact) ([]byte, error) {
	parsed, err := url.Parse(artifact.URL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || strings.ContainsAny(artifact.URL, "?#") || !sha256Pattern.MatchString(artifact.SHA256) {
		return nil, errors.New("catalog: invalid artifact URL or digest")
	}
	configured := http.Client{Timeout: 2 * time.Minute}
	if client != nil {
		configured = *client
		if configured.Timeout == 0 || configured.Timeout > 2*time.Minute {
			configured.Timeout = 2 * time.Minute
		}
	}
	previousRedirect := configured.CheckRedirect
	configured.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) >= 5 || request.URL.Scheme != "https" || request.URL.Host == "" || request.URL.User != nil || request.URL.Fragment != "" {
			return errors.New("catalog: unsafe artifact redirect")
		}
		if previousRedirect != nil {
			return previousRedirect(request, via)
		}
		return nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, artifact.URL, nil)
	if err != nil {
		return nil, err
	}
	response, err := configured.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("catalog: artifact HTTP status %d", response.StatusCode)
	}
	if response.ContentLength > MaxArtifactBytes {
		return nil, errors.New("catalog: artifact exceeds download bound")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, MaxArtifactBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 || int64(len(raw)) > MaxArtifactBytes {
		return nil, errors.New("catalog: artifact exceeds download bound")
	}
	hash := sha256.Sum256(raw)
	if hex.EncodeToString(hash[:]) != artifact.SHA256 {
		return nil, errors.New("catalog: artifact SHA256 mismatch")
	}
	return raw, nil
}
