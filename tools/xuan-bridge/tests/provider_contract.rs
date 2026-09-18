use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;

use serde_json::{Value, json};
use tempfile::TempDir;

fn serve_once(content_type: &str, body: Vec<u8>) -> (SocketAddr, Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = mpsc::channel();
    let content_type = content_type.to_string();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = Vec::new();
        let mut header_end = None;
        let mut chunk = [0_u8; 1024];
        while request.len() < 64 * 1024 {
            let read = stream.read(&mut chunk).unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
            if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                header_end = Some(index + 4);
                break;
            }
        }
        let header_end = header_end.unwrap();
        let headers = String::from_utf8_lossy(&request[..header_end]);
        let content_length = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        while request.len() < header_end + content_length {
            let read = stream.read(&mut chunk).unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
        }
        sender
            .send(String::from_utf8_lossy(&request).to_string())
            .unwrap();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .unwrap();
        stream.write_all(&body).unwrap();
    });
    (address, receiver)
}

fn serve_json_once(body: Value) -> (SocketAddr, Receiver<String>) {
    serve_once("application/json", serde_json::to_vec(&body).unwrap())
}

fn serve_json_sequence(bodies: Vec<Value>) -> (SocketAddr, Receiver<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut requests = Vec::new();
        for body in bodies {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            while request.len() < 64 * 1024 {
                let read = stream.read(&mut chunk).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            requests.push(String::from_utf8_lossy(&request).to_string());
            let body = serde_json::to_vec(&body).unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        }
        sender.send(requests).unwrap();
    });
    (address, receiver)
}

fn serve_sse_once(events: &str) -> (SocketAddr, Receiver<String>) {
    serve_once("text/event-stream", events.as_bytes().to_vec())
}

fn call_bridge(home: &TempDir, method: &str, params: Value, env: &[(&str, &str)]) -> Value {
    let mut command = Command::new(env!("CARGO_BIN_EXE_xuan-bridge"));
    command
        .env("XUAN_HOME", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command.spawn().unwrap();
    writeln!(
        child.stdin.as_mut().unwrap(),
        "{}",
        json!({ "id": "contract", "method": method, "params": params })
    )
    .unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "bridge failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(output.stdout.trim_ascii()).unwrap()
}

fn write_config(home: &TempDir, config: Value) {
    fs::write(
        home.path().join("xuan-plugins.json"),
        serde_json::to_vec_pretty(&config).unwrap(),
    )
    .unwrap();
}

#[test]
fn usage_query_uses_the_current_relay_instead_of_stale_usage_configuration() {
    let home = tempfile::tempdir().unwrap();
    let (address, request) = serve_json_once(json!({ "total": 12.5, "unit": "USD" }));
    let codex_settings = home.path().join("codex-settings.json");
    fs::write(
        &codex_settings,
        serde_json::to_vec_pretty(&json!({
            "activeRelayId": "primary",
            "relayProfiles": [{
                "id": "primary",
                "name": "Current Relay",
                "protocol": "responses",
                "upstreamBaseUrl": format!("http://{address}/v1"),
                "authContents": "{\"OPENAI_API_KEY\":\"relay-secret\"}"
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    write_config(
        &home,
        json!({
            "schemaVersion": 1,
            "plugins": {
                "xuan-usage": {
                    "defaultProfile": "stale",
                    "profiles": {
                        "stale": {
                            "provider": "owlai",
                            "baseUrl": "https://api.owlai.tech/v1",
                            "apiKeyEnv": "XUAN_TEST_USAGE_KEY"
                        }
                    }
                }
            }
        }),
    );
    let response = call_bridge(
        &home,
        "usage.query",
        json!({ "startDate": "2026-09-01", "endDate": "2026-09-11" }),
        &[
            ("XUAN_CODEX_SETTINGS_PATH", codex_settings.to_str().unwrap()),
            ("XUAN_TEST_USAGE_KEY", "usage-secret"),
            ("XUAN_USAGE_BASE_URL", "https://api.owlai.tech/v1"),
            ("XUAN_USAGE_PROVIDER", "owlai"),
        ],
    );
    assert_eq!(response["result"]["profileRef"], "primary");
    assert_eq!(response["result"]["data"]["total"], 12.5);
    assert!(!response.to_string().contains("relay-secret"));
    let request = request.recv().unwrap();
    assert!(request.starts_with("GET /v1/usage?"));
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer relay-secret")
    );
}

#[test]
fn usage_query_ignores_a_custom_address_request() {
    let home = tempfile::tempdir().unwrap();
    let (address, request) = serve_json_once(json!({ "total": 7.5, "unit": "USD" }));
    let codex_settings = home.path().join("codex-settings.json");
    fs::write(
        &codex_settings,
        serde_json::to_vec_pretty(&json!({
            "activeRelayId": "active-relay",
            "relayProfiles": [{
                "id": "active-relay",
                "name": "Active Relay",
                "protocol": "responses",
                "upstreamBaseUrl": format!("http://{address}/v1"),
                "authContents": "{\"OPENAI_API_KEY\":\"relay-secret\"}"
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    write_config(
        &home,
        json!({
            "schemaVersion": 1,
            "plugins": { "xuan-usage": {} }
        }),
    );
    let response = call_bridge(
        &home,
        "usage.query",
        json!({
            "baseUrl": "https://api.owlai.tech/v1",
            "startDate": "2026-09-01",
            "endDate": "2026-09-11"
        }),
        &[("XUAN_CODEX_SETTINGS_PATH", codex_settings.to_str().unwrap())],
    );
    assert_eq!(response["result"]["profileRef"], "active-relay");
    assert_eq!(response["result"]["data"]["total"], 7.5);
    assert!(!response.to_string().contains("relay-secret"));
    let request = request.recv().unwrap();
    assert!(request.starts_with("GET /v1/usage?"));
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer relay-secret")
    );
}

#[test]
fn openox_settings_are_scoped_to_the_active_relay_without_returning_the_token() {
    let home = tempfile::tempdir().unwrap();
    let codex_settings = home.path().join("codex-settings.json");
    fs::write(
        &codex_settings,
        serde_json::to_vec_pretty(&json!({
            "activeRelayId": "openox-primary",
            "relayProfiles": [{
                "id": "openox-primary",
                "name": "OpenOx",
                "protocol": "responses",
                "upstreamBaseUrl": "https://api.openox.tech/v1",
                "authContents": "{\"OPENAI_API_KEY\":\"relay-secret\"}"
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    write_config(
        &home,
        json!({ "schemaVersion": 1, "plugins": { "xuan-usage": {} } }),
    );
    let env = [("XUAN_CODEX_SETTINGS_PATH", codex_settings.to_str().unwrap())];
    let initial = call_bridge(&home, "usage.settings.get", json!({}), &env);
    assert_eq!(initial["result"]["provider"], "openox");
    assert_eq!(initial["result"]["tokenConfigured"], false);

    let saved = call_bridge(
        &home,
        "usage.settings.set",
        json!({ "keyName": "codex-main", "token": "dashboard-token" }),
        &env,
    );
    assert_eq!(saved["result"]["keyName"], "codex-main");
    assert_eq!(saved["result"]["tokenConfigured"], true);
    assert!(!saved.to_string().contains("dashboard-token"));

    let stored: Value =
        serde_json::from_slice(&fs::read(home.path().join("xuan-plugins.json")).unwrap()).unwrap();
    assert_eq!(
        stored["plugins"]["xuan-usage"]["openox"]["openox-primary"]["token"],
        "dashboard-token"
    );
    let reloaded = call_bridge(&home, "usage.settings.get", json!({}), &env);
    assert_eq!(reloaded["result"]["keyName"], "codex-main");
    assert_eq!(reloaded["result"]["tokenConfigured"], true);
    assert!(!reloaded.to_string().contains("dashboard-token"));
}

#[test]
fn openox_usage_filters_the_named_key_and_aggregates_cache_hits_by_model() {
    let home = tempfile::tempdir().unwrap();
    let (address, requests) = serve_json_sequence(vec![
        json!({
            "success": true,
            "data": {
                "subscription": {
                    "plan_name": "企业 Enterprise",
                    "status": "active",
                    "period_quota": "9000",
                    "period_used": "300",
                    "period_remaining": "8700",
                    "period_end": "2026-10-20T08:25:03Z",
                    "today_credit": { "limit": "300", "used": "267.5", "remaining": "32.5" }
                }
            }
        }),
        json!({
            "success": true,
            "data": {
                "total": 3,
                "items": [
                    {
                        "api_key_name": "codex-main", "model_id": "gpt-6-astra",
                        "input_tokens": 100, "output_tokens": 20, "cache_read_tokens": 900,
                        "cache_creation_tokens": 0, "cache_write_tokens": 0,
                        "total_tokens": 1020, "cost": "0.12"
                    },
                    {
                        "api_key_name": "codex-main", "model_id": "gpt-6-astra",
                        "input_tokens": 400, "output_tokens": 30, "cache_read_tokens": 0,
                        "cache_creation_tokens": 50, "cache_write_tokens": 0,
                        "total_tokens": 480, "cost": "0.08"
                    },
                    {
                        "api_key_name": "another-key", "model_id": "gpt-5.6-terra",
                        "input_tokens": 999, "output_tokens": 99, "cache_read_tokens": 999,
                        "total_tokens": 2097, "cost": "9.99"
                    }
                ]
            }
        }),
    ]);
    let codex_settings = home.path().join("codex-settings.json");
    fs::write(
        &codex_settings,
        serde_json::to_vec_pretty(&json!({
            "activeRelayId": "openox-primary",
            "relayProfiles": [{
                "id": "openox-primary",
                "name": "OpenOx",
                "protocol": "responses",
                "upstreamBaseUrl": "https://api.openox.tech/v1",
                "authContents": "{\"OPENAI_API_KEY\":\"relay-secret\"}"
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    write_config(
        &home,
        json!({
            "schemaVersion": 1,
            "plugins": {
                "xuan-usage": {
                    "openox": {
                        "openox-primary": {
                            "keyName": "codex-main",
                            "token": "dashboard-token"
                        }
                    }
                }
            }
        }),
    );
    let response = call_bridge(
        &home,
        "usage.query",
        json!({ "startDate": "2026-09-18", "endDate": "2026-09-18" }),
        &[
            ("XUAN_CODEX_SETTINGS_PATH", codex_settings.to_str().unwrap()),
            ("XUAN_OPENOX_API_BASE_URL", &format!("http://{address}")),
        ],
    );
    assert_eq!(response["result"]["provider"], "openox");
    assert_eq!(response["result"]["data"]["today"]["remaining"], 32.5);
    assert_eq!(
        response["result"]["data"]["models"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let model = &response["result"]["data"]["models"][0];
    assert_eq!(model["model"], "gpt-6-astra");
    assert_eq!(model["requests"], 2);
    assert_eq!(model["hitRequests"], 1);
    assert_eq!(model["inputTokens"], 500);
    assert_eq!(model["cacheReadTokens"], 900);
    assert_eq!(model["cost"], 0.2);
    assert!((model["hitRate"].as_f64().unwrap() - 0.5).abs() < f64::EPSILON);
    assert!((model["cacheTokenRate"].as_f64().unwrap() - (900.0 / 1400.0)).abs() < 1e-9);
    assert!(!response.to_string().contains("dashboard-token"));

    let requests = requests.recv().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].starts_with("GET /api/v1/subscriptions/current "));
    assert!(requests[1].starts_with("GET /api/v1/usage?"));
    assert!(requests[1].contains("start_date=2026-09-18"));
    assert!(requests[1].contains("end_date=2026-09-18"));
    for request in requests {
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer dashboard-token")
        );
    }
}

#[test]
fn polish_settings_return_relay_model_choices_without_credentials() {
    let home = tempfile::tempdir().unwrap();
    let codex_settings = home.path().join("codex-settings.json");
    fs::write(
        &codex_settings,
        serde_json::to_vec_pretty(&json!({
            "activeRelayId": "primary",
            "relayProfiles": [{
                "id": "primary",
                "name": "Primary Relay",
                "protocol": "responses",
                "upstreamBaseUrl": "https://relay.example/v1",
                "authContents": "{\"OPENAI_API_KEY\":\"relay-secret\"}",
                "model": "primary-model[1M]",
                "modelList": "primary-model[1M]\nfast-model[200K]"
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    write_config(
        &home,
        json!({
            "schemaVersion": 1,
            "plugins": { "xuan-polish": {} }
        }),
    );
    let response = call_bridge(
        &home,
        "polish.settings.get",
        json!({}),
        &[("XUAN_CODEX_SETTINGS_PATH", codex_settings.to_str().unwrap())],
    );
    assert_eq!(response["result"]["settings"]["relayId"], "primary");
    assert_eq!(
        response["result"]["settings"]["providers"][0]["models"],
        json!(["primary-model", "fast-model"])
    );
    assert_eq!(
        response["result"]["settings"]["providers"][0]["defaultModel"],
        "primary-model"
    );
    assert!(!response.to_string().contains("relay-secret"));
}

#[test]
fn polish_profile_calls_responses_and_preserves_context_boundaries() {
    let home = tempfile::tempdir().unwrap();
    let (address, request) = serve_sse_once(concat!(
        "event: response.output_text.delta\n",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"```text\\npolished \"}\n\n",
        "event: response.output_text.delta\n",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"result\\n```\"}\n\n",
        "data: [DONE]\n\n"
    ));
    write_config(
        &home,
        json!({
            "schemaVersion": 1,
            "plugins": {
                "xuan-polish": {
                    "defaultProfile": "primary",
                    "profiles": {
                        "primary": {
                            "protocol": "responses",
                            "baseUrl": format!("http://{address}/v1"),
                            "apiKeyEnv": "XUAN_TEST_POLISH_KEY",
                            "model": "polish-test"
                        }
                    }
                }
            }
        }),
    );
    let response = call_bridge(
        &home,
        "polish.generate",
        json!({
            "text": "continue",
            "recentTurns": [{ "userText": "modify the project", "assistantText": "confirmed" }],
            "projectMap": "src/main.rs"
        }),
        &[("XUAN_TEST_POLISH_KEY", "polish-secret")],
    );
    assert_eq!(response["result"]["protocol"], "responses");
    assert_eq!(response["result"]["model"], "polish-test");
    assert_eq!(response["result"]["text"], "polished result");
    assert!(!response.to_string().contains("polish-secret"));
    let request = request.recv().unwrap();
    assert!(request.starts_with("POST /v1/responses "));
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer polish-secret")
    );
    assert!(
        request
            .to_ascii_lowercase()
            .contains("accept: text/event-stream")
    );
    assert_eq!(
        request
            .lines()
            .filter_map(|line| line.split_once(':'))
            .filter(|(name, _)| name.eq_ignore_ascii_case("content-type"))
            .count(),
        1,
        "Content-Type 请求头只能发送一次"
    );
    let body = request.split("\r\n\r\n").nth(1).unwrap();
    let body: Value = serde_json::from_str(body).unwrap();
    assert_eq!(body["model"], "polish-test");
    assert_eq!(body["stream"], true);
    assert_eq!(body["input"][0]["type"], "message");
    assert_eq!(body["input"][0]["role"], "user");
    assert_eq!(body["input"][0]["content"][0]["type"], "input_text");
    assert!(
        body["input"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("<draft>\ncontinue\n</draft>")
    );
}
