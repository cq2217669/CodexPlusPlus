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
        -Property ProcessId, Name, ExecutablePath, CreationDate |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like "*$($_.Name)" })
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
        $procs = Get-CodexPlusProcesses
        # 主程序先记录、先结束，管理控制台随后处理。
        $ordered = @($procs | Where-Object { $_.Name -eq $mainBinary }) +
            @($procs | Where-Object { $_.Name -ne $mainBinary })
        $paths = @()
        foreach ($proc in $ordered) {
            if ($paths -notcontains $proc.ExecutablePath) { $paths += $proc.ExecutablePath }
        }
        if ($StateFile) {
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
        foreach ($item in $ordered) {
            $process = $null
            try {
                $process = Get-Process -Id $item.ProcessId -ErrorAction Stop
            } catch {
                continue
            }
            if ($process.HasExited) { continue }
            # 结束前复核进程身份，避免误杀同名进程。
            $current = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($item.ProcessId)"
            if (-not $current -or $current.CreationDate -ne $item.CreationDate -or $current.ExecutablePath -ne $item.ExecutablePath) {
                continue
            }
            if ($PSCmdlet.ShouldProcess($item.ExecutablePath, '结束 Codex++ 主程序进程')) {
                Stop-Process -InputObject $process -Force -ErrorAction Stop
                if (-not $process.WaitForExit(15000)) {
                    throw "Codex++ 主程序进程未及时退出：$($item.ExecutablePath)"
                }
                $stopped++
            }
        }
        if (-not $WhatIfPreference) {
            $remaining = Get-CodexPlusProcesses
            if ($remaining.Count -gt 0) { throw '仍有 Codex++ 主程序进程未退出，已停止安装。' }
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
        Write-Output '[警告] 未找到 Codex++ 主程序，请手动启动 Codex++。'
        exit 0
    }
    $running = Get-CodexPlusProcesses
    foreach ($target in $targets) {
        $name = [System.IO.Path]::GetFileName($target)
        if (@($running | Where-Object { $_.Name -eq $name }).Count -gt 0) {
            Write-Output "  [跳过] $name 已在运行。"
            continue
        }
        if ($PSCmdlet.ShouldProcess($target, '启动 Codex++ 主程序')) {
            Start-Process -FilePath $target -WorkingDirectory ([System.IO.Path]::GetDirectoryName($target))
            Write-Output "  [OK] 已启动 Codex++ 主程序：$target"
        }
    }
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
