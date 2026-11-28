// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"encoding/hex"
	"net/http"
	"regexp"
	"strings"

	"quetzalcoatl-hub/internal/store"
)

// 设备之间传递的封存钥匙（条目钥匙、纪元钥匙）。
//
// 每一份都已经在客户端用接收设备的 X-Wing 公钥封存，Hub 只看得到密文。
// 和签名事件链不同，这里的东西可以删除：抹除一个条目时，客户端删掉它在所有设备上的那一份。
const sealedKeySlotPrefix = "sealed_key:"

var sealedKeyNamePattern = regexp.MustCompile(`^[A-Za-z0-9._@:/-]{1,240}$`)

// RegisterSealedKeyRoutes 挂载设备之间传递封存钥匙的入口。
func (s *Service) RegisterSealedKeyRoutes(mux *http.ServeMux) {
	mux.HandleFunc("PUT /v1/keys/{agent_id}/{device_id}/{name...}", s.handlePutSealedKey)
	mux.HandleFunc("GET /v1/keys/{agent_id}/{device_id}", s.handleListSealedKeys)
	mux.HandleFunc("DELETE /v1/keys/{agent_id}/{name...}", s.handleDeleteSealedKey)
}

func sealedKeySlot(deviceID, name string) string {
	return sealedKeySlotPrefix + deviceID + ":" + name
}

func (s *Service) handlePutSealedKey(w http.ResponseWriter, r *http.Request) {
	agentID := r.PathValue("agent_id")
	deviceID := r.PathValue("device_id")
	name := r.PathValue("name")
	if _, _, ok := s.requireAgentOwner(w, r, agentID); !ok {
		return
	}
	if !sealedKeyNamePattern.MatchString(name) || strings.Contains(name, "..") {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "invalid key name")
		return
	}
	device, err := s.store.GetDevice(r.Context(), agentID, deviceID)
	if err != nil || device.Revoked {
		writeAPIError(w, http.StatusForbidden, "PERMISSION_DENIED", "recipient device is not active for agent")
		return
	}
	var req struct {
		AADUTF8       string `json:"aad_utf8"`
		CiphertextHex string `json:"ciphertext_hex"`
		HPKEEncHex    string `json:"hpke_enc_hex"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	if _, err := hex.DecodeString(req.CiphertextHex); err != nil || req.CiphertextHex == "" || len(req.CiphertextHex) > 64*1024 {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "ciphertext_hex must be non-empty hex")
		return
	}
	if _, err := hex.DecodeString(req.HPKEEncHex); err != nil || req.HPKEEncHex == "" {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "hpke_enc_hex must be non-empty hex")
		return
	}
	if err := s.store.UpsertKeySlot(r.Context(), store.KeySlotEnvelope{
		AgentID:       agentID,
		Slot:          sealedKeySlot(deviceID, name),
		AADUTF8:       req.AADUTF8,
		CiphertextHex: req.CiphertextHex,
		HPKEEncHex:    req.HPKEEncHex,
		MetadataJSON:  "{}",
		UpdatedAtMs:   s.clock().UnixMilli(),
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agent_id": agentID, "device_id": deviceID, "name": name})
}

func (s *Service) handleListSealedKeys(w http.ResponseWriter, r *http.Request) {
	agentID := r.PathValue("agent_id")
	deviceID := r.PathValue("device_id")
	principal, _, ok := s.requireAgentOwner(w, r, agentID)
	if !ok {
		return
	}
	// 只有收件设备自己能取走寄给它的那一份。
	if principal.DeviceID == "" || principal.DeviceID != deviceID {
		writeAPIError(w, http.StatusForbidden, "PERMISSION_DENIED", "only the recipient device may read its sealed keys")
		return
	}
	slots, err := s.store.ListKeySlots(r.Context(), agentID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	prefix := sealedKeySlotPrefix + deviceID + ":"
	items := make([]map[string]any, 0)
	for _, slot := range slots {
		if !strings.HasPrefix(slot.Slot, prefix) {
			continue
		}
		items = append(items, map[string]any{
			"name":           strings.TrimPrefix(slot.Slot, prefix),
			"aad_utf8":       slot.AADUTF8,
			"ciphertext_hex": slot.CiphertextHex,
			"hpke_enc_hex":   slot.HPKEEncHex,
			"updated_at_ms":  slot.UpdatedAtMs,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Service) handleDeleteSealedKey(w http.ResponseWriter, r *http.Request) {
	agentID := r.PathValue("agent_id")
	name := r.PathValue("name")
	if _, _, ok := s.requireAgentOwner(w, r, agentID); !ok {
		return
	}
	if !sealedKeyNamePattern.MatchString(name) {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "invalid key name")
		return
	}
	slots, err := s.store.ListKeySlots(r.Context(), agentID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	var doomed []string
	for _, slot := range slots {
		rest, isSealed := strings.CutPrefix(slot.Slot, sealedKeySlotPrefix)
		if !isSealed {
			continue
		}
		// 槽位名是「设备编号:钥匙名」，设备编号里没有冒号。
		if _, keyName, found := strings.Cut(rest, ":"); found && keyName == name {
			doomed = append(doomed, slot.Slot)
		}
	}
	deleted, err := s.store.DeleteKeySlots(r.Context(), agentID, doomed)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
}
