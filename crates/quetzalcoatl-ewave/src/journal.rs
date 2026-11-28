//! 变更日志：良知的每一次变更都是脊柱里的一条事件，良知本身由事件重放得到。
//!
//! 三条规矩：
//! 1. **事件是唯一的真相。** 内存里的良知只是重放的结果；任何改动都要先能写成事件，否则回滚。
//! 2. **正文不以明文进链。** 每个条目用自己的钥匙封存后才写入事件；钥匙放在可以删除的地方。
//!    销毁钥匙即抹除——签名链不动，但那一条再也读不出来。
//! 3. **按条目记差异，不记整份快照。** 一条事件只带这一次变了的条目，谁改的都一样：
//!    仲裁器、导入、治理面上的亲手修改，走的是同一个提交函数。

use std::collections::{BTreeMap, BTreeSet};

use quetzalcoatl_crypto::{EntryKey, PackCompartment, SealedEntry, open_entry, seal_entry};
use quetzalcoatl_spine::{MaterializedStore, SpineEngine};
use quetzalcoatl_types::{QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

use crate::conscience::{
    Conscience, ConscienceManifest, DisclosureNotice, Episode, FocusConfig, IdentityBlock,
    MemoryEntry, PersonaGrant, ProtectedDirective, Relationship, ValueEntry,
};

/// 变更事件的类别标记。
pub const SEA_CHANGE_KIND: &str = "sea.change";
/// 条目钥匙在本地私有存储里的键前缀。
const ENTRY_KEY_PREFIX: &str = "sea.entry-key";

/// 条目所在的层。
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeaLayer {
    Identity,
    Value,
    Relationship,
    Memory,
    Episode,
}

impl SeaLayer {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Identity => "identity",
            Self::Value => "value",
            Self::Relationship => "relationship",
            Self::Memory => "memory",
            Self::Episode => "episode",
        }
    }
}

/// 一处变更。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum SeaDelta {
    /// 新增或整条替换一个条目；正文已封存。
    EntryPut {
        layer: SeaLayer,
        id: String,
        sealed: SealedEntry,
    },
    /// 抹除一个条目：它的钥匙已销毁。
    EntryRemove {
        layer: SeaLayer,
        id: String,
    },
    /// 底线与部署约束连同签名清单一起更换。
    DirectivesSigned {
        root: Vec<ProtectedDirective>,
        operator: Vec<ProtectedDirective>,
        manifest: ConscienceManifest,
    },
    FocusSet {
        focus: FocusConfig,
    },
    DisclosuresSet {
        pending: Vec<DisclosureNotice>,
    },
    GrantsSet {
        given: Vec<PersonaGrant>,
        received: Vec<PersonaGrant>,
    },
    PeerLinksSet {
        links: BTreeMap<String, String>,
    },
}

/// 一条变更事件。除条目正文外，其余字段都是明文，可直接用于审计。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SeaChangeEvent {
    pub kind: String,
    pub schema_version: String,
    /// 谁改的：`owner`（本人亲手）、`arbiter`（仲裁放行）、`import`、`system`。
    pub actor: String,
    /// 写入时持有的纪元；多设备下用来丢弃过期纪元写下的变更。
    pub epoch: u64,
    pub at_ms: u64,
    /// 给审计看的一句话，不含任何条目正文。
    pub summary: String,
    pub deltas: Vec<SeaDelta>,
}

/// 条目钥匙的存放处。必须是能真正删除的地方。
pub trait EntryKeyStore {
    fn load_key(&self, layer: SeaLayer, id: &str) -> Result<Option<EntryKey>>;
    /// 取这个条目的钥匙，没有就新建一把并存下。
    fn obtain_key(&mut self, layer: SeaLayer, id: &str) -> Result<EntryKey>;
    fn destroy_key(&mut self, layer: SeaLayer, id: &str) -> Result<()>;
}

/// 把条目钥匙放在脊柱本地库的私有存储里（不进签名链、不进导出的密文包）。
pub struct StoreEntryKeys<'a, S: MaterializedStore>(pub &'a mut S);

/// 一个条目的钥匙在私有状态块里的名字。
pub fn entry_key_blob_name(layer: SeaLayer, id: &str) -> String {
    format!("{ENTRY_KEY_PREFIX}/{}/{id}", layer.as_str())
}

impl<S: MaterializedStore> EntryKeyStore for StoreEntryKeys<'_, S> {
    fn load_key(&self, layer: SeaLayer, id: &str) -> Result<Option<EntryKey>> {
        match self.0.get_private_blob(&entry_key_blob_name(layer, id))? {
            Some(hex) => Ok(Some(EntryKey::from_hex(hex.trim())?)),
            None => Ok(None),
        }
    }

    fn obtain_key(&mut self, layer: SeaLayer, id: &str) -> Result<EntryKey> {
        if let Some(existing) = self.load_key(layer, id)? {
            return Ok(existing);
        }
        let key = EntryKey::generate();
        self.0
            .put_private_blob(&entry_key_blob_name(layer, id), &key.to_hex())?;
        Ok(key)
    }

    fn destroy_key(&mut self, layer: SeaLayer, id: &str) -> Result<()> {
        self.0.delete_private_blob(&entry_key_blob_name(layer, id))
    }
}

fn serialization_error(what: &str, err: &serde_json::Error) -> QuetzalcoatlError {
    QuetzalcoatlError::SerializationError {
        detail: format!("{what}: {err}"),
    }
}

fn to_json<T: Serialize>(value: &T, what: &str) -> Result<String> {
    serde_json::to_string(value).map_err(|e| serialization_error(what, &e))
}

/// 把良知里的条目摊平成「层 + 编号 → 规范 JSON」，保持各层内的原有顺序。
fn flatten_entries(conscience: &Conscience) -> Result<Vec<((SeaLayer, String), String)>> {
    let mut out = Vec::new();
    for block in &conscience.identity {
        out.push((
            (SeaLayer::Identity, block.id.clone()),
            to_json(block, "序列化身份块失败")?,
        ));
    }
    for value in &conscience.values {
        out.push((
            (SeaLayer::Value, value.id.clone()),
            to_json(value, "序列化价值条目失败")?,
        ));
    }
    for relationship in &conscience.relationships {
        out.push((
            (SeaLayer::Relationship, relationship.id.clone()),
            to_json(relationship, "序列化关系失败")?,
        ));
    }
    for memory in &conscience.memories {
        out.push((
            (SeaLayer::Memory, memory.id.clone()),
            to_json(memory, "序列化记忆失败")?,
        ));
    }
    for episode in &conscience.episodes {
        out.push((
            (SeaLayer::Episode, episode.id.clone()),
            to_json(episode, "序列化相处记录失败")?,
        ));
    }
    Ok(out)
}

/// 还没封存的变更：条目正文是明文 JSON。
enum PlainDelta {
    Put {
        layer: SeaLayer,
        id: String,
        json: String,
    },
    Remove {
        layer: SeaLayer,
        id: String,
    },
    Ready(Box<SeaDelta>),
}

/// 计算从 `before` 到 `after` 的差异。`before` 为 `None` 表示从无到有（收编为基线）。
fn diff(before: Option<&Conscience>, after: &Conscience) -> Result<Vec<PlainDelta>> {
    let mut deltas = Vec::new();

    let directives_changed = before.is_none_or(|b| {
        b.manifest != after.manifest
            || b.root_directives != after.root_directives
            || b.operator_directives != after.operator_directives
    });
    if directives_changed {
        deltas.push(PlainDelta::Ready(Box::new(SeaDelta::DirectivesSigned {
            root: after.root_directives.clone(),
            operator: after.operator_directives.clone(),
            manifest: after.manifest.clone(),
        })));
    }

    let after_entries = flatten_entries(after)?;
    let before_entries: BTreeMap<(SeaLayer, String), String> = match before {
        Some(b) => flatten_entries(b)?.into_iter().collect(),
        None => BTreeMap::new(),
    };
    let after_keys: BTreeSet<(SeaLayer, String)> =
        after_entries.iter().map(|(key, _)| key.clone()).collect();
    for ((layer, id), json) in after_entries {
        if before_entries.get(&(layer, id.clone())) != Some(&json) {
            deltas.push(PlainDelta::Put { layer, id, json });
        }
    }
    for (layer, id) in before_entries.into_keys() {
        if !after_keys.contains(&(layer, id.clone())) {
            deltas.push(PlainDelta::Remove { layer, id });
        }
    }

    if before.is_none_or(|b| b.focus != after.focus) {
        deltas.push(PlainDelta::Ready(Box::new(SeaDelta::FocusSet {
            focus: after.focus.clone(),
        })));
    }
    let disclosures_changed = match before {
        Some(b) => b.pending_disclosures != after.pending_disclosures,
        None => !after.pending_disclosures.is_empty(),
    };
    if disclosures_changed {
        deltas.push(PlainDelta::Ready(Box::new(SeaDelta::DisclosuresSet {
            pending: after.pending_disclosures.clone(),
        })));
    }
    let grants_changed = match before {
        Some(b) => {
            b.grants_given != after.grants_given || b.grants_received != after.grants_received
        }
        None => !after.grants_given.is_empty() || !after.grants_received.is_empty(),
    };
    if grants_changed {
        deltas.push(PlainDelta::Ready(Box::new(SeaDelta::GrantsSet {
            given: after.grants_given.clone(),
            received: after.grants_received.clone(),
        })));
    }
    let links_changed = match before {
        Some(b) => b.peer_links != after.peer_links,
        None => !after.peer_links.is_empty(),
    };
    if links_changed {
        deltas.push(PlainDelta::Ready(Box::new(SeaDelta::PeerLinksSet {
            links: after.peer_links.clone(),
        })));
    }
    Ok(deltas)
}

/// 把 `before → after` 的差异写成一条变更事件。没有差异时什么都不写，返回 `None`。
///
/// 抹除（条目从 `after` 里消失）时先销毁钥匙、再写事件：即使在两步之间崩溃，
/// 重放时也会因为钥匙不在而把那一条当作已抹除。
pub fn commit<S: MaterializedStore>(
    spine: &mut SpineEngine<S>,
    before: Option<&Conscience>,
    after: &Conscience,
    actor: &str,
    epoch: u64,
    summary: &str,
    now_ms: u64,
) -> Result<Option<u64>> {
    let plain = diff(before, after)?;
    if plain.is_empty() {
        return Ok(None);
    }
    let mut deltas = Vec::with_capacity(plain.len());
    {
        let mut keys = StoreEntryKeys(spine.store_mut());
        for delta in plain {
            match delta {
                PlainDelta::Put { layer, id, json } => {
                    let key = keys.obtain_key(layer, &id)?;
                    let sealed = seal_entry(&key, &id, json.as_bytes())?;
                    deltas.push(SeaDelta::EntryPut { layer, id, sealed });
                }
                PlainDelta::Remove { layer, id } => {
                    keys.destroy_key(layer, &id)?;
                    deltas.push(SeaDelta::EntryRemove { layer, id });
                }
                PlainDelta::Ready(ready) => deltas.push(*ready),
            }
        }
    }
    let event = SeaChangeEvent {
        kind: String::from(SEA_CHANGE_KIND),
        schema_version: after.schema_version.clone(),
        actor: String::from(actor),
        epoch,
        at_ms: now_ms,
        summary: String::from(summary),
        deltas,
    };
    let payload = to_json(&event, "序列化变更事件失败")?;
    let appended = spine.append_event(PackCompartment::Core, &payload, now_ms)?;
    Ok(Some(appended.header.seq))
}

#[derive(Default)]
struct Rebuilt {
    schema_version: String,
    directives: Option<(
        Vec<ProtectedDirective>,
        Vec<ProtectedDirective>,
        ConscienceManifest,
    )>,
    identity: Vec<IdentityBlock>,
    values: Vec<ValueEntry>,
    relationships: Vec<Relationship>,
    memories: Vec<MemoryEntry>,
    episodes: Vec<Episode>,
    focus: Option<FocusConfig>,
    disclosures: Vec<DisclosureNotice>,
    grants_given: Vec<PersonaGrant>,
    grants_received: Vec<PersonaGrant>,
    peer_links: BTreeMap<String, String>,
}

fn upsert_by_id<T>(items: &mut Vec<T>, entry: T, id_of: impl Fn(&T) -> &str) {
    let id = id_of(&entry).to_owned();
    if let Some(slot) = items.iter_mut().find(|item| id_of(item) == id) {
        *slot = entry;
    } else {
        items.push(entry);
    }
}

impl Rebuilt {
    fn remove(&mut self, layer: SeaLayer, id: &str) {
        match layer {
            SeaLayer::Identity => self.identity.retain(|e| e.id != id),
            SeaLayer::Value => self.values.retain(|e| e.id != id),
            SeaLayer::Relationship => self.relationships.retain(|e| e.id != id),
            SeaLayer::Memory => self.memories.retain(|e| e.id != id),
            SeaLayer::Episode => self.episodes.retain(|e| e.id != id),
        }
    }

    fn put(&mut self, layer: SeaLayer, plaintext: &[u8]) -> Result<()> {
        let bad = |e: serde_json::Error| serialization_error("解析变更事件里的条目失败", &e);
        match layer {
            SeaLayer::Identity => upsert_by_id(
                &mut self.identity,
                serde_json::from_slice(plaintext).map_err(bad)?,
                |e: &IdentityBlock| e.id.as_str(),
            ),
            SeaLayer::Value => upsert_by_id(
                &mut self.values,
                serde_json::from_slice(plaintext).map_err(bad)?,
                |e: &ValueEntry| e.id.as_str(),
            ),
            SeaLayer::Relationship => upsert_by_id(
                &mut self.relationships,
                serde_json::from_slice(plaintext).map_err(bad)?,
                |e: &Relationship| e.id.as_str(),
            ),
            SeaLayer::Memory => upsert_by_id(
                &mut self.memories,
                serde_json::from_slice(plaintext).map_err(bad)?,
                |e: &MemoryEntry| e.id.as_str(),
            ),
            SeaLayer::Episode => upsert_by_id(
                &mut self.episodes,
                serde_json::from_slice(plaintext).map_err(bad)?,
                |e: &Episode| e.id.as_str(),
            ),
        }
        Ok(())
    }

    fn apply(&mut self, delta: SeaDelta, keys: &dyn EntryKeyStore) -> Result<()> {
        match delta {
            SeaDelta::EntryPut { layer, id, sealed } => match keys.load_key(layer, &id)? {
                Some(key) => {
                    let plaintext = open_entry(&key, &id, &sealed)?;
                    self.put(layer, &plaintext)?;
                }
                // 钥匙不在了：这一条已被抹除，连它更早的版本也一并拿掉。
                None => self.remove(layer, &id),
            },
            SeaDelta::EntryRemove { layer, id } => self.remove(layer, &id),
            SeaDelta::DirectivesSigned {
                root,
                operator,
                manifest,
            } => self.directives = Some((root, operator, manifest)),
            SeaDelta::FocusSet { focus } => self.focus = Some(focus),
            SeaDelta::DisclosuresSet { pending } => self.disclosures = pending,
            SeaDelta::GrantsSet { given, received } => {
                self.grants_given = given;
                self.grants_received = received;
            }
            SeaDelta::PeerLinksSet { links } => self.peer_links = links,
        }
        Ok(())
    }

    fn finish(self) -> Option<Conscience> {
        let (root_directives, operator_directives, manifest) = self.directives?;
        Some(Conscience {
            schema_version: self.schema_version,
            root_directives,
            operator_directives,
            manifest,
            identity: self.identity,
            values: self.values,
            relationships: self.relationships,
            memories: self.memories,
            focus: self.focus.unwrap_or_default(),
            grants_given: self.grants_given,
            grants_received: self.grants_received,
            episodes: self.episodes,
            peer_links: self.peer_links,
            pending_disclosures: self.disclosures,
        })
    }
}

/// 一个条目的一个版本：谁、什么时候写下的，当时的完整内容。
#[derive(Clone, Debug, PartialEq)]
pub struct EntryVersion {
    pub at_ms: u64,
    pub actor: String,
    pub summary: String,
    pub value: serde_json::Value,
}

/// 按时间先后列出一个条目的每一个版本。钥匙已经销毁（被抹除）的条目返回空。
pub fn entry_history<S: MaterializedStore>(
    spine: &mut SpineEngine<S>,
    layer: SeaLayer,
    id: &str,
) -> Result<Vec<EntryVersion>> {
    let keys = StoreEntryKeys(spine.store_mut());
    let Some(key) = keys.load_key(layer, id)? else {
        return Ok(Vec::new());
    };
    let mut versions = Vec::new();
    for (event, _) in spine.store().list_all_events()? {
        if !event.payload_utf8.contains(SEA_CHANGE_KIND) || !event.payload_utf8.contains(id) {
            continue;
        }
        let Ok(change) = serde_json::from_str::<SeaChangeEvent>(&event.payload_utf8) else {
            continue;
        };
        for delta in &change.deltas {
            if let SeaDelta::EntryPut {
                layer: delta_layer,
                id: delta_id,
                sealed,
            } = delta
                && *delta_layer == layer
                && delta_id == id
            {
                let plaintext = open_entry(&key, id, sealed)?;
                let value = serde_json::from_slice(&plaintext).map_err(|e| {
                    QuetzalcoatlError::SerializationError {
                        detail: format!("条目版本无法解析: {e}"),
                    }
                })?;
                versions.push(EntryVersion {
                    at_ms: change.at_ms,
                    actor: change.actor.clone(),
                    summary: change.summary.clone(),
                    value,
                });
            }
        }
    }
    Ok(versions)
}

/// 变更日志里被抹除过的全部条目（层与编号）。收到别的设备的抹除后，本机据此销毁对应的钥匙。
pub fn erased_entries<S: MaterializedStore>(
    spine: &SpineEngine<S>,
) -> Result<Vec<(SeaLayer, String)>> {
    let mut out = Vec::new();
    for (event, _) in spine.store().list_all_events()? {
        if !event.payload_utf8.contains(SEA_CHANGE_KIND) {
            continue;
        }
        let Ok(change) = serde_json::from_str::<SeaChangeEvent>(&event.payload_utf8) else {
            continue;
        };
        for delta in change.deltas {
            if let SeaDelta::EntryRemove { layer, id } = delta {
                out.push((layer, id));
            }
        }
    }
    Ok(out)
}

/// 由脊柱里的变更事件重放出良知。还没有任何变更事件时返回 `None`。
///
/// `current_epoch` 之后的纪元写下的变更照常应用；多设备下由调用方保证只有持控制权的设备写变更。
pub fn replay<S: MaterializedStore>(spine: &mut SpineEngine<S>) -> Result<Option<Conscience>> {
    let events = spine.store().list_all_events()?;
    let mut changes: Vec<SeaChangeEvent> = Vec::new();
    for (event, _) in events {
        // 先看类别再整段解析：脊柱里绝大多数事件不是变更事件。
        if !event.payload_utf8.contains(SEA_CHANGE_KIND) {
            continue;
        }
        if let Ok(change) = serde_json::from_str::<SeaChangeEvent>(&event.payload_utf8)
            && change.kind == SEA_CHANGE_KIND
        {
            changes.push(change);
        }
    }
    if changes.is_empty() {
        return Ok(None);
    }
    let mut rebuilt = Rebuilt::default();
    let keys = StoreEntryKeys(spine.store_mut());
    for change in changes {
        rebuilt.schema_version = change.schema_version;
        for delta in change.deltas {
            rebuilt.apply(delta, &keys)?;
        }
    }
    Ok(rebuilt.finish())
}
