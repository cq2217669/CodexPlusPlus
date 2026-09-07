use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, mpsc};
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use serde::Deserialize;
use serde_json::{Value, json};

const DEFAULT_MAX_RESULTS: usize = 2_000;
const MAX_RESULTS: usize = 2_000;
const MAX_CONCURRENT_SEARCHES: usize = 4;
const MAX_RETAINED_TASKS: usize = 32;
const MAX_RESULT_LINE_CHARS: usize = 2_000;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(15);
const TASK_RETENTION: Duration = Duration::from_secs(120);
const MAX_PREVIEW_BYTES: u64 = 1024 * 1024;

static NEXT_SEARCH_ID: AtomicU64 = AtomicU64::new(1);
static SEARCH_TASKS: LazyLock<Mutex<HashMap<String, Arc<SearchTask>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SearchRequest {
    root: String,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
    include: Vec<String>,
    exclude: Vec<String>,
    max_results: usize,
}

struct SearchTask {
    created_at: Instant,
    cancel: Arc<AtomicBool>,
    state: Mutex<SearchTaskState>,
}

enum SearchTaskState {
    Running,
    Complete(SearchOutput),
    Failed(String),
    Cancelled,
}

#[derive(Clone)]
struct SearchOutput {
    root: String,
    results: Vec<Value>,
    truncated: bool,
    elapsed_ms: u64,
}

pub fn roots_response() -> anyhow::Result<Value> {
    let home = crate::codex_home::default_codex_home_dir();
    let roots = crate::codex_app_state::workspace_roots(&home)?
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    Ok(json!({ "status": "ok", "roots": roots }))
}

pub fn start_response(payload: Value) -> anyhow::Result<Value> {
    let mut request: SearchRequest = serde_json::from_value(payload)?;
    request.root = canonical_workspace_root(&request.root)?
        .to_string_lossy()
        .to_string();
    request.query = request.query.trim().to_string();
    if request.query.is_empty() {
        bail!("请输入搜索内容");
    }
    if request.query.len() > 1_000 || request.query.contains('\0') {
        bail!("搜索内容过长或包含无效字符");
    }
    request.max_results = if request.max_results == 0 {
        DEFAULT_MAX_RESULTS
    } else {
        request.max_results.clamp(1, MAX_RESULTS)
    };
    request.include = normalized_globs(request.include);
    request.exclude = normalized_globs(request.exclude);

    cleanup_tasks();
    let search_id = format!(
        "workspace-search-{}-{}",
        std::process::id(),
        NEXT_SEARCH_ID.fetch_add(1, Ordering::Relaxed)
    );
    let task = Arc::new(SearchTask {
        created_at: Instant::now(),
        cancel: Arc::new(AtomicBool::new(false)),
        state: Mutex::new(SearchTaskState::Running),
    });
    let mut tasks = SEARCH_TASKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let running = tasks
        .values()
        .filter(|task| {
            matches!(
                *task
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()),
                SearchTaskState::Running
            )
        })
        .count();
    if running >= MAX_CONCURRENT_SEARCHES {
        bail!("同时运行的工作区搜索过多，请稍后重试");
    }
    tasks.insert(search_id.clone(), task.clone());
    drop(tasks);
    std::thread::spawn(move || run_search(task, request));

    Ok(json!({ "status": "ok", "searchId": search_id }))
}

pub fn poll_response(payload: Value) -> anyhow::Result<Value> {
    let search_id = payload
        .get("searchId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let task = SEARCH_TASKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(search_id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("搜索任务不存在或已过期"))?;
    let state = task
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(match &*state {
        SearchTaskState::Running => json!({ "status": "running", "searchId": search_id }),
        SearchTaskState::Cancelled => {
            json!({ "status": "cancelled", "searchId": search_id })
        }
        SearchTaskState::Failed(message) => {
            json!({ "status": "failed", "searchId": search_id, "message": message })
        }
        SearchTaskState::Complete(output) => json!({
            "status": "ok",
            "searchId": search_id,
            "root": output.root,
            "results": output.results,
            "truncated": output.truncated,
            "elapsedMs": output.elapsed_ms,
        }),
    })
}

pub fn cancel_response(payload: Value) -> anyhow::Result<Value> {
    let search_id = payload
        .get("searchId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let task = SEARCH_TASKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(search_id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("搜索任务不存在或已过期"))?;
    task.cancel.store(true, Ordering::Release);
    Ok(json!({ "status": "ok", "searchId": search_id }))
}

pub fn preview_response(payload: Value) -> anyhow::Result<Value> {
    let root = payload
        .get("root")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let path = payload
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let line = payload
        .get("line")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1) as usize;
    let root = canonical_workspace_root(root)?;
    let path = std::fs::canonicalize(path).with_context(|| "无法读取搜索结果文件")?;
    if !path.starts_with(&root) || !path.is_file() {
        bail!("文件不在当前工作区内");
    }
    let mut bytes = Vec::new();
    File::open(&path)?
        .take(MAX_PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PREVIEW_BYTES {
        bail!("文件超过 1 MB，无法在搜索面板中预览");
    }
    if bytes.contains(&0) {
        bail!("二进制文件无法预览");
    }
    let text = String::from_utf8_lossy(&bytes);
    let all_lines = text.lines().collect::<Vec<_>>();
    let start = line.saturating_sub(6);
    let end = (line + 5).min(all_lines.len());
    let lines = all_lines[start..end]
        .iter()
        .enumerate()
        .map(|(index, text)| json!({ "number": start + index + 1, "text": text }))
        .collect::<Vec<_>>();
    Ok(json!({
        "status": "ok",
        "path": path.to_string_lossy(),
        "line": line,
        "startLine": start + 1,
        "lines": lines,
    }))
}

fn cleanup_tasks() {
    let now = Instant::now();
    let mut tasks = SEARCH_TASKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    tasks.retain(|_, task| {
        matches!(
            *task
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            SearchTaskState::Running
        ) || now.duration_since(task.created_at) < TASK_RETENTION
    });
    if tasks.len() <= MAX_RETAINED_TASKS {
        return;
    }
    let mut completed = tasks
        .iter()
        .filter_map(|(id, task)| {
            let running = matches!(
                *task
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()),
                SearchTaskState::Running
            );
            (!running).then_some((id.clone(), task.created_at))
        })
        .collect::<Vec<_>>();
    completed.sort_by_key(|(_, created_at)| *created_at);
    let remove_count = tasks.len().saturating_sub(MAX_RETAINED_TASKS);
    for (id, _) in completed.into_iter().take(remove_count) {
        tasks.remove(&id);
    }
}

fn normalized_globs(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value.len() <= 300 && !value.contains('\0'))
        .take(32)
        .collect()
}

fn canonical_workspace_root(root: &str) -> anyhow::Result<PathBuf> {
    let root = Path::new(root.trim());
    if !root.is_absolute() {
        bail!("工作区路径必须是绝对路径");
    }
    let root = std::fs::canonicalize(root).with_context(|| "工作区不存在或不可访问")?;
    if !root.is_dir() {
        bail!("工作区路径不是目录");
    }
    Ok(root)
}

fn run_search(task: Arc<SearchTask>, request: SearchRequest) {
    let started = Instant::now();
    let result = execute_search(&task.cancel, &request, started);
    let mut state = task
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *state = match result {
        Ok(_output) if task.cancel.load(Ordering::Acquire) => SearchTaskState::Cancelled,
        Ok(output) => SearchTaskState::Complete(output),
        Err(_error) if task.cancel.load(Ordering::Acquire) => SearchTaskState::Cancelled,
        Err(error) => SearchTaskState::Failed(error.to_string()),
    };
}

fn execute_search(
    cancelled: &AtomicBool,
    request: &SearchRequest,
    started: Instant,
) -> anyhow::Result<SearchOutput> {
    let mut command = Command::new("rg");
    command.args([
        "--json",
        "--line-number",
        "--column",
        "--with-filename",
        "--no-heading",
        "--color",
        "never",
        "--max-filesize",
        "5M",
    ]);
    if request.regex {
        command.arg("--engine").arg("auto");
    } else {
        command.arg("--fixed-strings");
    }
    command.arg(if request.case_sensitive {
        "--case-sensitive"
    } else {
        "--ignore-case"
    });
    if request.whole_word {
        command.arg("--word-regexp");
    }
    for pattern in &request.include {
        command.arg("--glob").arg(pattern);
    }
    for pattern in &request.exclude {
        command.arg("--glob").arg(format!("!{pattern}"));
    }
    command
        .arg("-e")
        .arg(&request.query)
        .arg(".")
        .current_dir(&request.root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(crate::windows_create_no_window());
    }
    let mut child = command
        .spawn()
        .with_context(|| "无法启动 ripgrep，请确认 rg 已安装并可从 PATH 访问")?;
    let stdout = child.stdout.take().context("无法读取 ripgrep 输出")?;
    let stderr = child.stderr.take().context("无法读取 ripgrep 错误输出")?;
    let (sender, receiver) = mpsc::sync_channel::<Option<String>>(128);
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if sender.send(Some(line)).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = sender.send(None);
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut message = String::new();
        let _ = BufReader::new(stderr)
            .take(64 * 1024)
            .read_to_string(&mut message);
        message
    });

    let mut results = Vec::new();
    let mut reader_done = false;
    let mut truncated = false;
    let mut timed_out = false;
    loop {
        if cancelled.load(Ordering::Acquire) {
            let _ = child.kill();
            break;
        }
        if started.elapsed() >= SEARCH_TIMEOUT {
            timed_out = true;
            truncated = true;
            let _ = child.kill();
            break;
        }
        match receiver.recv_timeout(Duration::from_millis(25)) {
            Ok(Some(line)) => {
                if let Some(item) = parse_rg_match(&line, Path::new(&request.root)) {
                    results.push(item);
                    if results.len() >= request.max_results {
                        truncated = true;
                        let _ = child.kill();
                        break;
                    }
                }
            }
            Ok(None) => reader_done = true,
            Err(mpsc::RecvTimeoutError::Disconnected) => reader_done = true,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if reader_done && child.try_wait()?.is_some() {
            break;
        }
    }
    let status = child.wait()?;
    let stderr = stderr_reader.join().unwrap_or_default();
    if !cancelled.load(Ordering::Acquire) && !truncated && !matches!(status.code(), Some(0 | 1)) {
        let message = stderr.trim();
        bail!(
            "{}",
            if message.is_empty() {
                "ripgrep 搜索失败"
            } else {
                message
            }
        );
    }
    if timed_out && results.is_empty() {
        bail!("搜索超过 15 秒，已自动停止");
    }
    Ok(SearchOutput {
        root: request.root.clone(),
        results,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn parse_rg_match(line: &str, root: &Path) -> Option<Value> {
    let event: Value = serde_json::from_str(line).ok()?;
    if event.get("type")?.as_str()? != "match" {
        return None;
    }
    let data = event.get("data")?;
    let relative = data
        .get("path")?
        .get("text")?
        .as_str()?
        .trim_start_matches("./")
        .trim_start_matches(".\\");
    let line_number = data.get("line_number")?.as_u64()?;
    let full_text = data
        .get("lines")?
        .get("text")?
        .as_str()?
        .trim_end_matches(['\r', '\n']);
    let full_ranges = data
        .get("submatches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let start = item.get("start")?.as_u64()? as usize;
            let end = item.get("end")?.as_u64()? as usize;
            Some((
                byte_to_char_index(full_text, start),
                byte_to_char_index(full_text, end),
            ))
        })
        .collect::<Vec<_>>();
    let column = full_ranges
        .first()
        .map(|(start, _)| *start as u64)
        .unwrap_or(0)
        + 1;
    let (text, ranges, line_truncated) = result_line_snippet(full_text, &full_ranges);
    let absolute = root.join(relative);
    Some(json!({
        "path": absolute.to_string_lossy(),
        "relativePath": relative.replace('\\', "/"),
        "line": line_number,
        "column": column,
        "text": text,
        "ranges": ranges,
        "lineTruncated": line_truncated,
    }))
}

fn result_line_snippet(text: &str, ranges: &[(usize, usize)]) -> (String, Vec<Value>, bool) {
    let characters = text.chars().collect::<Vec<_>>();
    if characters.len() <= MAX_RESULT_LINE_CHARS {
        return (
            text.to_string(),
            ranges
                .iter()
                .map(|(start, end)| json!({ "start": start, "end": end }))
                .collect(),
            false,
        );
    }
    let first_match = ranges.first().map(|(start, _)| *start).unwrap_or(0);
    let max_start = characters.len().saturating_sub(MAX_RESULT_LINE_CHARS);
    let snippet_start = first_match.saturating_sub(400).min(max_start);
    let snippet_end = (snippet_start + MAX_RESULT_LINE_CHARS).min(characters.len());
    let leading = snippet_start > 0;
    let trailing = snippet_end < characters.len();
    let mut snippet = characters[snippet_start..snippet_end]
        .iter()
        .collect::<String>();
    if leading {
        snippet.insert(0, '…');
    }
    if trailing {
        snippet.push('…');
    }
    let leading_offset = usize::from(leading);
    let adjusted = ranges
        .iter()
        .filter_map(|(start, end)| {
            if *end <= snippet_start || *start >= snippet_end {
                return None;
            }
            Some(json!({
                "start": start.saturating_sub(snippet_start) + leading_offset,
                "end": end.min(&snippet_end).saturating_sub(snippet_start) + leading_offset,
            }))
        })
        .collect();
    (snippet, adjusted, true)
}

fn byte_to_char_index(value: &str, byte_index: usize) -> usize {
    value
        .get(..byte_index.min(value.len()))
        .unwrap_or(value)
        .chars()
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_utf8_match_offsets_as_character_indexes() {
        let root = Path::new("C:/repo");
        let line = r#"{"type":"match","data":{"path":{"text":"src/main.rs"},"lines":{"text":"前缀 needle 后缀\n"},"line_number":7,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":7,"end":13}]}}"#;
        let value = parse_rg_match(line, root).unwrap();
        assert_eq!(value["line"], 7);
        assert_eq!(value["column"], 4);
        assert_eq!(value["ranges"][0]["start"], 3);
        assert_eq!(value["ranges"][0]["end"], 9);
    }

    #[test]
    fn long_result_lines_keep_the_match_and_stay_bounded() {
        let text = format!("{}needle{}", "x".repeat(3_000), "y".repeat(3_000));
        let (snippet, ranges, truncated) = result_line_snippet(&text, &[(3_000, 3_006)]);

        assert!(truncated);
        assert!(snippet.chars().count() <= MAX_RESULT_LINE_CHARS + 2);
        assert!(snippet.contains("needle"));
        assert_eq!(ranges.len(), 1);
    }

    #[test]
    fn preview_rejects_files_outside_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let error = preview_response(json!({
            "root": workspace.path(),
            "path": outside.path(),
            "line": 1,
        }))
        .unwrap_err();
        assert!(error.to_string().contains("不在当前工作区"));
    }

    #[test]
    fn ripgrep_search_respects_include_filter_and_utf8_content() {
        if Command::new("rg").arg("--version").output().is_err() {
            return;
        }
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        std::fs::write(
            workspace.path().join("src/main.rs"),
            "fn main() { println!(\"轩++ needle\"); }\n",
        )
        .unwrap();
        std::fs::write(workspace.path().join("ignored.txt"), "needle\n").unwrap();
        let request = SearchRequest {
            root: std::fs::canonicalize(workspace.path())
                .unwrap()
                .to_string_lossy()
                .to_string(),
            query: "needle".to_string(),
            include: vec!["*.rs".to_string()],
            max_results: 20,
            ..SearchRequest::default()
        };

        let output = execute_search(&AtomicBool::new(false), &request, Instant::now()).unwrap();

        assert_eq!(output.results.len(), 1);
        assert_eq!(output.results[0]["relativePath"], "src/main.rs");
        assert_eq!(output.results[0]["line"], 1);
        assert!(!output.truncated);
    }
}
