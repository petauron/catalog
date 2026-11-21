package catalog

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

func TestCPARecipeUsesV8AndDisablesIndependentPanelUpdates(t *testing.T) {
	raw, err := os.ReadFile("catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	c, err := ParseCatalog(raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, app := range c.Apps {
		if app.ID != "cpa" {
			continue
		}
		if app.Version != "8.0.79" || !strings.Contains(app.Images[0].Reference, "v8.0.79@sha256:") {
			t.Fatal("CPA version and immutable image must agree")
		}
		container := app.Runtime.Docker.Containers[0]
		if !slices.Contains(app.Runtime.RequiredCapabilities, "host-network") || !slices.Contains(app.Runtime.RequiredCapabilities, "cpa-tunnel-identity") {
			t.Fatal("old executors must not accept the CPA identity recipe")
		}
		data, err := RenderConfigFile(container.ConfigFiles[0], map[string]any{"debug": false}, map[string]string{"api_key": "example-client-key", "management_key": "example-management-key"}, map[string]string{"private-address:": "100.64.0.2"})
		if err != nil {
			t.Fatal(err)
		}
		var config map[string]any
		if err := json.Unmarshal(data, &config); err != nil {
			t.Fatal(err)
		}
		if config["config-version"] != float64(8) {
			t.Fatal("missing v8 config layout")
		}
		management := config["management"].(map[string]any)
		if management["disable-auto-update-panel"] != true || management["allow-remote"] != true || management["secret-key"] != "example-management-key" {
			t.Fatal("panel policy or management identity lost")
		}
		server := config["server"].(map[string]any)
		if server["port"] != float64(8317) || server["host"] != "100.64.0.2" || len(server["trusted-proxies"].([]any)) != 0 || !container.HostNetwork {
			t.Fatal("listener changed")
		}
		access := config["access"].(map[string]any)
		if access["api-keys"].([]any)[0] != "example-client-key" {
			t.Fatal("client key lost")
		}
		if config["oauth"].(map[string]any)["auth-dir"] != "/root/.cli-proxy-api" {
			t.Fatal("authentication storage moved")
		}
		for _, key := range []string{"host", "port", "api-keys", "remote-management", "auth-dir", "debug", "logging-to-file"} {
			if _, exists := config[key]; exists {
				t.Fatalf("obsolete root field retained: %s", key)
			}
		}
		if len(container.Mounts) != 4 {
			t.Fatal("persistent auth/log/plugin mounts changed")
		}
		if app.PackageRevision != 3 || container.Mounts[3].Storage != "management-panel" || container.Mounts[3].Target != "/CLIProxyAPI/static" {
			t.Fatal("compatible management panel is not retained across container updates")
		}
		return
	}
	t.Fatal("CPA recipe missing")
}

func TestKeeperOriginMigrationRequiresCurrentExecutor(t *testing.T) {
	raw, err := os.ReadFile("catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	c, err := ParseCatalog(raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, app := range c.Apps {
		if app.ID == "keeper" {
			if app.PackageRevision != 3 || !slices.Contains(app.Runtime.RequiredCapabilities, "cpa-tunnel-identity") {
				t.Fatal("Keeper origin migration is not gated")
			}
			c := app.Runtime.Docker.Containers[0]
			if len(c.Command) != 1 || len(c.Arguments) != 1 {
				t.Fatal("Keeper must preserve its non-privileged command and binary argument")
			}
			cmd, cmdErr := ResolveString(c.Command[0], nil, nil)
			arg, argErr := ResolveString(c.Arguments[0], nil, nil)
			work, workErr := ResolveString(c.Environment["WORK_DIR"], nil, nil)
			if c.User != "app:app" || cmdErr != nil || cmd != "/usr/bin/env" || argErr != nil || arg != "/app/cpa-usage-keeper" || workErr != nil || work != "/data" || slices.Contains(app.Runtime.RequiredCapabilities, "root") {
				t.Fatal("Keeper must run the pinned image's app identity without a privileged chown/su-exec entrypoint")
			}
			return
		}
	}
	t.Fatal("Keeper recipe missing")
}
