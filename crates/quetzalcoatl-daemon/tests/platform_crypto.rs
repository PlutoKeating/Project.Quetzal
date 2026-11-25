#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

use quetzalcoatl_daemon::{decrypt_json_envelope, decrypt_wecom};

#[test]
fn wecom_encrypted_fixture_decrypts_to_known_plaintext() -> Result<(), Box<dyn std::error::Error>> {
    let key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
    let ct = "43uuyl/uOF58KspcVgvH+2p6uUQPMvWw7gKAFf/9n1RqNAukV7va8QAayCBhm9I3FucvWFZNjS/Y5/r9SbbyuPbV0JcIU1C45p9cOwux+IU=";
    let plain = decrypt_wecom(ct, key)?;
    assert_eq!(String::from_utf8(plain)?, "企业微信解密后的合成消息");
    Ok(())
}

#[test]
fn feishu_encrypted_fixture_decrypts_to_known_plaintext() -> Result<(), Box<dyn std::error::Error>>
{
    let body = br#"{"encrypt":"Wt8gRMnedJrqKqSwDr0hHrfNRewoNskZwGHJ9XZvN0YCYHnVxplfZhsrbU19AjfFAujWyKclz46vHdgipUlYabqjsAjnsQVBHLeavKflYdGsk0pZONU+dfC6hru6rldu2D1Xs+LJTCWaR3TtBG6mPS4/DGdikp8xCw/ByfXpUJeDa+yPOu62DlvsLipmG4TJQpDWlh04YJDmfiYttjPczm5c3Kpy176qbpExOCrwvjY="}"#;
    let plain = decrypt_json_envelope(body, "test-encrypt-key")?;
    let value: serde_json::Value = serde_json::from_slice(&plain)?;
    assert_eq!(value["header"]["event_id"], "ev_feishu_dec");
    Ok(())
}

#[test]
fn dingtalk_encrypted_fixture_decrypts_to_known_plaintext() -> Result<(), Box<dyn std::error::Error>>
{
    let body = br#"{"encrypt":"257D26CF/G3RvK8mDomkfSds7wRSskqiD7cALiQUpxSV3xH91bDekkcCp+Am/JV9sVQMedVyOW/8TWdwUdsPfO9PHNzXDyOIvIFPUWElAVwPXnho+BS6LPsWiN+Uc1WDsDqh0IIDpSTNKwOPVJjSAg=="}"#;
    let plain = decrypt_json_envelope(body, "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=")?;
    let value: serde_json::Value = serde_json::from_slice(&plain)?;
    assert_eq!(value["msgId"], "ev_ding_dec");
    Ok(())
}

#[test]
fn corrupt_ciphertext_is_a_typed_integrity_error() -> Result<(), Box<dyn std::error::Error>> {
    let err = decrypt_wecom("AAAA", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
        .err()
        .ok_or("corrupt ciphertext must fail")?;
    assert_eq!(err.code().as_str(), "INTEGRITY_VIOLATION");
    Ok(())
}
