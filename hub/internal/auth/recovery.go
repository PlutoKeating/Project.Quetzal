// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"encoding/hex"
	"encoding/json"
	"net/http"

	"quetzalcoatl-hub/internal/store"
)

// 应急恢复包：所有设备都丢了时，凭应急码与登录口令在新机器上把他找回来。
//
// 客户端用应急码（Argon2id 派生的钥匙）把恢复包封好再交上来，Hub 只存密文与派生参数；
// 每个 Agent 至多一份，新的盖掉旧的。读写都只认这个 Agent 的所有者会话（口令登录得到的也算）。
const recoverySlot = "recovery_kit"

// 恢复包里每条往事一把钥匙，往事多了会大：上限留宽一些。
const maxRecoveryCiphertextHex = 32 << 20

// RegisterRecoveryRoutes 挂载应急恢复包的入口。
func (s *Service) RegisterRecoveryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("PUT /v1/recovery/{agent_id}", s.handlePutRecovery)
	mux.HandleFunc("GET /v1/recovery/{agent_id}", s.handleGetRecovery)
	mux.HandleFunc("DELETE /v1/recovery/{agent_id}", s.handleDeleteRecovery)
}

type recoveryKit struct {
	SaltHex       string `json:"salt_hex"`
	MemoryKiB     uint32 `json:"memory_kib"`
	Iterations    uint32 `json:"iterations"`
	Parallelism   uint32 `json:"parallelism"`
	NonceHex      string `json:"nonce_hex"`
	CiphertextHex string `json:"ciphertext_hex"`
}

func (s *Service) handlePutRecovery(w http.ResponseWriter, r *http.Request) {
	agentID := r.PathValue("agent_id")
	if _, _, ok := s.requireAgentOwner(w, r, agentID); !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRecoveryCiphertextHex+64*1024)
	var kit recoveryKit
	if err := json.NewDecoder(r.Body).Decode(&kit); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	for _, field := range []string{kit.SaltHex, kit.NonceHex, kit.CiphertextHex} {
		if _, err := hex.DecodeString(field); err != nil || field == "" {
			writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "salt, nonce and ciphertext must be non-empty hex")
			return
		}
	}
	if len(kit.CiphertextHex) > maxRecoveryCiphertextHex || kit.MemoryKiB == 0 || kit.Iterations == 0 || kit.Parallelism == 0 {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "recovery kit parameters out of range")
		return
	}
	params, err := json.Marshal(map[string]any{
		"salt_hex": kit.SaltHex, "memory_kib": kit.MemoryKiB, "iterations": kit.Iterations,
		"parallelism": kit.Parallelism, "nonce_hex": kit.NonceHex,
	})
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "SERIALIZATION_ERROR", err.Error())
		return
	}
	nowMs := s.clock().UnixMilli()
	if err := s.store.UpsertKeySlot(r.Context(), store.KeySlotEnvelope{
		AgentID:       agentID,
		Slot:          recoverySlot,
		AADUTF8:       "quetzalcoatl/recovery-kit",
		CiphertextHex: kit.CiphertextHex,
		HPKEEncHex:    "",
		MetadataJSON:  string(params),
		UpdatedAtMs:   nowMs,
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agent_id": agentID, "updated_at_ms": nowMs})
}

func (s *Service) handleGetRecovery(w http.ResponseWriter, r *http.Request) {
	agentID := r.PathValue("agent_id")
	if _, _, ok := s.requireAgentOwner(w, r, agentID); !ok {
		return
	}
	slot, err := s.store.GetKeySlot(r.Context(), agentID, recoverySlot)
	if err != nil || slot == nil {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "no recovery kit for this agent")
		return
	}
	var kit recoveryKit
	if err := json.Unmarshal([]byte(slot.MetadataJSON), &kit); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "SERIALIZATION_ERROR", err.Error())
		return
	}
	kit.CiphertextHex = slot.CiphertextHex
	writeJSON(w, http.StatusOK, map[string]any{
		"salt_hex": kit.SaltHex, "memory_kib": kit.MemoryKiB, "iterations": kit.Iterations,
		"parallelism": kit.Parallelism, "nonce_hex": kit.NonceHex, "ciphertext_hex": kit.CiphertextHex,
		"updated_at_ms": slot.UpdatedAtMs,
	})
}

func (s *Service) handleDeleteRecovery(w http.ResponseWriter, r *http.Request) {
	agentID := r.PathValue("agent_id")
	if _, _, ok := s.requireAgentOwner(w, r, agentID); !ok {
		return
	}
	deleted, err := s.store.DeleteKeySlots(r.Context(), agentID, []string{recoverySlot})
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
}
