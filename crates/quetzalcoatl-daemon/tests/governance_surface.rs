#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 治理面的接口（docs/GOVERNANCE_SURFACE.md 第 3 节）：只看和签。
//!
//! 用 V1 夹具导入一片海，然后按治理面的用法走一遍：总览、他、往事、单条的来历、
//! 改 / 不主动提 / 抹除、签底线（第一次签即设口令，之后口令不对就签不了）、迎合、记录。

mod common;

use std::error::Error;
use std::fs;
use std::path::PathBuf;

use quetzalcoatl_daemon::{DaemonConfig, IpcClient, IpcRequest, IpcResponse, QuetzalcoatlDaemon};

type TestResult = Result<(), Box<dyn Error>>;

struct TempGuard(PathBuf);

impl Drop for TempGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn call(client: &IpcClient, request: &IpcRequest) -> Result<serde_json::Value, Box<dyn Error>> {
    let response = client.call(request)?;
    let value = serde_json::to_value(&response)?;
    if value["kind"] == "error" {
        return Err(format!("守护进程报错: {value}").into());
    }
    Ok(value)
}

fn call_err(client: &IpcClient, request: &IpcRequest) -> Result<String, Box<dyn Error>> {
    match client.call(request)? {
        IpcResponse::Error { code, detail } => Ok(format!("{code}: {detail}")),
        other => Err(format!("本应被拒绝: {other:?}").into()),
    }
}

#[test]
fn the_governance_surface_can_look_and_sign_but_never_talk() -> TestResult {
    let root = common::temp_root("gov")?;
    let _guard = TempGuard(root.clone());
    let home = root.join("h");
    let mut daemon = QuetzalcoatlDaemon::start(DaemonConfig::new(home.clone()))?;
    let client = IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());
    let soul = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../quetzalcoatl-spine/tests/fixtures/v1_soul_v14");
    call(
        &client,
        &IpcRequest::ImportV1 {
            soul_dir: soul,
            db_paths: Vec::new(),
        },
    )?;

    // 总览：名字、底线未签、计数。
    let overview = call(&client, &IpcRequest::SeaOverview)?;
    assert_eq!(overview["kind"], "sea_overview");
    let data = &overview["data"];
    assert_eq!(data["agent"]["name"], "青羽");
    assert_eq!(data["baseline"]["signed"], false);
    assert!(
        data["counts"]["memories"].as_u64().unwrap_or(0) >= 5,
        "{data}"
    );
    assert_eq!(data["sync"]["state"], "local-only");

    // 他：身份来自导入的自述。
    let me = call(&client, &IpcRequest::SeaSelf)?;
    let identity = me["data"]["identity"].to_string();
    assert!(identity.contains("青羽"), "{identity}");

    // 往事：分页与搜索。
    let page = call(
        &client,
        &IpcRequest::SeaMemories {
            query: None,
            state: None,
            cursor: None,
            limit: Some(2),
        },
    )?;
    assert_eq!(page["data"]["items"].as_array().map(Vec::len), Some(2));
    assert!(page["data"]["next_cursor"].is_string(), "还有下一页");
    let found = call(
        &client,
        &IpcRequest::SeaMemories {
            query: Some(String::from("跨设备切换会话")),
            state: None,
            cursor: None,
            limit: None,
        },
    )?;
    let hit = found["data"]["items"][0].clone();
    let id = hit["id"].as_str().ok_or("搜索应当命中一条")?.to_owned();
    assert!(
        hit["text"]
            .as_str()
            .unwrap_or_default()
            .contains("未完成目标")
    );
    assert_eq!(hit["source"]["kind"], "import");

    // 改：旧的一条到此为止，新的一条接替，来历里写着是你改的。
    let updated = call(
        &client,
        &IpcRequest::SeaEntryUpdate {
            id: id.clone(),
            text: String::from("跨设备切换会话时，先看未完成目标的步骤状态，再继续。"),
        },
    )?;
    let new_id = updated["data"]["id"]
        .as_str()
        .ok_or("改后的编号")?
        .to_owned();
    assert_ne!(new_id, id);
    assert!(updated["data"]["audit_seq"].as_u64().unwrap_or(0) > 0);
    let detail = call(&client, &IpcRequest::SeaMemory { id: new_id.clone() })?;
    assert_eq!(detail["data"]["supersedes"], id.as_str());
    assert_eq!(detail["data"]["by_owner"], true);
    assert_eq!(detail["data"]["history"][0]["action"], "corrected");
    assert_eq!(detail["data"]["history"][0]["by"], "你");
    let expired = call(
        &client,
        &IpcRequest::SeaMemories {
            query: None,
            state: Some(String::from("expired")),
            cursor: None,
            limit: None,
        },
    )?;
    assert!(
        expired["data"].to_string().contains(&id),
        "旧的那条在「已过期」里"
    );

    // 不主动提，再解除：来历里各记一笔。
    call(
        &client,
        &IpcRequest::SeaEntryMute {
            id: new_id.clone(),
            muted: true,
        },
    )?;
    call(
        &client,
        &IpcRequest::SeaEntryMute {
            id: new_id.clone(),
            muted: false,
        },
    )?;
    let detail = call(&client, &IpcRequest::SeaMemory { id: new_id.clone() })?;
    let actions: Vec<&str> = detail["data"]["history"]
        .as_array()
        .map(|h| h.iter().filter_map(|e| e["action"].as_str()).collect())
        .unwrap_or_default();
    assert_eq!(actions, vec!["corrected", "muted", "unmuted"]);

    // 抹除：再也找不到。
    call(&client, &IpcRequest::SeaEntryErase { id: new_id.clone() })?;
    assert!(call_err(&client, &IpcRequest::SeaMemory { id: new_id.clone() })?.contains("没有找到"));

    // 签底线：第一次签即设口令；口令太短不行；之后口令不对签不了。
    let sign = |passphrase: &str| IpcRequest::SeaBaselineSign {
        directives: vec![quetzalcoatl_daemon::DirectiveDraft {
            title: String::from("不替我做不可撤回的决定"),
            text: String::from("删除、付款、对外发送之前，先问我。"),
        }],
        passphrase: String::from(passphrase),
    };
    assert!(call_err(&client, &sign("short"))?.contains("口令至少"));
    let signed = call(&client, &sign("湖边第三棵柳树下面"))?;
    assert!(signed["data"]["signed_at_ms"].as_u64().unwrap_or(0) > 0);
    let baseline = call(&client, &IpcRequest::SeaBaseline)?;
    assert_eq!(baseline["data"]["signed"], true);
    assert_eq!(
        baseline["data"]["directives"][0]["title"],
        "不替我做不可撤回的决定"
    );
    assert!(call_err(&client, &sign("湖边第四棵柳树下面"))?.contains("口令不对"));
    let passphrase_file = fs::read_to_string(home.join("identity/owner_passphrase.json"))?;
    assert!(!passphrase_file.contains("湖边"), "口令本身不落盘");

    // 迎合：不低于下限。
    let us = call(&client, &IpcRequest::SeaFocusSet { self_weight: 0.0 })?;
    let floor = us["data"]["focus"]["floor_self"].as_f64().unwrap_or(1.0);
    assert!((us["data"]["focus"]["self_weight"].as_f64().unwrap_or(0.0) - floor).abs() < 1e-9);

    // 记录：最新的在前，本人的改动标着「owner」。
    let audit = call(
        &client,
        &IpcRequest::SeaAudit {
            cursor: None,
            limit: Some(5),
        },
    )?;
    let items = audit["data"]["items"].as_array().ok_or("记录")?;
    assert_eq!(items[0]["actor"], "owner");
    assert_eq!(items[0]["kind"], "迎合");
    assert!(
        items
            .windows(2)
            .all(|w| w[0]["seq"].as_u64() > w[1]["seq"].as_u64())
    );
    assert!(audit["data"]["next_cursor"].is_string());

    // 宿主与设备。
    let hosts = call(&client, &IpcRequest::SeaHosts)?;
    assert_eq!(hosts["data"]["hosts"][0]["host"], "claude-code");
    assert_eq!(
        hosts["data"]["hosts"][0]["checks"].as_array().map(Vec::len),
        Some(4)
    );
    let devices = call(&client, &IpcRequest::SeaDevices)?;
    assert_eq!(devices["data"]["devices"].as_array().map(Vec::len), Some(1));
    assert!(
        call_err(
            &client,
            &IpcRequest::SeaDeviceRevoke {
                device_id: devices["data"]["this_device"]["id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                passphrase: String::from("湖边第三棵柳树下面"),
            }
        )?
        .contains("正在使用"),
    );

    // 重启之后：底线、改动都还在。
    daemon.shutdown()?;
    let daemon = QuetzalcoatlDaemon::start(DaemonConfig::new(home.clone()))?;
    let client = IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());
    let baseline = call(&client, &IpcRequest::SeaBaseline)?;
    assert_eq!(baseline["data"]["signed"], true, "签过的底线重启后仍然有效");
    assert!(call_err(&client, &IpcRequest::SeaMemory { id: new_id })?.contains("没有找到"));
    Ok(())
}

#[test]
fn an_export_carries_him_to_an_empty_home_and_only_the_passphrase_opens_it() -> TestResult {
    let root = common::temp_root("carry")?;
    let _guard = TempGuard(root.clone());
    let home_a = root.join("a");
    let home_b = root.join("b");
    let zip = root.join("sea.zip");
    let mut daemon = QuetzalcoatlDaemon::start(DaemonConfig::new(home_a.clone()))?;
    let client = IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());
    let soul = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../quetzalcoatl-spine/tests/fixtures/v1_soul_v14");
    call(
        &client,
        &IpcRequest::ImportV1 {
            soul_dir: soul,
            db_paths: Vec::new(),
        },
    )?;
    let page = call(
        &client,
        &IpcRequest::SeaMemories {
            query: Some(String::from("跨设备切换会话")),
            state: None,
            cursor: None,
            limit: None,
        },
    )?;
    let id = page["data"]["items"][0]["id"]
        .as_str()
        .ok_or("命中")?
        .to_owned();
    let updated = call(
        &client,
        &IpcRequest::SeaEntryUpdate {
            id,
            text: String::from("鸢尾花计划在跨设备切换时先核对步骤状态"),
        },
    )?;
    let kept = updated["data"]["id"].as_str().ok_or("新编号")?.to_owned();
    let all = call(
        &client,
        &IpcRequest::SeaMemories {
            query: None,
            state: None,
            cursor: None,
            limit: Some(200),
        },
    )?;
    let erased = all["data"]["items"]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["id"] != kept.as_str()))
        .ok_or("还有别的往事")?
        .clone();
    let erased_text = erased["text"].as_str().unwrap_or_default().to_owned();
    call(
        &client,
        &IpcRequest::SeaEntryErase {
            id: erased["id"].as_str().unwrap_or_default().to_owned(),
        },
    )?;

    let exported = call(
        &client,
        &IpcRequest::Export {
            zip_path: zip.clone(),
            include_sealed_spine: true,
            passphrase: Some(String::from("湖边第三棵柳树下面")),
        },
    )?;
    assert_eq!(exported["data"]["detail"], "recoverable");
    daemon.shutdown()?;

    // 人读得懂的那一份。
    let readable =
        quetzalcoatl_spine::read_archive_entry(&zip, "海/往事.md")?.ok_or("可读的往事")?;
    let readable = String::from_utf8(readable)?;
    assert!(readable.contains("鸢尾花计划"), "{readable}");
    assert!(!readable.contains(&erased_text), "抹除的不在导出里");

    // 口令不对打不开；对了，空目录里他原样回来。
    assert!(quetzalcoatl_daemon::restore_offline(&home_b, &zip, "湖边第四棵柳树下面").is_err());
    let report = quetzalcoatl_daemon::restore_offline(&home_b, &zip, "湖边第三棵柳树下面")?;
    assert_eq!(report.agent_name, "青羽");
    assert!(
        quetzalcoatl_daemon::restore_offline(&home_b, &zip, "湖边第三棵柳树下面").is_err(),
        "已经有一片海的目录不接受恢复"
    );

    let daemon_b = QuetzalcoatlDaemon::start(DaemonConfig::new(home_b.clone()))?;
    let client_b =
        IpcClient::from_runtime_info(daemon_b.runtime_info(), daemon_b.ipc_token().to_owned());
    let found = call(
        &client_b,
        &IpcRequest::SeaMemories {
            query: Some(String::from("鸢尾花计划")),
            state: None,
            cursor: None,
            limit: None,
        },
    )?;
    assert_eq!(found["data"]["items"][0]["id"], kept.as_str(), "{found}");
    assert_eq!(found["data"]["items"][0]["by_owner"], true);
    let everything = call(
        &client_b,
        &IpcRequest::SeaMemories {
            query: None,
            state: Some(String::from("all")),
            cursor: None,
            limit: Some(200),
        },
    )?;
    assert!(
        !everything.to_string().contains(&erased_text),
        "抹除的没有回来"
    );
    Ok(())
}

#[test]
fn notes_and_chat_exports_come_in_as_one_batch_and_can_be_taken_back_out() -> TestResult {
    let root = common::temp_root("bring")?;
    let _guard = TempGuard(root.clone());
    let notes = root.join("notes");
    fs::create_dir_all(notes.join("sub"))?;
    fs::write(
        notes.join("项目.md"),
        "# 发布\n鸢尾花计划的发布日定在周四。\n# 数据库\n生产迁移先在预发环境演练。\n",
    )?;
    fs::write(
        notes.join("sub/conversations.json"),
        r#"[{"name":"旅行","chat_messages":[{"sender":"human","text":"我十月去京都，住鸭川附近"},{"sender":"assistant","text":"好的"}]}]"#,
    )?;
    fs::write(notes.join("photo.png"), [0u8, 1, 2])?;
    let daemon = QuetzalcoatlDaemon::start(DaemonConfig::new(root.join("h")))?;
    let client = IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());

    let brought = call(&client, &IpcRequest::ImportNotes { paths: vec![notes] })?;
    assert_eq!(brought["data"]["added"], 3, "{brought}");
    assert_eq!(brought["data"]["files"], 2, "{brought}");
    let batch = brought["data"]["batch_id"].as_str().ok_or("batch")?.to_owned();
    let found = call(
        &client,
        &IpcRequest::SeaMemories {
            query: Some(String::from("京都 鸭川")),
            state: None,
            cursor: None,
            limit: None,
        },
    )?;
    let hit = &found["data"]["items"][0];
    assert!(hit["text"].as_str().unwrap_or_default().contains("我十月去京都"));
    assert!(!hit["text"].as_str().unwrap_or_default().contains("好的"));
    assert_eq!(hit["source"]["kind"], "import");
    assert!(hit["source"]["label"].as_str().unwrap_or_default().contains(&batch));

    let undone = call(&client, &IpcRequest::ImportUndo { batch_id: batch })?;
    assert_eq!(undone["data"]["erased"], 3, "{undone}");
    let after = call(
        &client,
        &IpcRequest::SeaMemories {
            query: None,
            state: Some(String::from("all")),
            cursor: None,
            limit: Some(200),
        },
    )?;
    assert!(
        !after.to_string().contains("鸢尾花计划"),
        "整批撤回后一条不剩: {after}"
    );
    Ok(())
}
