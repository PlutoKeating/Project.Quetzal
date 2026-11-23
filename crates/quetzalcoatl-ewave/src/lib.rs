#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-ewave` — 兼容 `@plutokeating/ewave@0.2.0` JSON-v2 的蛇形四维记忆核与两段式良知治理引擎。

pub mod align;
pub mod arbiter;
pub mod assembler;
pub mod conscience;
pub mod graph;

pub use align::{
    AlignOptions, AlignmentPair, AlignmentResult, MergeOptions, MergeResult, SayItIngestContext,
    SayItIngestResult, SayItIngestStatus, SayItSessionRecord,
};
pub use arbiter::{
    ArbiterBatchReport, ArbiterMode, ConscienceArbiter, Proposal, ProposalEvaluation,
    ProposalStatus, ReflectorAttestation, SelfCorePolicy, compute_evidence_hash,
};
pub use assembler::{
    ANTI_MIND_VIRUS_IMMUNITY_CLAUSE, AssembledContext, AssemblyRequest, BudgetProfile,
    ContextAssembler, GrantAccessRecord, IncomingPeerMessage,
};
pub use conscience::{
    Authority, Conscience, ConscienceManifest, DisclosureNotice, Episode, FocusConfig,
    FocusShiftOutcome, GrantScope, IdentityBlock, MemoryEntry, MemoryKind, ModelRef, ModelRole,
    Mutability, MutabilityMode, PeerKind, PersonaGrant, ProtectedDirective, ProvenanceRecord,
    Relationship, SharedField, SignalKind, ValueEntry, canonicalize_protected_text,
    compute_directive_blake3,
};
pub use graph::{
    ActivateOptions, ActivatedRegion, AddOptions, AttachOptions, BranchOptions, ClusteringFeature,
    CollapseTimeOptions, DEFAULT_EMB_DIM, DEFAULT_EMB_MODEL_ID, EdgeKind, EdgeSnapshot,
    EwaveSnapshot, GraphEdge, GraphNode, GraphOptions, GraphStats, LinkOptions, LockActor,
    LockMode, LogicPolarity, NodeId, NodeKind, NodeLock, NodeSnapshot, ObserveAction,
    ObserveOptions, ObserveResult, QueryInput, ScoredEdgeNode, ScoredNode, SerpentineGraph,
    SplitOptions, SplitResult, TemporalFilter, TemporalInput, TemporalMode, TemporalTag,
    TimeSliceSummary, cf_centroid, cf_combine, cf_from_vector, cmp_utf16, cosine_distance,
    cosine_similarity, fnv1a_utf16, hash_embed, hash_embed_64, lexical_jaccard,
    normalize_nfkc_lower_trim, normalize_vector,
};
