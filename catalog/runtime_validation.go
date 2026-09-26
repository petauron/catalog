package catalog

import (
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var environmentName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
var runtimeName = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{0,62}$`)
var userName = regexp.MustCompile(`^(?:[a-z_][a-z0-9_-]{0,31}|[0-9]{1,10})(?::(?:[a-z_][a-z0-9_-]{0,31}|[0-9]{1,10}))?$`)

// UnmarshalJSON keeps a future runtime opaque without relaxing known versions.
// Every nested object still receives the duplicate-property/depth checks.
func (r *RuntimeSpec) UnmarshalJSON(raw []byte) error {
	var object map[string]json.RawMessage
	if err := decodeStrictJSON(raw, &object); err != nil {
		return err
	}
	var kind string
	var version int
	if err := json.Unmarshal(object["kind"], &kind); err != nil {
		return errors.New("runtime kind is required")
	}
	if err := json.Unmarshal(object["version"], &version); err != nil {
		return errors.New("runtime version is required")
	}
	if (kind != "docker" && kind != "systemd") || version != 1 {
		*r = RuntimeSpec{Kind: kind, Version: version, Unsupported: append(json.RawMessage(nil), raw...)}
		if value := object["requiredCapabilities"]; value != nil {
			if err := json.Unmarshal(value, &r.RequiredCapabilities); err != nil {
				return err
			}
		}
		return nil
	}
	type knownRuntime RuntimeSpec
	var known knownRuntime
	if err := decodeStrictJSON(raw, &known); err != nil {
		return err
	}
	if err := validateRequiredRuntimeJSON(object); err != nil {
		return err
	}
	*r = RuntimeSpec(known)
	return nil
}

func validateRequiredRuntimeJSON(object map[string]json.RawMessage) error {
	var storage []map[string]json.RawMessage
	if raw, exists := object["storage"]; exists {
		if err := json.Unmarshal(raw, &storage); err != nil {
			return err
		}
		for _, item := range storage {
			if _, exists := item["persistent"]; !exists {
				return errors.New("catalog: storage must explicitly declare persistent")
			}
		}
	}
	var processes []map[string]json.RawMessage
	if raw, exists := object["docker"]; exists {
		var docker struct {
			Containers []map[string]json.RawMessage `json:"containers"`
		}
		if err := json.Unmarshal(raw, &docker); err != nil {
			return err
		}
		processes = append(processes, docker.Containers...)
	}
	if raw, exists := object["systemd"]; exists {
		var native map[string]json.RawMessage
		if err := json.Unmarshal(raw, &native); err != nil {
			return err
		}
		processes = append(processes, native)
	}
	for _, process := range processes {
		if raw, exists := process["configFiles"]; exists {
			var files []map[string]json.RawMessage
			if err := json.Unmarshal(raw, &files); err != nil {
				return err
			}
			for _, file := range files {
				if _, exists := file["values"]; !exists {
					return errors.New("catalog: config file values are required")
				}
			}
		}
	}
	return nil
}

func (r RuntimeSpec) MarshalJSON() ([]byte, error) {
	if r.Unsupported != nil {
		var object map[string]json.RawMessage
		if err := decodeStrictJSON(r.Unsupported, &object); err != nil {
			return nil, err
		}
		// Canonicalize opaque nested objects as well, preserving exact numbers.
		var generic any
		decoder := json.NewDecoder(strings.NewReader(string(r.Unsupported)))
		decoder.UseNumber()
		if err := decoder.Decode(&generic); err != nil {
			return nil, err
		}
		return json.Marshal(generic)
	}
	type knownRuntime RuntimeSpec
	return json.Marshal(knownRuntime(r))
}

func ValidateRuntime(app AppManifest) error {
	r := app.Runtime
	if r == nil || !runtimeName.MatchString(r.Kind) || r.Version < 1 || int64(r.Version) > maxPortableInteger {
		return errors.New("catalog: runtime kind and positive version are required")
	}
	caps := map[string]bool{}
	for _, capability := range r.RequiredCapabilities {
		if !runtimeName.MatchString(capability) || caps[capability] {
			return errors.New("catalog: invalid or duplicate runtime capability")
		}
		caps[capability] = true
	}
	if r.Version != 1 || (r.Kind != "docker" && r.Kind != "systemd") {
		return nil
	}
	if r.Unsupported != nil {
		return errors.New("catalog: known runtime cannot carry opaque content")
	}
	storage := map[string]bool{}
	for _, item := range r.Storage {
		if !runtimeName.MatchString(item.Name) || storage[item.Name] {
			return errors.New("catalog: invalid or duplicate storage name")
		}
		storage[item.Name] = true
	}
	if r.Kind == "docker" {
		if r.Docker == nil || r.Systemd != nil || len(r.Docker.Containers) < 1 || len(r.Docker.Containers) > 32 {
			return errors.New("catalog: docker runtime requires 1 to 32 containers")
		}
		names := map[string]bool{}
		for _, container := range r.Docker.Containers {
			if !runtimeName.MatchString(container.Name) || names[container.Name] {
				return errors.New("catalog: invalid or duplicate container name")
			}
			names[container.Name] = true
		}
		for _, container := range r.Docker.Containers {
			found := false
			for _, image := range app.Images {
				if image.Name == container.Image {
					found = true
				}
			}
			if !found {
				return fmt.Errorf("catalog: container %s references unknown image", container.Name)
			}
			if err := validateProcess(app, container.User, container.Command, container.Arguments, container.Environment, container.ConfigFiles, container.Health, container.Limits, caps, true); err != nil {
				return err
			}
			availableState := map[string]bool{}
			for _, mount := range container.Mounts {
				if mount.Storage != "" {
					availableState[mount.Storage] = true
				}
			}
			if err := validateRuntimeReferences(app, container.Command, container.Arguments, container.Environment, container.ConfigFiles, container.Credentials, availableState); err != nil {
				return err
			}
			for name, key := range container.Credentials {
				if !runtimeName.MatchString(name) {
					return errors.New("catalog: invalid credential name")
				}
				if err := validateValue(Value{Secret: key}, app.Config, true); err != nil {
					return err
				}
			}
			if container.HostNetwork && !caps["host-network"] {
				return errors.New("catalog: host networking requires host-network capability")
			}
			for _, device := range container.Devices {
				if !caps["devices"] || !safeAbsolute(device) || !strings.HasPrefix(device, "/dev/") {
					return errors.New("catalog: devices require explicit devices capability and /dev paths")
				}
			}
			mountTargets := map[string]bool{}
			for _, mount := range container.Mounts {
				if !safeAbsolute(mount.Target) || mountTargets[mount.Target] || (mount.Storage == "") == (mount.HostPath == "") {
					return errors.New("catalog: invalid or duplicate mount target")
				}
				mountTargets[mount.Target] = true
				if mount.Storage != "" && !storage[mount.Storage] {
					return errors.New("catalog: mount references undeclared storage")
				}
				if mount.HostPath != "" && (!safeAbsolute(mount.HostPath) || !caps["host-path"]) {
					return errors.New("catalog: host mounts require explicit host-path capability")
				}
			}
			seenPorts := map[string]bool{}
			for _, port := range container.Ports {
				if !hasService(app, port.Service) || seenPorts[port.Service] || port.Protocol != "" && port.Protocol != "tcp" {
					return errors.New("catalog: invalid or duplicate service port reference")
				}
				seenPorts[port.Service] = true
			}
			deps := map[string]bool{}
			for _, dependency := range container.DependsOn {
				if dependency == container.Name || !names[dependency] || deps[dependency] {
					return errors.New("catalog: invalid container dependency")
				}
				deps[dependency] = true
			}
		}
		_, err := ContainerStartOrder(r.Docker.Containers)
		return err
	}
	if r.Systemd == nil || r.Docker != nil {
		return errors.New("catalog: systemd runtime requires only systemd specification")
	}
	s := r.Systemd
	artifactFound := false
	for _, artifact := range app.Artifacts {
		if artifact.Name == s.Artifact {
			artifactFound = true
		}
	}
	if !artifactFound {
		return errors.New("catalog: systemd runtime references unknown artifact")
	}
	if err := validateArtifactFiles(s.Files); err != nil {
		return err
	}
	entryFound := false
	for _, file := range s.Files {
		if file.Path == s.Executable && file.Executable {
			entryFound = true
		}
	}
	if !entryFound {
		return errors.New("catalog: executable must reference an explicitly executable artifact file")
	}
	if err := validateProcess(app, s.User, nil, s.Arguments, s.Environment, s.ConfigFiles, s.Health, s.Limits, caps, false); err != nil {
		return err
	}
	availableState := map[string]bool{}
	for _, directory := range s.StateDirectories {
		availableState[directory] = true
	}
	if err := validateRuntimeReferences(app, nil, s.Arguments, s.Environment, s.ConfigFiles, s.Credentials, availableState); err != nil {
		return err
	}
	seenState := map[string]bool{}
	for _, directory := range s.StateDirectories {
		if !storage[directory] || seenState[directory] {
			return errors.New("catalog: state directory references unknown or duplicate storage")
		}
		seenState[directory] = true
	}
	for name, key := range s.Credentials {
		if !runtimeName.MatchString(name) {
			return errors.New("catalog: invalid credential name")
		}
		if err := validateValue(Value{Secret: key}, app.Config, true); err != nil {
			return err
		}
	}
	return nil
}

func validateProcess(app AppManifest, user string, command, arguments []Value, environment map[string]Value, files []ConfigFile, health *HealthCheck, limits *ResourceLimits, capabilities map[string]bool, docker bool) error {
	if user != "" && !userName.MatchString(user) {
		return errors.New("catalog: invalid process user")
	}
	parts := strings.Split(user, ":")
	for _, part := range parts {
		numeric, numericErr := strconv.ParseUint(part, 10, 32)
		if (part == "root" || numericErr == nil && numeric == 0) && !capabilities["root"] {
			return errors.New("catalog: root process requires root capability")
		}
	}
	if len(command)+len(arguments) > 256 || len(environment) > 256 || len(files) > 128 {
		return errors.New("catalog: process specification exceeds bounds")
	}
	for _, value := range append(append([]Value{}, command...), arguments...) {
		if err := validateValue(value, app.Config, false); err != nil {
			return err
		}
		if err := validateScalarValue(value); err != nil {
			return err
		}
	}
	for name, value := range environment {
		if !environmentName.MatchString(name) {
			return errors.New("catalog: invalid environment variable name")
		}
		if err := validateValue(value, app.Config, true); err != nil {
			return err
		}
		if err := validateScalarValue(value); err != nil {
			return err
		}
	}
	paths := map[string]bool{}
	for _, file := range files {
		validPath := safeRelative(file.Path)
		if docker {
			validPath = safeAbsolute(file.Path)
		}
		if !validPath || paths[file.Path] || file.Format != "json" && file.Format != "yaml" && file.Format != "env" {
			return errors.New("catalog: invalid or duplicate config file")
		}
		paths[file.Path] = true
		for key, value := range file.Values {
			if key == "" || file.Format == "env" && !environmentName.MatchString(key) {
				return errors.New("catalog: invalid config file key")
			}
			if err := validateValue(value, app.Config, true); err != nil {
				return err
			}
		}
	}
	if health != nil {
		if !hasService(app, health.Service) || health.TimeoutSeconds < 0 || health.TimeoutSeconds > 120 || health.Path != "" && ((health.Path != "/" && !safeAbsolute(health.Path)) || strings.ContainsAny(health.Path, "?#")) {
			return errors.New("catalog: invalid health check")
		}
	}
	if limits != nil && (limits.MemoryBytes < 0 || limits.CPUMillis < 0 || limits.Pids < 0 || limits.MemoryBytes > maxPortableInteger || limits.CPUMillis > maxPortableInteger || limits.Pids > maxPortableInteger) {
		return errors.New("catalog: invalid resource limits")
	}
	return nil
}

func validateValue(value Value, fields []ConfigField, allowSecret bool) error {
	return validateNestedValue(value, fields, allowSecret, 0)
}

func validateNestedValue(value Value, fields []ConfigField, allowSecret bool, depth int) error {
	if depth > 32 {
		return errors.New("catalog: nested value exceeds depth bound")
	}
	count := 0
	if value.Literal != nil {
		count++
		var decoded any
		if len(*value.Literal) > 65536 {
			return errors.New("catalog: literal exceeds bound")
		}
		if err := decodeStrictJSON(*value.Literal, &decoded); err != nil {
			return err
		}
		if err := rejectJSONNull("literal", decoded); err != nil {
			return err
		}
	}
	if value.Config != "" {
		count++
	}
	if value.Secret != "" {
		count++
	}
	if value.Runtime != nil {
		count++
		r := value.Runtime
		if r.Path != "" && (r.Kind != "state-directory" || !safeRelative(r.Path)) {
			return errors.New("catalog: runtime suffix must be a safe relative state path")
		}
		switch r.Kind {
		case "private-address":
			if r.Name != "" {
				return errors.New("catalog: private-address cannot specify a name")
			}
		case "service-address", "state-directory", "credential-file":
			if !runtimeName.MatchString(r.Name) {
				return errors.New("catalog: invalid named runtime value")
			}
		case "config-file":
			if !safeRelative(r.Name) && !safeAbsolute(r.Name) {
				return errors.New("catalog: invalid config file reference")
			}
		default:
			return errors.New("catalog: unknown runtime value kind")
		}
	}
	if value.Object != nil {
		count++
		for key, child := range value.Object {
			if key == "" {
				return errors.New("catalog: empty object key")
			}
			if err := validateNestedValue(child, fields, allowSecret, depth+1); err != nil {
				return err
			}
		}
	}
	if value.Array != nil {
		count++
		for _, child := range value.Array {
			if err := validateNestedValue(child, fields, allowSecret, depth+1); err != nil {
				return err
			}
		}
	}
	if count != 1 {
		return errors.New("catalog: value requires exactly one source")
	}
	if value.Secret != "" && !allowSecret {
		return errors.New("catalog: secrets must not be passed in process arguments or environment")
	}
	key := value.Config
	if value.Secret != "" {
		key = value.Secret
	}
	if key != "" {
		for _, field := range fields {
			if field.Key == key {
				if field.Secret != (value.Secret != "") {
					return errors.New("catalog: config/secret source classification mismatch")
				}
				return nil
			}
		}
		return fmt.Errorf("catalog: unknown value source %q", key)
	}
	return nil
}

func safeRelative(value string) bool {
	return value != "" && value != "." && !strings.ContainsAny(value, "\\\x00\r\n") && !strings.HasPrefix(value, "/") && path.Clean(value) == value && value != ".." && !strings.HasPrefix(value, "../")
}
func safeAbsolute(value string) bool {
	return value != "/" && strings.HasPrefix(value, "/") && path.Clean(value) == value && !strings.ContainsAny(value, "\\\x00\r\n")
}
func hasService(app AppManifest, name string) bool {
	for _, service := range app.Services {
		if service.Name == name {
			return true
		}
	}
	return false
}

func CheckRuntimeSupport(app AppManifest, available ExecutorSupport) SupportResult {
	result := SupportResult{Supported: true}
	if app.Runtime == nil {
		return SupportResult{Reasons: []string{"runtime specification is missing"}}
	}
	r := app.Runtime
	if r.Version != 1 || (r.Kind != "docker" && r.Kind != "systemd") || available.Versions[r.Kind] != r.Version {
		result.Reasons = append(result.Reasons, fmt.Sprintf("runtime %s version %d is unsupported", r.Kind, r.Version))
	}
	for _, required := range r.RequiredCapabilities {
		found := false
		for _, capability := range available.Capabilities {
			if required == capability {
				found = true
			}
		}
		if !found {
			result.Reasons = append(result.Reasons, "unsupported capability: "+required)
		}
	}
	result.Supported = len(result.Reasons) == 0
	return result
}

// ValidateAuthorizedCapabilities is checked again at execution, not only in UI.
func ValidateAuthorizedCapabilities(app AppManifest, granted []string) error {
	if err := ValidateApp(app); err != nil {
		return err
	}
	approved := map[string]bool{}
	for _, capability := range granted {
		if !runtimeName.MatchString(capability) || approved[capability] {
			return errors.New("catalog: invalid or duplicate capability authorization")
		}
		approved[capability] = true
	}
	for _, required := range app.Runtime.RequiredCapabilities {
		if !approved[required] {
			return fmt.Errorf("catalog: capability %s requires explicit authorization", required)
		}
		delete(approved, required)
	}
	if len(approved) != 0 {
		return errors.New("catalog: extra capability authorizations are forbidden")
	}
	return nil
}

// ContainerStartOrder returns a deterministic topological order or rejects cycles.
func ContainerStartOrder(containers []Container) ([]Container, error) {
	remaining := map[string]Container{}
	for _, item := range containers {
		remaining[item.Name] = item
	}
	var result []Container
	for len(remaining) > 0 {
		var ready []string
		for name, item := range remaining {
			blocked := false
			for _, dependency := range item.DependsOn {
				if _, exists := remaining[dependency]; exists {
					blocked = true
				}
			}
			if !blocked {
				ready = append(ready, name)
			}
		}
		if len(ready) == 0 {
			return nil, errors.New("catalog: cyclic container dependencies")
		}
		sort.Strings(ready)
		for _, name := range ready {
			result = append(result, remaining[name])
			delete(remaining, name)
		}
	}
	return result, nil
}
