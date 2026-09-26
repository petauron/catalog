package catalog

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dlclark/regexp2"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

type ecmaRegexp struct{ *regexp2.Regexp }

func (r ecmaRegexp) MatchString(value string) bool {
	match, err := r.Regexp.MatchString(value)
	return err == nil && match
}

func TestPublishedSchemasCompileAndValidateV4Fixtures(t *testing.T) {
	compiler := jsonschema.NewCompiler()
	compiler.UseRegexpEngine(func(pattern string) (jsonschema.Regexp, error) {
		re, err := regexp2.Compile(pattern, regexp2.ECMAScript)
		if err != nil {
			return nil, err
		}
		re.MatchTimeout = 100 * time.Millisecond
		return ecmaRegexp{re}, nil
	})
	for _, name := range []string{"catalog.schema.json", "catalog-envelope.schema.json", "app-manifest.schema.json", "runtime.schema.json"} {
		raw, err := os.ReadFile(filepath.Join("..", "schemas", name))
		if err != nil {
			t.Fatal(err)
		}
		value, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if err := compiler.AddResource("https://petauron.com/contracts/catalog/v4/"+name, value); err != nil {
			t.Fatal(err)
		}
	}
	schema, err := compiler.Compile("https://petauron.com/contracts/catalog/v4/catalog.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"catalog.json", "testdata/v4/valid-catalog.json", "testdata/v4/valid/integer-decimal.json", "testdata/v4/valid/integer-exponent.json"} {
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		value, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if err := schema.Validate(value); err != nil {
			t.Fatalf("schema rejected %s: %v", name, err)
		}
	}
	for _, runtime := range []string{`{"kind":"future","version":1,"arbitraryFutureField":true}`, `{"kind":"docker","version":2,"futureRecipe":{}}`} {
		value := validCatalog()
		if err := value.Apps[0].Runtime.UnmarshalJSON([]byte(runtime)); err != nil {
			t.Fatal(err)
		}
		raw, err := MarshalCatalog(value)
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if err := schema.Validate(decoded); err != nil {
			t.Fatal("future runtime broke whole catalog schema", err)
		}
	}
	for _, name := range []string{"default-type.json", "missing-config.json", "null-config.json", "secret-default.json", "unknown-field.json", "unpinned-image.json"} {
		raw, err := os.ReadFile(filepath.Join("testdata/v4/invalid", name))
		if err != nil {
			t.Fatal(err)
		}
		value, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if err := schema.Validate(value); err == nil {
			t.Fatal("schema accepted invalid fixture", name)
		}
	}
}
