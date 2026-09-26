package catalog

import (
	"encoding/json"
	"errors"
	"fmt"
)

func validateScalarValue(value Value) error {
	if value.Object != nil || value.Array != nil {
		return errors.New("catalog: process arguments and environment require scalar values")
	}
	if value.Literal != nil {
		var decoded any
		if err := json.Unmarshal(*value.Literal, &decoded); err != nil {
			return err
		}
		switch decoded.(type) {
		case string, float64, bool:
		default:
			return errors.New("catalog: process literals must be scalar")
		}
	}
	return nil
}

func validateRuntimeReferences(app AppManifest, command, arguments []Value, environment map[string]Value, files []ConfigFile, credentials map[string]string, state map[string]bool) error {
	configPaths := map[string]bool{}
	for _, file := range files {
		configPaths[file.Path] = true
	}
	var check func(Value) error
	check = func(value Value) error {
		if r := value.Runtime; r != nil {
			found := false
			switch r.Kind {
			case "private-address":
				found = true
			case "service-address":
				found = hasService(app, r.Name)
			case "state-directory":
				found = state[r.Name]
			case "config-file":
				found = configPaths[r.Name]
			case "credential-file":
				_, found = credentials[r.Name]
			}
			if !found {
				return fmt.Errorf("catalog: unresolved runtime reference %s:%s", r.Kind, r.Name)
			}
		}
		for _, child := range value.Object {
			if err := check(child); err != nil {
				return err
			}
		}
		for _, child := range value.Array {
			if err := check(child); err != nil {
				return err
			}
		}
		return nil
	}
	for _, value := range append(append([]Value{}, command...), arguments...) {
		if err := check(value); err != nil {
			return err
		}
	}
	for _, value := range environment {
		if err := check(value); err != nil {
			return err
		}
	}
	for _, file := range files {
		for _, value := range file.Values {
			if err := check(value); err != nil {
				return err
			}
		}
	}
	return nil
}
