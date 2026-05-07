package main

import (
	"encoding/json"
	"fmt"
)

type uploadPrekeysRequest struct {
	SignedPrekey []byte `json:"signed_prekey"`
}

func main() {
	jsonData := `{"signed_prekey": [1, 2, 3, 4]}`
	var req uploadPrekeysRequest
	err := json.Unmarshal([]byte(jsonData), &req)
	if err != nil {
		fmt.Println("Error:", err)
	} else {
		fmt.Println("Success:", req.SignedPrekey)
	}
}
