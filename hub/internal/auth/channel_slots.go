// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"

	"quetzalcoatl-hub/internal/store"
)

// ChannelIngressSlotType 是公网 Webhook 的 X-Wing 入站公钥槽位。
// 该槽位只保存公钥与不可逆 key id，绝不接受任何私钥材料。
const ChannelIngressSlotType = "channel_ingress"

// RegisterChannelIngressRoutes 挂载 Agent 所有者的入站公钥登记入口。
func (s *Service) RegisterChannelIngressRoutes(mux *http.ServeMux) {
	mux.HandleFunc("PUT /v1/auth/slots/{agent_id}/"+ChannelIngressSlotType, s.handlePutChannelIngressSlot)
}

func (s *Service) handlePutChannelIngressSlot(w http.ResponseWriter, r *http.Request) {
	agentID := r.PathValue("agent_id")
	principal, _, ok := s.requireAgentOwner(w, r, agentID)
	if !ok {
		return
	}
	var req struct {
		XWingPubKeyHex string `json:"xwing_pubkey_hex"`
		KeyID          string `json:"key_id"`
		DeviceID       string `json:"device_id"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	pk, err := hex.DecodeString(strings.TrimSpace(req.XWingPubKeyHex))
	if err != nil || len(pk) != XWingPKLen {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "xwing_pubkey_hex must be a valid X-Wing public key")
		return
	}
	deviceID := strings.TrimSpace(req.DeviceID)
	if deviceID == "" {
		deviceID = principal.DeviceID
	}
	if deviceID == "" || (principal.DeviceID != "" && deviceID != principal.DeviceID) {
		writeAPIError(w, http.StatusForbidden, "PERMISSION_DENIED", "device_id must match authenticated session device")
		return
	}
	device, err := s.store.GetDevice(r.Context(), agentID, deviceID)
	if err != nil || device.Revoked {
		writeAPIError(w, http.StatusForbidden, "PERMISSION_DENIED", "device is not active for agent")
		return
	}
	keyID := strings.TrimSpace(req.KeyID)
	if keyID == "" || len(keyID) > 128 {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "key_id is required (max 128 chars)")
		return
	}
	slotType := ChannelIngressSlotType + ":" + deviceID
	discarded := int64(0)
	if previous, err := s.store.GetKeySlot(r.Context(), agentID, slotType); err == nil {
		if previous.CiphertextHex != hex.EncodeToString(pk) {
			discarded, _ = s.store.DeleteWebhookIngressForDevice(r.Context(), agentID, deviceID)
		}
	}
	metadata, err := json.Marshal(map[string]string{"key_id": keyID, "device_id": deviceID, "purpose": "channel-ingress"})
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "SERIALIZATION_ERROR", "metadata marshal failed")
		return
	}
	aad, err := json.Marshal(map[string]string{"agent_id": agentID, "purpose": "channel-ingress", "key_id": keyID})
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "SERIALIZATION_ERROR", "aad marshal failed")
		return
	}
	if err := s.store.UpsertKeySlot(r.Context(), store.KeySlotEnvelope{
		AgentID:       agentID,
		Slot:          slotType,
		AADUTF8:       string(aad),
		NonceHex:      "",
		CiphertextHex: hex.EncodeToString(pk),
		MetadataJSON:  string(metadata),
		UpdatedAtMs:   s.clock().UnixMilli(),
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"agent_id":       agentID,
		"slot":           slotType,
		"key_id":         keyID,
		"device_id":      deviceID,
		"discarded_rows": discarded,
	})
}
