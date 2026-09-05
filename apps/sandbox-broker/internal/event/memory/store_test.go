package memory

import (
	"context"
	"testing"
)

func TestStoreSequenceAndResume(t *testing.T) {
	store := New()
	for _, eventType := range []string{"queued", "running", "completed"} {
		if _, err := store.Append(context.Background(), "run-1", eventType, map[string]string{"status": eventType}); err != nil {
			t.Fatal(err)
		}
	}
	events, err := store.List(context.Background(), "run-1", 1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Sequence != 2 || events[1].Sequence != 3 {
		t.Fatalf("unexpected resumed events: %+v", events)
	}
}
