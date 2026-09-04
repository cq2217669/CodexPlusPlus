$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$output = Join-Path $root 'target\msvc-package-build.out.log'
$error = Join-Path $root 'target\msvc-package-build.err.log'
$process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', 'call package.bat') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $output -RedirectStandardError $error -PassThru
Write-Output $process.Id
