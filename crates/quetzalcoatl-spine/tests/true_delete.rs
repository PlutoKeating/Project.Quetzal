#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 「抹除是真删」在存储层的含义：删掉之后，本机库的任何一个文件里都找不到那段内容。
//! 主库的页要清零，预写日志要截断，全文索引里的词条也要拿掉。

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use quetzalcoatl_spine::{MaterializedMemory, MaterializedStore, RusqliteWalStore};
use quetzalcoatl_types::HlcTimestamp;

type TestResult = Result<(), Box<dyn Error>>;

struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn any_file_contains(dir: &Path, needle: &[u8]) -> Result<Option<PathBuf>, Box<dyn Error>> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let bytes = fs::read(&path)?;
        if bytes.windows(needle.len()).any(|window| window == needle) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

#[test]
fn deleted_memories_and_keys_leave_no_bytes_in_any_database_file() -> TestResult {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("qz_true_delete_{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir)?;
    let _guard = TempDirGuard(dir.clone());

    let secret = "鸢尾花计划的发布日是周五";
    let key_material = "5ec2e7f00dfeedfacecafebabe0123456789abcdef0123456789abcdef012345";
    let mut store = RusqliteWalStore::open(&dir.join("spine.sqlite"))?;
    let hlc = HlcTimestamp::from_parts(1_795_400_000_000, 0, 1);
    for idx in 0..40 {
        store.upsert_memory(&MaterializedMemory {
            memory_id: format!("filler-{idx}"),
            category: String::from("memory"),
            authority: 30,
            content: format!("第 {idx} 条无关的往事，用来把页填满"),
            updated_hlc: hlc,
        })?;
    }
    store.upsert_memory(&MaterializedMemory {
        memory_id: String::from("mem-secret"),
        category: String::from("memory"),
        authority: 30,
        content: String::from(secret),
        updated_hlc: hlc,
    })?;
    store.put_private_blob("sea.entry-key/memory/mem-secret", key_material)?;
    assert!(
        any_file_contains(&dir, secret.as_bytes())?.is_some(),
        "写入之后应当找得到（否则这个用例什么都没验）"
    );
    assert_eq!(store.search_memories_fts("鸢尾花计划", 5)?.len(), 1);

    store.delete_memory("mem-secret")?;
    store.delete_private_blob("sea.entry-key/memory/mem-secret")?;

    assert!(store.search_memories_fts("鸢尾花计划", 5)?.is_empty());
    assert_eq!(
        store.get_private_blob("sea.entry-key/memory/mem-secret")?,
        None
    );
    assert_eq!(
        any_file_contains(&dir, secret.as_bytes())?,
        None,
        "正文不得留在任何一个库文件里"
    );
    assert_eq!(
        any_file_contains(&dir, "鸢尾花".as_bytes())?,
        None,
        "全文索引里的词条也不得留下"
    );
    assert_eq!(
        any_file_contains(&dir, key_material.as_bytes())?,
        None,
        "钥匙不得留在任何一个库文件里"
    );
    assert_eq!(store.list_memories()?.len(), 40, "别的往事不受影响");
    Ok(())
}
