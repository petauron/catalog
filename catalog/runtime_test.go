package catalog

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func literal(value string) Value { raw := json.RawMessage(value); return Value{Literal: &raw} }

func TestRuntimeFutureContractsDoNotPoisonCatalog(t *testing.T) {
	for _, runtime := range []string{
		`{"kind":"future","version":1,"custom":{"preserve":true},"requiredCapabilities":["future-network"]}`,
		`{"kind":"docker","version":2,"futureOption":[1,2,3]}`,
	} {
		value := validCatalog()
		if err := json.Unmarshal([]byte(runtime), &value.Apps[0].Runtime); err != nil {
			t.Fatal(err)
		}
		raw, err := MarshalCatalog(value)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := ParseCatalog(raw)
		if err != nil {
			t.Fatal(err)
		}
		if CheckRuntimeSupport(parsed.Apps[0], ExecutorSupport{Versions: map[string]int{"docker": 1, "future": 1}, Capabilities: []string{"future-network"}}).Supported {
			t.Fatal("unknown executable version was supported")
		}
		roundtrip, err := json.Marshal(parsed.Apps[0].Runtime)
		if err != nil {
			t.Fatal(err)
		}
		var before, after any
		_ = json.Unmarshal([]byte(runtime), &before)
		_ = json.Unmarshal(roundtrip, &after)
		b, _ := json.Marshal(before)
		a, _ := json.Marshal(after)
		if string(a) != string(b) {
			t.Fatal("opaque runtime content was lost")
		}
	}
	value := validCatalog()
	value.Apps[0].Runtime.RequiredCapabilities = []string{"future-network"}
	if err := ValidateCatalog(value); err != nil {
		t.Fatal(err)
	}
	if CheckRuntimeSupport(value.Apps[0], ExecutorSupport{Versions: map[string]int{"docker": 1}}).Supported {
		t.Fatal("unknown capability was executable")
	}
}

func TestKnownRuntimeRejectsAmbiguousAndUnknownFields(t *testing.T) {
	for _, raw := range []string{
		`{"kind":"docker","version":1,"docker":{"containers":[]},"shell":"rm -rf /"}`,
		`{"kind":"docker","version":1,"version":2}`,
		`{"Kind":"docker","version":1,"docker":{"containers":[]}}`,
		`{"kind":"future","version":2,"opaque":{"duplicate":1,"duplicate":2}}`,
	} {
		var runtime RuntimeSpec
		if err := json.Unmarshal([]byte(raw), &runtime); err == nil {
			t.Fatalf("ambiguous runtime accepted: %s", raw)
		}
	}
}

func TestRuntimeCapabilitiesAreExactAndExplicit(t *testing.T) {
	for _, change := range []func(*Container){
		func(c *Container) { c.User = "root" }, func(c *Container) { c.User = "0000" }, func(c *Container) { c.User = "1000:0000" }, func(c *Container) { c.HostNetwork = true },
		func(c *Container) { c.Mounts = []Mount{{HostPath: "/etc", Target: "/read-only", ReadOnly: true}} }, func(c *Container) { c.Devices = []string{"/dev/net/tun"} },
	} {
		app := validCatalog().Apps[0]
		change(&app.Runtime.Docker.Containers[0])
		if err := ValidateApp(app); err == nil {
			t.Fatal("dangerous operation lacked required capability")
		}
	}
	app := validCatalog().Apps[0]
	app.Runtime.RequiredCapabilities = []string{"root"}
	app.Runtime.Docker.Containers[0].User = "0:0"
	if err := ValidateAuthorizedCapabilities(app, []string{"root"}); err != nil {
		t.Fatal(err)
	}
	for _, grants := range [][]string{nil, {"root", "root"}, {"root", "host-path"}} {
		if err := ValidateAuthorizedCapabilities(app, grants); err == nil {
			t.Fatalf("inexact capabilities accepted: %v", grants)
		}
	}
}

func TestRuntimeRejectsUnsafePathsSecretsAndCycles(t *testing.T) {
	for _, change := range []func(*AppManifest){
		func(a *AppManifest) { a.Runtime.Docker.Containers[0].Arguments = []Value{{Secret: "tunnel_token"}} },
		func(a *AppManifest) {
			a.Runtime.Docker.Containers[0].Arguments = []Value{{Object: map[string]Value{"secret": {Secret: "tunnel_token"}}}}
		},
		func(a *AppManifest) {
			a.Runtime.Docker.Containers[0].Environment = map[string]Value{"INJECT\nKEY": literal(`"x"`)}
		},
		func(a *AppManifest) {
			a.Runtime.Docker.Containers[0].ConfigFiles = []ConfigFile{{Path: "/etc/../bad", Format: "env", Values: map[string]Value{}}}
		},
		func(a *AppManifest) {
			a.Runtime.Docker.Containers[0].Environment = map[string]Value{"PATH": {Runtime: &RuntimeValue{Kind: "state-directory", Name: "missing"}}}
		},
		func(a *AppManifest) {
			a.Runtime.Docker.Containers[0].Environment = map[string]Value{"PATH": {Runtime: &RuntimeValue{Kind: "private-address", Path: "../escape"}}}
		},
		func(a *AppManifest) {
			a.Runtime.Docker.Containers = append(a.Runtime.Docker.Containers, Container{Name: "sidecar", Image: "api", DependsOn: []string{"main"}})
			a.Runtime.Docker.Containers[0].DependsOn = []string{"sidecar"}
		},
	} {
		app := validCatalog().Apps[0]
		change(&app)
		if err := ValidateApp(app); err == nil {
			t.Fatal("unsafe runtime accepted")
		}
	}
}

func TestStructuredConfigurationRendersWithoutTemplates(t *testing.T) {
	file := ConfigFile{Path: "/config.json", Format: "json", Values: map[string]Value{
		"remote-management": {Object: map[string]Value{"secret-key": {Secret: "token"}, "allow-remote": literal(`true`)}},
		"empty-array":       {Array: []Value{}}, "empty-object": {Object: map[string]Value{}},
		"port": literal(`8080`), "state": {Runtime: &RuntimeValue{Kind: "state-directory", Name: "data", Path: "credentials.json"}},
	}}
	context := map[string]string{"state-directory:data": "/srv/app"}
	raw, err := RenderConfigFile(file, nil, map[string]string{"token": "$(touch /tmp/never-executed)\""}, context)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["state"] != "/srv/app/credentials.json" || decoded["port"] != float64(8080) || len(decoded["empty-array"].([]any)) != 0 {
		t.Fatalf("wrong rendered config: %s", raw)
	}
	for _, value := range []Value{{Array: []Value{}}, {Object: map[string]Value{}}} {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if string(raw) == "{}" {
			t.Fatal("empty structured value erased")
		}
	}
	file.Format = "yaml"
	if _, err := RenderConfigFile(file, nil, map[string]string{"token": "${DO_NOT_INTERPOLATE}"}, context); err != nil {
		t.Fatal(err)
	}
	file = ConfigFile{Format: "env", Values: map[string]Value{"TOKEN": {Secret: "token"}}}
	for _, secret := range []string{"x\nOTHER=injected", "x'"} {
		if _, err := RenderConfigFile(file, nil, map[string]string{"token": secret}); err == nil {
			t.Fatal("multiline env injection accepted")
		}
	}
	if _, err := ResolveString(literal(`{"not":"scalar"}`), nil, nil); err == nil {
		t.Fatal("composite argv accepted")
	}
}

func TestManifestRecipeRevisionAndLegacyHistory(t *testing.T) {
	app := validCatalog().Apps[0]
	legacy := OfficialManifestHistory{app.ID: {app.Version: strings.Repeat("b", 64)}}
	imported, err := ImportLegacyManifestHistory(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if imported[app.ID][PackageHistoryKey(app.Version, 0)] != strings.Repeat("b", 64) || legacy[app.ID][app.Version] == "" {
		t.Fatal("legacy digest changed or input mutated")
	}
	value := validCatalog()
	first, err := ExtendOfficialManifestHistory(imported, value)
	if err != nil {
		t.Fatal(err)
	}
	value.Apps[0].Description.English = "recipe changed"
	if _, err := ExtendOfficialManifestHistory(first, value); err == nil {
		t.Fatal("immutable published revision changed")
	}
	value.Apps[0].PackageRevision++
	next, err := ExtendOfficialManifestHistory(first, value)
	if err != nil {
		t.Fatal(err)
	}
	if len(next[app.ID]) != 3 {
		t.Fatal("historical revisions were lost")
	}
	value.Apps[0].PackageRevision = 0
	if err := ValidateCatalog(value); err == nil {
		t.Fatal("legacy recipe was executable")
	}
}

func TestCanonicalEmptyConfigRemainsExecutableSchema(t *testing.T) {
	value := validCatalog()
	value.Apps[0].Config = []ConfigField{}
	canonical, err := CanonicalAppManifest(value.Apps[0])
	if err != nil {
		t.Fatal(err)
	}
	value.Apps[0] = canonical
	raw, err := MarshalCatalog(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseCatalog(raw); err != nil {
		t.Fatal("canonical empty config became invalid null", err)
	}
}

func TestRootFilesRemainIndependent(t *testing.T) {
	if _, err := os.Stat("trust/1.root.json"); err != nil {
		t.Fatal(err)
	}
}
