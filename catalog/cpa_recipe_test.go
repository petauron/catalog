package catalog

import (
	"encoding/json"
	"os"
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
		if app.Version != "8.0.28" || !strings.Contains(app.Images[0].Reference, "v8.0.28@sha256:") {
			t.Fatal("CPA version and immutable image must agree")
		}
		container := app.Runtime.Docker.Containers[0]
		data, err := RenderConfigFile(container.ConfigFiles[0], map[string]any{"debug": false}, map[string]string{"api_key": "example-client-key", "management_key": "example-management-key"})
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
		if server["port"] != float64(8317) || server["host"] != "0.0.0.0" {
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
		if len(container.Mounts) != 3 {
			t.Fatal("persistent auth/log/plugin mounts changed")
		}
		return
	}
	t.Fatal("CPA recipe missing")
}
