#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-fabric` — 基于 `iroh 1.5` 的零中心端到端加密穿透平面、
//! 密文 Packfile 双模同步器、两态围栏动态 `Router` 租约协调器与跨机异构 `RemoteWorkerPool`。

pub mod endpoint;
pub mod lease_router;
pub mod sync_actor;
pub mod worker_pool;

pub use endpoint::{
    FABRIC_ALPN, FabricNode, FabricNodeConfig, FabricPeerEndpoint, FabricRelaySettings,
    FabricRpcHandler, FabricRpcRequest, FabricRpcResponse, HubAuthSession, HubClient,
    HubClientConfig, LeaseWitnessRecord, PairHpkeBundle, PairInitiateResponse, PairStatusResponse,
    PeerPathKind, PeerStatusSnapshot, QadReportSnapshot, parse_ca_certs_pem_or_der,
};
pub use lease_router::{
    FencedDeliveryOutcome, FencedLeaseCoordinator, LeaseCoordinatorConfig, LeaseNetworkOutcome,
    LeaseNetworkReport, LeaseWitnessBackend, MonotonicClock, OutboxReconcileItem,
    OutboxReconcileOutcome, OutboxReconcilePlan, RouterLeaseState, SimulatedMonotonicClock,
    StdMonotonicClock,
};
pub use sync_actor::{PeerSyncOutcome, PeerSyncPlan, SpineSyncActor, SpineSyncBackend, SyncReport};
pub use worker_pool::{
    NodeCapabilityAnnouncement, NodeCapabilitySpec, RemoteWorkerPool, RemoteWorkerTaskResult,
    RemoteWorkerTaskSpec, enforce_remote_worker_lease_fence, execute_remote_worker_task_locally,
};
