package domain

import (
	"encoding/json"
	"time"
)

type Event struct {
	RunID     string          `json:"runId"`
	Sequence  int64           `json:"sequence"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"createdAt"`
}
