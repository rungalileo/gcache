package dialcache_test

import (
	"context"
	"fmt"

	dialcache "github.com/lan17/DialCache/go"
)

func ExampleCached() {
	cache := dialcache.New[string](dialcache.Options[string]{})
	loads := 0
	lookup, err := dialcache.Cached(cache, dialcache.Operation{
		Identity: dialcache.Identity{KeyType: "user", UseCase: "displayName"},
		Policy:   dialcache.Policy{RequestLocal: true},
	}, func(id string) (dialcache.Identity, error) {
		return dialcache.Identity{ID: id}, nil
	}, func(ctx context.Context, id string) (string, error) {
		loads++
		return "Ada", nil
	})
	if err != nil {
		panic(err)
	}
	err = cache.Enable(context.Background(), func(ctx context.Context) error {
		for range 2 {
			value, err := lookup(ctx, "42")
			if err != nil {
				return err
			}
			fmt.Println(value)
		}
		return nil
	})
	if err != nil {
		panic(err)
	}
	fmt.Println("source calls:", loads)
	// Output:
	// Ada
	// Ada
	// source calls: 1
}
