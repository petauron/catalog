package catalog

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"debug/elf"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func artifactArchive(t *testing.T, headers []*tar.Header) []byte {
	t.Helper()
	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	archive := tar.NewWriter(gzipWriter)
	for _, header := range headers {
		if header.Typeflag == tar.TypeReg {
			header.Size = 7
		}
		if err := archive.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if header.Typeflag == tar.TypeReg {
			if _, err := archive.Write([]byte("binary!")); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestBoundedExtractionOnlyDeclaredRegularFiles(t *testing.T) {
	raw := artifactArchive(t, []*tar.Header{{Name: "release", Typeflag: tar.TypeDir}, {Name: "release/agent", Typeflag: tar.TypeReg, Mode: 07777}, {Name: "release/private.key", Typeflag: tar.TypeReg}})
	destination := filepath.Join(t.TempDir(), "output")
	files, err := ExtractArtifact(bytes.NewReader(raw), destination, Artifact{Format: "tar.gz", StripComponents: 1}, []ArtifactFile{{Path: "agent", Executable: true}})
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 {
		t.Fatal("undeclared file extracted")
	}
	info, err := os.Stat(files[0])
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("unsafe extracted permissions: %v %v", info, err)
	}
	if _, err := os.Stat(filepath.Join(destination, "private.key")); !os.IsNotExist(err) {
		t.Fatal("undeclared file exists")
	}
	if _, err := ExtractArtifact(bytes.NewReader(raw), destination, Artifact{StripComponents: 1}, []ArtifactFile{{Path: "agent"}}); err == nil {
		t.Fatal("existing destination overwritten")
	}
}

func TestArchiveRejectsTraversalLinksAndCollisionsBeforeWrites(t *testing.T) {
	for _, headers := range [][]*tar.Header{
		{{Name: "../agent", Typeflag: tar.TypeReg}}, {{Name: "/agent", Typeflag: tar.TypeReg}},
		{{Name: "release/agent", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}},
		{{Name: "release/agent", Typeflag: tar.TypeLink, Linkname: "/etc/passwd"}},
		{{Name: "release/agent", Typeflag: tar.TypeFifo}},
		{{Name: "one/agent", Typeflag: tar.TypeReg}, {Name: "two/agent", Typeflag: tar.TypeReg}},
		{{Name: "release/agent", Typeflag: tar.TypeReg}, {Name: "release/agent", Typeflag: tar.TypeReg}},
	} {
		destination := filepath.Join(t.TempDir(), "output")
		if _, err := ExtractArtifact(bytes.NewReader(artifactArchive(t, headers)), destination, Artifact{StripComponents: 1}, []ArtifactFile{{Path: "agent"}}); err == nil {
			t.Fatal("unsafe archive accepted")
		}
		if _, err := os.Stat(destination); !os.IsNotExist(err) {
			t.Fatal("invalid archive created destination")
		}
	}
	raw := artifactArchive(t, []*tar.Header{{Name: "release/agent", Typeflag: tar.TypeReg}})
	raw[len(raw)-5] ^= 0xff
	if _, err := ExtractArtifact(bytes.NewReader(raw), filepath.Join(t.TempDir(), "out"), Artifact{StripComponents: 1}, []ArtifactFile{{Path: "agent"}}); err == nil {
		t.Fatal("invalid gzip CRC accepted")
	}
}

func TestDownloadAuthenticatesBeforeExtraction(t *testing.T) {
	content := []byte("artifact")
	hash := sha256.Sum256(content)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "http://example.invalid/insecure", 302)
			return
		}
		_, _ = w.Write(content)
	}))
	defer server.Close()
	artifact := Artifact{URL: server.URL + "/asset", SHA256: hex.EncodeToString(hash[:])}
	raw, err := DownloadArtifact(context.Background(), server.Client(), artifact)
	if err != nil || !bytes.Equal(raw, content) {
		t.Fatalf("download=%q error=%v", raw, err)
	}
	artifact.SHA256 = strings.Repeat("0", 64)
	if _, err := DownloadArtifact(context.Background(), server.Client(), artifact); err == nil {
		t.Fatal("wrong digest accepted")
	}
	artifact.URL = server.URL + "/redirect"
	if _, err := DownloadArtifact(context.Background(), server.Client(), artifact); err == nil {
		t.Fatal("HTTP downgrade followed")
	}
}

func TestELFVerificationBothArchitecturesWithoutExecution(t *testing.T) {
	for _, architecture := range []string{"amd64", "arm64"} {
		var raw bytes.Buffer
		header := elf.Header64{Type: uint16(elf.ET_EXEC), Version: 1, Ehsize: 64}
		copy(header.Ident[:], []byte{0x7f, 'E', 'L', 'F', byte(elf.ELFCLASS64), byte(elf.ELFDATA2LSB), 1})
		header.Machine = uint16(elf.EM_X86_64)
		other := "arm64"
		if architecture == "arm64" {
			header.Machine = uint16(elf.EM_AARCH64)
			other = "amd64"
		}
		if err := binary.Write(&raw, binary.LittleEndian, header); err != nil {
			t.Fatal(err)
		}
		file := filepath.Join(t.TempDir(), "elf")
		if err := os.WriteFile(file, raw.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
		if err := VerifyELF(file, architecture); err != nil {
			t.Fatal(err)
		}
		if err := VerifyELF(file, other); err == nil {
			t.Fatal("wrong architecture accepted")
		}
	}
}

func TestArtifactDecompressionAndMemberCountBounds(t *testing.T) {
	// A declared oversize header is rejected without allocating its body.
	var raw bytes.Buffer
	gzipWriter := gzip.NewWriter(&raw)
	archive := tar.NewWriter(gzipWriter)
	if err := archive.WriteHeader(&tar.Header{Name: "agent", Typeflag: tar.TypeReg, Size: MaxArtifactFileBytes + 1}); err != nil {
		t.Fatal(err)
	}
	_ = archive.Flush()
	_ = gzipWriter.Close()
	if _, err := ExtractArtifact(bytes.NewReader(raw.Bytes()), filepath.Join(t.TempDir(), "out"), Artifact{}, []ArtifactFile{{Path: "agent"}}); err == nil {
		t.Fatal("oversize file header accepted")
	}
	if _, err := ExtractArtifact(io.LimitReader(strings.NewReader("abc"), 3), filepath.Join(t.TempDir(), "raw"), Artifact{Format: "raw"}, []ArtifactFile{{Path: "../bad"}}); err == nil {
		t.Fatal("unsafe raw destination accepted")
	}
}

type artifactRequestFunc func(*http.Request) (*http.Response, error)

func (f artifactRequestFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestGitHubReleaseAssetKeepsIdentityBoundsAndDigest(t *testing.T) {
	content := []byte("artifact")
	hash := sha256.Sum256(content)
	artifact := Artifact{URL: "https://github.com/owner/repository/releases/download/v1/agent", SHA256: hex.EncodeToString(hash[:])}
	metadataURL := artifact.URL
	payload := content
	var assetCalls int
	var oversized bool
	client := &http.Client{Transport: artifactRequestFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.github.com" || r.URL.Scheme != "https" || r.Header.Get("Authorization") != "" {
			t.Fatalf("unexpected request origin or credentials: %s", r.URL.Host)
		}
		var raw []byte
		switch r.URL.Path {
		case "/repos/owner/repository/releases/tags/v1":
			if r.Header.Get("Accept") != "application/vnd.github+json" {
				t.Fatal("missing metadata accept")
			}
			raw, _ = json.Marshal(map[string]any{"tag_name": "v1", "assets": []map[string]any{{"id": 7, "name": "agent", "browser_download_url": metadataURL, "state": "uploaded", "size": len(content), "digest": "sha256:" + artifact.SHA256}}})
		case "/repos/owner/repository/releases/assets/7":
			if r.Header.Get("Accept") != "application/octet-stream" {
				t.Fatal("missing binary accept")
			}
			assetCalls++
			raw = payload
		default:
			t.Fatalf("unexpected asset route: %s", r.URL.Path)
		}
		length := int64(len(raw))
		if oversized {
			length = 2 << 20
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), ContentLength: length, Body: io.NopCloser(bytes.NewReader(raw)), Request: r}, nil
	})}
	raw, err := DownloadArtifact(context.Background(), client, artifact)
	if err != nil || !bytes.Equal(raw, content) || assetCalls != 1 {
		t.Fatalf("exact asset failed: %v", err)
	}
	payload = []byte("tampered")
	if _, err := DownloadArtifact(context.Background(), client, artifact); err == nil {
		t.Fatal("metadata digest trusted instead of actual bytes")
	}
	payload = content
	metadataURL = artifact.URL + "-other"
	before := assetCalls
	if _, err := DownloadArtifact(context.Background(), client, artifact); err == nil || assetCalls != before {
		t.Fatal("mismatched original URL reached binary download")
	}
	metadataURL = artifact.URL
	oversized = true
	if _, err := DownloadArtifact(context.Background(), client, artifact); err == nil || assetCalls != before {
		t.Fatal("oversized metadata accepted")
	}
}
