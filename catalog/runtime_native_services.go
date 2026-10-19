package catalog

import (
	"errors"
	"sort"
	"strings"
)

// validateNativeServices reuses the single-process security validation rather
// than introducing a second interpretation of executable/config/secret values.
func validateNativeServices(app AppManifest, caps map[string]bool) error {
	r := app.Runtime
	b := r.NativeServices
	if r.Kind != "systemd" || r.Systemd != nil || r.Docker != nil || b == nil {
		return errors.New("catalog: systemd version 2 requires only nativeServices")
	}
	if !caps["native-services"] {
		return errors.New("catalog: native services require native-services capability")
	}
	if b.Namespace != "" && !runtimeName.MatchString(b.Namespace) {
		return errors.New("catalog: invalid native service namespace")
	}
	if len(b.Services) < 1 || len(b.Services) > 16 || b.Users == nil || len(b.Users) > 16 {
		return errors.New("catalog: native services exceed resource bounds")
	}
	users := map[string]bool{}
	for _, user := range b.Users {
		if !runtimeName.MatchString(user) || user == "root" || users[user] {
			return errors.New("catalog: invalid or duplicate managed user")
		}
		users[user] = true
	}
	usedUsers := map[string]bool{}
	names := map[string]bool{}
	stateOwners := map[string]string{}
	storage := map[string]bool{}
	for _, s := range r.Storage {
		storage[s.Name] = true
	}
	for _, service := range b.Services {
		if !runtimeName.MatchString(service.Name) || names[service.Name] {
			return errors.New("catalog: invalid or duplicate native service name")
		}
		names[service.Name] = true
		if service.Start != "automatic" && service.Start != "manual" {
			return errors.New("catalog: explicit automatic or manual start is required")
		}
		process := service.Process
		owner := service.ManagedUser
		if owner != "" {
			if !users[owner] || process.User != "" {
				return errors.New("catalog: managed user must be declared and cannot select a host user")
			}
			usedUsers[owner] = true
		} else if process.User != "root" {
			return errors.New("catalog: native service requires a managed user or explicitly authorized root")
		} else {
			owner = "root"
		}
		for _, state := range process.StateDirectories {
			if prior, exists := stateOwners[state]; exists && prior != owner {
				return errors.New("catalog: state directory cannot have multiple owners")
			}
			stateOwners[state] = owner
		}
		seenWrite := map[string]bool{}
		for _, state := range service.WritableState {
			if !storage[state] || seenWrite[state] {
				return errors.New("catalog: invalid or duplicate writable state reference")
			}
			seenWrite[state] = true
			for _, owned := range process.StateDirectories {
				if owned == state {
					return errors.New("catalog: owned state is already writable")
				}
			}
		}
		if len(service.StateCredentials) > 16 {
			return errors.New("catalog: too many state credentials")
		}
		for name, source := range service.StateCredentials {
			_, collision := process.Credentials[name]
			if !runtimeName.MatchString(name) || strings.HasPrefix(name, "config-") || collision || !storage[source.Storage] || !safeRelative(source.Path) || strings.ContainsAny(source.Path, ":%") {
				return errors.New("catalog: invalid state credential reference")
			}
		}
		if err := validateSystemdProcess(app, &process, caps, storage, service.WritableState, service.StateCredentials); err != nil {
			return err
		}
	}
	for _, service := range b.Services {
		for _, source := range service.StateCredentials {
			if stateOwners[source.Storage] != "root" {
				return errors.New("catalog: state credential source requires root ownership")
			}
			for _, writer := range b.Services {
				for _, state := range writer.WritableState {
					if state == source.Storage && (writer.ManagedUser != "" || writer.Process.User != "root") {
						return errors.New("catalog: state credential source cannot be writable by non-root services")
					}
				}
			}
		}
		for _, state := range service.WritableState {
			if _, exists := stateOwners[state]; !exists {
				return errors.New("catalog: writable state must have a declared owner")
			}
		}
	}
	if len(usedUsers) != len(users) {
		return errors.New("catalog: unused managed user declaration")
	}
	for _, service := range b.Services {
		if _, err := nativeArtifactFiles(r, service.Process.Artifact); err != nil {
			return err
		}
	}
	return nil
}

// NativeArtifactFiles returns the complete signed extraction allowlist for one
// artifact, including files used by multiple services. It never downloads or
// executes the artifact. A package cannot reinterpret a shared file's mode.
func NativeArtifactFiles(app AppManifest, artifactName string) ([]ArtifactFile, error) {
	if err := ValidateRuntime(app); err != nil {
		return nil, err
	}
	return nativeArtifactFiles(app.Runtime, artifactName)
}

func nativeArtifactFiles(r *RuntimeSpec, artifactName string) ([]ArtifactFile, error) {
	if r == nil || r.Kind != "systemd" || !knownRuntimeVersion(r.Kind, r.Version) {
		return nil, errors.New("catalog: artifact files require supported systemd runtime")
	}
	var processes []SystemdRuntime
	if r.Version == 1 && r.Systemd != nil {
		processes = append(processes, *r.Systemd)
	} else if r.Version == 2 && r.NativeServices != nil {
		for _, service := range r.NativeServices.Services {
			processes = append(processes, service.Process)
		}
	}
	files := map[string]ArtifactFile{}
	for _, process := range processes {
		if process.Artifact != artifactName {
			continue
		}
		for _, file := range process.Files {
			if previous, exists := files[file.Path]; exists && previous != file {
				return nil, errors.New("catalog: conflicting shared artifact file declaration")
			}
			files[file.Path] = file
		}
	}
	if len(files) == 0 {
		return nil, errors.New("catalog: native artifact is not referenced")
	}
	result := make([]ArtifactFile, 0, len(files))
	for _, file := range files {
		result = append(result, file)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Path < result[j].Path })
	if err := validateArtifactFiles(result); err != nil {
		return nil, err
	}
	return result, nil
}
