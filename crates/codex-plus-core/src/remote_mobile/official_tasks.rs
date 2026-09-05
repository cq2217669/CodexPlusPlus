use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialTask {
    pub id: String,
    pub name: String,
    pub workspace_name: String,
    #[serde(skip)]
    pub path: PathBuf,
}

pub fn list_tasks(home: &Path) -> anyhow::Result<Vec<OfficialTask>> {
    query_tasks(home, None)
}

pub(super) fn find_task(home: &Path, id: &str) -> anyhow::Result<Option<OfficialTask>> {
    Ok(query_tasks(home, Some(id))?.into_iter().next())
}

fn query_tasks(home: &Path, id: Option<&str>) -> anyhow::Result<Vec<OfficialTask>> {
    let mut tasks = BTreeMap::new();
    let mut available = false;
    for path in crate::codex_sqlite::codex_session_db_paths_from_home(home) {
        if !path.is_file() {
            continue;
        }
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        db.busy_timeout(std::time::Duration::from_secs(2))?;
        let has_threads: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads')",
            [],
            |r| r.get(0),
        )?;
        if !has_threads {
            continue;
        }
        available = true;
        let mut statement = db
            .prepare(
                "SELECT id, title, cwd, rollout_path FROM threads
             WHERE archived=0 AND (?1 IS NULL OR id=?1) ORDER BY updated_at DESC LIMIT 500",
            )
            .context("当前官方任务索引格式暂不支持")?;
        for task in statement.query_map([id], |row| {
            let cwd: String = row.get(2)?;
            Ok(OfficialTask {
                id: row.get(0)?,
                name: clip(&row.get::<_, String>(1)?, 256),
                workspace_name: clip(
                    Path::new(&cwd)
                        .file_name()
                        .and_then(|v| v.to_str())
                        .unwrap_or("本地工作区"),
                    256,
                ),
                path: PathBuf::from(row.get::<_, String>(3)?),
            })
        })? {
            let task = task?;
            if super::opaque_id(&task.id) {
                tasks.entry(task.id.clone()).or_insert(task);
            }
        }
    }
    if id.is_some() && !available {
        bail!("官方任务索引暂不可用");
    }
    Ok(tasks.into_values().collect())
}

pub(super) fn clip(text: &str, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

#[derive(Default)]
pub(super) struct TaskReader {
    path: PathBuf,
    offset: u64,
    created: Option<std::time::SystemTime>,
    verified: bool,
    pub reply: String,
    pub model: String,
    pub outcome: String,
    turn_id: String,
}

impl TaskReader {
    pub fn read(&mut self, home: &Path, task: &OfficialTask) -> anyhow::Result<Value> {
        let path = task.path.canonicalize().context("任务记录暂不可用")?;
        let allowed = ["sessions", "archived_sessions"].iter().any(|directory| {
            home.join(directory)
                .canonicalize()
                .is_ok_and(|root| path.starts_with(root))
        });
        if !allowed || path.extension().and_then(|v| v.to_str()) != Some("jsonl") {
            bail!("任务记录不在官方会话目录内");
        }
        let mut file = std::fs::File::open(&path)?;
        let metadata = file.metadata()?;
        let created = metadata.created().ok();
        if self.path != path || metadata.len() < self.offset || self.created != created {
            *self = Self {
                path,
                created,
                ..Self::default()
            };
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut reader = BufReader::new(file);
        loop {
            let mut line = Vec::new();
            // 工具输出可能很大；限制单行分配，且不消费尚未写完的行。
            let read = reader
                .by_ref()
                .take(8 * 1024 * 1024 + 1)
                .read_until(b'\n', &mut line)?;
            if read > 8 * 1024 * 1024 {
                bail!("任务记录单条内容过大，已暂停同步");
            }
            if read == 0 || line.last() != Some(&b'\n') {
                break;
            }
            let value: Value = serde_json::from_slice(&line).context("任务记录格式暂不支持")?;
            self.apply(&value, &task.id)?;
            self.offset += read as u64;
        }
        if !self.verified {
            bail!("任务记录尚未就绪");
        }
        let (task_status, turn_status, outcome) = match self.outcome.as_str() {
            "running" => ("running", "running", "none"),
            "completed" => ("stopped", "completed", "completed"),
            "interrupted" => ("stopped", "interrupted", "interrupted"),
            "failed" => ("failed", "failed", "failed"),
            _ => ("reconciling", "reconciling", "reconciling"),
        };
        let text = clip(&self.reply, 2 * 1024 * 1024);
        let truncated = text.len() != self.reply.len();
        let state = if text.is_empty() {
            "absent"
        } else if truncated {
            "truncated"
        } else {
            "available"
        };
        Ok(json!({
            "name": task.name, "workspaceName": task.workspace_name,
            "modelLabel": if self.model.is_empty() { "Codex" } else { &self.model },
            "taskStatus": task_status, "turnStatus": turn_status, "lastTurnOutcome": outcome,
            "lastReply": if text.is_empty() { Value::Null } else {
                json!({"state": state, "text": text, "byteLength": text.len(), "truncated": truncated})
            },
            "lastReplyState": state, "lastError": null, "pcConnectionState": "online"
        }))
    }

    fn apply(&mut self, value: &Value, expected_id: &str) -> anyhow::Result<()> {
        let payload = &value["payload"];
        let kind = value["type"].as_str().unwrap_or("");
        if !self.verified {
            if kind != "session_meta"
                || payload["id"] != expected_id
                || payload["source"].is_object()
            {
                bail!("任务身份不匹配或属于子任务，未同步");
            }
            self.verified = true;
            return Ok(());
        }
        match kind {
            "turn_context" => {
                if let Some(model) = payload["model"].as_str() {
                    self.model = clip(model, 256);
                }
            }
            "event_msg" => match payload["type"].as_str().unwrap_or("") {
                "task_started" => {
                    self.turn_id = payload["turn_id"].as_str().unwrap_or("").to_owned();
                    self.reply.clear();
                    self.outcome = "running".into();
                }
                "agent_message" => {
                    if let Some(text) = payload["message"].as_str() {
                        self.reply = text.to_owned();
                    }
                }
                "task_complete" | "task_completed" => {
                    if !self.matches_turn(payload) {
                        return Ok(());
                    }
                    if let Some(text) = payload["last_agent_message"].as_str()
                        && !text.is_empty()
                    {
                        self.reply = text.to_owned();
                    }
                    self.outcome = "completed".into();
                }
                "turn_aborted" => {
                    if self.matches_turn(payload) {
                        self.outcome = "interrupted".into();
                    }
                }
                _ => {}
            },
            "response_item" if payload["type"] == "message" && payload["role"] == "assistant" => {
                let text = payload["content"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter(|item| item["type"] == "output_text")
                            .filter_map(|item| item["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                if !text.is_empty() {
                    self.reply = text;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn matches_turn(&self, payload: &Value) -> bool {
        payload["turn_id"]
            .as_str()
            .is_none_or(|id| self.turn_id.is_empty() || id == self.turn_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "仅显式核验当前任务的官方记录，不上传或修改记录"]
    fn current_official_task_read_only() {
        let id = std::env::var("CODEX_THREAD_ID").expect("当前任务标识不可用");
        let home = crate::codex_home::default_codex_home_dir();
        let task = find_task(&home, &id)
            .unwrap()
            .expect("官方索引中没有当前任务");
        let snapshot = TaskReader::default().read(&home, &task).unwrap();
        assert!(snapshot["lastReplyState"].is_string());
        println!(
            "当前官方任务只读核验通过，回复字节数：{}",
            snapshot["lastReply"]["byteLength"].as_u64().unwrap_or(0)
        );
    }

    #[test]
    fn official_reply_preserves_unicode_and_ignores_tools_reasoning_and_stale_completion() {
        let mut reader = TaskReader::default();
        let id = "official_task_0001";
        for value in [
            json!({"type":"session_meta","payload":{"id":id,"source":"vscode"}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-two"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","output":"不应同步"}}),
            json!({"type":"event_msg","payload":{"type":"agent_reasoning","text":"不应同步"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"完整中文回复\n第二行"}]}}),
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-one","last_agent_message":"旧回复"}}),
        ] {
            reader.apply(&value, id).unwrap();
        }
        assert_eq!(reader.reply, "完整中文回复\n第二行");
        assert_eq!(reader.outcome, "running");
        reader.apply(&json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-two"}}), id).unwrap();
        assert_eq!(reader.outcome, "completed");
    }

    #[test]
    fn partial_line_is_retried_and_new_turn_clears_old_reply() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        std::fs::create_dir(&sessions).unwrap();
        let path = sessions.join("task.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"session_meta","payload":{"id":"official_task_0001","source":"vscode"}})
        )
        .unwrap();
        let task = OfficialTask {
            id: "official_task_0001".into(),
            name: "任务".into(),
            workspace_name: "工作区".into(),
            path,
        };
        let mut reader = TaskReader::default();
        write!(
            file,
            "{}",
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"回复"}})
        )
        .unwrap();
        assert_eq!(
            reader.read(dir.path(), &task).unwrap()["lastReplyState"],
            "absent"
        );
        writeln!(file).unwrap();
        assert_eq!(
            reader.read(dir.path(), &task).unwrap()["lastReply"]["byteLength"],
            6
        );
        writeln!(
            file,
            "{}",
            json!({"type":"event_msg","payload":{"type":"task_started"}})
        )
        .unwrap();
        assert_eq!(
            reader.read(dir.path(), &task).unwrap()["lastReplyState"],
            "absent"
        );
    }

    #[test]
    fn rejects_path_escape_and_mismatched_identity() {
        let mut reader = TaskReader::default();
        assert!(
            reader
                .apply(
                    &json!({"type":"session_meta","payload":{"id":"other"}}),
                    "selected_task_0001"
                )
                .is_err()
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("outside.jsonl");
        std::fs::write(&path, "{}\n").unwrap();
        let task = OfficialTask {
            id: "selected_task_0001".into(),
            name: "".into(),
            workspace_name: "".into(),
            path,
        };
        assert!(reader.read(dir.path(), &task).is_err());
        assert_eq!(clip("中文测试", 7), "中文");
        assert!(find_task(dir.path(), "selected_task_0001").is_err());
    }
}
