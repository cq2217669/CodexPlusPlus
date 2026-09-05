use std::time::Duration;

use anyhow::{Context, bail};
use reqwest::Url;
use serde_json::{Value, json};

use crate::settings::BackendSettings;

const DEFAULT_USAGE_PATH: &str = "/v1/usage";
const DEFAULT_TIMEZONE: &str = "Asia/Shanghai";
const OWLAI_HOST: &str = "api.owlai.tech";
const OWLAI_USAGE_URL: &str = "https://api.owlai.tech/v1/usage";

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
    if endpoint.is_empty() {
        return Ok(json!({
            "status": "ok",
            "disabled": true,
            "message": "当前中转未配置可用的地址",
        }));
    }

    let provider = resolve_provider(endpoint, &settings.codex_app_relay_balance_provider)?;
    if provider == "owlai" {
        return Ok(
            match query_owlai(&profile.api_key, &profile.user_agent).await {
                Ok(data) => json!({
                    "status": "ok",
                    "disabled": false,
                    "provider": provider,
                    "profileId": profile.id,
                    "profileName": profile.name,
                    "data": data,
                }),
                Err(error) => json!({
                    "status": "failed",
                    "provider": provider,
                    "profileName": profile.name,
                    "message": error.to_string(),
                }),
            },
        );
    }
    if profile.api_key.trim().is_empty() && !profile.uses_no_auth() {
        bail!("当前中转未配置可用的 API Key");
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
        "provider": provider,
        "profileId": profile.id,
        "profileName": profile.name,
        "data": data,
    }))
}

fn resolve_provider(endpoint: &str, configured: &str) -> anyhow::Result<&'static str> {
    let url = Url::parse(endpoint.trim()).context("中转站地址无效")?;
    let is_owlai = url.scheme() == "https"
        && url.host_str() == Some(OWLAI_HOST)
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none();
    match configured.trim() {
        "" | "auto" => Ok(if is_owlai { "owlai" } else { "generic" }),
        "generic" => Ok("generic"),
        "owlai" if is_owlai => Ok("owlai"),
        "owlai" => bail!("OwlAI 方案仅适用于当前地址为 api.owlai.tech 的 HTTPS 中转"),
        _ => bail!("用量方案无效，请重新选择"),
    }
}

async fn query_owlai(api_key: &str, user_agent: &str) -> anyhow::Result<Value> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .user_agent(if user_agent.trim().is_empty() {
            format!("XuanPlusPlus/{}", env!("CARGO_PKG_VERSION"))
        } else {
            user_agent.trim().to_string()
        })
        .build()
        .map_err(|_| anyhow::anyhow!("无法初始化用量查询"))?;
    let response = owlai_request(&client, api_key)?
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("今日用量查询连接失败或超时，请检查网络后重试"))?;
    if !response.status().is_success() {
        bail!(remote_error_message(response.status().as_u16(), ""));
    }
    let data: Value = response
        .json()
        .await
        .map_err(|_| anyhow::anyhow!("用量接口返回的数据无法识别"))?;
    parse_owlai_today(&data)
}

fn owlai_request(
    client: &reqwest::Client,
    api_key: &str,
) -> anyhow::Result<reqwest::RequestBuilder> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        bail!("请在当前中转配置中填写并保存 API Key");
    }
    if !api_key.is_ascii()
        || api_key
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        bail!("当前中转的 API Key 格式无效，请检查后重试");
    }
    // 只读取站点定义的今日摘要；不发送自定义路径和日期，也不携带登录凭据。
    Ok(client
        .get(OWLAI_USAGE_URL)
        .query(&[("days", "1"), ("timezone", DEFAULT_TIMEZONE)])
        .header("Accept", "application/json")
        .header("Accept-Language", "zh")
        .bearer_auth(api_key))
}

fn quota_number(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    let number = value.as_f64().or_else(|| value.as_str()?.parse().ok())?;
    (number.is_finite() && number >= 0.0).then_some(number)
}

fn parse_owlai_today(payload: &Value) -> anyhow::Result<Value> {
    if !payload.is_object() {
        bail!("OwlAI 返回的数据无法识别");
    }
    if payload.get("error").is_some()
        || payload
            .get("code")
            .is_some_and(|code| code.as_i64() != Some(0))
        || payload.get("isValid") == Some(&Value::Bool(false))
    {
        bail!("OwlAI 用量查询未成功，请检查当前中转的 API Key");
    }
    // 缺失数据不视为零，也不使用标价、累计消耗或账户订阅消耗代替当前 Key 的实际扣费。
    let today_used = quota_number(payload.pointer("/usage/today/actual_cost"));
    Ok(json!({ "todayUsed": today_used, "unit": "USD" }))
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

fn remote_error_message(status: u16, _body: &str) -> String {
    match status {
        401 | 403 => "用量查询凭据无效或已过期，请更新对应方案的凭据".to_string(),
        404 => "站点未提供该用量接口，请检查所选方案".to_string(),
        429 => "用量查询过于频繁，请稍后重试".to_string(),
        300..=399 => "用量接口发生重定向，请检查站点地址".to_string(),
        _ => format!("站点暂时无法完成用量查询（状态码 {status}），请稍后重试"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owlai_reads_only_current_key_today_actual_cost() {
        let data = parse_owlai_today(&json!({
            "balance": 999,
            "remaining": 100,
            "subscription": { "daily_usage_usd": 88 },
            "usage": {
                "today": { "actual_cost": 1.2345, "cost": 20 },
                "total": { "actual_cost": 200 }
            },
            "private_test_field": "private-test-value"
        }))
        .unwrap();
        assert_eq!(data, json!({"todayUsed": 1.2345, "unit": "USD"}));
        assert!(!data.to_string().contains("private-test-value"));
        for value in [json!(0), json!("0"), json!("1.25"), json!(1.25)] {
            let data =
                parse_owlai_today(&json!({"usage": {"today": {"actual_cost": value}}})).unwrap();
            assert!(data["todayUsed"].is_number());
        }
    }

    #[test]
    fn owlai_missing_today_cost_is_not_zero_or_another_metric() {
        for value in [
            Value::Null,
            json!(""),
            json!(" "),
            json!(false),
            json!([]),
            json!({}),
            json!(-1),
            json!("NaN"),
            json!("inf"),
        ] {
            let data = parse_owlai_today(&json!({
                "usage": {"today": {"actual_cost": value, "cost": 20}, "total": {"actual_cost": 200}},
                "balance": 100
            })).unwrap();
            assert!(data["todayUsed"].is_null());
        }
        for payload in [
            json!({}),
            json!({"usage": {}}),
            json!({"usage": {"today": {"cost": 10}}}),
        ] {
            assert!(parse_owlai_today(&payload).unwrap()["todayUsed"].is_null());
        }
    }

    #[test]
    fn owlai_rejects_errors_without_forwarding_remote_details() {
        for payload in [
            json!({"code": 401, "message": "private-test-value"}),
            json!({"error": {"message": "private-test-value"}}),
            json!({"isValid": false}),
            json!([]),
            Value::Null,
        ] {
            let error = parse_owlai_today(&payload).unwrap_err().to_string();
            assert!(!error.contains("private-test-value"));
        }
        assert!(!remote_error_message(401, "private-test-value").contains("private-test-value"));
    }

    #[test]
    fn owlai_preset_pins_origin_and_uses_model_key() {
        for endpoint in [
            "https://api.owlai.tech",
            "https://api.owlai.tech/v1",
            "https://api.owlai.tech/api/v1",
        ] {
            assert_eq!(resolve_provider(endpoint, "").unwrap(), "owlai");
        }
        for endpoint in [
            "https://api.owlai.tech.evil.test",
            "http://api.owlai.tech",
            "https://api.owlai.tech:444",
            "https://relay.example",
        ] {
            assert_eq!(resolve_provider(endpoint, "").unwrap(), "generic");
            assert!(resolve_provider(endpoint, "owlai").is_err());
        }
        assert_eq!(
            resolve_provider("https://api.owlai.tech/v1", "generic").unwrap(),
            "generic"
        );
        let client = reqwest::Client::new();
        assert!(owlai_request(&client, "").is_err());
        assert!(owlai_request(&client, "test\r\nheader").is_err());
        let request = owlai_request(&client, " test-model-key ")
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            request.url().as_str(),
            "https://api.owlai.tech/v1/usage?days=1&timezone=Asia%2FShanghai"
        );
        assert_eq!(request.method(), reqwest::Method::GET);
        assert_eq!(request.headers()["authorization"], "Bearer test-model-key");
        assert!(!request.headers().contains_key("x-user-ui-request"));
        assert!(!request.headers().contains_key("x-api-key"));
        assert!(!request.headers().contains_key("cookie"));
    }

    #[tokio::test]
    async fn owlai_missing_model_key_does_not_use_legacy_login_token() {
        let settings = BackendSettings {
            enhancements_enabled: true,
            codex_app_relay_balance_enabled: true,
            codex_app_relay_balance_owl_token: "test-private-login-token".to_string(),
            relay_profiles: vec![crate::settings::RelayProfile {
                base_url: "https://api.owlai.tech/v1".to_string(),
                api_key: String::new(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let result = query(json!({"usagePath": "https://evil.test"}), &settings)
            .await
            .unwrap();
        assert_eq!(result["status"], "failed");
        assert_eq!(result["provider"], "owlai");
        assert!(result["message"].as_str().unwrap().contains("API Key"));
        assert!(!result.to_string().contains("test-private-login-token"));
    }

    #[test]
    fn owlai_login_token_never_enters_injected_scripts() {
        let settings = BackendSettings {
            enhancements_enabled: true,
            codex_app_relay_balance_enabled: true,
            codex_app_relay_balance_provider: "owlai".to_string(),
            codex_app_relay_balance_owl_token: "test-private-login-token".to_string(),
            ..Default::default()
        };
        let script = crate::assets::injection_script_with_settings(57321, &settings);
        assert!(script.contains("__codexPlusRelayBalance"));
        assert!(!script.contains("test-private-login-token"));
        assert!(!script.contains("codexAppRelayBalanceOwlToken"));
    }

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
