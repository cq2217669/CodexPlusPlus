use std::time::Duration;

use anyhow::{Context, bail};
use reqwest::Url;
use serde_json::{Value, json};

use crate::settings::BackendSettings;

const DEFAULT_USAGE_PATH: &str = "/v1/usage";
const DEFAULT_TIMEZONE: &str = "Asia/Shanghai";

pub async fn query(payload: Value, settings: &BackendSettings) -> anyhow::Result<Value> {
    if !settings.enhancements_enabled || !settings.codex_app_relay_balance_enabled {
        return Ok(json!({
            "status": "ok",
            "disabled": true,
            "message": "中转余额监控未启用",
        }));
    }
    if settings.active_aggregate_relay_profile().is_some() {
        return Ok(json!({
            "status": "ok",
            "disabled": true,
            "message": "当前为聚合中转，无法确定单一账户余额",
        }));
    }

    let profile = settings.active_relay_profile();
    let endpoint = if profile.upstream_base_url.trim().is_empty() {
        profile.base_url.trim()
    } else {
        profile.upstream_base_url.trim()
    };
    if endpoint.is_empty() || (profile.api_key.trim().is_empty() && !profile.uses_no_auth()) {
        return Ok(json!({
            "status": "ok",
            "disabled": true,
            "message": "当前中转未配置可用的地址和 API Key",
        }));
    }

    let usage_path = payload
        .get("usagePath")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_USAGE_PATH);
    let range = usage_range(&payload);
    let url = build_usage_url(endpoint, usage_path, range.as_ref())?;
    let client = crate::http_client::proxied_client(&profile.user_agent)?;
    let mut request = client.get(url.clone()).header("Accept", "application/json");
    if !profile.api_key.trim().is_empty() {
        request = request
            .bearer_auth(profile.api_key.trim())
            .header("x-api-key", profile.api_key.trim());
    }
    let response = tokio::time::timeout(Duration::from_secs(15), request.send())
        .await
        .context("余额请求超时")??;
    let status = response.status();
    let body = response.text().await.context("读取余额响应失败")?;
    if !status.is_success() {
        bail!(remote_error_message(status.as_u16(), &body));
    }
    let data: Value = serde_json::from_str(&body).context("余额接口返回了无法解析的 JSON")?;
    Ok(json!({
        "status": "ok",
        "disabled": false,
        "profileId": profile.id,
        "profileName": profile.name,
        "data": data,
    }))
}

#[derive(Debug)]
struct UsageRange {
    start_date: String,
    end_date: String,
    timezone: String,
}

fn usage_range(payload: &Value) -> Option<UsageRange> {
    let start_date = payload.get("startDate").and_then(Value::as_str)?.trim();
    let end_date = payload.get("endDate").and_then(Value::as_str)?.trim();
    if start_date.is_empty() || end_date.is_empty() {
        return None;
    }
    let timezone = payload
        .get("timezone")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_TIMEZONE);
    Some(UsageRange {
        start_date: start_date.to_string(),
        end_date: end_date.to_string(),
        timezone: timezone.to_string(),
    })
}

fn build_usage_url(
    endpoint: &str,
    usage_path: &str,
    range: Option<&UsageRange>,
) -> anyhow::Result<Url> {
    let mut url = Url::parse(endpoint.trim()).context("中转站地址无效")?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("余额接口仅支持 HTTP 或 HTTPS");
    }
    let usage_path = normalize_usage_path(usage_path)?;
    let base_path = url.path().trim_end_matches('/');
    let target_path = if base_path.ends_with("/usage") && usage_path == DEFAULT_USAGE_PATH {
        base_path.to_string()
    } else if base_path.ends_with("/v1") && usage_path == DEFAULT_USAGE_PATH {
        format!("{base_path}/usage")
    } else {
        format!("{base_path}{usage_path}")
    };
    url.set_path(&target_path);
    url.set_query(None);
    if let Some(range) = range {
        url.query_pairs_mut()
            .append_pair("start_date", &range.start_date)
            .append_pair("end_date", &range.end_date)
            .append_pair("days", "90")
            .append_pair("timezone", &range.timezone);
    }
    Ok(url)
}

fn normalize_usage_path(path: &str) -> anyhow::Result<String> {
    let path = path.trim();
    if path.is_empty() {
        return Ok(DEFAULT_USAGE_PATH.to_string());
    }
    if path.contains("://") || path.starts_with("//") || path.contains(['?', '#']) {
        bail!("余额接口路径必须是站内路径");
    }
    Ok(format!("/{}", path.trim_start_matches('/')))
}

fn remote_error_message(status: u16, body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let detail = parsed
        .as_ref()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.get("message"))
                .or_else(|| value.get("detail"))
                .or_else(|| value.pointer("/error/code"))
                .or_else(|| value.get("code"))
        })
        .and_then(Value::as_str)
        .unwrap_or_else(|| body.trim())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let detail = detail.chars().take(240).collect::<String>();
    if detail.is_empty() {
        format!("余额接口请求失败：HTTP {status}")
    } else {
        format!("余额接口请求失败：HTTP {status}：{detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_sub2api_usage_urls_without_repeating_v1() {
        assert_eq!(
            build_usage_url("https://relay.example/v1", "/v1/usage", None)
                .unwrap()
                .as_str(),
            "https://relay.example/v1/usage"
        );
        assert_eq!(
            build_usage_url("https://relay.example/api", "v1/usage", None)
                .unwrap()
                .as_str(),
            "https://relay.example/api/v1/usage"
        );
    }

    #[test]
    fn appends_usage_range_and_rejects_absolute_override() {
        let range = UsageRange {
            start_date: "2026-09-01".to_string(),
            end_date: "2026-09-04".to_string(),
            timezone: "Asia/Shanghai".to_string(),
        };
        let url = build_usage_url("https://relay.example", "/v1/usage", Some(&range)).unwrap();
        assert!(url.as_str().contains("start_date=2026-09-01"));
        assert!(url.as_str().contains("timezone=Asia%2FShanghai"));
        assert!(build_usage_url("https://relay.example", "https://evil.test", None).is_err());
    }

    #[tokio::test]
    async fn disabled_query_does_not_contact_the_network() {
        let result = query(Value::Null, &BackendSettings::default())
            .await
            .unwrap();
        assert_eq!(result["disabled"], true);
    }
}
