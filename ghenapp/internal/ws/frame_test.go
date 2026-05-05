package ws_test

import (
	"testing"

	"github.com/ghenapp/ghenapp/internal/ws"
)

func TestFrame_EncodeDecodeRoundtrip(t *testing.T) {
	original := &ws.Frame{
		Version:     ws.IMCPVersion,
		Type:        ws.MsgText,
		ID:          12345678901234,
		TimestampMS: 1700000000000,
		TTLSeconds:  3600,
		Payload:     []byte("encrypted-hello-world"),
		Padding:     []byte{0x00, 0x01, 0x02},
	}
	copy(original.ConversationID[:], []byte("0123456789abcdef"))

	data, err := original.Encode()
	if err != nil {
		t.Fatalf("Encode failed: %v", err)
	}

	decoded, err := ws.Decode(data)
	if err != nil {
		t.Fatalf("Decode failed: %v", err)
	}

	if decoded.Type != original.Type {
		t.Errorf("Type: got %v want %v", decoded.Type, original.Type)
	}
	if decoded.ID != original.ID {
		t.Errorf("ID: got %d want %d", decoded.ID, original.ID)
	}
	if decoded.TimestampMS != original.TimestampMS {
		t.Errorf("TimestampMS: got %d want %d", decoded.TimestampMS, original.TimestampMS)
	}
	if decoded.TTLSeconds != original.TTLSeconds {
		t.Errorf("TTLSeconds: got %d want %d", decoded.TTLSeconds, original.TTLSeconds)
	}
	if string(decoded.Payload) != string(original.Payload) {
		t.Errorf("Payload: got %q want %q", decoded.Payload, original.Payload)
	}
	if decoded.ConversationID != original.ConversationID {
		t.Errorf("ConversationID mismatch")
	}
}

func TestFrame_PayloadSizeEnforcement(t *testing.T) {
	// Text frame exceeding 4KB limit
	bigPayload := make([]byte, ws.MaxPayloadByType(ws.MsgText)+1)
	f := &ws.Frame{
		Version: ws.IMCPVersion,
		Type:    ws.MsgText,
		Payload: bigPayload,
	}
	data, err := f.Encode()
	if err != nil {
		t.Fatalf("Encode failed: %v", err)
	}
	// Decode should reject it
	_, err = ws.Decode(data)
	if err == nil {
		t.Fatal("expected payload size error, got nil")
	}
}

func TestFrame_UnsupportedVersion(t *testing.T) {
	f := &ws.Frame{
		Version: 99, // bad version
		Type:    ws.MsgText,
		Payload: []byte("test"),
	}
	data, _ := f.Encode()
	_, err := ws.Decode(data)
	if err == nil {
		t.Fatal("expected version error, got nil")
	}
}

func TestFrame_TooShort(t *testing.T) {
	_, err := ws.Decode([]byte{0x01, 0x02})
	if err == nil {
		t.Fatal("expected error for truncated frame, got nil")
	}
}

func TestMsgTypeString(t *testing.T) {
	cases := map[ws.MsgType]string{
		ws.MsgText:       "TEXT",
		ws.MsgImage:      "IMAGE",
		ws.MsgCallSignal: "CALL_SIGNAL",
	}
	for t_, want := range cases {
		if got := t_.String(); got != want {
			t.Errorf("MsgType(%d).String() = %q, want %q", t_, got, want)
		}
	}
}
