package catalog

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// ResolveValue resolves already validated declarations, never templates or code.
// Missing values fail closed; a caller applies validated ConfigField defaults.
func ResolveValue(value Value, config map[string]any, secrets map[string]string, runtimeValues ...map[string]string) (any, error) {
	count := 0
	if value.Literal != nil {
		count++
	}
	if value.Config != "" {
		count++
	}
	if value.Secret != "" {
		count++
	}
	if value.Runtime != nil {
		count++
	}
	if value.Object != nil {
		count++
	}
	if value.Array != nil {
		count++
	}
	if count != 1 {
		return nil, errors.New("catalog: value must have one source")
	}
	if value.Object != nil {
		result := map[string]any{}
		for key, child := range value.Object {
			resolved, err := ResolveValue(child, config, secrets, runtimeValues...)
			if err != nil {
				return nil, err
			}
			result[key] = resolved
		}
		return result, nil
	}
	if value.Array != nil {
		result := make([]any, 0, len(value.Array))
		for _, child := range value.Array {
			resolved, err := ResolveValue(child, config, secrets, runtimeValues...)
			if err != nil {
				return nil, err
			}
			result = append(result, resolved)
		}
		return result, nil
	}
	if value.Runtime != nil {
		if len(runtimeValues) != 1 {
			return nil, errors.New("catalog: runtime values context is required")
		}
		key := value.Runtime.Kind + ":" + value.Runtime.Name
		result, ok := runtimeValues[0][key]
		if !ok {
			return nil, fmt.Errorf("catalog: missing runtime reference %s", key)
		}
		if value.Runtime.Path != "" {
			if value.Runtime.Kind != "state-directory" || !safeRelative(value.Runtime.Path) {
				return nil, errors.New("catalog: unsafe runtime suffix")
			}
			result = path.Join(result, value.Runtime.Path)
		}
		return result, nil
	}
	if value.Literal != nil {
		var result any
		decoder := json.NewDecoder(bytes.NewReader(*value.Literal))
		decoder.UseNumber()
		if err := decodeStrictJSON(*value.Literal, &result); err != nil {
			return nil, err
		}
		if err := decoder.Decode(&result); err != nil {
			return nil, err
		}
		return result, nil
	}
	if value.Config != "" {
		result, ok := config[value.Config]
		if !ok {
			return nil, fmt.Errorf("catalog: config field %s is missing", value.Config)
		}
		return result, nil
	}
	result, ok := secrets[value.Secret]
	if !ok {
		return nil, fmt.Errorf("catalog: secret field %s is missing", value.Secret)
	}
	return result, nil
}

func ResolveString(value Value, config map[string]any, secrets map[string]string, runtimeValues ...map[string]string) (string, error) {
	resolved, err := ResolveValue(value, config, secrets, runtimeValues...)
	if err != nil {
		return "", err
	}
	var result string
	switch v := resolved.(type) {
	case string:
		result = v
	case bool:
		result = strconv.FormatBool(v)
	case json.Number:
		result = v.String()
	case int:
		result = strconv.Itoa(v)
	case int64:
		result = strconv.FormatInt(v, 10)
	case float64:
		result = strconv.FormatFloat(v, 'f', -1, 64)
	default:
		return "", errors.New("catalog: process values must be scalar strings, numbers, or booleans")
	}
	if strings.ContainsRune(result, 0) || len(result) > 65536 {
		return "", errors.New("catalog: process value exceeds bounds or contains NUL")
	}
	return result, nil
}

func RenderConfigFile(file ConfigFile, config map[string]any, secrets map[string]string, runtimeValues ...map[string]string) ([]byte, error) {
	values := map[string]any{}
	for key, value := range file.Values {
		resolved, err := ResolveValue(value, config, secrets, runtimeValues...)
		if err != nil {
			return nil, err
		}
		values[key] = resolved
	}
	var output []byte
	var err error
	switch file.Format {
	case "json":
		output, err = json.Marshal(values)
	case "yaml":
		// json.Number has to stay a number in YAML, not become a quoted string.
		raw, marshalErr := json.Marshal(values)
		if marshalErr != nil {
			return nil, marshalErr
		}
		var node yaml.Node
		if err = yaml.Unmarshal(raw, &node); err == nil {
			output, err = yaml.Marshal(&node)
		}
	case "env":
		keys := make([]string, 0, len(file.Values))
		for key := range file.Values {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		var buffer strings.Builder
		for _, key := range keys {
			if !environmentName.MatchString(key) {
				return nil, errors.New("catalog: invalid env key")
			}
			value, resolveErr := ResolveString(file.Values[key], config, secrets, runtimeValues...)
			if resolveErr != nil {
				return nil, resolveErr
			}
			// A dotenv file is data: single-quoted values disable interpolation.
			// Reject line breaks rather than creating a second assignment.
			if strings.ContainsAny(value, "\r\n'") {
				return nil, errors.New("catalog: env value contains unsupported quote or line break")
			}
			fmt.Fprintf(&buffer, "%s='%s'\n", key, value)
		}
		output = []byte(buffer.String())
	default:
		return nil, errors.New("catalog: unknown config file encoding")
	}
	if len(output) > 1<<20 {
		return nil, errors.New("catalog: rendered config file exceeds bound")
	}
	return output, err
}
