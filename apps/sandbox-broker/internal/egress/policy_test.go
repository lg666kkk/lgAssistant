package egress

import (
	"context"
	"net"
	"net/http"
	"testing"
)

type fakeResolver map[string][]net.IP

func (resolver fakeResolver) LookupIP(_ context.Context, _ string, host string) ([]net.IP, error) {
	return resolver[host], nil
}

func TestPolicyAllowsOnlyAllowlistedPublicHTTPS(t *testing.T) {
	policy, err := NewPolicy([]string{"api.example.com"}, fakeResolver{
		"api.example.com": {net.ParseIP("203.0.113.10")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := policy.Validate(context.Background(), http.MethodGet, "https://api.example.com/data"); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		method string
		url    string
	}{
		{http.MethodPost, "https://api.example.com/data"},
		{http.MethodGet, "http://api.example.com/data"},
		{http.MethodGet, "https://other.example.com/data"},
		{http.MethodGet, "https://api.example.com:8443/data"},
		{http.MethodGet, "https://user:password@api.example.com/data"},
	} {
		if err := policy.Validate(context.Background(), test.method, test.url); err == nil {
			t.Fatalf("expected %s %s to fail", test.method, test.url)
		}
	}
}

func TestPolicyRejectsEveryNonPublicResolution(t *testing.T) {
	addresses := []string{
		"127.0.0.1", "::1", "10.0.0.1", "172.16.0.1", "192.168.1.1",
		"169.254.169.254", "fe80::1", "0.0.0.0", "224.0.0.1",
	}
	for _, address := range addresses {
		t.Run(address, func(t *testing.T) {
			policy, err := NewPolicy([]string{"api.example.com"}, fakeResolver{
				"api.example.com": {net.ParseIP(address)},
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := policy.Validate(context.Background(), http.MethodGet, "https://api.example.com/data"); err == nil {
				t.Fatalf("expected %s to be rejected", address)
			}
		})
	}
}

func TestPolicyRejectsMixedPublicAndPrivateDNS(t *testing.T) {
	policy, err := NewPolicy([]string{"api.example.com"}, fakeResolver{
		"api.example.com": {net.ParseIP("203.0.113.10"), net.ParseIP("10.0.0.1")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := policy.Validate(context.Background(), http.MethodGet, "https://api.example.com"); err == nil {
		t.Fatal("expected mixed DNS answer to fail")
	}
}
