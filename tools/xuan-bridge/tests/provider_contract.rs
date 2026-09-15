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
