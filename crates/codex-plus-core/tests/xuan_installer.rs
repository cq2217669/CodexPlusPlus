#[test]
fn xuan_installer_preserves_restart_failures() {
    let batch = include_str!("../../../install-xuan-features.bat").replace("\r\n", "\n");
    assert!(batch.contains("call :restart_codex_plus\nif errorlevel 1 exit /b 1"));
    let restart = batch.split("\n:restart_codex_plus\n").nth(1).unwrap();
    assert!(restart.find("exit /b 1").unwrap() < restart.find("del /q").unwrap());
    assert!(batch.contains("if not exist \"%CODEX_PLUS_STATE_FILE%\" exit /b 1"));
}

#[cfg(windows)]
#[test]
fn xuan_installer_process_tree_regressions() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("pwsh.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-File"])
        .arg(root.join("scripts/restart-codex-plus.test.ps1"))
        .output()
        .expect("PowerShell 7 is required for Windows installer tests");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(windows)]
#[test]
fn xuan_installer_start_errors_return_failure() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for scenario in ["StartFailure", "MissingInstall"] {
        let output = std::process::Command::new("pwsh.exe")
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-File"])
            .arg(root.join("scripts/restart-codex-plus.test.ps1"))
            .args(["-Scenario", scenario])
            .output()
            .expect("PowerShell 7 is required for Windows installer tests");
        assert_eq!(output.status.code(), Some(1), "{scenario}");
        let errors = String::from_utf8_lossy(&output.stderr);
        let expected = if scenario == "StartFailure" {
            "Simulated start failure."
        } else {
            "未找到 Codex++"
        };
        assert!(errors.contains(expected), "{scenario}: {errors}");
    }
}

#[cfg(windows)]
#[test]
fn xuan_installer_summary_does_not_restart_live_app() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("pwsh.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-File"])
        .arg(root.join("scripts/install-xuan-features.test.ps1"))
        .output()
        .expect("PowerShell 7 is required for Windows installer tests");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
