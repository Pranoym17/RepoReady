param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $CargoArguments
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$localRust = Join-Path $repoRoot '.cache\rustup'
if (-not (Test-Path -LiteralPath $localRust)) { throw 'Local Rust cache not present. Use a provisioned Rust/MSVC toolchain and standard cargo commands in docs/development.md.' }
$llvmRoot = Get-ChildItem -LiteralPath (Join-Path $repoRoot '.cache\llvm-mingw') -Directory | Select-Object -First 1
if (-not $llvmRoot) { throw 'Verified local LLVM cache not present.' }
$env:RUSTUP_HOME = $localRust
$env:CARGO_HOME = Join-Path $repoRoot '.cache\cargo'
$env:Path = (Join-Path $llvmRoot.FullName 'bin') + ';' + $env:Path
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER = 'x86_64-w64-mingw32-clang.exe'
$env:RUSTFLAGS = '-C dlltool=llvm-dlltool.exe'
& cargo +1.99.0-x86_64-pc-windows-gnullvm @CargoArguments
exit $LASTEXITCODE
