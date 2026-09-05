package skill

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/xeipuuv/gojsonschema"
)

func ValidateJSON(schema []byte, document []byte) error {
	if len(schema) == 0 || len(document) == 0 {
		return errors.New("JSON schema and document are required")
	}
	var parsed any
	if err := json.Unmarshal(schema, &parsed); err != nil {
		return fmt.Errorf("parse JSON schema: %w", err)
	}
	if err := rejectExternalReferences(parsed); err != nil {
		return err
	}
	result, err := gojsonschema.Validate(
		gojsonschema.NewBytesLoader(schema),
		gojsonschema.NewBytesLoader(document),
	)
	if err != nil {
		return fmt.Errorf("validate JSON schema: %w", err)
	}
	if result.Valid() {
		return nil
	}
	messages := make([]string, 0, len(result.Errors()))
	for _, validationError := range result.Errors() {
		messages = append(messages, validationError.String())
		if len(messages) == 5 {
			break
		}
	}
	return fmt.Errorf("JSON schema validation failed: %s", strings.Join(messages, "; "))
}

func rejectExternalReferences(value any) error {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if key == "$ref" {
				ref, ok := child.(string)
				if !ok || !strings.HasPrefix(ref, "#") {
					return errors.New("JSON schema external references are not allowed")
				}
			}
			if err := rejectExternalReferences(child); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range typed {
			if err := rejectExternalReferences(child); err != nil {
				return err
			}
		}
	}
	return nil
}
