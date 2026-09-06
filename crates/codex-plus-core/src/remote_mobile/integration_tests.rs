use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature::{Ed25519KeyPair, KeyPair};
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};

struct CloudProcess(Child);
impl Drop for CloudProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct AppDevice {
    key: Ed25519KeyPair,
    device_id: String,
    key_id: String,
    client: reqwest::Client,
    base: String,
}

impl AppDevice {
    fn envelope(&self, kind: &str) -> Value {
        json!({
            "schemaVersion":"1.5", "messageType":kind, "messageId":id(),
            "environment":"dev", "sentAt":now(), "appDeviceId":self.device_id,
        })
    }

    fn proof(&self, method: &str, path: &str, body: &[u8]) -> Vec<(&'static str, String)> {
        let timestamp = now();
        let nonce = id();
        let canonical = format!(
            "workagents-device-request-v1\n{method}\n{path}\ndev\n{timestamp}\n{nonce}\n{:x}",
            Sha256::digest(body),
        );
        vec![
            ("x-workagents-device-key-id", self.key_id.clone()),
            ("x-workagents-device-timestamp", timestamp),
            ("x-workagents-device-nonce", nonce),
            (
                "x-workagents-device-signature",
                URL_SAFE_NO_PAD.encode(self.key.sign(canonical.as_bytes()).as_ref()),
            ),
        ]
    }

    async fn enroll(base: String) -> Self {
        let mut app = Self {
            key: Ed25519KeyPair::from_seed_unchecked(&[37; 32]).unwrap(),
            device_id: id(),
            key_id: String::new(),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            base,
        };
        let mut der = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        der.extend_from_slice(app.key.public_key().as_ref());
        let mut value = app.envelope("app/device-registration-challenge");
        value["deviceKeyAlgorithm"] = json!("ed25519");
        value["devicePublicKey"] = json!(URL_SAFE_NO_PAD.encode(&der));
        let challenge: Value = app
            .client
            .post(format!("{}/v1/app-devices/challenges", app.base))
            .json(&value)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        value["messageType"] = json!("app/device-register");
        value["messageId"] = json!(id());
        value["challengeId"] = challenge["challengeId"].clone();
        value["challenge"] = challenge["challenge"].clone();
        let canonical = format!(
            "workagents-device-registration-v1\ndev\n{}\n{}\n{}\n{:x}",
            app.device_id,
            challenge["challengeId"].as_str().unwrap(),
            challenge["challenge"].as_str().unwrap(),
            Sha256::digest(&der),
        );
        value["registrationSignature"] =
            json!(URL_SAFE_NO_PAD.encode(app.key.sign(canonical.as_bytes()).as_ref()));
        value["pushProvider"] = json!("huawei_push_kit");
        value["pushToken"] = json!("isolated-test-push-token");
        value["appDisplayName"] = json!("集成测试手机");
        value["appVersion"] = json!("0.1.9-dev");
        let response: Value = app
            .client
            .post(format!("{}/v1/app-devices", app.base))
            .json(&value)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        app.key_id = response["deviceKeyId"].as_str().unwrap().to_owned();
        app
    }

    async fn post(&self, path: &str, value: &Value) -> Value {
        let body = serde_json::to_vec(value).unwrap();
        let mut request = self
            .client
            .post(format!("{}{path}", self.base))
            .header("content-type", "application/json")
            .body(body.clone());
        for (key, value) in self.proof("POST", path, &body) {
            request = request.header(key, value);
        }
        let response = request.send().await.unwrap();
        assert!(
            response.status().is_success(),
            "测试请求被云端拒绝：{}",
            response.status()
        );
        response.json().await.unwrap()
    }

    fn get_request(&self, path: &str, query: &Value) -> reqwest::Request {
        let mut request = self
            .client
            .get(format!("{}{path}", self.base))
            .query(query)
            .build()
            .unwrap();
        let url = request.url();
        let canonical = format!("{}?{}", url.path(), url.query().unwrap());
        for (key, value) in self.proof("GET", &canonical, &[]) {
            request.headers_mut().insert(
                reqwest::header::HeaderName::from_static(key),
                value.parse().unwrap(),
            );
        }
        request
    }

    async fn get(&self, path: &str, query: &Value) -> Value {
        self.client
            .execute(self.get_request(path, query))
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }

    async fn snapshot(&self, task: &str) -> Value {
        let mut query = self.envelope("app/task-query");
        query["remoteTaskId"] = json!(task);
        self.get(&format!("/v1/tasks/{task}"), &query).await
    }

    async fn tasks(&self, pc_device_id: &str) -> Value {
        let mut query = self.envelope("app/task-list-query");
        query["pcDeviceId"] = json!(pc_device_id);
        self.get(&format!("/v1/pc-devices/{pc_device_id}/tasks"), &query)
            .await
    }
}

async fn action(tx: &mpsc::Sender<Request>, action: Action) -> Result<(), String> {
    let (reply, rx) = oneshot::channel();
    tx.send(Request { action, reply }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(20), rx)
        .await
        .unwrap()
        .unwrap()
}

async fn wait_status(status: &Arc<Mutex<MobileStatus>>, predicate: impl Fn(&MobileStatus) -> bool) {
    for _ in 0..200 {
        if predicate(&status.lock().unwrap()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("桌面状态未在时限内更新");
}

async fn wait_reply(app: &AppDevice, task: &str, expected: &str) -> Value {
    for _ in 0..100 {
        let response = app.snapshot(task).await;
        if response["snapshot"]["lastReply"]["text"] == expected {
            return response["snapshot"].clone();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("云端未收到预期回复");
}

async fn wait_task_count(app: &AppDevice, pc_device_id: &str, expected: usize) -> Value {
    for _ in 0..120 {
        let response = app.tasks(pc_device_id).await;
        if response["tasks"]
            .as_array()
            .is_some_and(|tasks| tasks.len() == expected)
        {
            return response;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("云端任务数量未在时限内更新为 {expected}");
}

#[tokio::test]
#[ignore = "由 scripts/test-mobile-remote.ps1 提供独立云端测试程序"]
async fn desktop_binding_and_reply_sync_with_real_local_cloud() {
    let temp = tempfile::tempdir().unwrap();
    let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = probe.local_addr().unwrap();
    drop(probe);
    let executable =
        std::env::var_os("XUANPLUS_REMOTE_TEST_CLOUD_EXE").expect("需要本地云端测试程序");
    let mut command = Command::new(executable);
    command
        .args([
            "--ignored",
            "--exact",
            "desktop_gateway_test_server",
            "--nocapture",
        ])
        .env("XUANPLUS_REMOTE_TEST_LISTEN", address.to_string())
        .env(
            "XUANPLUS_REMOTE_TEST_DATABASE",
            temp.path().join("cloud.sqlite"),
        )
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .creation_flags(crate::windows_create_no_window());
    let _cloud = CloudProcess(command.spawn().unwrap());
    let base = format!("http://{address}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .unwrap();
    let mut ready = false;
    for _ in 0..100 {
        if client.get(format!("{base}/healthz")).send().await.is_ok() {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ready, "本地云端未启动");

    let home = temp.path().join("home");
    std::fs::create_dir_all(home.join("sessions")).unwrap();
    let task_id = id();
    let path = home.join("sessions/official.jsonl");
    let mut file = std::fs::File::create(&path).unwrap();
    for value in [
        json!({"type":"session_meta","payload":{"id":task_id,"source":"vscode"}}),
        json!({"type":"turn_context","payload":{"model":"测试模型"}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"current-turn"}}),
        json!({"type":"event_msg","payload":{"type":"agent_message","message":"处理中"}}),
    ] {
        writeln!(file, "{value}").unwrap();
    }
    let db = rusqlite::Connection::open(home.join("state_5.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, rollout_path TEXT, archived INTEGER, updated_at INTEGER);").unwrap();
    db.execute(
        "INSERT INTO threads VALUES (?1, '官方测试任务', 'E:/workspace', ?2, 0, 1)",
        rusqlite::params![task_id, path.to_str().unwrap()],
    )
    .unwrap();
    drop(db);
    let state_path = temp.path().join("desktop.sqlite");
    let status = Arc::new(Mutex::new(MobileStatus::default()));
    let mut worker = Worker {
        store: Store::open(&state_path).unwrap(),
        config: ServiceConfig {
            enabled: true,
            protocol_environment: "dev".into(),
            api_base_url: base.clone(),
            wss_url: format!("ws://{address}/v1/gateway/connect"),
        },
        home: home.clone(),
        status: Arc::clone(&status),
        pairing_id: None,
        confirmation: None,
        confirmation_id: None,
    };
    let pairing = worker.register_pairing().await.unwrap();
    let pc_id = worker.store.state.pc_id.clone();
    let (tx, rx) = mpsc::channel(16);
    let running = tokio::spawn(async move { worker.run(rx).await });
    let app = AppDevice::enroll(base).await;
    let mut consume = app.envelope("pairing/consume");
    consume["pairing"] = pairing;
    let pending = app.post("/v1/pairings/consume", &consume).await;
    wait_status(&status, |s| s.pending.is_some()).await;
    assert!(!status.lock().unwrap().bound);
    assert!(action(&tx, Action::Confirm(id(), true)).await.is_err());
    let confirmation = status.lock().unwrap().pending.clone().unwrap();
    assert_eq!(
        confirmation.safety_phrase,
        pending["bindingSummary"]["safetyPhrase"].as_str().unwrap()
    );
    action(&tx, Action::Confirm(confirmation.request_id, true))
        .await
        .unwrap();
    wait_status(&status, |s| s.bound).await;
    wait_reply(&app, &task_id, "处理中").await;

    let created_task_id = id();
    let created_path = home.join("sessions/created.jsonl");
    let mut created_file = std::fs::File::create(&created_path).unwrap();
    for value in [
        json!({"type":"session_meta","payload":{"id":created_task_id,"source":"vscode"}}),
        json!({"type":"turn_context","payload":{"model":"新增模型"}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"created-turn"}}),
    ] {
        writeln!(created_file, "{value}").unwrap();
    }
    let db = rusqlite::Connection::open(home.join("state_5.sqlite")).unwrap();
    db.execute(
        "INSERT INTO threads VALUES (?1, '新增任务', 'E:/新增项目', ?2, 0, 3)",
        rusqlite::params![created_task_id, created_path.to_str().unwrap()],
    )
    .unwrap();
    drop(db);
    let created_list = wait_task_count(&app, &pc_id, 2).await;
    assert!(
        created_list["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|task| {
                task["remoteTaskId"] == created_task_id && task["workspaceName"] == "新增项目"
            })
    );

    let db = rusqlite::Connection::open(home.join("state_5.sqlite")).unwrap();
    db.execute(
        "UPDATE threads SET title='已编辑任务', cwd='E:/已编辑项目', updated_at=4 WHERE id=?1",
        [&created_task_id],
    )
    .unwrap();
    drop(db);
    let mut edited = false;
    for _ in 0..120 {
        let snapshot = app.snapshot(&created_task_id).await;
        if snapshot["snapshot"]["name"] == "已编辑任务"
            && snapshot["snapshot"]["workspaceName"] == "已编辑项目"
        {
            edited = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(edited, "任务名称与项目归属未实时更新");

    let stream_query = app.envelope("app/reply-stream-connect");
    let stream_request =
        app.get_request(&format!("/v1/tasks/{task_id}/reply-stream"), &stream_query);
    let mut stream_url = stream_request.url().clone();
    stream_url.set_scheme("ws").unwrap();
    let mut request = stream_url.as_str().into_client_request().unwrap();
    for (key, value) in stream_request.headers() {
        request.headers_mut().insert(
            key.as_str()
                .parse::<tokio_tungstenite::tungstenite::http::HeaderName>()
                .unwrap(),
            value.as_bytes().try_into().unwrap(),
        );
    }
    let (mut stream, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let complete = "完整中文回复\n含有多段内容与标点。\n".repeat(5000);
    writeln!(
        file,
        "{}",
        json!({"type":"event_msg","payload":{"type":"agent_message","message":complete}})
    )
    .unwrap();
    writeln!(file, "{}", json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"current-turn","last_agent_message":complete}})).unwrap();
    let mut history = format!("处理中\n\n---\n\n{complete}");
    let snapshot = wait_reply(&app, &task_id, &history).await;
    assert_eq!(snapshot["lastReply"]["byteLength"], history.len());
    assert_eq!(snapshot["turnStatus"], "completed");
    let mut got_complete = false;
    let mut streamed_history = String::new();
    let mut stream_seq = 0;
    for _ in 0..10 {
        let frame = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let Message::Text(text) = frame {
            let frame: Value = serde_json::from_str(&text).unwrap();
            if frame["messageType"] == "reply-stream/reset" {
                assert_eq!(frame["streamSeq"], 1);
                stream_seq = 1;
                streamed_history = frame["text"].as_str().unwrap().to_owned();
            } else if frame["messageType"] == "reply-stream/append" {
                assert_eq!(frame["streamSeq"], stream_seq + 1);
                stream_seq += 1;
                streamed_history.push_str(frame["text"].as_str().unwrap());
            }
            got_complete = streamed_history == history;
            if frame["messageType"] == "reply-stream/end" && got_complete {
                break;
            }
        }
    }
    assert!(got_complete, "回复流没有完整内容");
    stream.close(None).await.unwrap();
    writeln!(file, "{}", json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"next-turn"}})).unwrap();
    let mut next_turn_running = false;
    for _ in 0..120 {
        let snapshot = app.snapshot(&task_id).await;
        if snapshot["snapshot"]["turnStatus"] == "running" {
            assert_eq!(snapshot["snapshot"]["lastReply"]["text"], history);
            next_turn_running = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(next_turn_running, "新回合状态必须自动同步，并保留之前的回复");
    for value in [
        json!({"type":"event_msg","payload":{"type":"agent_message","message":"第二轮回复"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"第二轮回复"}]}}),
        json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"next-turn","last_agent_message":"第二轮回复"}}),
    ] {
        writeln!(file, "{value}").unwrap();
    }
    history.push_str("\n\n---\n\n第二轮回复");
    let snapshot = wait_reply(&app, &task_id, &history).await;
    let old_version = snapshot["stateVersion"].as_u64().unwrap();
    let listed = app.tasks(&pc_id).await;
    assert_eq!(listed["tasks"].as_array().unwrap().len(), 2);

    let command = app.post(&format!("/v1/tasks/{task_id}/commands"), &json!({
        "schemaVersion":"1.5","messageType":"app/command","messageId":id(),"environment":"dev",
        "remoteTaskId":task_id,"clientRequestId":id(),"expectedStateVersion":old_version,
        "expiresAt":(Utc::now()+chrono::Duration::minutes(1)).to_rfc3339(),
        "commandType":"send_input","payload":{"text":"不得执行本条测试输入"},
    })).await;
    let command_id = command["command"]["commandId"].as_str().unwrap();
    let mut rejected = false;
    for _ in 0..100 {
        let mut query = app.envelope("app/command-query");
        query["commandId"] = json!(command_id);
        let result = app.get(&format!("/v1/commands/{command_id}"), &query).await;
        if result["command"]["status"] == "rejected" {
            assert_eq!(result["command"]["errorCode"], "unsupported_operation");
            rejected = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(rejected, "只读接入必须拒绝远程执行命令");
    action(&tx, Action::Enable(false)).await.unwrap();
    wait_status(&status, |s| !s.connected).await;
    action(&tx, Action::Enable(true)).await.unwrap();
    wait_status(&status, |s| s.bound).await;
    let mut advanced = false;
    for _ in 0..100 {
        let result = app.snapshot(&task_id).await;
        if result["snapshot"]["stateVersion"].as_u64().unwrap_or(0) > old_version {
            advanced = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(advanced, "重连后同步版本不能回退");
    let db = rusqlite::Connection::open(home.join("state_5.sqlite")).unwrap();
    db.execute("DELETE FROM threads WHERE id=?1", [&created_task_id])
        .unwrap();
    drop(db);
    let remaining = wait_task_count(&app, &pc_id, 1).await;
    assert_eq!(remaining["tasks"][0]["remoteTaskId"], task_id);
    action(&tx, Action::Enable(false)).await.unwrap();
    action(&tx, Action::Pair).await.unwrap();
    wait_status(&status, |s| s.bound && s.qr_image.is_some()).await;
    let binding_id = pending["bindingId"].as_str().unwrap();
    let mut revoke = app.envelope("binding/revoke");
    revoke["bindingId"] = json!(binding_id);
    app.post(&format!("/v1/bindings/{binding_id}/revoke"), &revoke)
        .await;
    let mut unbound = false;
    for _ in 0..400 {
        if !status.lock().unwrap().bound {
            unbound = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(unbound, "手机解绑后桌面不能无限期保留绑定状态");
    action(&tx, Action::Enable(false)).await.unwrap();
    drop(tx);
    tokio::time::timeout(Duration::from_secs(5), running)
        .await
        .unwrap()
        .unwrap();
    drop(file);
}
