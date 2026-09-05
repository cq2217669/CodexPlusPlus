param(
  [Parameter(Mandatory = $true)]
  [string]$SourceRepository,
  [switch]$Copy
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceRoot = (Resolve-Path -LiteralPath $SourceRepository).Path
$sourcePrefix = 'harmony6-workagents-remote-app/'
$destinationRoot = Join-Path $workspaceRoot 'apps\xuan-plus-remote'

try {
  $gitArgs = @('-C', $sourceRoot, 'ls-files', '-z', '--', $sourcePrefix)
  $trackedOutput = & git @gitArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $trackedFiles = ($trackedOutput -join "`n").Split([char]0, [StringSplitOptions]::RemoveEmptyEntries)
  $plan = @()
  foreach ($trackedPath in $trackedFiles) {
    if (-not $trackedPath.StartsWith($sourcePrefix, [StringComparison]::Ordinal)) {
      throw '源文件不在指定的手机端目录内。'
    }
    $relativePath = $trackedPath.Substring($sourcePrefix.Length)
    $included = $relativePath.StartsWith('app/', [StringComparison]::Ordinal) -or
      $relativePath.StartsWith('protocol/', [StringComparison]::Ordinal) -or
      $relativePath.StartsWith('cloud-service/src/', [StringComparison]::Ordinal) -or
      $relativePath -in @('cloud-service/Cargo.toml', 'cloud-service/Cargo.lock',
        'environment/shared-remote-service.json', 'environment/verify-shared-service-config.mjs')
    if (-not $included -or $relativePath.EndsWith('.md', [StringComparison]::OrdinalIgnoreCase)) {
      continue
    }
    if ($relativePath -match '(^|/)(\.git|\.idea|\.hvigor|\.signing[^/]*|oh_modules|node_modules|build|runtime|target|dist)(/|$)' -or
      $relativePath -match '(?i)(\.env[^/]*|\.p12|\.p7b|\.pem|\.key|\.cer|\.hap|\.jks|local\.properties|oh-package-lock\.json5)$' -or
      $relativePath -eq 'app/build-profile.json5') {
      throw '发现受版本控制的私有文件或生成产物，已停止复制。'
    }
    $sourcePath = [IO.Path]::GetFullPath((Join-Path $sourceRoot $trackedPath))
    $destinationPath = [IO.Path]::GetFullPath((Join-Path $destinationRoot $relativePath))
    if (-not $sourcePath.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      -not $destinationPath.StartsWith($destinationRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw '解析后的路径超出本次复制范围。'
    }
    $sourceItem = Get-Item -LiteralPath $sourcePath -Force
    if ($sourceItem.PSIsContainer) { throw '仅允许逐个复制普通文件。' }
    $ancestor = $sourceItem
    while ($null -ne $ancestor) {
      if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw '不允许复制源目录中的符号链接或目录联接。'
      }
      $ancestor = if ($ancestor -is [IO.FileInfo]) { $ancestor.Directory } else { $ancestor.Parent }
    }
    $plan += [pscustomobject]@{
      RelativePath = $relativePath
      Source = $sourcePath
      Destination = $destinationPath
      Hash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
      Bytes = $sourceItem.Length
    }
  }
  if ($plan.Count -eq 0) { throw '没有找到可复制的受版本控制源码。' }
  if (Test-Path -LiteralPath $destinationRoot) {
    throw '目标目录已存在；本脚本不会合并或覆盖已有手机端副本。'
  }
  $destinationParent = Get-Item -LiteralPath (Split-Path -Parent $destinationRoot)
  while ($null -ne $destinationParent) {
    if (($destinationParent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw '目标目录不能经过符号链接或目录联接。'
    }
    $destinationParent = $destinationParent.Parent
  }
  if ($Copy) {
    foreach ($entry in $plan) {
      $directory = Split-Path -Parent $entry.Destination
      [void][IO.Directory]::CreateDirectory($directory)
      # 不覆盖既有文件；复制后同时核对源和副本，避免迁移期间的并发改动。
      [IO.File]::Copy($entry.Source, $entry.Destination, $false)
      if ((Get-FileHash -LiteralPath $entry.Source -Algorithm SHA256).Hash -ne $entry.Hash -or
        (Get-FileHash -LiteralPath $entry.Destination -Algorithm SHA256).Hash -ne $entry.Hash) {
        throw '源文件发生变化或副本校验失败；请先检查已复制内容，不要直接重试。'
      }
    }
  }
  [ordered]@{
    copied = [bool]$Copy
    files = $plan.Count
    bytes = ($plan | Measure-Object -Property Bytes -Sum).Sum
    destination = $destinationRoot
    sourceUnmodified = $true
  } | ConvertTo-Json -Compress
} catch {
  Write-Error $_
  exit 1
}
