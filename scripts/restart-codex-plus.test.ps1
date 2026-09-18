param([ValidateSet('Tree', 'StartFailure', 'MissingInstall')][string]$Scenario = 'Tree')
$ErrorActionPreference = 'Stop'
# 启动错误测试使用完全隔离的命令替身，不发现或启动机器上的真实程序。
if ($Scenario -ne 'Tree') {
    function Get-CimInstance { @() }
    function Get-ItemProperty { @() }
    function Resolve-Path { throw 'Fixture has no installed directory.' }
    function Test-Path { $Scenario -eq 'StartFailure' }
    function Get-Content { 'C:\fixture\codex-plus-plus.exe' }
    function Start-Process { throw 'Simulated start failure.' }
    & (Join-Path $PSScriptRoot 'restart-codex-plus.ps1') -Action Start -StateFile 'fixture-state.txt'
    exit $LASTEXITCODE
}
# 只加载纯进程树函数，不执行真实 Stop/Start。
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'restart-codex-plus.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$function = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Get-CodexPlusProcessTree'
}, $true)
. ([scriptblock]::Create($function.Extent.Text))

function New-Fixture {
    param([int]$Id, [int]$Parent, [int]$Created, [string]$Name = 'ChatGPT.exe')
    [pscustomobject]@{
        ProcessId = $Id
        ParentProcessId = $Parent
        CreationDate = [datetime]'2026-01-01' + [timespan]::FromSeconds($Created)
        Name = $Name
        ExecutablePath = "C:\fixture\$Name"
    }
}
function Assert-Ids {
    param([object[]]$Actual, [int[]]$Expected)
    $ids = @($Actual | ForEach-Object { $_.ProcessId } | Sort-Object)
    if (($ids -join ',') -ne (($Expected | Sort-Object) -join ',')) {
        throw "Unexpected process tree: $ids; expected: $Expected"
    }
}
$manager = New-Fixture 10 1 1 'codex-plus-plus-manager.exe'
$launcher = New-Fixture 20 10 2 'codex-plus-plus.exe'
$desktop = New-Fixture 30 20 3
$renderer = New-Fixture 40 30 4
$cli = New-Fixture 50 30 4 'codex.exe'
$plugin = New-Fixture 60 50 5 'node.exe'
$unrelated = New-Fixture 70 1 6
$staleChild = New-Fixture 80 20 1
$snapshot = @($plugin, $renderer, $unrelated, $staleChild, $cli, $desktop, $launcher, $manager)
$tree = @(Get-CodexPlusProcessTree -Roots @($manager, $launcher) -Snapshot $snapshot)
Assert-Ids $tree @(10, 20, 30, 40, 50, 60)
if ($tree[0].ProcessId -ne 10) { throw 'Parent must be stopped before children.' }

# 父进程已退出、后续派生的后代仍可发现。
$late = New-Fixture 90 60 7 'xuan-bridge.exe'
Assert-Ids (Get-CodexPlusProcessTree -Roots $tree -Snapshot @($plugin, $late)) @(10, 20, 30, 40, 50, 60, 90)
# 父 PID 已复用，不把新进程的子进程归到旧树。
$reused = New-Fixture 20 1 10
$newChild = New-Fixture 100 20 11
Assert-Ids (Get-CodexPlusProcessTree -Roots @($launcher) -Snapshot @($reused, $newChild)) @(20)
Assert-Ids (Get-CodexPlusProcessTree -Roots @() -Snapshot $snapshot) @()
Write-Output 'Process tree regression tests passed (no live processes stopped).'
