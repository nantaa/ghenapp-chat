package snowflake_test

import (
	"sync"
	"testing"

	"github.com/ghenapp/ghenapp/internal/snowflake"
)

func TestSnowflake_Uniqueness(t *testing.T) {
	gen := snowflake.New(1)
	const count = 10000

	ids := make(map[int64]struct{}, count)
	var mu sync.Mutex
	var wg sync.WaitGroup

	for i := 0; i < count; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := gen.NextID()
			mu.Lock()
			if _, exists := ids[id]; exists {
				t.Errorf("duplicate snowflake ID: %d", id)
			}
			ids[id] = struct{}{}
			mu.Unlock()
		}()
	}
	wg.Wait()

	if len(ids) != count {
		t.Errorf("expected %d unique IDs, got %d", count, len(ids))
	}
}

func TestSnowflake_Monotonic(t *testing.T) {
	gen := snowflake.New(1)
	prev := gen.NextID()
	for i := 0; i < 1000; i++ {
		id := gen.NextID()
		if id <= prev {
			t.Errorf("ID not monotonically increasing: %d <= %d", id, prev)
		}
		prev = id
	}
}

func TestSnowflake_TimeFromID(t *testing.T) {
	gen := snowflake.New(1)
	id := gen.NextID()
	ts := snowflake.TimeFromID(id)
	if ts.IsZero() {
		t.Error("TimeFromID returned zero time")
	}
}

func TestSnowflake_InvalidMachineID(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Error("expected panic for invalid machine ID")
		}
	}()
	snowflake.New(9999) // should panic
}
