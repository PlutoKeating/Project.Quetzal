//! 设备之间传递的小秘密（条目钥匙、纪元钥匙）：用接收设备的 X-Wing 公钥封存。
//!
//! 密文绑定 Agent、接收设备与这份秘密的名字：挪给别的设备或改名都解不开。

use serde::{Deserialize, Serialize};

use crate::keys::{
    DeviceIdentity, DevicePublicRecord, HpkeSealedBox, XWING_PK_LEN, hpke_xwing_open,
    hpke_xwing_seal,
};
use crate::{hex_decode, hex_encode};
use quetzalcoatl_types::{AgentId, DeviceId, QuetzalcoatlError, Result};

const DEVICE_SEAL_INFO: &[u8] = b"quetzalcoatl/v2/device-sealed-secret";

/// 封存好的一份秘密，可以原样交给 Hub 转交。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceSealedSecret {
    pub aad_utf8: String,
    pub ciphertext_hex: String,
    pub hpke_enc_hex: String,
}

fn aad(agent_id: AgentId, device_id: DeviceId, name: &str) -> String {
    format!("quetzalcoatl/device-secret|{agent_id}|{device_id}|{name}")
}

/// 为一台设备封存一份秘密。
pub fn seal_for_device(
    agent_id: AgentId,
    device: &DevicePublicRecord,
    name: &str,
    secret: &[u8],
) -> Result<DeviceSealedSecret> {
    if device.xwing_pubkey.len() != XWING_PK_LEN {
        return Err(QuetzalcoatlError::IntegrityViolation {
            detail: String::from("接收设备的 X-Wing 公钥长度不对"),
        });
    }
    let mut pk = [0u8; XWING_PK_LEN];
    pk.copy_from_slice(&device.xwing_pubkey);
    let aad_utf8 = aad(agent_id, device.device_id, name);
    let sealed = hpke_xwing_seal(&pk, DEVICE_SEAL_INFO, aad_utf8.as_bytes(), secret)?;
    Ok(DeviceSealedSecret {
        aad_utf8,
        ciphertext_hex: hex_encode(&sealed.ciphertext),
        hpke_enc_hex: hex_encode(&sealed.enc),
    })
}

/// 本机设备打开寄给它的一份秘密。
pub fn open_for_device(
    agent_id: AgentId,
    device: &DeviceIdentity,
    name: &str,
    sealed: &DeviceSealedSecret,
) -> Result<Vec<u8>> {
    let expected = aad(agent_id, device.device_id(), name);
    if sealed.aad_utf8 != expected {
        return Err(QuetzalcoatlError::IntegrityViolation {
            detail: String::from("这份秘密不是寄给本机这个名字的"),
        });
    }
    let boxed = HpkeSealedBox {
        enc: hex_decode("device_seal_enc", &sealed.hpke_enc_hex)?,
        ciphertext: hex_decode("device_seal_ciphertext", &sealed.ciphertext_hex)?,
    };
    hpke_xwing_open(
        device.xwing_keypair(),
        DEVICE_SEAL_INFO,
        expected.as_bytes(),
        &boxed,
    )
}

#[cfg(test)]
mod tests {
    use super::{open_for_device, seal_for_device};
    use crate::keys::DeviceIdentity;
    use quetzalcoatl_types::{AgentId, DeviceId};

    #[test]
    fn a_secret_opens_only_on_its_device_under_its_name() {
        let agent = AgentId::new_v4();
        let (Ok(b), Ok(c)) = (
            DeviceIdentity::generate(DeviceId::new_v4()),
            DeviceIdentity::generate(DeviceId::new_v4()),
        ) else {
            return;
        };
        let Ok(sealed) =
            seal_for_device(agent, &b.public_record(), "sea.entry-key/memory/m1", b"k")
        else {
            return;
        };
        assert_eq!(
            open_for_device(agent, &b, "sea.entry-key/memory/m1", &sealed).ok(),
            Some(b"k".to_vec())
        );
        assert!(open_for_device(agent, &c, "sea.entry-key/memory/m1", &sealed).is_err());
        assert!(open_for_device(agent, &b, "sea.entry-key/memory/m2", &sealed).is_err());
    }
}
