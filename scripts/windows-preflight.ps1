param()
# Read-only inspection. Does not install tools, launch RepoReady, alter the registry or reboot.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$vswherePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$msvcFound = $false
if (Test-Path -LiteralPath $vswherePath) {
    $instances = @(& $vswherePath -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
    $msvcFound = $instances.Count -gt 0
}
$webview = @(Get-ItemProperty 'HKLM:/SOFTWARE/WOW6432Node/Microsoft/EdgeUpdate/Clients/*','HKCU:/SOFTWARE/Microsoft/EdgeUpdate/Clients/*' -ErrorAction SilentlyContinue | Where-Object name -Match 'WebView2' | Select-Object -ExpandProperty pv)
$os = Get-CimInstance Win32_OperatingSystem
$system = Get-CimInstance Win32_ComputerSystem
$sdk = Test-Path -LiteralPath (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/Include')
$volume = Get-PSDrive -Name ([IO.Path]::GetPathRoot($repoRoot).TrimEnd('\').TrimEnd(':')) -ErrorAction SilentlyContinue
$authority = Get-Content -LiteralPath (Join-Path $repoRoot 'apps/desktop/src-tauri/packaging/update-authority.json') -Raw | ConvertFrom-Json
$stableProfile = Get-Content -LiteralPath (Join-Path $repoRoot 'apps/desktop/src-tauri/tauri.bundle.stable.json') -Raw | ConvertFrom-Json
[ordered]@{
    schemaVersion = 1
    purpose = 'read-only Windows build/test inventory; not clean-device certification'
    windowsBuild = [int]$os.BuildNumber
    windows11 = ([int]$os.BuildNumber -ge 22000)
    x64 = ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64')
    ramMb = [math]::Round($system.TotalPhysicalMemory / 1MB)
    workspaceFreeMb = if ($volume) { [math]::Round($volume.Free / 1MB) } else { $null }
    msvcDiscovered = $msvcFound
    windowsSdkDiscovered = $sdk
    webview2RegisteredVersions = @($webview | Sort-Object -Unique)
    node = if (Get-Command node -ErrorAction SilentlyContinue) { (& node --version) } else { $null }
    npm = if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { (& npm.cmd --version) } else { $null }
    rustupAvailable = [bool](Get-Command rustup -ErrorAction SilentlyContinue)
    updateAuthorityEnabled = $authority.enabled
    windowsSigningThumbprintConfigured = [bool]$stableProfile.bundle.windows.certificateThumbprint
    signingVerified = $false
    cleanDeviceVerified = $false
} | ConvertTo-Json -Depth 4
