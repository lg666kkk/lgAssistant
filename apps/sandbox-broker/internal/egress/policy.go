package egress

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

const maxResponseBytes = 5 << 20

type Resolver interface {
	LookupIP(context.Context, string, string) ([]net.IP, error)
}

type Policy struct {
	allowedHosts map[string]struct{}
	resolver     Resolver
}

func NewPolicy(allowedHosts []string, resolver Resolver) (*Policy, error) {
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	hosts := make(map[string]struct{}, len(allowedHosts))
	for _, host := range allowedHosts {
		normalized := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
		if normalized == "" || net.ParseIP(normalized) != nil || strings.ContainsAny(normalized, "/:@") {
			return nil, fmt.Errorf("invalid egress allowlist host: %s", host)
		}
		hosts[normalized] = struct{}{}
	}
	return &Policy{allowedHosts: hosts, resolver: resolver}, nil
}

func (policy *Policy) Validate(ctx context.Context, method string, rawURL string) error {
	if method != http.MethodGet && method != http.MethodHead {
		return errors.New("egress method is not allowed")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Fragment != "" {
		return errors.New("egress URL must be an HTTPS URL without credentials or fragment")
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if _, ok := policy.allowedHosts[host]; !ok {
		return errors.New("egress host is not allowlisted")
	}
	port := parsed.Port()
	if port != "" && port != "443" {
		return errors.New("egress port is not allowed")
	}
	addresses, err := policy.resolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return fmt.Errorf("resolve egress host: %w", err)
	}
	if len(addresses) == 0 {
		return errors.New("egress host resolved to no addresses")
	}
	for _, address := range addresses {
		if !IsPublicIP(address) {
			return fmt.Errorf("egress host resolved to a non-public address: %s", address)
		}
	}
	return nil
}

func IsPublicIP(address net.IP) bool {
	if address == nil || address.IsUnspecified() || address.IsLoopback() ||
		address.IsPrivate() || address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() ||
		address.IsMulticast() {
		return false
	}
	if address.Equal(net.ParseIP("169.254.169.254")) {
		return false
	}
	return true
}

func (policy *Policy) Hosts() []string {
	hosts := make([]string, 0, len(policy.allowedHosts))
	for host := range policy.allowedHosts {
		hosts = append(hosts, host)
	}
	sort.Strings(hosts)
	return hosts
}

func MaxResponseBytes() int64 { return maxResponseBytes }
