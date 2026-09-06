use std::collections::BTreeSet;
use std::sync::{Arc, OnceLock};

use codex_plus_core::remote_mobile::{MobileRemote, MobileStatus, official_tasks::OfficialTask};

fn runtime() -> &'static Arc<MobileRemote> {
    static RUNTIME: OnceLock<Arc<MobileRemote>> = OnceLock::new();
    RUNTIME.get_or_init(|| Arc::new(MobileRemote::default()))
}

pub fn restore() {
    let remote = Arc::clone(runtime());
    tauri::async_runtime::spawn(async move { remote.restore().await });
}

#[tauri::command]
pub fn mobile_remote_status() -> MobileStatus {
    runtime().status()
}

#[tauri::command]
pub async fn mobile_remote_pair() -> Result<MobileStatus, String> {
    runtime().pair().await
}

#[tauri::command]
pub async fn mobile_remote_enable(enabled: bool) -> Result<MobileStatus, String> {
    runtime().enable(enabled).await
}

#[tauri::command]
pub async fn mobile_remote_confirm(
    request_id: String,
    confirmed: bool,
) -> Result<MobileStatus, String> {
    runtime().confirm(request_id, confirmed).await
}

#[tauri::command]
pub async fn mobile_remote_auto_sync(enabled: bool) -> Result<MobileStatus, String> {
    runtime().auto_sync(enabled).await
}

#[tauri::command]
pub async fn mobile_remote_select(selected: BTreeSet<String>) -> Result<MobileStatus, String> {
    runtime().select(selected).await
}

#[tauri::command]
pub async fn mobile_remote_tasks() -> Result<Vec<OfficialTask>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        codex_plus_core::remote_mobile::official_tasks::list_tasks(
            &codex_plus_core::codex_home::default_codex_home_dir(),
        )
        .map_err(|_| "暂时无法读取官方任务列表，请稍后重试".to_owned())
    })
    .await
    .map_err(|_| "读取任务列表失败".to_owned())?
}
