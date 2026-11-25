//! 浏览器 OPFS 单写者存储（`wasm32-unknown-unknown`）。
//!
//! 写入前**必须先取到独占 Web Lock**（`navigator.locks.request(name, {mode:"exclusive",
//! ifAvailable:true})`）：取不到立即以 `writer lock busy` 失败，绝不无锁写入。
//! `web-sys` 的 `LockManager` 仍标注为 unstable API，为免给全仓库引入
//! `--cfg web_sys_unstable_apis`，这里通过 `Reflect` 动态取得 `navigator.locks.request`
//! 并按 Web Locks 标准签名调用（同步/异步语义完全一致，且对旧浏览器可优雅报错）。
//!
//! 运行时验证（真实浏览器 OPFS + Web Lock 竞争）属于 Task 4.2 Web 端 E2E；
//! 本模块由 `cargo check --target wasm32-unknown-unknown` 做类型级门禁。

use js_sys::{Function, Promise, Reflect};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::{JsFuture, spawn_local};

const LOCK_PREFIX: &str = "quetzalcoatl-spine-writer";
const OPFS_ROOT: &str = "quetzalcoatl-spine";

/// 统一 Window 与 Web Worker 两种全局对象下的 `navigator`（以 JS 对象返回，
/// 避开 `Navigator` / `WorkerNavigator` 两个 web-sys 类型的分叉）。
fn navigator_object() -> Result<JsValue, JsValue> {
    let global = js_sys::global();
    if let Ok(window) = global.clone().dyn_into::<web_sys::Window>() {
        return Ok(window.navigator().into());
    }
    if let Ok(worker) = global.dyn_into::<web_sys::WorkerGlobalScope>() {
        return Ok(worker.navigator().into());
    }
    Err(JsValue::from_str(
        "当前全局对象没有 navigator（需要 Window 或 WorkerGlobalScope）",
    ))
}

fn storage_manager() -> Result<web_sys::StorageManager, JsValue> {
    let nav = navigator_object()?;
    Reflect::get(&nav, &JsValue::from_str("storage"))?
        .dyn_into::<web_sys::StorageManager>()
        .map_err(|_| JsValue::from_str("navigator.storage 不可用（缺少 OPFS 支持）"))
}

fn validate_key(key: &str) -> Result<(), JsValue> {
    if key.is_empty()
        || key.len() > 200
        || key.contains('/')
        || key.contains('\\')
        || key.contains("..")
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(JsValue::from_str("非法 OPFS 存储键"));
    }
    Ok(())
}

/// `navigator.locks.request(name, options, callback)` 的动态调用器。
async fn request_exclusive_lock(
    lock_name: &str,
    body: impl FnOnce() -> Promise + 'static,
) -> Result<(), JsValue> {
    let nav = navigator_object()?;
    let locks = Reflect::get(&nav, &JsValue::from_str("locks"))?;
    if locks.is_undefined() || locks.is_null() {
        return Err(JsValue::from_str(
            "当前浏览器缺少 Web Locks（navigator.locks），拒绝无锁写入 OPFS",
        ));
    }
    let request = Reflect::get(&locks, &JsValue::from_str("request"))?
        .dyn_into::<Function>()
        .map_err(|_| JsValue::from_str("navigator.locks.request 不可调用"))?;

    let options = js_sys::Object::new();
    Reflect::set(
        &options,
        &JsValue::from_str("mode"),
        &JsValue::from_str("exclusive"),
    )?;
    // fail fast：锁被其他写者持有时回调会以 null 调用，而不是排队阻塞。
    Reflect::set(&options, &JsValue::from_str("ifAvailable"), &JsValue::TRUE)?;

    let body = std::cell::RefCell::new(Some(body));
    let callback = Closure::<dyn FnMut(JsValue) -> Promise>::new(move |lock: JsValue| {
        if lock.is_null() || lock.is_undefined() {
            return Promise::reject(&JsValue::from_str(
                "writer lock busy: 另一写者正持有 OPFS 独占租约",
            ));
        }
        let Some(body) = body.borrow_mut().take() else {
            return Promise::reject(&JsValue::from_str("writer lock body 已被消费"));
        };
        body()
    });

    let promise = request
        .call3(
            &locks,
            &JsValue::from_str(lock_name),
            &options,
            callback.as_ref().unchecked_ref::<Function>(),
        )
        .map_err(|_| JsValue::from_str("navigator.locks.request 调用失败"))?;
    let promise: Promise = promise
        .dyn_into()
        .map_err(|_| JsValue::from_str("navigator.locks.request 未返回 Promise"))?;

    JsFuture::from(promise).await?;
    drop(callback);
    Ok(())
}

fn spawn_body(future: impl std::future::Future<Output = Result<(), JsValue>> + 'static) -> Promise {
    let mut future = Some(future);
    Promise::new(&mut move |resolve, reject| {
        let Some(future) = future.take() else {
            let _ = reject.call1(&JsValue::NULL, &JsValue::from_str("body 已执行"));
            return;
        };
        spawn_local(async move {
            match future.await {
                Ok(()) => {
                    let _ = resolve.call0(&JsValue::NULL);
                }
                Err(err) => {
                    let _ = reject.call1(&JsValue::NULL, &err);
                }
            }
        });
    })
}

/// 受 Web Lock 保护的 OPFS 单写者存储句柄。
#[wasm_bindgen]
pub struct OpfsSpine {
    dir: web_sys::FileSystemDirectoryHandle,
    lock_name: String,
}

#[wasm_bindgen]
impl OpfsSpine {
    /// 打开（或创建）`OPFS/quetzalcoatl-spine/<root>` 目录。
    pub async fn open(root: String) -> Result<OpfsSpine, JsValue> {
        let storage = storage_manager()?;
        let root_dir = JsFuture::from(web_sys::StorageManager::get_directory(&storage))
            .await?
            .dyn_into::<web_sys::FileSystemDirectoryHandle>()
            .map_err(|_| JsValue::from_str("OPFS getDirectory 返回类型错误"))?;
        let opts = web_sys::FileSystemGetDirectoryOptions::new();
        opts.set_create(true);
        let dir = JsFuture::from(root_dir.get_directory_handle_with_options(OPFS_ROOT, &opts))
            .await?
            .dyn_into::<web_sys::FileSystemDirectoryHandle>()
            .map_err(|_| JsValue::from_str("OPFS getDirectoryHandle 返回类型错误"))?;

        Ok(OpfsSpine {
            dir,
            lock_name: format!("{LOCK_PREFIX}:{root}"),
        })
    }

    /// 在独占 Web Lock 下原子写入一个键（锁争用立即失败）。
    pub async fn write_blob(&self, key: String, bytes: Vec<u8>) -> Result<(), JsValue> {
        validate_key(&key)?;
        let dir = self.dir.clone();
        let lock_name = self.lock_name.clone();
        request_exclusive_lock(&lock_name, move || {
            spawn_body(async move {
                let opts = web_sys::FileSystemGetFileOptions::new();
                opts.set_create(true);
                let handle = JsFuture::from(dir.get_file_handle_with_options(&key, &opts)).await?;
                let file = handle
                    .dyn_into::<web_sys::FileSystemFileHandle>()
                    .map_err(|_| JsValue::from_str("OPFS getFileHandle 返回类型错误"))?;
                let writable = JsFuture::from(file.create_writable()).await?;
                let writable = writable
                    .dyn_into::<web_sys::FileSystemWritableFileStream>()
                    .map_err(|_| JsValue::from_str("OPFS createWritable 返回类型错误"))?;
                JsFuture::from(writable.write_with_u8_array(&bytes)?).await?;
                JsFuture::from(writable.close()).await?;
                Ok(())
            })
        })
        .await
    }

    /// 读取一个键（不存在返回 `undefined`）。
    pub async fn read_blob(&self, key: String) -> Result<Option<Vec<u8>>, JsValue> {
        validate_key(&key)?;
        let handle = match JsFuture::from(self.dir.get_file_handle(&key)).await {
            Ok(handle) => handle,
            Err(_) => return Ok(None),
        };
        let file = handle
            .dyn_into::<web_sys::FileSystemFileHandle>()
            .map_err(|_| JsValue::from_str("OPFS getFileHandle 返回类型错误"))?;
        let blob = JsFuture::from(file.get_file())
            .await?
            .dyn_into::<web_sys::Blob>()
            .map_err(|_| JsValue::from_str("OPFS getFile 返回类型错误"))?;
        let buffer = JsFuture::from(blob.array_buffer())
            .await?
            .dyn_into::<js_sys::ArrayBuffer>()
            .map_err(|_| JsValue::from_str("Blob.arrayBuffer 返回类型错误"))?;
        Ok(Some(js_sys::Uint8Array::new(&buffer).to_vec()))
    }
}

/// 供 JS 直接调用的纯 Rust `ruzstd` 解压入口（浏览器端不捆绑 C zstd）。
#[wasm_bindgen]
pub fn decompress_pack_frame(frame: &[u8]) -> Result<Vec<u8>, JsValue> {
    crate::compress::decompress_pack(frame)
        .map_err(|e| JsValue::from_str(&format!("ruzstd 解压失败: {e}")))
}
