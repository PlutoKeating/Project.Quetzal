//! 无状态房间协调席（Facilitator）：由当前 `FencedLeaseCoordinator` 持有者按
//! `witness_epoch` 选举，串行化共享资源请求并负责任务路由；新持有者接管不重放历史。

use std::collections::VecDeque;

use quetzalcoatl_types::{AgentId, DeviceId, QuetzalcoatlError, Result};

/// 协调席持有者视图（由 fabric `FencedLeaseCoordinator` 当前 `ActiveRouter` 派生）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FacilitatorHolder {
    pub device_id: DeviceId,
    pub witness_epoch: u64,
}

/// 共享资源请求（如唯一厨房时段、唯一预算配额）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SharedResourceRequest {
    pub request_id: String,
    pub agent_id: AgentId,
    pub resource: String,
    pub requested_at_group_seq: u64,
}

/// 协调席签发的共享资源票据（严格串行，杜绝并发抢占）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SharedResourceTicket {
    pub request_id: String,
    pub agent_id: AgentId,
    pub resource: String,
    pub granted_at_group_seq: u64,
    pub serial_index: u64,
}

/// 协调席路由的任务记录。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskRoute {
    pub request_id: String,
    pub agent_id: AgentId,
    pub resource: String,
    pub serial_index: u64,
}

/// 房间协调席。
#[derive(Clone, Debug)]
pub struct RoomFacilitator {
    room_id: String,
    holder: FacilitatorHolder,
    pending: VecDeque<SharedResourceRequest>,
    routed_tasks: Vec<TaskRoute>,
    replayed_history: Vec<String>,
    next_serial: u64,
}

impl RoomFacilitator {
    /// 依据当前租约持有者选举协调席；无持有者时拒绝（`PERMISSION_DENIED`）。
    pub fn elect(room_id: impl Into<String>, holder: Option<FacilitatorHolder>) -> Result<Self> {
        let holder = holder.ok_or_else(|| QuetzalcoatlError::PermissionDenied {
            detail: String::from(
                "当前无 ActiveRouter 租约持有者，禁止选举房间协调席（防双协调席脑裂）",
            ),
        })?;
        if holder.witness_epoch == 0 {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("witness_epoch 为 0 的租约不得承担协调席"),
            });
        }
        Ok(Self {
            room_id: room_id.into(),
            holder,
            pending: VecDeque::new(),
            routed_tasks: Vec::new(),
            replayed_history: Vec::new(),
            next_serial: 1,
        })
    }

    #[must_use]
    pub fn room_id(&self) -> &str {
        &self.room_id
    }

    #[must_use]
    pub const fn witness_epoch(&self) -> u64 {
        self.holder.witness_epoch
    }

    #[must_use]
    pub const fn holder(&self) -> &FacilitatorHolder {
        &self.holder
    }

    #[must_use]
    pub fn routed_task_count(&self) -> usize {
        self.routed_tasks.len()
    }

    #[must_use]
    pub fn pending_queue_is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// 新持有者接管时绝不重放历史（无状态协调席）。
    #[must_use]
    pub fn replayed_history_len(&self) -> usize {
        self.replayed_history.len()
    }

    pub fn enqueue(&mut self, request: SharedResourceRequest) -> Result<()> {
        if request.resource.trim().is_empty() || request.request_id.trim().is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "SharedResourceRequest",
                "request_id 与 resource 不能为空",
            ));
        }
        let duplicate = self
            .pending
            .iter()
            .any(|queued| queued.request_id == request.request_id)
            || self
                .routed_tasks
                .iter()
                .any(|routed| routed.request_id == request.request_id);
        if duplicate {
            return Err(QuetzalcoatlError::DeliveryRefused {
                detail: format!("重复的共享资源请求: {}", request.request_id),
            });
        }
        self.pending.push_back(request);
        Ok(())
    }

    pub fn enqueue_all(&mut self, requests: impl IntoIterator<Item = SharedResourceRequest>) {
        for request in requests {
            // 重复请求在批量路径上直接丢弃，由单条 enqueue 负责显式报错。
            if self.enqueue(request).is_err() {
                continue;
            }
        }
    }

    /// 一轮内串行签发共享资源票据并登记路由。
    pub fn drain_round(&mut self, round: u64) -> Vec<SharedResourceTicket> {
        let mut tickets = Vec::with_capacity(self.pending.len());
        while let Some(request) = self.pending.pop_front() {
            let ticket = SharedResourceTicket {
                request_id: request.request_id.clone(),
                agent_id: request.agent_id,
                resource: request.resource.clone(),
                granted_at_group_seq: round,
                serial_index: self.next_serial,
            };
            self.routed_tasks.push(TaskRoute {
                request_id: request.request_id,
                agent_id: request.agent_id,
                resource: request.resource,
                serial_index: self.next_serial,
            });
            self.next_serial = self.next_serial.saturating_add(1);
            tickets.push(ticket);
        }
        tickets
    }

    #[must_use]
    pub fn routed_tasks(&self) -> &[TaskRoute] {
        &self.routed_tasks
    }

    /// 租约易主：新持有者接管协调席，清空未决队列且不重放历史。
    pub fn handover(&self, next: FacilitatorHolder) -> Result<Self> {
        if next.witness_epoch <= self.holder.witness_epoch {
            return Err(QuetzalcoatlError::StaleLeaseEpoch {
                provided: next.witness_epoch,
                current: self.holder.witness_epoch,
            });
        }
        Ok(Self {
            room_id: self.room_id.clone(),
            holder: next,
            pending: VecDeque::new(),
            routed_tasks: self.routed_tasks.clone(),
            replayed_history: Vec::new(),
            next_serial: self.next_serial,
        })
    }
}
