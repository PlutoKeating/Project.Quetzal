use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use quetzalcoatl_crypto::{
    AccountRootKey, DeviceIdentity, EPOCH_KEY_WRAP_INFO, EpochKey, EpochKeyRing, OpaqueMhfParams,
    PackCompartment, WEBHOOK_INGRESS_INFO, XWING_COMBINER_LABEL, XWING_ENC_LEN, XWING_PK_LEN,
    XWingKeyPair, compute_bucket_len, hex_decode, hex_decode_fixed, hex_encode, hpke_xwing_open,
    hpke_xwing_seal_deterministic, hpke_xwing_seal_with_context, opaque_3dh_derive,
    opaque_build_envelope_deterministic, opaque_evaluate_oprf, opaque_finalize_oprf,
    opaque_open_envelope, opaque_oprf_blind_deterministic, open_packfile, seal_packfile,
    seal_packfile_with_materials, zstd_decompress_1mib_guarded,
};
use quetzalcoatl_types::{AgentId, DeviceId, Epoch, ErrorCode, HlcTimestamp};

type TestResult = Result<(), Box<dyn Error>>;

fn repo_root() -> Result<PathBuf, Box<dyn Error>> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .ok_or("无法定位仓库根目录")?;
    Ok(root.to_path_buf())
}

#[test]
fn opaque_rfc9807_vector_and_slot4_root_key_wrap_byte_exact() -> TestResult {
    let root = repo_root()?;
    let vec_json: serde_json::Value = serde_json::from_str(&fs::read_to_string(
        root.join("spec/vectors/opaque_rfc9807.json"),
    )?)?;

    let inputs = &vec_json["inputs"];
    let oprf_env = &vec_json["oprf_and_envelope"];
    let ake = &vec_json["ake_3dh"];
    let mhf_v = &vec_json["mhf"];
    let slot4 = &vec_json["slot4_root_key_wrap"];

    let password = inputs["password_utf8"]
        .as_str()
        .ok_or("password")?
        .as_bytes();
    let blind_scalar = hex_decode_fixed::<32>(
        "blind_scalar",
        inputs["blind_scalar_hex"].as_str().ok_or("blind_scalar")?,
    )?;
    let oprf_key_scalar = hex_decode_fixed::<32>(
        "oprf_key_scalar",
        inputs["oprf_key_scalar_hex"].as_str().ok_or("oprf_key")?,
    )?;

    let blinded = opaque_oprf_blind_deterministic(password, &blind_scalar)?;
    assert_eq!(
        hex_encode(&blinded),
        oprf_env["blinded_element_hex"].as_str().ok_or("blinded")?
    );

    let evaluated = opaque_evaluate_oprf(&blinded, &oprf_key_scalar)?;
    assert_eq!(
        hex_encode(&evaluated),
        oprf_env["evaluated_element_hex"]
            .as_str()
            .ok_or("evaluated")?
    );

    let oprf_output = opaque_finalize_oprf(password, &blind_scalar, &evaluated)?;
    assert_eq!(
        hex_encode(&oprf_output),
        oprf_env["oprf_output_hex"].as_str().ok_or("oprf_output")?
    );

    let mhf = OpaqueMhfParams {
        memory_kib: mhf_v["memory_kib"].as_u64().ok_or("memory_kib")? as u32,
        iterations: mhf_v["iterations"].as_u64().ok_or("iterations")? as u32,
        parallelism: mhf_v["parallelism"].as_u64().ok_or("parallelism")? as u32,
        salt: hex_decode_fixed::<16>("mhf.salt", mhf_v["salt_hex"].as_str().ok_or("salt")?)?,
    };
    let env_nonce = hex_decode_fixed::<32>(
        "envelope_nonce",
        inputs["envelope_nonce_hex"].as_str().ok_or("env_nonce")?,
    )?;
    let masking_nonce = hex_decode_fixed::<32>(
        "masking_nonce",
        inputs["masking_nonce_hex"].as_str().ok_or("mask_nonce")?,
    )?;
    let server_priv = hex_decode_fixed::<32>(
        "server_private_scalar",
        inputs["server_private_scalar_hex"]
            .as_str()
            .ok_or("server_priv")?,
    )?;
    let server_id = inputs["server_identity_utf8"]
        .as_str()
        .ok_or("server_id")?
        .as_bytes();
    let client_id = inputs["client_identity_utf8"]
        .as_str()
        .ok_or("client_id")?
        .as_bytes();

    let bundle = opaque_build_envelope_deterministic(
        &oprf_output,
        &mhf,
        &env_nonce,
        &masking_nonce,
        &server_priv,
        server_id,
        client_id,
    )?;

    assert_eq!(
        hex_encode(&bundle.hardened_output),
        oprf_env["hardened_output_hex"].as_str().ok_or("hardened")?
    );
    assert_eq!(
        hex_encode(&bundle.randomized_pwd),
        oprf_env["randomized_pwd_hex"]
            .as_str()
            .ok_or("randomized_pwd")?
    );
    assert_eq!(
        hex_encode(&bundle.masking_key),
        oprf_env["masking_key_hex"].as_str().ok_or("masking_key")?
    );
    assert_eq!(
        hex_encode(&bundle.export_key),
        oprf_env["export_key_hex"].as_str().ok_or("export_key")?
    );
    assert_eq!(
        hex_encode(&bundle.auth_key),
        oprf_env["auth_key_hex"].as_str().ok_or("auth_key")?
    );
    assert_eq!(
        hex_encode(&bundle.client_private_scalar),
        oprf_env["client_private_scalar_hex"]
            .as_str()
            .ok_or("client_priv")?
    );
    assert_eq!(
        hex_encode(&bundle.client_public_key),
        oprf_env["client_public_key_hex"]
            .as_str()
            .ok_or("client_pub")?
    );
    assert_eq!(
        hex_encode(&bundle.server_public_key),
        oprf_env["server_public_key_hex"]
            .as_str()
            .ok_or("server_pub")?
    );
    assert_eq!(
        hex_encode(&bundle.cleartext_credentials),
        oprf_env["cleartext_credentials_hex"]
            .as_str()
            .ok_or("cleartext_creds")?
    );
    assert_eq!(
        hex_encode(&bundle.envelope_auth_tag),
        oprf_env["envelope_auth_tag_hex"]
            .as_str()
            .ok_or("env_tag")?
    );
    assert_eq!(
        hex_encode(&bundle.envelope),
        oprf_env["envelope_hex"].as_str().ok_or("envelope")?
    );
    assert_eq!(
        hex_encode(&bundle.masked_response),
        oprf_env["masked_response_hex"]
            .as_str()
            .ok_or("masked_resp")?
    );

    let (recovered_export, recovered_client_sk, recovered_server_pk) = opaque_open_envelope(
        &bundle.randomized_pwd,
        &evaluated,
        &masking_nonce,
        &bundle.masked_response,
        server_id,
        client_id,
    )?;
    assert_eq!(recovered_export, bundle.export_key);
    assert_eq!(recovered_client_sk, bundle.client_private_scalar);
    assert_eq!(recovered_server_pk, bundle.server_public_key);

    // Negative case: tampered envelope_auth_tag -> INTEGRITY_VIOLATION
    let mut tampered_masked = bundle.masked_response.clone();
    if let Some(last) = tampered_masked.last_mut() {
        *last ^= 0xff;
    }
    let neg_err = opaque_open_envelope(
        &bundle.randomized_pwd,
        &evaluated,
        &masking_nonce,
        &tampered_masked,
        server_id,
        client_id,
    )
    .err()
    .ok_or("篡改 OPAQUE 信封认证标签必须失败")?;
    assert_eq!(neg_err.code(), ErrorCode::IntegrityViolation);

    // 3DH AKE transcript byte-for-byte check
    let context = inputs["context_utf8"].as_str().ok_or("ctx")?.as_bytes();
    let client_nonce = hex_decode_fixed::<32>(
        "client_nonce",
        inputs["client_nonce_hex"].as_str().ok_or("c_nonce")?,
    )?;
    let client_eph = hex_decode_fixed::<32>(
        "client_eph",
        inputs["client_ephemeral_scalar_hex"]
            .as_str()
            .ok_or("c_eph")?,
    )?;
    let server_nonce = hex_decode_fixed::<32>(
        "server_nonce",
        inputs["server_nonce_hex"].as_str().ok_or("s_nonce")?,
    )?;
    let server_eph = hex_decode_fixed::<32>(
        "server_eph",
        inputs["server_ephemeral_scalar_hex"]
            .as_str()
            .ok_or("s_eph")?,
    )?;

    let transcript = opaque_3dh_derive(
        context,
        client_id,
        server_id,
        &blinded,
        &client_nonce,
        &bundle.client_private_scalar,
        &client_eph,
        &evaluated,
        &masking_nonce,
        &bundle.masked_response,
        &server_nonce,
        &server_priv,
        &server_eph,
    )?;
    assert_eq!(
        hex_encode(&transcript.ke1),
        ake["ke1_hex"].as_str().ok_or("ke1")?
    );
    assert_eq!(
        hex_encode(&transcript.credential_response),
        ake["credential_response_hex"].as_str().ok_or("cred_resp")?
    );
    assert_eq!(
        hex_encode(&transcript.preamble),
        ake["preamble_hex"].as_str().ok_or("preamble")?
    );
    assert_eq!(
        hex_encode(&transcript.preamble_sha512),
        ake["preamble_sha512_hex"]
            .as_str()
            .ok_or("preamble_sha512")?
    );
    assert_eq!(
        hex_encode(&transcript.dh_ikm),
        ake["dh_ikm_hex"].as_str().ok_or("dh_ikm")?
    );
    assert_eq!(
        hex_encode(&transcript.prk),
        ake["prk_hex"].as_str().ok_or("prk")?
    );
    assert_eq!(
        hex_encode(&transcript.handshake_secret),
        ake["handshake_secret_hex"].as_str().ok_or("hs")?
    );
    assert_eq!(
        hex_encode(&transcript.session_key),
        ake["session_key_hex"].as_str().ok_or("session_key")?
    );
    assert_eq!(
        hex_encode(&transcript.km2),
        ake["km2_hex"].as_str().ok_or("km2")?
    );
    assert_eq!(
        hex_encode(&transcript.km3),
        ake["km3_hex"].as_str().ok_or("km3")?
    );
    assert_eq!(
        hex_encode(&transcript.server_mac),
        ake["server_mac_hex"].as_str().ok_or("server_mac")?
    );
    assert_eq!(
        hex_encode(&transcript.client_mac),
        ake["client_mac_hex"].as_str().ok_or("client_mac")?
    );

    // Slot 4 Root Key Wrap check
    let agent_id = AgentId::from_str("018f4a90-7c20-4d31-8b12-9a0b1c2d3e4f")?;
    let root_bytes = hex_decode_fixed::<32>(
        "account_root_key",
        slot4["account_root_key_hex"].as_str().ok_or("root_key")?,
    )?;
    let root_key = AccountRootKey::from_bytes(root_bytes);
    let slot4_nonce = hex_decode_fixed::<24>(
        "slot4_nonce",
        slot4["nonce_hex"].as_str().ok_or("slot4_nonce")?,
    )?;

    let wrapped_slot4 =
        root_key.wrap_slot4_deterministic(agent_id, &bundle.export_key, &slot4_nonce)?;
    assert_eq!(
        wrapped_slot4.aad_utf8,
        slot4["aad_utf8"].as_str().ok_or("slot4_aad")?
    );
    assert_eq!(
        wrapped_slot4.kek_debug_only.map(|k| hex_encode(&k)),
        Some(String::from(slot4["kek_hex"].as_str().ok_or("kek")?))
    );
    assert_eq!(
        hex_encode(&wrapped_slot4.ciphertext),
        slot4["ciphertext_hex"].as_str().ok_or("slot4_ct")?
    );

    let unwrapped_root =
        AccountRootKey::unwrap_slot4(agent_id, &bundle.export_key, &wrapped_slot4)?;
    assert_eq!(unwrapped_root.as_bytes(), root_key.as_bytes());

    let mut bad_slot4 = wrapped_slot4.clone();
    bad_slot4.ciphertext[0] ^= 1;
    let bad_err = AccountRootKey::unwrap_slot4(agent_id, &bundle.export_key, &bad_slot4)
        .err()
        .ok_or("篡改 Slot4 密文必须报错")?;
    assert_eq!(bad_err.code(), ErrorCode::IntegrityViolation);

    Ok(())
}

#[test]
fn hpke_xwing_vector_and_seal_cases_byte_exact() -> TestResult {
    let root = repo_root()?;
    let vec_json: serde_json::Value = serde_json::from_str(&fs::read_to_string(
        root.join("spec/vectors/hpke_xwing.json"),
    )?)?;

    assert_eq!(
        hex_encode(XWING_COMBINER_LABEL),
        vec_json["hpke_ids"]["xwing_combiner_label_hex"]
            .as_str()
            .ok_or("label")?
    );

    let kem = &vec_json["kem"];
    let sk_seed = hex_decode_fixed::<32>("sk_seed", kem["sk_seed_hex"].as_str().ok_or("sk_seed")?)?;
    let kp = XWingKeyPair::from_seed(sk_seed)?;

    assert_eq!(
        hex_encode(kp.expanded_shake256_96()),
        kem["expanded_shake256_96_hex"].as_str().ok_or("exp96")?
    );
    assert_eq!(kp.public_key_bytes().len(), XWING_PK_LEN);
    assert_eq!(
        hex_encode(kp.public_key_bytes()),
        kem["xwing_pk_hex"].as_str().ok_or("xwing_pk")?
    );
    assert_eq!(
        hex_encode(&kp.x25519_public_key_bytes()),
        kem["x25519_pk_hex"].as_str().ok_or("x25519_pk")?
    );

    let encap_seed = hex_decode_fixed::<64>(
        "encap_seed_64",
        kem["encap_seed_64_hex"].as_str().ok_or("encap_seed")?,
    )?;
    let debug = XWingKeyPair::encapsulate_deterministic(kp.public_key_bytes(), &encap_seed)?;
    assert_eq!(debug.enc.len(), XWING_ENC_LEN);
    assert_eq!(
        hex_encode(&debug.mlkem768_ss),
        kem["mlkem768_ss_hex"].as_str().ok_or("mlkem_ss")?
    );
    assert_eq!(
        hex_encode(&debug.x25519_ct),
        kem["x25519_ct_hex"].as_str().ok_or("x25519_ct")?
    );
    assert_eq!(
        hex_encode(&debug.x25519_ss),
        kem["x25519_ss_hex"].as_str().ok_or("x25519_ss")?
    );
    assert_eq!(
        hex_encode(&debug.enc),
        kem["xwing_enc_hex"].as_str().ok_or("xwing_enc")?
    );
    assert_eq!(
        hex_encode(&debug.shared_secret),
        kem["xwing_shared_secret_hex"].as_str().ok_or("xwing_ss")?
    );

    let decapped = kp.decapsulate(&debug.enc)?;
    assert_eq!(decapped, debug.shared_secret);

    let cases = vec_json["seal_cases"].as_array().ok_or("seal_cases")?;
    for case in cases {
        let info = case["info_utf8"].as_str().ok_or("info")?.as_bytes();
        let aad = case["aad_utf8"].as_str().ok_or("aad")?.as_bytes();
        let pt = hex_decode("plaintext", case["plaintext_hex"].as_str().ok_or("pt")?)?;

        let (schedule, ct) = hpke_xwing_seal_with_context(&debug.shared_secret, info, aad, &pt)?;
        assert_eq!(
            hex_encode(&schedule.aead_key),
            case["aead_key_hex"].as_str().ok_or("aead_key")?
        );
        assert_eq!(
            hex_encode(&schedule.base_nonce),
            case["base_nonce_hex"].as_str().ok_or("base_nonce")?
        );
        assert_eq!(
            hex_encode(&schedule.exporter_secret),
            case["exporter_secret_hex"].as_str().ok_or("exporter")?
        );
        assert_eq!(
            hex_encode(&ct),
            case["ciphertext_hex"].as_str().ok_or("ct")?
        );

        let sealed =
            hpke_xwing_seal_deterministic(kp.public_key_bytes(), info, aad, &pt, &encap_seed)?;
        assert_eq!(sealed.ciphertext, ct);
        let opened = hpke_xwing_open(&kp, info, aad, &sealed)?;
        assert_eq!(opened, pt);

        // Negative tamper check
        let mut bad_sealed = sealed.clone();
        bad_sealed.ciphertext[0] ^= 0x80;
        let err = hpke_xwing_open(&kp, info, aad, &bad_sealed)
            .err()
            .ok_or("篡改 HPKE 密文必须报错")?;
        assert_eq!(err.code(), ErrorCode::IntegrityViolation);
    }

    assert_eq!(EPOCH_KEY_WRAP_INFO, b"quetzalcoatl/v2/epoch-key-wrap");
    assert_eq!(WEBHOOK_INGRESS_INFO, b"quetzalcoatl/v2/webhook-ingress");

    Ok(())
}

#[test]
fn spine_pack_aad_vector_zstd_window_guard_and_tamper_detection() -> TestResult {
    let root = repo_root()?;
    let vec_json: serde_json::Value = serde_json::from_str(&fs::read_to_string(
        root.join("spec/vectors/spine_pack_aad.json"),
    )?)?;

    let id_v = &vec_json["identity"];
    let pf_v = &vec_json["packfile"];

    let agent_id = AgentId::from_str(id_v["agent_id"].as_str().ok_or("agent_id")?)?;
    let device_id = DeviceId::from_str(id_v["device_id"].as_str().ok_or("device_id")?)?;
    let epoch = Epoch::new(pf_v["epoch"].as_u64().ok_or("epoch")?);
    let epoch_key = EpochKey::from_bytes(hex_decode_fixed::<32>(
        "epoch_key",
        pf_v["epoch_key_hex"].as_str().ok_or("epoch_key")?,
    )?);
    let per_pack_dek = hex_decode_fixed::<32>(
        "per_pack_dek",
        pf_v["per_pack_dek_hex"].as_str().ok_or("dek")?,
    )?;
    let dek_wrap_nonce = hex_decode_fixed::<24>(
        "dek_wrap_nonce",
        pf_v["dek_wrap_nonce_hex"].as_str().ok_or("dek_nonce")?,
    )?;
    let pack_nonce = hex_decode_fixed::<24>(
        "pack_nonce",
        pf_v["pack_nonce_hex"].as_str().ok_or("pack_nonce")?,
    )?;
    let uncompressed_jsonl = pf_v["uncompressed_jsonl_utf8"]
        .as_str()
        .ok_or("jsonl")?
        .as_bytes();
    let vector_zstd_bytes = hex_decode(
        "zstd_compressed",
        pf_v["zstd_compressed_hex"].as_str().ok_or("zstd")?,
    )?;

    let min_hlc = HlcTimestamp::from_hex(
        vec_json["events"][0]["hlc_u128_hex"]
            .as_str()
            .ok_or("hlc0")?,
    )?;
    let max_hlc = HlcTimestamp::from_hex(
        vec_json["events"][1]["hlc_u128_hex"]
            .as_str()
            .ok_or("hlc1")?,
    )?;

    assert_eq!(compute_bucket_len(10)?, 256);
    assert_eq!(compute_bucket_len(663)?, 1024);

    let sealed = seal_packfile_with_materials(
        agent_id,
        device_id,
        PackCompartment::Core,
        epoch,
        &epoch_key,
        1,
        2,
        min_hlc,
        max_hlc,
        uncompressed_jsonl,
        None,
        &per_pack_dek,
        &dek_wrap_nonce,
        &pack_nonce,
    )?;

    let compressed_wl20 = quetzalcoatl_crypto::zstd_compress_1mib(uncompressed_jsonl)?;
    assert_eq!(compressed_wl20, vector_zstd_bytes);
    let padded_wl20 = quetzalcoatl_crypto::build_padded_frame(&compressed_wl20)?;
    assert_eq!(
        hex_encode(&padded_wl20),
        pf_v["padded_frame_hex"].as_str().ok_or("padded_frame")?
    );

    assert_eq!(
        sealed.aad_utf8,
        pf_v["canonical_aad_utf8"].as_str().ok_or("aad")?
    );
    assert_eq!(
        sealed.aad.uncompressed_blake3.to_hex(),
        pf_v["uncompressed_blake3_hex"]
            .as_str()
            .ok_or("uncompressed_b3")?
    );
    assert_eq!(
        hex_encode(&sealed.wrapped_dek),
        pf_v["wrapped_dek_hex"].as_str().ok_or("wrapped_dek")?
    );
    assert_eq!(
        hex_encode(&sealed.ciphertext),
        pf_v["ciphertext_hex"].as_str().ok_or("ciphertext")?
    );
    assert_eq!(
        sealed.pack_id.to_hex(),
        pf_v["pack_id_blake3_hex"].as_str().ok_or("pack_id")?
    );

    let opened = open_packfile(&sealed, &epoch_key)?;
    assert_eq!(opened, uncompressed_jsonl);

    // Negative 1: tampered_aad_epoch
    let mut tampered_aad_pack = sealed.clone();
    tampered_aad_pack.aad_utf8 = String::from(
        vec_json["negative_cases"][0]["tampered_aad_utf8"]
            .as_str()
            .ok_or("tampered_aad")?,
    );
    tampered_aad_pack.aad.epoch = 2;
    let err1 = open_packfile(&tampered_aad_pack, &epoch_key)
        .err()
        .ok_or("篡改 AAD epoch 必须报错")?;
    assert_eq!(err1.code(), ErrorCode::IntegrityViolation);

    // Negative 2: tampered_ciphertext_tag_byte
    let tampered_last_byte = hex_decode_fixed::<1>(
        "tampered_last",
        vec_json["negative_cases"][1]["tampered_ciphertext_last_byte_hex"]
            .as_str()
            .ok_or("tampered_last")?,
    )?[0];
    let mut tampered_ct_pack = sealed.clone();
    if let Some(last) = tampered_ct_pack.ciphertext.last_mut() {
        *last = tampered_last_byte;
    }
    let err2 = open_packfile(&tampered_ct_pack, &epoch_key)
        .err()
        .ok_or("篡改密文末尾字节必须报错")?;
    assert_eq!(err2.code(), ErrorCode::IntegrityViolation);

    // Negative 3: tampered wrapped_dek byte
    let mut tampered_dek_pack = sealed;
    tampered_dek_pack.wrapped_dek[0] ^= 0x01;
    let err3 = open_packfile(&tampered_dek_pack, &epoch_key)
        .err()
        .ok_or("篡改 wrapped_dek 必须报错")?;
    assert_eq!(err3.code(), ErrorCode::IntegrityViolation);

    // Pitfall #15: zstd frame requesting window > 1 MiB (both windowLog=21 2MiB and windowLog=24 16MiB) MUST be rejected!
    for bad_wd in [0x58u8, 0x70u8] {
        let oversized_zstd_header = [0x28u8, 0xb5, 0x2f, 0xfd, 0x00, bad_wd, 0x01, 0x00, 0x00];
        let err_win = zstd_decompress_1mib_guarded(&oversized_zstd_header)
            .err()
            .ok_or("超出 1MiB 窗口的 zstd 帧必须被拦截")?;
        assert_eq!(err_win.code(), ErrorCode::IntegrityViolation);
    }

    // Random seal_packfile + open_packfile roundtrip
    let random_sealed = seal_packfile(
        agent_id,
        device_id,
        PackCompartment::ExternalChannel,
        epoch,
        &epoch_key,
        10,
        12,
        min_hlc,
        max_hlc,
        b"{\"external\":true}\n",
    )?;
    assert_eq!(
        random_sealed.aad.compartment,
        PackCompartment::ExternalChannel
    );
    assert!(random_sealed.aad.padded_len >= 256 && random_sealed.aad.padded_len.is_power_of_two());
    let random_opened = open_packfile(&random_sealed, &epoch_key)?;
    assert_eq!(random_opened, b"{\"external\":true}\n");

    Ok(())
}

#[test]
fn account_root_key_five_slots_and_epoch_key_ring_revocation_forward_secrecy() -> TestResult {
    let agent_id = AgentId::new_v4();
    let root_key = AccountRootKey::generate()?;

    // Slot 1: Passkey PRF
    let prf = [0x42u8; 32];
    let s1 = root_key.wrap_with_passkey_prf(agent_id, &prf)?;
    assert_eq!(
        AccountRootKey::unwrap_with_passkey_prf(agent_id, &prf, &s1)?.as_bytes(),
        root_key.as_bytes()
    );

    // Slot 2: Pairing X-Wing HPKE
    let peer_kp = XWingKeyPair::generate()?;
    let s2 = root_key.wrap_with_pairing_hpke(agent_id, peer_kp.public_key_bytes())?;
    assert_eq!(
        AccountRootKey::unwrap_with_pairing_hpke(agent_id, &peer_kp, &s2)?.as_bytes(),
        root_key.as_bytes()
    );

    // Slot 3: Guardian Shamir 2-of-3 threshold shares
    let shares = root_key.split_shamir_shares(2, 3)?;
    assert_eq!(shares.len(), 3);
    let rec_0_2 =
        AccountRootKey::reconstruct_shamir_shares(&[shares[0].clone(), shares[2].clone()])?;
    assert_eq!(rec_0_2.as_bytes(), root_key.as_bytes());
    let under_threshold_err = AccountRootKey::reconstruct_shamir_shares(&[shares[1].clone()])
        .err()
        .ok_or("低于门限数量的分片必须拒绝恢复")?;
    assert_eq!(under_threshold_err.code(), ErrorCode::IntegrityViolation);

    // Slot 4: OPAQUE ExportKey wrap
    let opaque_export = [0x77u8; 64];
    let s4 = root_key.wrap_slot4(agent_id, &opaque_export)?;
    assert_eq!(
        AccountRootKey::unwrap_slot4(agent_id, &opaque_export, &s4)?.as_bytes(),
        root_key.as_bytes()
    );

    // Slot 5: Hardware local secret
    let hw_secret = [0x99u8; 32];
    let s5 = root_key.wrap_with_hardware_secret(agent_id, &hw_secret)?;
    assert_eq!(
        AccountRootKey::unwrap_with_hardware_secret(agent_id, &hw_secret, &s5)?.as_bytes(),
        root_key.as_bytes()
    );

    // EpochKeyRing: Add Device B, then Revoke Device B -> rotates to Epoch 2!
    let dev_a = DeviceIdentity::generate(DeviceId::new_v4())?;
    let dev_b = DeviceIdentity::generate(DeviceId::new_v4())?;

    let mut ring = EpochKeyRing::new_genesis(agent_id, &root_key, dev_a.public_record())?;
    assert_eq!(ring.current_epoch(), Epoch::new(1));

    let add_rec = ring.add_device(&root_key, dev_b.public_record())?;
    AccountRootKey::verify_membership_change(ring.root_verifying_key(), &add_rec)?;

    let ep1 = ring.current_epoch();
    let entry_a_ep1 = ring
        .wrapped_entry_for(ep1, dev_a.device_id())
        .ok_or("缺少设备 A 的当前纪元包裹")?;
    let entry_b_ep1 = ring
        .wrapped_entry_for(ep1, dev_b.device_id())
        .ok_or("缺少设备 B 的当前纪元包裹")?;
    let key_a_1 = EpochKeyRing::unwrap_for_device(&dev_a, entry_a_ep1)?;
    let key_b_1 = EpochKeyRing::unwrap_for_device(&dev_b, entry_b_ep1)?;
    assert_eq!(key_a_1.as_bytes(), key_b_1.as_bytes());

    // Revoke Device B -> advances to next Epoch!
    let (ep_after_revoke, revoke_rec) = ring.revoke_device(&root_key, dev_b.device_id())?;
    AccountRootKey::verify_membership_change(ring.root_verifying_key(), &revoke_rec)?;
    assert!(ep_after_revoke > ep1);
    assert!(!ring.is_device_active(dev_b.device_id()));
    assert!(
        ring.wrapped_entry_for(ep_after_revoke, dev_b.device_id())
            .is_none()
    );

    let entry_a_next = ring
        .wrapped_entry_for(ep_after_revoke, dev_a.device_id())
        .ok_or("保留设备 A 必须获得新纪元密钥包裹")?;
    let key_a_next = EpochKeyRing::unwrap_for_device(&dev_a, entry_a_next)?;
    assert_ne!(key_a_next.as_bytes(), key_b_1.as_bytes());

    // Revoked Device B cannot unwrap Device A's entry nor decrypt new packfiles!
    let steal_err = EpochKeyRing::unwrap_for_device(&dev_b, entry_a_next)
        .err()
        .ok_or("已吊销设备 B 绝不能解封新纪元密钥")?;
    assert_eq!(steal_err.code(), ErrorCode::IntegrityViolation);

    let hlc = HlcTimestamp::from_parts(1_795_400_100_000, 0, dev_a.device_id().hlc_node_tag());
    let new_pack = seal_packfile(
        agent_id,
        dev_a.device_id(),
        PackCompartment::Core,
        ep_after_revoke,
        &key_a_next,
        1,
        1,
        hlc,
        hlc,
        b"{\"secret\":\"post-revocation\"}\n",
    )?;
    let old_key_err = open_packfile(&new_pack, &key_b_1)
        .err()
        .ok_or("旧纪元密钥绝不能解开吊销后的新 Packfile")?;
    assert_eq!(old_key_err.code(), ErrorCode::IntegrityViolation);

    Ok(())
}
