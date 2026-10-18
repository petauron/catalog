package catalog

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func nativeServicesFixture() AppManifest {
	a := validCatalog().Apps[0]
	a.Artifacts = []Artifact{{Name: "bundle"}}
	a.Runtime = &RuntimeSpec{Kind: "systemd", Version: 2,
		RequiredCapabilities: []string{"native-services", "root"},
		Storage:              []Storage{{Name: "data", Persistent: true}},
		NativeServices: &NativeServicesRuntime{Users: []string{"worker"}, Services: []NativeService{
			{Name: "controller", Start: "automatic", Process: SystemdRuntime{Artifact: "bundle", Executable: "controller", Files: []ArtifactFile{{Path: "controller", Executable: true}}, User: "root"}},
			{Name: "worker", Start: "manual", ManagedUser: "worker", Process: SystemdRuntime{Artifact: "bundle", Executable: "worker", Files: []ArtifactFile{{Path: "worker", Executable: true}}, StateDirectories: []string{"data"}}},
		}},
	}
	return a
}

func TestNativeServicesContract(t *testing.T) {
	a := nativeServicesFixture()
	if err := ValidateRuntime(a); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(a.Runtime)
	if err != nil {
		t.Fatal(err)
	}
	var parsed RuntimeSpec
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		strings.Replace(string(raw), `"start":"manual"`, `"start":"manual","execStartPre":"arbitrary"`, 1),
		strings.Replace(string(raw), `"executable":"worker"`, `"executable":"worker","shell":"arbitrary"`, 1),
	} {
		var rejected RuntimeSpec
		if err := json.Unmarshal([]byte(bad), &rejected); err == nil {
			t.Fatal("undeclared execution field accepted")
		}
	}
	a.Runtime = &parsed
	if err := ValidateRuntime(a); err != nil {
		t.Fatal(err)
	}
	if CheckRuntimeSupport(a, ExecutorSupport{Versions: map[string]int{"systemd": 1}, Capabilities: a.Runtime.RequiredCapabilities}).Supported {
		t.Fatal("old executor accepted native services")
	}
	if CheckRuntimeSupport(a, ExecutorSupport{Versions: map[string]int{"systemd": 2}}).Supported {
		t.Fatal("executor missing capabilities accepted native services")
	}
}

func TestNativeServicesRejectUnsafeDeclarations(t *testing.T) {
	for name, change := range map[string]func(*RuntimeSpec){
		"missing capability":    func(r *RuntimeSpec) { r.RequiredCapabilities = []string{"root"} },
		"unauthorized root":     func(r *RuntimeSpec) { r.RequiredCapabilities = []string{"native-services"} },
		"old version":           func(r *RuntimeSpec) { r.Version = 1 },
		"mixed specifications":  func(r *RuntimeSpec) { r.Systemd = &SystemdRuntime{} },
		"duplicate service":     func(r *RuntimeSpec) { r.NativeServices.Services[1].Name = "controller" },
		"host unit path":        func(r *RuntimeSpec) { r.NativeServices.Services[1].Name = "../sshd.service" },
		"implicit start":        func(r *RuntimeSpec) { r.NativeServices.Services[1].Start = "" },
		"undeclared user":       func(r *RuntimeSpec) { r.NativeServices.Services[1].ManagedUser = "missing" },
		"host user":             func(r *RuntimeSpec) { r.NativeServices.Services[1].Process.User = "daemon" },
		"unused user":           func(r *RuntimeSpec) { r.NativeServices.Users = append(r.NativeServices.Users, "unused") },
		"root user label":       func(r *RuntimeSpec) { r.NativeServices.Users[0] = "root" },
		"conflicting ownership": func(r *RuntimeSpec) { r.NativeServices.Services[0].Process.StateDirectories = []string{"data"} },
		"undeclared executable": func(r *RuntimeSpec) { r.NativeServices.Services[1].Process.Executable = "unknown" },
		"undeclared storage":    func(r *RuntimeSpec) { r.NativeServices.Services[1].Process.StateDirectories = []string{"unknown"} },
	} {
		t.Run(name, func(t *testing.T) {
			a := nativeServicesFixture()
			change(a.Runtime)
			if err := ValidateRuntime(a); err == nil {
				t.Fatal("unsafe declaration accepted")
			}
		})
	}
}

func TestNativeArtifactFilesUnion(t *testing.T) {
	a := nativeServicesFixture()
	want := []ArtifactFile{{Path: "controller", Executable: true}, {Path: "worker", Executable: true}}
	got, err := NativeArtifactFiles(a, "bundle")
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("union = %v, %v", got, err)
	}
	a.Runtime.NativeServices.Services[1].Process.Files = append(a.Runtime.NativeServices.Services[1].Process.Files, want[0])
	got, err = NativeArtifactFiles(a, "bundle")
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("deduplicated union = %v, %v", got, err)
	}
	a.Runtime.NativeServices.Services[1].Process.Files[1].Executable = false
	if err := ValidateRuntime(a); err == nil {
		t.Fatal("shared executable mode conflict accepted")
	}
	a = nativeServicesFixture()
	if _, err := NativeArtifactFiles(a, "missing"); err == nil {
		t.Fatal("unreferenced artifact accepted")
	}
	a.Runtime.Version = 9
	if _, err := NativeArtifactFiles(a, "bundle"); err == nil {
		t.Fatal("future contract became executable")
	}
	a = nativeServicesFixture()
	process := a.Runtime.NativeServices.Services[0].Process
	a.Runtime = &RuntimeSpec{Kind: "systemd", Version: 1, RequiredCapabilities: []string{"root"}, Systemd: &process}
	got, err = NativeArtifactFiles(a, "bundle")
	if err != nil || !reflect.DeepEqual(got, want[:1]) {
		t.Fatalf("v1 extraction changed: %v, %v", got, err)
	}
}
