package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

func ExecuteInputHash(request ExecuteRequest) string {
	payload, _ := json.Marshal(struct {
		UserID         string          `json:"userId"`
		ProfileID      string          `json:"profileId"`
		Command        []string        `json:"command"`
		Input          json.RawMessage `json:"input,omitempty"`
		TimeoutSeconds int             `json:"timeoutSeconds"`
	}{
		UserID:         request.UserID,
		ProfileID:      request.ProfileID,
		Command:        request.Command,
		Input:          request.Input,
		TimeoutSeconds: request.TimeoutSeconds,
	})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func SkillInputHash(request SkillRunRequest) string {
	payload, _ := json.Marshal(struct {
		UserID       string          `json:"userId"`
		SkillID      string          `json:"skillId"`
		SkillVersion string          `json:"skillVersion"`
		Input        json.RawMessage `json:"input"`
	}{
		UserID: request.UserID, SkillID: request.SkillID,
		SkillVersion: request.SkillVersion, Input: request.Input,
	})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}
