param(
    [Parameter(Mandatory = $true)][string] $PublicAuthorityPath,
    [string] $VersionA = '0.1.0-alpha.1',
    [string] $VersionB = '0.1.0-alpha.2'
)
# BUILD ONLY. Never launches an app/installer, signs a policy or publishes any file.
# Run only in the approved Windows build environment after MSVC/SDK setup and test-key custody.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if ($VersionA -notmatch '^0\.1\.0-alpha\.\d+$' -or $VersionB -notmatch '^0\.1\.0-alpha\.\d+$' -or [int]$VersionB.Split('.')[-1] -le [int]$VersionA.Split('.')[-1]) { throw 'Choose two increasing 0.1.0-alpha.N private test versions.' }
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) { throw 'Supply the private TEST updater key through the protected process environment first. No key value is printed.' }
$authorityPath = (Resolve-Path -LiteralPath $PublicAuthorityPath).Path
$authority = Get-Content -LiteralPath $authorityPath -Raw | ConvertFrom-Json
if ($authority.schemaVersion -ne 1 -or $authority.enabled -ne $true -or $authority.channel -ne 'development') { throw 'A reviewed development-only PUBLIC authority file is required.' }
$toolchain = '1.99.0-x86_64-pc-windows-msvc'
& rustup run $toolchain rustc --version
if ($LASTEXITCODE -ne 0) { throw 'Provision the pinned MSVC Rust toolchain in the approved environment first.' }
$buildRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot ('.worktrees/m2-private-' + [guid]::NewGuid().ToString('N'))))
$workspacePrefix = [IO.Path]::GetFullPath((Join-Path $repoRoot '.worktrees')) + [IO.Path]::DirectorySeparatorChar
if (-not $buildRoot.StartsWith($workspacePrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Build path escaped the workspace.' }
& git -C $repoRoot worktree add --detach $buildRoot HEAD
if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated private build checkout.' }
$saved = @{}
foreach ($name in @('REPOREADY_ALLOW_PRIVATE_PACKAGING','RUSTUP_TOOLCHAIN','CARGO_HOME','CARGO_TARGET_DIR','NPM_CONFIG_CACHE')) { $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
Push-Location $buildRoot
try {
    $env:REPOREADY_ALLOW_PRIVATE_PACKAGING = '1'
    $env:RUSTUP_TOOLCHAIN = $toolchain
    $env:CARGO_HOME = Join-Path $repoRoot '.cache/cargo'
    $env:CARGO_TARGET_DIR = Join-Path $buildRoot 'target'
    $env:NPM_CONFIG_CACHE = Join-Path $repoRoot '.cache/npm'
    Copy-Item -LiteralPath $authorityPath -Destination (Join-Path $buildRoot 'apps/desktop/src-tauri/packaging/update-authority.json')
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Private checkout dependency installation failed.' }
    & node apps/desktop/src-tauri/packaging/check-profile.mjs development
    if ($LASTEXITCODE -ne 0) { throw 'Private packaging preflight rejected this configuration.' }
    foreach ($version in @($VersionA,$VersionB)) {
        $profile = Get-Content apps/desktop/src-tauri/tauri.bundle.dev.json -Raw | ConvertFrom-Json
        $profile.version = $version
        $profile.bundle | Add-Member -NotePropertyName useLocalToolsDir -NotePropertyValue $true -Force
        $profilePath = Join-Path $buildRoot ('private-' + $version + '.json')
        [IO.File]::WriteAllText($profilePath,($profile | ConvertTo-Json -Depth 20),(New-Object Text.UTF8Encoding($false)))
        & npm.cmd run tauri -w '@repoready/desktop' -- build --target x86_64-pc-windows-msvc --config $profilePath
        if ($LASTEXITCODE -ne 0) { throw "Private build failed for $version. No installer was executed." }
    }
    Write-Output 'Builds finished. No installer was executed and nothing was published.'
    Write-Output "Private build checkout: $buildRoot"
    Write-Output 'Record final installer bytes/signatures and prepare the approved staging policy before device testing.'
} finally {
    Pop-Location
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
}
