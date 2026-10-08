param([Parameter(Mandatory = $true)][string]$ArtifactDirectory)
$ErrorActionPreference = 'Stop'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installer = (Resolve-Path "$ArtifactDirectory/pash_${version}_windows_x86_64-setup.exe").Path
$installDirectory = Join-Path $env:ProgramFiles 'pash'
$installation = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installDirectory") -PassThru -Wait
if ($installation.ExitCode -ne 0) { throw "Installer exited with $($installation.ExitCode)" }
foreach ($name in @('clash-verge.exe', 'verge-mihomo.exe', 'network-agent-node.exe', 'resources/network-agent.mjs')) {
  if (-not (Test-Path (Join-Path $installDirectory $name))) { throw "Missing installed file: $name" }
}
$runtime = Join-Path $installDirectory 'network-agent-node.exe'
$nodeVersion = & $runtime --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne 'v24.21.0') { throw 'Bundled Node runtime did not start' }
$workerCheck = @'
const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, [process.argv[1]], {
  input: JSON.stringify({ prompt: '' }), encoding: 'utf8', timeout: 15000
});
const event = JSON.parse(result.stdout.trim());
if (result.status !== 1 || event.type !== 'error' || !event.error.startsWith('Provide a prompt'))
  throw new Error('Installed assistant did not initialize correctly');
console.log('Installed assistant initialized successfully');
'@
& $runtime -e $workerCheck (Join-Path $installDirectory 'resources/network-agent.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Bundled assistant could not start' }
$key = (Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).plugins.updater.pubkey
$keyFile = Join-Path $env:RUNNER_TEMP 'pash-update.pub'
$signatureFile = Join-Path $env:RUNNER_TEMP 'pash-update.sig'
[System.IO.File]::WriteAllBytes($keyFile, [Convert]::FromBase64String($key))
[System.IO.File]::WriteAllBytes($signatureFile, [Convert]::FromBase64String((Get-Content "$installer.sig" -Raw).Trim()))
$dependencies = 'target/x86_64-pc-windows-msvc/release/deps'
$library = Get-ChildItem "$dependencies/libminisign_verify-*.rlib" | Select-Object -First 1
if (-not $library) { throw 'Updater verification library was not built' }
$verifier = Join-Path $env:RUNNER_TEMP 'verify-pash-signature.exe'
rustc --edition=2021 scripts/verify-update-signature.rs --extern "minisign_verify=$($library.FullName)" -L "dependency=$dependencies" -o $verifier
if ($LASTEXITCODE -ne 0) { throw 'Could not build updater signature verifier' }
& $verifier $keyFile $signatureFile $installer
if ($LASTEXITCODE -ne 0) { throw 'Installer update signature verification failed' }
$app = Start-Process -FilePath (Join-Path $installDirectory 'clash-verge.exe') -PassThru
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if ($app.HasExited) { throw 'Installed pash exited during startup' }
    $listener = Get-NetTCPConnection -LocalPort 7897 -State Listen -ErrorAction SilentlyContinue
    if ($listener) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw 'Installed pash did not start its proxy core' }
  Write-Output 'Installed pash started its proxy core successfully.'
} finally {
  if (-not $app.HasExited) { Stop-Process -Id $app.Id -Force }
}
Write-Output "Installed pash $version with verified updater signature and bundled Node $nodeVersion."
