package catalog

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestGlivelaNodeNativeRecipe(t *testing.T) {
	raw, err := os.ReadFile("recipes/glivela-node.runtime.json")
	if err != nil {
		t.Fatal(err)
	}
	a := nativeServicesFixture()
	if err := json.Unmarshal(raw, &a.Runtime); err != nil {
		t.Fatal(err)
	}
	a.Config = []ConfigField{
		{Key: "controller_url", Type: "string", Required: true},
		{Key: "network_interface", Type: "string", Required: true},
		{Key: "certificate_pem", Type: "string", Secret: true, Required: true},
		{Key: "private_key_pem", Type: "string", Secret: true, Required: true},
		{Key: "ca_pem", Type: "string", Secret: true, Required: true},
	}
	if err := ValidateRuntime(a); err != nil {
		t.Fatal(err)
	}
	files, err := NativeArtifactFiles(a, "bundle")
	if err != nil || len(files) != 7 {
		t.Fatal("incomplete native distribution allowlist", err)
	}
	wantFiles := map[string]bool{"glivela": true, "xray": true, "runtime.json": false, "LICENSE.glivela": false, "LICENSE.xray": false, "glivela-ui.js": false, "glivela-ui.css": false}
	for _, file := range files {
		mode, exists := wantFiles[file.Path]
		if !exists || file.Executable != mode {
			t.Fatal("recipe differs from native distribution", file.Path)
		}
	}
	node, worker := a.Runtime.NativeServices.Services[0], a.Runtime.NativeServices.Services[1]
	if node.Start != "automatic" || worker.Start != "manual" || worker.ManagedUser != "xray" || worker.Process.User != "" || len(worker.WritableState) != 0 {
		t.Fatal("worker isolation changed")
	}
	var arguments []string
	for _, value := range worker.Process.Arguments {
		arg, err := ResolveString(value, nil, nil, map[string]string{"credential-file:configuration.json": "/run/example-worker/configuration.json"})
		if err != nil {
			t.Fatal(err)
		}
		arguments = append(arguments, arg)
	}
	if strings.Join(arguments, " ") != "run -format json -config /run/example-worker/configuration.json" {
		t.Fatal("native systemd credential must use a JSON filename")
	}
	values := map[string]string{
		"state-directory:node-state":  "/var/lib/example-node-state",
		"credential-file:certificate": "/run/example-node/certificate",
		"credential-file:key":         "/run/example-node/key",
		"credential-file:ca":          "/run/example-node/ca",
		"native-installation:":        "/etc/example/installation.json",
	}
	configuration, err := RenderConfigFile(node.Process.ConfigFiles[0], map[string]any{"controller_url": "https://controller.example.invalid:9443", "network_interface": "tailscale0"}, nil, values)
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if json.Unmarshal(configuration, &cfg) != nil || cfg["mode"] != "node" || cfg["directory"] != values["state-directory:node-state"] {
		t.Fatal("bootstrap cannot be rendered")
	}
	xray := cfg["xray"].(map[string]any)
	if xray["installation"] != values["native-installation:"] || xray["service"] != "xray" {
		t.Fatal("installer-owned service identity lost")
	}
	if _, exists := xray["distribution"]; exists {
		t.Fatal("bundle path must come from executable")
	}
	for _, forbidden := range []string{"meridian-runtime", "landing.server", "docker", "binarySHA256", "unitSHA256"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("recipe introduced business-specific executor input: %s", forbidden)
		}
	}
}
