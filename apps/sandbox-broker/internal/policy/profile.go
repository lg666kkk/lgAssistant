package policy

import (
	"fmt"
	"sort"
)

type NetworkMode string

const (
	NetworkDisabled  NetworkMode = "disabled"
	NetworkAllowlist NetworkMode = "allowlist"
)

type Profile struct {
	ID                string      `json:"id"`
	Description       string      `json:"description"`
	CPUQuotaMilli     int         `json:"cpuQuotaMilli"`
	MemoryLimitMB     int         `json:"memoryLimitMb"`
	PIDLimit          int         `json:"pidLimit"`
	TimeoutSeconds    int         `json:"timeoutSeconds"`
	WritableWorkspace bool        `json:"writableWorkspace"`
	Network           NetworkMode `json:"network"`
	ProducesPatch     bool        `json:"producesPatch"`
}

type Registry struct {
	profiles map[string]Profile
}

func NewRegistry() *Registry {
	profiles := []Profile{
		{
			ID:                "skill-trusted",
			Description:       "Reviewed Skill bundle with a read-only bundle and writable temporary workspace.",
			CPUQuotaMilli:     500,
			MemoryLimitMB:     256,
			PIDLimit:          64,
			TimeoutSeconds:    30,
			WritableWorkspace: true,
			Network:           NetworkDisabled,
		},
		{
			ID:                "coding-untrusted",
			Description:       "Model-generated coding task in an isolated writable workspace; output is a patch artifact.",
			CPUQuotaMilli:     1000,
			MemoryLimitMB:     1024,
			PIDLimit:          128,
			TimeoutSeconds:    300,
			WritableWorkspace: true,
			Network:           NetworkDisabled,
			ProducesPatch:     true,
		},
	}

	registry := &Registry{profiles: make(map[string]Profile, len(profiles))}
	for _, profile := range profiles {
		registry.profiles[profile.ID] = profile
	}
	return registry
}

func (r *Registry) Get(id string) (Profile, error) {
	profile, ok := r.profiles[id]
	if !ok {
		return Profile{}, fmt.Errorf("unknown sandbox profile: %s", id)
	}
	return profile, nil
}

func (r *Registry) List() []Profile {
	profiles := make([]Profile, 0, len(r.profiles))
	for _, profile := range r.profiles {
		profiles = append(profiles, profile)
	}
	sort.Slice(profiles, func(i, j int) bool {
		return profiles[i].ID < profiles[j].ID
	})
	return profiles
}
