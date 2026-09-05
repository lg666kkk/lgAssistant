package skill

import "testing"

func TestValidateJSON(t *testing.T) {
	schema := []byte(`{"type":"object","required":["markdown"],"properties":{"markdown":{"type":"string"}},"additionalProperties":false}`)
	if err := ValidateJSON(schema, []byte(`{"markdown":"# Title"}`)); err != nil {
		t.Fatal(err)
	}
	if err := ValidateJSON(schema, []byte(`{"markdown":42}`)); err == nil {
		t.Fatal("expected invalid input to fail")
	}
	if err := ValidateJSON([]byte(`{"$ref":"https://example.com/schema.json"}`), []byte(`{}`)); err == nil {
		t.Fatal("expected external schema reference to fail")
	}
}
