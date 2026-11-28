#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 根私钥被口令包裹后，密钥环只凭根公钥与签过名的成员变更日志恢复。

use std::collections::BTreeMap;
use std::error::Error;

use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity, EpochKey, EpochKeyRing};
use quetzalcoatl_types::{AgentId, DeviceId, Epoch};

#[test]
fn a_ring_comes_back_from_its_signed_log_without_the_root_private_key() -> Result<(), Box<dyn Error>>
{
    let agent = AgentId::new_v4();
    let root = AccountRootKey::generate()?;
    let a = DeviceIdentity::generate(DeviceId::new_v4())?;
    let b = DeviceIdentity::generate(DeviceId::new_v4())?;
    let c = DeviceIdentity::generate(DeviceId::new_v4())?;
    let mut ring = EpochKeyRing::new_genesis(agent, &root, a.public_record())?;
    ring.add_device(&root, b.public_record())?;
    ring.add_device(&root, c.public_record())?;
    ring.revoke_device(&root, c.device_id())?;
    let keys: BTreeMap<Epoch, EpochKey> = (1..=ring.current_epoch().get())
        .filter_map(|e| {
            ring.epoch_key(Epoch::new(e))
                .map(|k| (Epoch::new(e), k.clone()))
        })
        .collect();
    let root_pk = root.verifying_key_bytes()?;

    // 被吊销的 c 不需要记录。
    let records = vec![a.public_record(), b.public_record()];
    let restored = EpochKeyRing::restore_verified(
        agent,
        root_pk,
        &records,
        ring.membership_log().to_vec(),
        keys.clone(),
    )?;
    assert_eq!(restored.current_epoch(), ring.current_epoch());
    assert_eq!(
        restored.active_devices().keys().collect::<Vec<_>>(),
        ring.active_devices().keys().collect::<Vec<_>>()
    );
    assert!(
        restored
            .wrapped_entry_for(ring.current_epoch(), b.device_id())
            .is_some()
    );

    // 换一把根公钥、或者篡改日志、或者缺了激活设备的记录，都恢复不了。
    let other = AccountRootKey::generate()?.verifying_key_bytes()?;
    assert!(
        EpochKeyRing::restore_verified(
            agent,
            other,
            &records,
            ring.membership_log().to_vec(),
            keys.clone()
        )
        .is_err()
    );
    let mut forged = ring.membership_log().to_vec();
    if let Some(first) = forged.first_mut() {
        first.ed25519_pubkey = c.public_record().ed25519_pubkey;
    }
    assert!(
        EpochKeyRing::restore_verified(agent, root_pk, &records, forged, keys.clone()).is_err()
    );
    assert!(
        EpochKeyRing::restore_verified(
            agent,
            root_pk,
            &[a.public_record()],
            ring.membership_log().to_vec(),
            keys
        )
        .is_err()
    );
    Ok(())
}
