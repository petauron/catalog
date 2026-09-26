package catalog

import "encoding/json"

// RuntimeSpec is a versioned, declarative execution contract. Unknown kinds and
// versions remain readable catalog entries, but never become executable.
type RuntimeSpec struct {
	Kind                 string          `json:"kind"`
	Version              int             `json:"version"`
	RequiredCapabilities []string        `json:"requiredCapabilities,omitempty"`
	Storage              []Storage       `json:"storage,omitempty"`
	Docker               *DockerRuntime  `json:"docker,omitempty"`
	Systemd              *SystemdRuntime `json:"systemd,omitempty"`
	// Unsupported preserves future runtime specifications in signed identities.
	Unsupported json.RawMessage `json:"-"`
}

type Value struct {
	Literal *json.RawMessage `json:"literal,omitempty"`
	Config  string           `json:"config,omitempty"`
	Secret  string           `json:"secret,omitempty"`
	Runtime *RuntimeValue    `json:"runtime,omitempty"`
	Object  map[string]Value `json:"object,omitempty"`
	Array   []Value          `json:"array,omitempty"`
}

type RuntimeValue struct {
	Kind string `json:"kind"`
	Name string `json:"name,omitempty"`
	Path string `json:"path,omitempty"`
}

// MarshalJSON preserves intentionally empty objects/arrays while omitting absent
// sources. omitempty alone would erase an empty structured configuration value.
func (v Value) MarshalJSON() ([]byte, error) {
	object := map[string]any{}
	if v.Literal != nil {
		object["literal"] = v.Literal
	}
	if v.Config != "" {
		object["config"] = v.Config
	}
	if v.Secret != "" {
		object["secret"] = v.Secret
	}
	if v.Runtime != nil {
		object["runtime"] = v.Runtime
	}
	if v.Object != nil {
		object["object"] = v.Object
	}
	if v.Array != nil {
		object["array"] = v.Array
	}
	return json.Marshal(object)
}

type Storage struct {
	Name       string `json:"name"`
	Persistent bool   `json:"persistent"`
}

type DockerRuntime struct {
	Containers []Container `json:"containers"`
}

type Container struct {
	Name        string            `json:"name"`
	Image       string            `json:"image"`
	Command     []Value           `json:"command,omitempty"`
	Arguments   []Value           `json:"arguments,omitempty"`
	Environment map[string]Value  `json:"environment,omitempty"`
	Credentials map[string]string `json:"credentials,omitempty"`
	ConfigFiles []ConfigFile      `json:"configFiles,omitempty"`
	Mounts      []Mount           `json:"mounts,omitempty"`
	Ports       []Port            `json:"ports,omitempty"`
	User        string            `json:"user,omitempty"`
	HostNetwork bool              `json:"hostNetwork,omitempty"`
	Devices     []string          `json:"devices,omitempty"`
	DependsOn   []string          `json:"dependsOn,omitempty"`
	Health      *HealthCheck      `json:"health,omitempty"`
	Limits      *ResourceLimits   `json:"limits,omitempty"`
}

type ConfigFile struct {
	Path   string           `json:"path"`
	Format string           `json:"format"`
	Values map[string]Value `json:"values"`
}

type Mount struct {
	Storage  string `json:"storage,omitempty"`
	HostPath string `json:"hostPath,omitempty"`
	Target   string `json:"target"`
	ReadOnly bool   `json:"readOnly,omitempty"`
}

type Port struct {
	Service  string `json:"service"`
	Protocol string `json:"protocol,omitempty"`
}

// HealthCheck never contains an executable command or a caller-provided host.
type HealthCheck struct {
	Service        string `json:"service"`
	Path           string `json:"path,omitempty"`
	TimeoutSeconds int    `json:"timeoutSeconds,omitempty"`
}

type ResourceLimits struct {
	MemoryBytes int64 `json:"memoryBytes,omitempty"`
	CPUMillis   int64 `json:"cpuMillis,omitempty"`
	Pids        int64 `json:"pids,omitempty"`
}

type SystemdRuntime struct {
	Artifact         string            `json:"artifact"`
	Executable       string            `json:"executable"`
	Files            []ArtifactFile    `json:"files"`
	Arguments        []Value           `json:"arguments,omitempty"`
	Environment      map[string]Value  `json:"environment,omitempty"`
	ConfigFiles      []ConfigFile      `json:"configFiles,omitempty"`
	Credentials      map[string]string `json:"credentials,omitempty"`
	StateDirectories []string          `json:"stateDirectories,omitempty"`
	User             string            `json:"user,omitempty"`
	Health           *HealthCheck      `json:"health,omitempty"`
	Limits           *ResourceLimits   `json:"limits,omitempty"`
}

type ArtifactFile struct {
	Path       string `json:"path"`
	Executable bool   `json:"executable,omitempty"`
}

type ExecutorSupport struct {
	Versions     map[string]int `json:"versions"`
	Capabilities []string       `json:"capabilities"`
}

type SupportResult struct {
	Supported bool     `json:"supported"`
	Reasons   []string `json:"reasons,omitempty"`
}
