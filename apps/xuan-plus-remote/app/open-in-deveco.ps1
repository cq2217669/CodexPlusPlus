param(
  [Parameter(Mandatory = $true)]
  [string]$DevEcoExecutable
)

$ErrorActionPreference = 'Stop'
$resolvedDevEcoExecutable = (Resolve-Path -LiteralPath $DevEcoExecutable).Path
$projectPath = (Resolve-Path -LiteralPath $PSScriptRoot).Path
Start-Process -FilePath $resolvedDevEcoExecutable -ArgumentList @("`"$projectPath`"") -WindowStyle Hidden
exit 0
