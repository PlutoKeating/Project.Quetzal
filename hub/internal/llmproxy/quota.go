// SPDX-License-Identifier: AGPL-3.0-only

package llmproxy

import (
	"bytes"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

var (
	ErrNotImplemented = errors.New("not implemented")
	ErrQuotaExceeded  = errors.New("llm token quota exceeded")
)

const (
	defaultOutputBudgetTokens int64 = 512
	maxOutputBudgetTokens     int64 = 1_000_000
	baseImageTokens           int64 = 256
	baseAudioVideoTokens      int64 = 320
)

type QuotaLimits struct {
	AccountDailyTokens int64
	AccountTotalTokens int64
	AgentDailyTokens   int64
	AgentTotalTokens   int64
}

type QuotaSnapshot struct {
	UsedDailyTokens int64
	UsedTotalTokens int64
	ReservedTokens  int64
}

type usageBucket struct {
	dayUTC    string
	usedDaily int64
	usedTotal int64
	reserved  int64
}

func (b *usageBucket) rollDay(dayUTC string) {
	if b.dayUTC != dayUTC {
		b.dayUTC = dayUTC
		b.usedDaily = 0
	}
}

type QuotaTracker struct {
	mu       sync.Mutex
	limits   QuotaLimits
	clock    func() time.Time
	accounts map[string]*usageBucket
	agents   map[string]*usageBucket
}

type Reservation struct {
	tracker        *QuotaTracker
	accountID      string
	agentID        string
	ReservedTokens int64
	settleOnce     sync.Once
}

func NewQuotaTracker(limits QuotaLimits, clock func() time.Time) *QuotaTracker {
	if clock == nil {
		clock = time.Now
	}
	return &QuotaTracker{
		limits:   limits,
		clock:    clock,
		accounts: make(map[string]*usageBucket),
		agents:   make(map[string]*usageBucket),
	}
}

func (q *QuotaTracker) currentDayUTC() string {
	return q.clock().UTC().Format("2006-01-02")
}

func (q *QuotaTracker) getOrCreateAccountLocked(accountID, day string) *usageBucket {
	b, ok := q.accounts[accountID]
	if !ok {
		b = &usageBucket{dayUTC: day}
		q.accounts[accountID] = b
	}
	b.rollDay(day)
	return b
}

func (q *QuotaTracker) getOrCreateAgentLocked(agentID, day string) *usageBucket {
	b, ok := q.agents[agentID]
	if !ok {
		b = &usageBucket{dayUTC: day}
		q.agents[agentID] = b
	}
	b.rollDay(day)
	return b
}

func (q *QuotaTracker) Reserve(accountID, agentID string, estimated int64) (*Reservation, error) {
	if estimated < 1 {
		estimated = 1
	}
	q.mu.Lock()
	defer q.mu.Unlock()

	day := q.currentDayUTC()
	acc := q.getOrCreateAccountLocked(accountID, day)
	if q.limits.AccountDailyTokens > 0 && acc.usedDaily+acc.reserved+estimated > q.limits.AccountDailyTokens {
		return nil, ErrQuotaExceeded
	}
	if q.limits.AccountTotalTokens > 0 && acc.usedTotal+acc.reserved+estimated > q.limits.AccountTotalTokens {
		return nil, ErrQuotaExceeded
	}

	var ag *usageBucket
	if agentID != "" {
		ag = q.getOrCreateAgentLocked(agentID, day)
		if q.limits.AgentDailyTokens > 0 && ag.usedDaily+ag.reserved+estimated > q.limits.AgentDailyTokens {
			return nil, ErrQuotaExceeded
		}
		if q.limits.AgentTotalTokens > 0 && ag.usedTotal+ag.reserved+estimated > q.limits.AgentTotalTokens {
			return nil, ErrQuotaExceeded
		}
	}

	acc.reserved += estimated
	if ag != nil {
		ag.reserved += estimated
	}

	return &Reservation{
		tracker:        q,
		accountID:      accountID,
		agentID:        agentID,
		ReservedTokens: estimated,
	}, nil
}

func (r *Reservation) Settle(actualConsumed int64) {
	if r == nil || r.tracker == nil {
		return
	}
	if actualConsumed < 0 {
		actualConsumed = 0
	}
	r.settleOnce.Do(func() {
		q := r.tracker
		q.mu.Lock()
		defer q.mu.Unlock()

		day := q.currentDayUTC()
		acc := q.getOrCreateAccountLocked(r.accountID, day)
		acc.reserved -= r.ReservedTokens
		if acc.reserved < 0 {
			acc.reserved = 0
		}
		acc.usedDaily += actualConsumed
		acc.usedTotal += actualConsumed

		if r.agentID != "" {
			ag := q.getOrCreateAgentLocked(r.agentID, day)
			ag.reserved -= r.ReservedTokens
			if ag.reserved < 0 {
				ag.reserved = 0
			}
			ag.usedDaily += actualConsumed
			ag.usedTotal += actualConsumed
		}
	})
}

func (q *QuotaTracker) AccountSnapshot(accountID string) QuotaSnapshot {
	q.mu.Lock()
	defer q.mu.Unlock()
	day := q.currentDayUTC()
	b, ok := q.accounts[accountID]
	if !ok {
		return QuotaSnapshot{}
	}
	b.rollDay(day)
	return QuotaSnapshot{
		UsedDailyTokens: b.usedDaily,
		UsedTotalTokens: b.usedTotal,
		ReservedTokens:  b.reserved,
	}
}

func (q *QuotaTracker) AgentSnapshot(agentID string) QuotaSnapshot {
	q.mu.Lock()
	defer q.mu.Unlock()
	day := q.currentDayUTC()
	b, ok := q.agents[agentID]
	if !ok {
		return QuotaSnapshot{}
	}
	b.rollDay(day)
	return QuotaSnapshot{
		UsedDailyTokens: b.usedDaily,
		UsedTotalTokens: b.usedTotal,
		ReservedTokens:  b.reserved,
	}
}

// EstimateInputTokens computes the structural input-side token estimate (including multimodal image/audio multipliers)
// without retaining or logging any prompt content.
func EstimateInputTokens(rawBody []byte) (inputTokens int64, outputAndReasoningBudget int64) {
	if len(rawBody) == 0 {
		return 1, defaultOutputBudgetTokens
	}

	var root map[string]any
	dec := json.NewDecoder(bytes.NewReader(rawBody))
	dec.UseNumber()
	if err := dec.Decode(&root); err != nil {
		// Malformed or opaque payload fallback: byte heuristic + default output budget
		return max(1, int64(len(rawBody)+3)/4), defaultOutputBudgetTokens
	}

	var textBytes int64
	var mediaTokens int64
	walkMultimodalValue(root["messages"], &textBytes, &mediaTokens, "")
	walkMultimodalValue(root["input"], &textBytes, &mediaTokens, "")
	walkMultimodalValue(root["system"], &textBytes, &mediaTokens, "")
	walkMultimodalValue(root["contents"], &textBytes, &mediaTokens, "")

	inputEst := max(1, (textBytes+3)/4) + mediaTokens

	maxOut := extractInt64Field(root, "max_tokens", "max_completion_tokens", "max_output_tokens")
	if maxOut <= 0 {
		if genCfg, ok := root["generationConfig"].(map[string]any); ok {
			maxOut = extractInt64Field(genCfg, "maxOutputTokens")
		}
	}
	if maxOut <= 0 {
		maxOut = defaultOutputBudgetTokens
	} else if maxOut > maxOutputBudgetTokens {
		maxOut = maxOutputBudgetTokens
	}

	var reasoningBudget int64
	if thinking, ok := root["thinking"].(map[string]any); ok {
		reasoningBudget += max(0, extractInt64Field(thinking, "budget_tokens"))
	}
	if reasoning, ok := root["reasoning"].(map[string]any); ok {
		rb := extractInt64Field(reasoning, "budget_tokens", "max_tokens")
		if rb > 0 {
			reasoningBudget += rb
		} else if effort, ok := reasoning["effort"].(string); ok {
			reasoningBudget += effortTokens(effort)
		}
	}
	if effort, ok := root["reasoning_effort"].(string); ok {
		reasoningBudget += effortTokens(effort)
	}

	return inputEst, maxOut + reasoningBudget
}

func EstimateRequestTokens(rawBody []byte) int64 {
	inTok, outTok := EstimateInputTokens(rawBody)
	return inTok + outTok
}

func effortTokens(effort string) int64 {
	switch effort {
	case "low":
		return 512
	case "medium":
		return 1024
	case "high":
		return 2048
	case "xhigh", "max":
		return 4096
	default:
		return 0
	}
}

func extractInt64Field(m map[string]any, keys ...string) int64 {
	for _, k := range keys {
		v, ok := m[k]
		if !ok {
			continue
		}
		switch n := v.(type) {
		case json.Number:
			if i, err := n.Int64(); err == nil {
				return i
			}
		case float64:
			return int64(n)
		}
	}
	return 0
}

func walkMultimodalValue(v any, textBytes *int64, mediaTokens *int64, mediaKind string) {
	if v == nil {
		return
	}
	switch val := v.(type) {
	case string:
		switch mediaKind {
		case "image":
			*mediaTokens += int64(len(val)) / 32
		case "audio":
			*mediaTokens += int64(len(val)) / 24
		default:
			*textBytes += int64(len(val))
		}
	case []any:
		for _, item := range val {
			walkMultimodalValue(item, textBytes, mediaTokens, mediaKind)
		}
	case map[string]any:
		blockKind := mediaKind
		if tStr, ok := val["type"].(string); ok {
			switch tStr {
			case "image", "image_url", "input_image":
				blockKind = "image"
				*mediaTokens += baseImageTokens
			case "input_audio", "audio", "video", "video_url":
				blockKind = "audio"
				*mediaTokens += baseAudioVideoTokens
			}
		}
		if inline, ok := val["inlineData"].(map[string]any); ok {
			mime, _ := inline["mimeType"].(string)
			if len(mime) >= 6 && mime[:6] == "image/" {
				*mediaTokens += baseImageTokens
				walkMultimodalValue(inline["data"], textBytes, mediaTokens, "image")
				return
			}
			*mediaTokens += baseAudioVideoTokens
			walkMultimodalValue(inline["data"], textBytes, mediaTokens, "audio")
			return
		}
		for k, child := range val {
			if k == "type" || k == "role" || k == "format" || k == "media_type" {
				continue
			}
			childKind := blockKind
			if blockKind != "" && k != "data" && k != "url" && k != "source" && k != "image_url" && k != "input_audio" {
				childKind = ""
			}
			walkMultimodalValue(child, textBytes, mediaTokens, childKind)
		}
	}
}
