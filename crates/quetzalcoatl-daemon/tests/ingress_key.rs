#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

use std::error::Error;

use quetzalcoatl_crypto::{
    DeviceIdentity, EpochKey, WEBHOOK_INGRESS_INFO, hex_encode, hpke_xwing_seal,
};
use quetzalcoatl_daemon::{ChannelIngressKey, ingress_and_device_keys_differ};
use quetzalcoatl_types::DeviceId;
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error>>;

fn temp_home(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("qz_ingress_{tag}_{}", Uuid::new_v4().simple()));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[test]
fn per_device_ingress_keys_are_distinct_from_device_identity_and_each_other() -> TestResult {
    let home = temp_home("derive");
    let epoch_key = EpochKey::from_bytes([0x42; 32]);
    let dev_a = DeviceIdentification::new()?;
    let dev_b = DeviceIdentification::new()?;
    let key_a = ChannelIngressKey::load_or_derive(&home, &epoch_key, dev_a.device.device_id())?;
    let key_b = ChannelIngressKey::load_or_derive(&home, &epoch_key, dev_b.device.device_id())?;
    assert_ne!(key_a.public_key(), key_b.public_key());
    assert!(ingress_and_device_keys_differ(&dev_a.device, &key_a));
    assert!(ingress_and_device_keys_differ(&dev_b.device, &key_b));

    let aad = b"{\"agent_id\":\"a\",\"channel\":\"webhook\",\"received_at_ms\":1}";
    let sealed_a = hpke_xwing_seal(key_a.public_key(), WEBHOOK_INGRESS_INFO, aad, b"payload-a")?;
    let sealed_b = hpke_xwing_seal(key_b.public_key(), WEBHOOK_INGRESS_INFO, aad, b"payload-b")?;
    assert_eq!(
        key_a.open(aad, &sealed_a.enc, &sealed_a.ciphertext)?,
        b"payload-a"
    );
    assert_eq!(
        key_b.open(aad, &sealed_b.enc, &sealed_b.ciphertext)?,
        b"payload-b"
    );
    assert!(
        key_b
            .open(aad, &sealed_a.enc, &sealed_a.ciphertext)
            .is_err()
    );
    Ok(())
}

#[test]
fn rotation_replaces_one_device_key_without_affecting_the_other() -> TestResult {
    let home_a = temp_home("rot-a");
    let home_b = temp_home("rot-b");
    let epoch_key = EpochKey::from_bytes([0x43; 32]);
    let dev_a = DeviceIdentification::new()?;
    let dev_b = DeviceIdentification::new()?;
    let old_a = ChannelIngressKey::load_or_derive(&home_a, &epoch_key, dev_a.device.device_id())?;
    let key_b = ChannelIngressKey::load_or_derive(&home_b, &epoch_key, dev_b.device.device_id())?;
    let new_a = ChannelIngressKey::rotate(&home_a, dev_a.device.device_id())?;
    assert_ne!(old_a.key_id(), new_a.key_id());
    let aad = b"{\"agent_id\":\"a\",\"channel\":\"webhook\",\"received_at_ms\":2}";
    let sealed_new = hpke_xwing_seal(new_a.public_key(), WEBHOOK_INGRESS_INFO, aad, b"new")?;
    assert!(
        old_a
            .open(aad, &sealed_new.enc, &sealed_new.ciphertext)
            .is_err()
    );
    assert_eq!(
        new_a.open(aad, &sealed_new.enc, &sealed_new.ciphertext)?,
        b"new"
    );
    let sealed_b = hpke_xwing_seal(key_b.public_key(), WEBHOOK_INGRESS_INFO, aad, b"b")?;
    assert_eq!(key_b.open(aad, &sealed_b.enc, &sealed_b.ciphertext)?, b"b");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::metadata(home_a.join("secrets/channel_ingress.json"))?;
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    }
    Ok(())
}

#[test]
fn persisted_seed_reloads_same_key_id() -> TestResult {
    let home = temp_home("reload");
    let epoch_key = EpochKey::from_bytes([0x44; 32]);
    let device = DeviceIdentification::new()?;
    let first = ChannelIngressKey::load_or_derive(&home, &epoch_key, device.device.device_id())?;
    let second = ChannelIngressKey::load_or_derive(&home, &epoch_key, device.device.device_id())?;
    assert_eq!(first.key_id(), second.key_id());
    assert_eq!(
        hex_encode(first.public_key()),
        hex_encode(second.public_key())
    );
    Ok(())
}

struct DeviceIdentification {
    device: DeviceIdentity,
}

impl DeviceIdentification {
    fn new() -> TestResult2 {
        Ok(Self {
            device: DeviceIdentity::generate(DeviceId::new_v4())?,
        })
    }
}

type TestResult2 = Result<DeviceIdentification, Box<dyn Error>>;
