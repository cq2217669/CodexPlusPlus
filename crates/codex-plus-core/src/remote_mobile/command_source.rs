use std::time::Duration;

use anyhow::{Context, bail};
use serde_json::{Value, json};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(12);

pub(super) async fn execute(request: Value) -> anyhow::Result<Value> {
    let port = crate::status::StatusStore::default()
        .load_latest()?
        .and_then(|status| status.debug_port)
        .context("桌面命令入口暂不可用")?;
    let targets = crate::cdp::list_targets(port).await?;
    let target = targets
        .iter()
        .find(|target| {
            crate::cdp::is_primary_codex_page_target(target) && target.url.starts_with("app://-/")
        })
        .context("桌面命令页面暂不可用")?;
    let websocket = target
        .web_socket_debugger_url
        .as_deref()
        .context("桌面命令连接暂不可用")?;
    crate::cdp::validate_cdp_websocket_url(websocket, port)?;
    let request = serde_json::to_string(&request)?;
    let script = format!(
        r#"(async () => {{
          const execute = window.__codexPlusMobileRemoteCommand;
          if (typeof execute !== "function") {{
            return {{ status: "failed", errorCode: "unsupported_operation",
              message: "桌面远程命令桥尚未就绪，请重启轩++与 Codex" }};
          }}
          try {{
            return await execute({request});
          }} catch (error) {{
            return {{ status: "failed", errorCode: "internal",
              message: String(error?.message || error || "桌面命令执行失败") }};
          }}
        }})()"#
    );
    let response = crate::bridge::evaluate_script_with_await_promise_timeout(
        websocket,
        &script,
        true,
        COMMAND_TIMEOUT,
    )
    .await
    .context("桌面命令响应失败")?;
    let value = response
        .get("result")
        .and_then(|result| result.get("result"))
        .and_then(|result| result.get("value"))
        .cloned()
        .context("桌面命令未返回结果")?;
    if !value.is_object() {
        bail!("桌面命令结果格式无效");
    }
    Ok(value)
}

pub(super) fn request(
    command_type: &str,
    thread_id: &str,
    turn_id: &str,
    client_request_id: &str,
    cwd: &str,
    model: &str,
    provider: &str,
    text: &str,
    name: &str,
) -> Value {
    json!({
        "commandType": command_type,
        "threadId": thread_id,
        "turnId": turn_id,
        "clientRequestId": client_request_id,
        "cwd": cwd,
        "model": model,
        "provider": provider,
        "text": text,
        "name": name,
    })
}
