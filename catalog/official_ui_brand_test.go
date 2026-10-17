package catalog

import "testing"

func TestOfficialUIBrandPreservesReleasedTargets(t *testing.T) {
	for _, item := range []struct{ version, name string }{
		{"0.1.0-alpha.20", "ui-meridian-0.1.0-alpha.20.js"},
		{"0.1.0-alpha.21", "ui-meridian-0.1.0-alpha.21.js"},
		{"0.1.0-alpha.22", "ui-glivela-0.1.0-alpha.22.js"},
		{"0.1.0-beta.1", "ui-glivela-0.1.0-beta.1.js"},
		{"1.2.3", "ui-glivela-1.2.3.js"},
	} {
		name, err := OfficialUITargetName("meridian", item.version)
		if err != nil || name != item.name {
			t.Fatalf("version %s: got %s, %v", item.version, name, err)
		}
	}
}
