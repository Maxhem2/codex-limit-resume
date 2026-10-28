param(
    [ValidateSet('Install', 'Uninstall')]
    [string]$Action = 'Install',
    [string]$SourceApp,
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'CodexQuotaQueue')
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
$receiptPath = Join-Path $root 'install.json'

function Get-QueueNode {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js 18 or newer is required. Install Node.js, then run this script again.' }
    $nodeVersion = & $node.Source --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 18) {
        throw 'Node.js 18 or newer is required.'
    }
    return $node
}

function Get-QueueReceipt {
    if (-not (Test-Path -LiteralPath $receiptPath)) { return $null }
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    $app = [IO.Path]::GetFullPath($receipt.appDirectory).TrimEnd('\')
    if ($receipt.product -ne 'CodexQuotaQueue' -or -not $app.StartsWith($root + '\app-', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The saved Codex Queue installation path is not valid.'
    }
    return @{ Receipt = $receipt; App = $app }
}

if ($Action -eq 'Uninstall') {
    $installed = Get-QueueReceipt
    if (-not $installed) { throw 'No Codex Queue installation was found.' }
    $app = $installed.App
    if (-not (Test-Path -LiteralPath $app)) { throw 'The saved Codex Queue app directory no longer exists.' }

    $running = Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith($app + '\', [StringComparison]::OrdinalIgnoreCase)
    }
    if ($running) { throw 'Close Codex Queue before uninstalling.' }

    $markerPath = Join-Path $app 'codex-quota-queue-install.json'
    if (-not (Test-Path -LiteralPath $markerPath)) { throw 'The app copy is not marked as a Codex Queue installation.' }
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if ($marker.mod -ne 'CodexQuotaQueue') { throw 'The app copy is not marked as a Codex Queue installation.' }

    Remove-Item -LiteralPath $app -Recurse -Force

    $shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Queue.lnk'
    if (Test-Path -LiteralPath $shortcutPath) {
        $shell = New-Object -ComObject WScript.Shell
        $target = $shell.CreateShortcut($shortcutPath).TargetPath
        if ($target -eq (Join-Path $app 'ChatGPT.exe')) { Remove-Item -LiteralPath $shortcutPath -Force }
    }

    Remove-Item -LiteralPath $receiptPath -Force
    Write-Host 'Removed Codex Queue. Your regular Codex installation and chats were left unchanged.' -ForegroundColor Green
    exit 0
}

$node = Get-QueueNode
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
$installed = Get-QueueReceipt

if ($installed) {
    $receipt = $installed.Receipt
    $app = $installed.App
    if (-not (Test-Path -LiteralPath $app)) { throw 'The saved Codex Queue app directory no longer exists. Uninstall the stale entry before reinstalling.' }
    if ($receipt.packageVersion -ne $manifest.packageVersion) {
        throw ('This package supports Codex ' + $manifest.packageVersion + ', but the existing Codex Queue copy was built from ' + $receipt.packageVersion + '. Uninstall it first, then run Install.cmd again.')
    }

    Write-Host 'Existing Codex Queue installation found. Close all Codex Queue windows to update it.' -ForegroundColor Yellow
    do {
        $running = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" | Where-Object {
            $_.ExecutablePath -and $_.ExecutablePath.StartsWith($app + '\', [StringComparison]::OrdinalIgnoreCase)
        })
        if ($running.Count) { Start-Sleep -Seconds 2 }
    } while ($running.Count)

    Write-Host 'Updating Codex Queue and keeping a rollback backup...'
    & $node.Source (Join-Path $PSScriptRoot 'update-app.cjs') $app
    if ($LASTEXITCODE -ne 0) { throw 'The update did not complete. Read the error above before opening Codex Queue.' }

    Write-Host ''
    Write-Host 'Updated. Open Codex Queue using your existing desktop shortcut.' -ForegroundColor Green
    exit 0
}

if (-not $SourceApp) {
    $package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $package) { throw 'The Codex Windows package was not found. Pass -SourceApp with its app directory.' }
    if ($package.Version.ToString() -ne $manifest.packageVersion) {
        throw ('This patch supports Codex ' + $manifest.packageVersion + '; installed: ' + $package.Version)
    }
    $SourceApp = Join-Path $package.InstallLocation 'app'
}

$source = (Resolve-Path -LiteralPath $SourceApp).Path.TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $source 'resources/app.asar'))) {
    throw 'SourceApp does not contain Codex resources/app.asar.'
}
if ($root -eq $source -or $source.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or $root.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'InstallDirectory must be separate from the installed app.'
}

$target = Join-Path $root ('app-' + $manifest.packageVersion)
if (Test-Path -LiteralPath $target) {
    throw ('A Codex Queue app copy already exists at ' + $target + ', but no valid installation receipt was found. Remove that stale folder or uninstall the previous copy first.')
}

$staging = Join-Path $root ('staging-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging -Force | Out-Null
try {
    Write-Host 'Copying Codex into your local app folder. The installed Windows package is unchanged.'
    & robocopy.exe $source $staging /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS
    if ($LASTEXITCODE -ge 8) { throw ('Copy failed with robocopy code ' + $LASTEXITCODE) }

    Write-Host 'Adding the queue and chat controls...'
    & $node.Source (Join-Path $PSScriptRoot 'patch-app.cjs') $staging
    if ($LASTEXITCODE -ne 0) { throw 'The patch could not be applied. The original installed app is unchanged.' }

    Move-Item -LiteralPath $staging -Destination $target
} catch {
    $resolvedStaging = [IO.Path]::GetFullPath($staging)
    if ($resolvedStaging.StartsWith($root + '\staging-', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStaging)) {
        Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
    }
    throw
}

$receipt = @{ product = 'CodexQuotaQueue'; appDirectory = $target; packageVersion = $manifest.packageVersion }
$receipt | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding UTF8

$shell = New-Object -ComObject WScript.Shell
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Queue.lnk'
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $target 'ChatGPT.exe'
$shortcut.WorkingDirectory = $target
$shortcut.Description = 'Codex with scheduled messages and per-chat auto-continue'
$shortcut.Save()

Write-Host ''
Write-Host 'Installed. Close all Codex windows, then open the Codex Queue desktop shortcut.' -ForegroundColor Green
Write-Host 'Run Install.cmd again after downloading a newer release to update this copy.'
Write-Host 'The regular Codex shortcut still opens the original app.'
