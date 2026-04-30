package snowflake

import (
	"sync"
	"time"
)

const (
	epoch          = int64(1700000000000)
	machineBits    = 10
	sequenceBits   = 12
	maxMachineID   = -1 ^ (-1 << machineBits)
	maxSequence    = -1 ^ (-1 << sequenceBits)
	machineShift   = sequenceBits
	timestampShift = machineBits + sequenceBits
)

type Generator struct {
	mu          sync.Mutex
	machineID   int64
	sequence    int64
	lastStampMS int64
}

func New(machineID int64) *Generator {
	if machineID < 0 || machineID > maxMachineID {
		panic("snowflake: machineID must be between 0 and 1023")
	}
	return &Generator{machineID: machineID}
}

func (g *Generator) NextID() int64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now().UnixMilli()
	for now < g.lastStampMS {
		time.Sleep(time.Millisecond)
		now = time.Now().UnixMilli()
	}
	if now == g.lastStampMS {
		g.sequence = (g.sequence + 1) & maxSequence
		if g.sequence == 0 {
			for now <= g.lastStampMS {
				now = time.Now().UnixMilli()
			}
		}
	} else {
		g.sequence = 0
	}
	g.lastStampMS = now
	return ((now - epoch) << timestampShift) | (g.machineID << machineShift) | g.sequence
}

func TimeFromID(id int64) time.Time {
	return time.UnixMilli((id>>timestampShift)+epoch).UTC()
}
