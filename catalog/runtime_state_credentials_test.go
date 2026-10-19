package catalog

import "testing"

func TestNativeStateCredentialScope(t *testing.T) {
	for _, failure := range []string{"", "storage", "parent", "absolute", "specifier", "owner", "writer", "name", "collision"} {
		t.Run(failure, func(t *testing.T) {
			a := nativeServicesFixture()
			worker := &a.Runtime.NativeServices.Services[1]
			worker.Process.StateDirectories = nil
			a.Runtime.NativeServices.Services[0].Process.StateDirectories = []string{"data"}
			source := StateCredential{Storage: "data", Path: "config.json"}
			name := "runtime"
			switch failure {
			case "storage":
				source.Storage = "foreign"
			case "parent":
				source.Path = "../secret"
			case "absolute":
				source.Path = "/etc/shadow"
			case "specifier":
				source.Path = "%d/secret"
			case "owner":
				a.Runtime.NativeServices.Services[0].Process.StateDirectories = nil
			case "writer":
				worker.WritableState = []string{"data"}
			case "name":
				name = "config-private"
			case "collision":
				worker.Process.Credentials = map[string]string{"runtime": "secret"}
			}
			worker.StateCredentials = map[string]StateCredential{name: source}
			worker.Process.Arguments = []Value{{Runtime: &RuntimeValue{Kind: "credential-file", Name: name}}}
			err := ValidateRuntime(a)
			if failure == "" && err != nil {
				t.Fatal(err)
			}
			if failure != "" && err == nil {
				t.Fatal("unsafe state credential accepted")
			}
		})
	}
}
