package gcache

import (
	"crypto/tls"
	"errors"
	"fmt"
	"slices"
	"testing"

	"github.com/redis/rueidis"
)

func TestClientOptionTLS(t *testing.T) {
	custom := &tls.Config{MinVersion: tls.VersionTLS13, ServerName: "redis.internal"}

	cases := []struct {
		name       string
		opts       RueidisOptions
		wantTLS    bool
		wantMin    uint16
		wantServer string
	}{
		{name: "plain redis ignores TLS", opts: RueidisOptions{Protocol: "redis", TLSConfig: custom}},
		{name: "rediss defaults to verified TLS 1.2", opts: RueidisOptions{Protocol: "rediss"}, wantTLS: true, wantMin: tls.VersionTLS12},
		{name: "rediss uses the caller's config", opts: RueidisOptions{Protocol: "rediss+cluster", TLSConfig: custom}, wantTLS: true, wantMin: tls.VersionTLS13, wantServer: "redis.internal"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := clientOption(tc.opts, "127.0.0.1:6379").TLSConfig
			if !tc.wantTLS {
				if got != nil {
					t.Fatalf("TLSConfig = %+v, want nil", got)
				}
				return
			}
			if got == nil {
				t.Fatal("TLSConfig = nil, want a config")
			}
			if got.MinVersion != tc.wantMin || got.ServerName != tc.wantServer {
				t.Fatalf("TLSConfig = {MinVersion: %d, ServerName: %q}, want {%d, %q}", got.MinVersion, got.ServerName, tc.wantMin, tc.wantServer)
			}
			if got.InsecureSkipVerify {
				t.Fatal("InsecureSkipVerify set, want verification")
			}
		})
	}
}

func TestClientOptionClonesTLSConfig(t *testing.T) {
	custom := &tls.Config{MinVersion: tls.VersionTLS12}
	got := clientOption(RueidisOptions{Protocol: "rediss", TLSConfig: custom}, "127.0.0.1:6379").TLSConfig
	if got == custom {
		t.Fatal("TLSConfig is the caller's pointer, want a clone")
	}
}

// stubClient satisfies rueidis.Client without a server. Only Close is reachable here.
type stubClient struct{ rueidis.Client }

func TestNewRueidisClientRetriesWithoutClientSideCache(t *testing.T) {
	orig := newRueidis
	t.Cleanup(func() { newRueidis = orig })

	cases := []struct {
		name      string
		opts      RueidisOptions
		firstErr  error
		wantDials []bool
		wantCache bool
		wantErr   bool
	}{
		{name: "server rejects CLIENT TRACKING", firstErr: fmt.Errorf("init: %w", rueidis.ErrNoCache), wantDials: []bool{false, true}},
		{name: "server accepts CLIENT TRACKING", wantDials: []bool{false}, wantCache: true},
		{name: "other dial errors do not retry", firstErr: errors.New("connection refused"), wantDials: []bool{false}, wantErr: true},
		{name: "cache already off", opts: RueidisOptions{DisableClientSideCache: true}, wantDials: []bool{true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var dials []bool
			newRueidis = func(opt rueidis.ClientOption) (rueidis.Client, error) {
				dials = append(dials, opt.DisableCache)
				if len(dials) == 1 && tc.firstErr != nil {
					return nil, tc.firstErr
				}
				return stubClient{}, nil
			}
			tc.opts.Host = "127.0.0.1"
			c, _, err := NewRueidisClient(tc.opts)
			if !slices.Equal(dials, tc.wantDials) {
				t.Fatalf("DisableCache per dial = %v, want %v", dials, tc.wantDials)
			}
			if tc.wantErr {
				if err == nil {
					t.Fatal("err = nil, want the dial error")
				}
				return
			}
			if err != nil {
				t.Fatalf("err = %v, want nil", err)
			}
			if got := c.(*rueidisClient).cacheEnabled; got != tc.wantCache {
				t.Fatalf("cacheEnabled = %v, want %v", got, tc.wantCache)
			}
		})
	}
}
