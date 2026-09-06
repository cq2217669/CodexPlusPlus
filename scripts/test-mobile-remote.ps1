param([switch]$UseCachedMirror)

$ErrorActionPreference = 'Stop'
$previous = $env:XUANPLUS_REMOTE_TEST_CLOUD_EXE
try {
    $root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $sourceFiles = @(
        'crates/codex-plus-core/src/remote_mobile/mod.rs',
        'crates/codex-plus-core/src/remote_mobile/store.rs',
        'crates/codex-plus-core/src/remote_mobile/official_tasks.rs',
        'crates/codex-plus-core/src/remote_mobile/live_source.rs',
        'crates/codex-plus-core/src/remote_mobile/live_source.js',
        'crates/codex-plus-core/src/remote_mobile/integration_tests.rs',
        'apps/codex-plus-manager/src-tauri/src/mobile_remote.rs',
        'apps/codex-plus-manager/src/MobileRemoteScreen.tsx',
        'apps/codex-plus-manager/src/mobile-remote.css',
        'apps/xuan-plus-remote/app/entry/src/main/ets/pages/Index.ets',
        'apps/xuan-plus-remote/app/entry/src/main/ets/remote/LiveReplyStreamCoordinator.ets',
        'apps/xuan-plus-remote/cloud-service/src/main.rs',
        'scripts/test-mobile-remote.ps1',
        'scripts/test-mobile-task-detail.mjs',
        'scripts/test-mobile-remote-ui.mjs'
    )
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $corrupted = [string]::Concat([char]0x951f, [char]0x65a4, [char]0x62f7)
    foreach ($relative in $sourceFiles) {
        $text = $utf8.GetString([System.IO.File]::ReadAllBytes((Join-Path $root $relative)))
        if ($text.Contains([char]0xfffd) -or $text.Contains($corrupted)) {
            throw "源码编码检查失败：$relative"
        }
    }
    & node (Join-Path $root 'scripts/test-mobile-task-detail.mjs')
    if ($LASTEXITCODE -ne 0) { throw '手机任务详情回归测试失败。' }
    $manifest = Join-Path $root 'apps/xuan-plus-remote/cloud-service/Cargo.toml'
    $arguments = @('test', '--manifest-path', $manifest, '--offline', '--locked', '--no-run', '--message-format=json')
    if ($UseCachedMirror) {
        $arguments += @('--config', 'source.crates-io.replace-with="cached-mirror"',
            '--config', 'source.cached-mirror.registry="sparse+https://rsproxy.cn/index/"')
    }
    $lines = & cargo @arguments
    if ($LASTEXITCODE -ne 0) { throw '云端测试程序构建失败。' }
    $artifacts = @($lines | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object {
        $_.reason -eq 'compiler-artifact' -and $_.profile.test -and
        $_.target.kind -contains 'bin' -and $_.executable
    })
    if ($artifacts.Count -ne 1) { throw '未找到唯一的云端测试程序。' }
    $executable = [System.IO.Path]::GetFullPath($artifacts[0].executable)
    if (-not $executable.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw '云端测试程序不在当前工作区内。'
    }
    $env:XUANPLUS_REMOTE_TEST_CLOUD_EXE = $executable
    $arguments = @('test', '--manifest-path', (Join-Path $root 'Cargo.toml'), '-p', 'codex-plus-core',
        '--offline', '--locked', '--lib', 'remote_mobile::integration_tests::desktop_binding_and_reply_sync_with_real_local_cloud',
        '--', '--ignored', '--exact')
    & cargo @arguments
    if ($LASTEXITCODE -ne 0) { throw '桌面与本地云端的集成测试失败。' }
} catch {
    Write-Error $_
    exit 1
} finally {
    $env:XUANPLUS_REMOTE_TEST_CLOUD_EXE = $previous
}
