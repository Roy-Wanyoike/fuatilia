package infra

import "encoding/json"

// jsonMarshal is the single JSON encoding seam used by the persistence
// helpers (payload columns).
func jsonMarshal(v any) (string, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
