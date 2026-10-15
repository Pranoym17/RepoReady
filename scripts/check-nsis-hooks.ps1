param([Parameter(Mandatory = $true)][string] $MakeNsisPath)
# Compile-only hook syntax check. Never executes the generated harness/installer.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $repoRoot '.cache/nsis-hook-syntax'
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$source = @'
Unicode true
Name "RepoReady hook compile harness"
OutFile "__OUTPUT__"
RequestExecutionLevel user
!define PRODUCTNAME "RepoReady Development"
!define MAINBINARYNAME "repoready-desktop"
Var DeleteAppDataCheckboxState
Var UpdateMode
; The real upstream app-running macro is separately covered by final installer tests.
; This same-arity stub lets both hook expansions be syntax-checked without app execution.
!macro CheckIfAppIsRunning executable product
  DetailPrint "Compile-only running-app check"
!macroend
!include "__HOOKS__"
Section
  !insertmacro NSIS_HOOK_PREINSTALL
SectionEnd
Section "Uninstall"
  !insertmacro NSIS_HOOK_PREUNINSTALL
SectionEnd
'@
$source = $source.Replace('__OUTPUT__',(Join-Path $outputRoot 'never-run.exe')).Replace('__HOOKS__',(Join-Path $repoRoot 'apps/desktop/src-tauri/packaging/hooks.nsh'))
$sourcePath = Join-Path $outputRoot 'hooks.nsi'
[IO.File]::WriteAllText($sourcePath,$source,(New-Object Text.UTF8Encoding($false)))
& (Resolve-Path -LiteralPath $MakeNsisPath).Path /NOCONFIG /V2 $sourcePath
if ($LASTEXITCODE -ne 0) { throw 'NSIS hook syntax compilation failed.' }
Write-Output 'NSIS hooks compiled. Generated harness was not executed; this is not installer acceptance.'
