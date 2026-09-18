[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Stop', 'Start')][string]$Action,
    [string]$StateFile,
    [string]$InstallDirectory
)

$ErrorActionPreference = 'Stop'

# Codex++ 主程序：codex-plus-plus.exe 为无窗口启动器（日常使用的主程序），
# codex-plus-plus-manager.exe 为 Tauri 管理控制台。两者都按进程名 + 可执行路径核实，不按名称批量结束。
$mainBinary = 'codex-plus-plus.exe'
$managerBinary = 'codex-plus-plus-manager.exe'
$binaries = @($mainBinary, $managerBinary)

function Get-CodexPlusProcesses {
    $filter = "Name = '$mainBinary' OR Name = '$managerBinary'"
    @(Get-CimInstance -ClassName Win32_Process -Filter $filter `
        -Property ProcessId, Name, ExecutablePath, CreationDate)
}

# 保留已退出父进程的身份，仍可识别其尚未退出的子进程；拒绝 PID 复用形成的假父子关系。
function Get-CodexPlusProcessTree {
    param([object[]]$Roots, [object[]]$Snapshot)
    $known = @{}
    $result = [System.Collections.Generic.List[object]]::new()
    foreach ($root in $Roots) {
        if (-not $known.ContainsKey([int]$root.ProcessId)) {
            $known[[int]$root.ProcessId] = $root
            $result.Add($root)
        }
    }
    do {
        $added = $false
        foreach ($item in $Snapshot) {
            if ($known.ContainsKey([int]$item.ProcessId)) { continue }
            $parent = $known[[int]$item.ParentProcessId]
            if (-not $parent -or $item.CreationDate -lt $parent.CreationDate) { continue }
            $liveParent = @($Snapshot | Where-Object { $_.ProcessId -eq $parent.ProcessId })
            if ($liveParent.Count -gt 0 -and $liveParent[0].CreationDate -ne $parent.CreationDate) { continue }
            $known[[int]$item.ProcessId] = $item
            $result.Add($item)
            $added = $true
        }
    } while ($added)
    return $result.ToArray()
}

function Get-CodexPlusInstallDirectories {
    param([string]$Hint)
    $raw = @()
    if ($Hint) { $raw += $Hint }
    $uninstallKeys = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($key in $uninstallKeys) {
        Get-ItemProperty -Path $key -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -like 'Codex++*' -and $_.InstallLocation } |
            ForEach-Object { $raw += $_.InstallLocation }
    }
    if ($env:LOCALAPPDATA) {
        $raw += (Join-Path $env:LOCALAPPDATA 'Programs\Codex++')
        $raw += (Join-Path $env:LOCALAPPDATA 'Codex++')
    }
    if ($env:ProgramFiles) { $raw += (Join-Path $env:ProgramFiles 'Codex++') }
    $dirs = @()
    foreach ($item in $raw) {
        if (-not $item) { continue }
        try {
            $full = (Resolve-Path -LiteralPath $item -ErrorAction Stop).Path
        } catch {
            continue
        }
        if ($dirs -notcontains $full) { $dirs += $full }
    }
    return @($dirs)
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'Codex++ 主程序重启仅支持 Windows。' }

    if ($Action -eq 'Stop') {
        $procs = @(Get-CodexPlusProcesses)
        if (@($procs | Where-Object { -not $_.ExecutablePath }).Count -gt 0) {
            throw '无法读取 Codex++ 进程路径，不能确认清理范围，已停止安装。'
        }
        # 恢复时只启动入口，不直接重启渲染器、CLI 或插件子进程。
        $ordered = @($procs | Where-Object { $_.Name -eq $mainBinary }) +
            @($procs | Where-Object { $_.Name -ne $mainBinary })
        $paths = @()
        foreach ($proc in $ordered) {
            if ($paths -notcontains $proc.ExecutablePath) { $paths += $proc.ExecutablePath }
        }
        $snapshot = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate)
        $stopRoots = @($procs | Where-Object { $_.Name -eq $managerBinary }) +
            @($procs | Where-Object { $_.Name -eq $mainBinary })
        $tree = @(Get-CodexPlusProcessTree -Roots $stopRoots -Snapshot $snapshot)
        if (@($tree | Where-Object { $_.ProcessId -eq $PID }).Count -gt 0) {
            throw '安装器位于 Codex++ 子进程树中，请从独立的资源管理器或终端运行安装脚本。'
        }
        if ($StateFile -and -not $WhatIfPreference) {
            if ($paths.Count -gt 0) {
                Set-Content -LiteralPath $StateFile -Value $paths -Encoding UTF8
            } else {
                Set-Content -LiteralPath $StateFile -Value '' -Encoding UTF8
            }
        }
        if ($ordered.Count -eq 0) {
            Write-Output 'Codex++ 主程序当前未运行，无需结束。'
            exit 0
        }
        $stopped = 0
        # 每轮先停止父进程，防止继续派生；保留完整快照以清理随后成为孤儿的子进程。
        for ($attempt = 0; $attempt -lt 5; $attempt++) {
            $snapshot = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate)
            $tree = @(Get-CodexPlusProcessTree -Roots $tree -Snapshot $snapshot)
            foreach ($item in $tree) {
                $process = $null
                try {
                    try {
                        $process = [System.Diagnostics.Process]::GetProcessById($item.ProcessId)
                    } catch [System.ArgumentException] { continue }
                    if ($process.HasExited) { continue }
                    $null = $process.Handle
                    # 结束前复核进程身份，避免误杀同名进程。
                    $current = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($item.ProcessId)"
                    if (-not $current -or $current.CreationDate -ne $item.CreationDate) {
                        continue
                    }
                    if (-not $item.ExecutablePath -or $current.ExecutablePath -ne $item.ExecutablePath) {
                        throw "无法核实进程身份，停止安装：PID $($item.ProcessId)"
                    }
                    if ($PSCmdlet.ShouldProcess($item.ExecutablePath, '结束 Codex++ 或客户端子进程')) {
                        Stop-Process -InputObject $process -Force -ErrorAction Stop
                        if (-not $process.WaitForExit(15000)) {
                            throw "进程未及时退出：$($item.ExecutablePath)"
                        }
                        $stopped++
                        Write-Output "  [已结束] $($item.Name) (PID $($item.ProcessId))"
                    }
                } catch [System.InvalidOperationException] {
                    if (-not $process -or -not $process.HasExited) { throw }
                } finally {
                    if ($process) { $process.Dispose() }
                }
            }
            if ($WhatIfPreference) { exit 0 }
            $snapshot = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate)
            $tree = @(Get-CodexPlusProcessTree -Roots $tree -Snapshot $snapshot)
            $remaining = @($snapshot | Where-Object {
                $live = $_
                @($tree | Where-Object { $_.ProcessId -eq $live.ProcessId -and $_.CreationDate -eq $live.CreationDate }).Count -gt 0
            })
            if ($remaining.Count -eq 0) { break }
        }
        if ($remaining.Count -gt 0 -or @(Get-CodexPlusProcesses).Count -gt 0) {
            throw '仍有 Codex++ 或客户端子进程未退出，已停止安装。'
        }
        Write-Output "Codex++ 主程序已结束，强制结束 $stopped 个进程；安装完成后会自动重新启动。"
        exit 0
    }

    $targets = @()
    if ($StateFile -and (Test-Path -LiteralPath $StateFile -PathType Leaf)) {
        $targets += @(Get-Content -LiteralPath $StateFile |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ })
    }
    $targets = @($targets | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if ($targets.Count -eq 0) {
        # 安装前未运行 Codex++：从安装目录发现主程序，仍然为用户启动一次。
        foreach ($dir in (Get-CodexPlusInstallDirectories -Hint $InstallDirectory)) {
            foreach ($name in $binaries) {
                $candidate = Join-Path $dir $name
                if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                    $targets += $candidate
                    break
                }
            }
            if ($targets.Count -gt 0) { break }
        }
    }
    if ($targets.Count -eq 0) {
        throw '未找到 Codex++ 主程序，请手动启动 Codex++。'
    }
    $running = Get-CodexPlusProcesses
    foreach ($target in $targets) {
        $name = [System.IO.Path]::GetFileName($target)
        if (@($running | Where-Object { $_.ExecutablePath -eq $target }).Count -gt 0) {
            Write-Output "  [跳过] $name 已在运行。"
            continue
        }
        if ($PSCmdlet.ShouldProcess($target, '启动 Codex++ 主程序')) {
            Start-Process -FilePath $target -WorkingDirectory ([System.IO.Path]::GetDirectoryName($target)) -WindowStyle Hidden -ErrorAction Stop
            Write-Output "  [OK] 已提交 Codex++ 启动请求：$target"
        }
    }
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
