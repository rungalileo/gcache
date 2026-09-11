package dialcache

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
)

func TestReservedIdentityValidationBoundary(t *testing.T) {
	for _, computed := range []bool{false, true} {
		for _, enabled := range []bool{false, true} {
			for _, sourceFails := range []bool{false, true} {
				t.Run(fmt.Sprintf("computed=%t/enabled=%t/sourceFails=%t", computed, enabled, sourceFails), func(t *testing.T) {
					var identities, policies, reads, writes, sources, keyErrors atomic.Int32
					remote := boundaryRemote{
						read: func(context.Context) (ReadResult, error) {
							reads.Add(1)
							return ReadResult{Kind: "miss", Reason: "value_absent"}, nil
						},
						write: func(Frame) error { writes.Add(1); return nil },
					}
					cache := New(Options[int]{Remote: remote, Logger: &boundaryLogger{},
						PolicyProvider: func(context.Context, Identity) (any, error) { policies.Add(1); return nil, nil },
						Observe: func(event Event) {
							if event.Kind == "error" && event.Data["error"] == "key_construction" {
								keyErrors.Add(1)
							}
						},
					})
					operation := Operation{
						Identity: Identity{UseCase: "watermark", KeyType: "id", ID: "1", Tracked: true},
						Policy:   Policy{LocalTTLMS: 1000, RemoteTTLMS: 60000},
						IdentityProvider: func() (Identity, error) {
							identities.Add(1)
							return Identity{UseCase: "watermark", KeyType: "id", ID: "1", Tracked: true}, nil
						},
					}
					if computed {
						operation.Identity.UseCase = "get"
					}
					sourceError := errors.New("source unavailable")
					invoke := func(ctx context.Context) error {
						// Repetition also verifies that fail-open results never enter
						// the enabled local cache under the invalid computed key.
						for call := 1; call <= 2; call++ {
							value, err := cache.GetOrLoad(ctx, operation, func(context.Context) (int, error) {
								value := int(sources.Add(1))
								if sourceFails {
									return 0, sourceError
								}
								return value, nil
							})
							if !computed {
								if err == nil || !strings.Contains(err.Error(), "reserved use case") || value != 0 {
									t.Fatalf("invalid static metadata must reject: value=%d error=%v", value, err)
								}
							} else if sourceFails {
								if err != sourceError {
									t.Fatalf("computed identity replaced source error: %v", err)
								}
							} else if err != nil || value != call {
								t.Fatalf("computed identity did not pass source result through: value=%d error=%v", value, err)
							}
						}
						return nil
					}
					if enabled {
						if err := cache.Enable(context.Background(), invoke); err != nil {
							t.Fatal(err)
						}
					} else if err := invoke(context.Background()); err != nil {
						t.Fatal(err)
					}
					wantSources, wantIdentities := int32(0), int32(0)
					if computed {
						wantSources = 2
						if enabled {
							wantIdentities = 2
						}
					}
					if policies.Load() != 0 || reads.Load() != 0 || writes.Load() != 0 {
						t.Fatalf("invalid identity reached cache effects: policy=%d read=%d write=%d", policies.Load(), reads.Load(), writes.Load())
					}
					if identities.Load() != wantIdentities || sources.Load() != wantSources || keyErrors.Load() != wantIdentities {
						t.Fatalf("boundary callbacks: identities=%d sources=%d keyErrors=%d", identities.Load(), sources.Load(), keyErrors.Load())
					}
				})
			}
		}
	}
}
