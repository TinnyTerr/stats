#requires -Version 5.1
<#
.SYNOPSIS
    stats installer for Windows — https://git.tinnyterr.com/tinnyterr/stats

.DESCRIPTION
    Installs the single-file `stats.exe` (it embeds the Bun runtime, the API
    and the dashboard, so nothing else is required) and, on request, a
    Scheduled Task that starts the node at boot and restarts it on failure.

    A Windows node is real but sparse: there is no `system` probe yet (see
    src/collect/platform/win32.ts), and `systemd`, `docker`, `processes` and
    `ports` don't apply — those modules declare the platforms they run on and
    the loader leaves them out. What does run: `projects`, `logs`, `terminal`
    (ConPTY), and `ca`, which trusts the fleet's CA via `certutil`.

.PARAMETER Node
    Install as a node (dials the hub) plus a Scheduled Task.

.PARAMETER HubUrl
    Where the hub is, e.g. ws://hub.lan:3000. Required for -Node on first
    install.

.PARAMETER Token
    Shared token; must match the hub's nodeToken.

.PARAMETER From
    Install from a local dist\ directory or a .exe, instead of downloading a
    release.

.PARAMETER Version
    Release tag to fetch. Defaults to the latest.

.PARAMETER InstallDir
    Where stats.exe and its config go. Default: C:\ProgramData\stats.

.PARAMETER NoTerminal
    Refuse to open shells for the dashboard.

.PARAMETER NoControl
    Refuse start/stop/restart requests.

.PARAMETER NoTask
    Install the binary and config but no Scheduled Task.

.PARAMETER Uninstall
    Remove the Scheduled Task and the binary.

.PARAMETER Purge
    With -Uninstall, also delete the config directory.

.EXAMPLE
    # Node, dialling an existing hub — run from an elevated PowerShell:
    iwr -useb https://git.tinnyterr.com/tinnyterr/stats/raw/branch/main/install.ps1 | iex
    # or, with parameters:
    .\install.ps1 -Node -HubUrl ws://hub.lan:3000 -Token <token>

.NOTES
    Everything it touches:
      C:\ProgramData\stats\stats.exe
      C:\ProgramData\stats\node.env       (hub URL + token)
      C:\ProgramData\stats\projects.json  (what the node runs, if absent)
      Scheduled Task "stats-node", running as SYSTEM

    It is re-runnable: installing over an existing copy upgrades the binary
    and restarts the task, and never overwrites a config or token you already
    have. It runs as SYSTEM by default, the Windows equivalent of the Linux
    installer's root node — unrestricted modules, and the hub may switch
    modules on and ask it to update unless you pass -NoRemoteUpdate or
    -NoHubModules.
#>
[CmdletBinding()]
param(
	[switch]$Node,
	[string]$HubUrl = $env:STATS_HUB,
	[string]$Token = $env:STATS_NODE_TOKEN,
	[string]$Id = $env:STATS_NODE_ID,
	[string]$Name = $env:STATS_NODE_NAME,
	[string]$From,
	[string]$Version,
	[string]$Repo = "tinnyterr/stats",
	[string]$InstallHost = "git.tinnyterr.com",
	[string]$InstallDir = "$env:ProgramData\stats",
	[switch]$NoTerminal,
	[switch]$NoControl,
	[switch]$NoRemoteUpdate,
	[switch]$NoHubModules,
	[switch]$NoTask,
	[switch]$Uninstall,
	[switch]$Purge,
	[switch]$Yes
)

$ErrorActionPreference = "Stop"
$TaskName = "stats-node"
$Bin = Join-Path $InstallDir "stats.exe"
$EnvFile = Join-Path $InstallDir "node.env"
$ProjectsFile = Join-Path $InstallDir "projects.json"

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Warning $msg }
function Die($msg) { Write-Error $msg; exit 1 }

function Test-Admin {
	$id = [Security.Principal.WindowsIdentity]::GetCurrent()
	$p = New-Object Security.Principal.WindowsPrincipal($id)
	return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
	Die "run this from an elevated PowerShell (Run as Administrator) — the Scheduled Task and C:\ProgramData\stats both need it."
}

function Confirm-Action($msg) {
	if ($Yes) { return }
	$reply = Read-Host "$msg [y/N]"
	if ($reply -notmatch '^(y|yes)$') { Die "cancelled." }
}

# --------------------------------------------------------------- uninstall

if ($Uninstall) {
	if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
		Step "removing scheduled task '$TaskName'"
		Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
		Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
	}
	if (Test-Path $Bin) {
		Step "removing $Bin"
		Remove-Item $Bin -Force
	}
	if ($Purge) {
		Confirm-Action "Delete $InstallDir (config, token)?"
		Step "purging $InstallDir"
		Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
	} elseif (Test-Path $InstallDir) {
		Write-Host "kept $InstallDir — pass -Purge to delete it." -ForegroundColor DarkGray
	}
	Write-Host "stats removed." -ForegroundColor Green
	exit 0
}

# ------------------------------------------------------------ obtain binary

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

function Get-Sha256($path) {
	(Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower()
}

# The download is a service binary, so check it against SHA256SUMS when the
# release publishes one. A missing sums file is a warning, not a hard stop.
function Test-Checksum($path, $assetName, $sumsPath) {
	if (-not (Test-Path $sumsPath)) {
		Warn "no SHA256SUMS alongside $assetName — skipping checksum."
		return
	}
	$line = Select-String -Path $sumsPath -Pattern "  $assetName$" | Select-Object -First 1
	if (-not $line) {
		Warn "$assetName is not listed in SHA256SUMS — skipping checksum."
		return
	}
	$want = ($line.Line -split '\s+')[0]
	$got = Get-Sha256 $path
	if ($want -ne $got) {
		Die "checksum mismatch for $assetName.`n  expected $want`n  got      $got"
	}
	Write-Host "checksum ok ($assetName)" -ForegroundColor DarkGray
}

$Asset = "stats-windows-x64.exe"
$Tmp = Join-Path $env:TEMP "stats-install-$([guid]::NewGuid())"
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
try {
	$TmpBin = Join-Path $Tmp "stats.exe"

	if ($From) {
		if (Test-Path $From -PathType Container) {
			$src = Join-Path $From $Asset
			if (-not (Test-Path $src)) { Die "$From has no $Asset. Build it with: bun run build --targets windows-x64" }
			Step "installing $Asset from $From"
			$sums = Join-Path $From "SHA256SUMS"
			Test-Checksum $src $Asset $sums
			Copy-Item $src $TmpBin
		} elseif (Test-Path $From -PathType Leaf) {
			Step "installing $From"
			Copy-Item $From $TmpBin
		} else {
			Die "-From path '$From' does not exist."
		}
	} else {
		if (-not $Version) {
			Step "looking up the latest release"
			$api = if ($InstallHost -eq "github.com") {
				"https://api.github.com/repos/$Repo/releases/latest"
			} else {
				"https://$InstallHost/api/v1/repos/$Repo/releases/latest"
			}
			$release = Invoke-RestMethod -Uri $api
			$Version = $release.tag_name
			if (-not $Version) { Die "couldn't work out the latest release from $api. Pass -Version." }
		}
		$base = "https://$InstallHost/$Repo/releases/download/$Version"
		Step "downloading $Asset ($Version) from $base"
		try {
			Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile (Join-Path $Tmp "SHA256SUMS") -ErrorAction Stop
		} catch { }
		Invoke-WebRequest -Uri "$base/$Asset" -OutFile $TmpBin
		Test-Checksum $TmpBin $Asset (Join-Path $Tmp "SHA256SUMS")
	}

	if (-not (& $TmpBin version)) { Die "the downloaded build doesn't run on this machine." }
	$InstalledVersion = & $TmpBin version

	# Copying over a running service's exe fails with a file-in-use error;
	# stop the task first so an upgrade doesn't need a second run to land.
	$existed = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
	if ($existed) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

	Copy-Item $TmpBin $Bin -Force
	Step "installed $InstalledVersion -> $Bin"
} finally {
	Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not $Node) {
	Write-Host ""
	Write-Host "Next: run with -Node -HubUrl ws://hub.lan:3000 -Token <token> to install as a service."
	exit 0
}

# --------------------------------------------------------------------- node

if (Test-Path $EnvFile) {
	Write-Host "keeping the existing $EnvFile" -ForegroundColor DarkGray
	$existing = Get-Content $EnvFile | Where-Object { $_ -match '^STATS_HUB=' }
	if (-not $HubUrl -and $existing) { $HubUrl = ($existing -split '=', 2)[1] }
	if (-not $Token) {
		$tokLine = Get-Content $EnvFile | Where-Object { $_ -match '^STATS_NODE_TOKEN=' }
		if ($tokLine) { $Token = ($tokLine -split '=', 2)[1] }
	}
} else {
	if (-not $HubUrl) { Die "a node needs its hub: -HubUrl ws://hub.lan:3000 (or set STATS_HUB)." }
	if (-not $Token) { Warn "no -Token given — the hub will only accept this node if it has no nodeToken set." }
	Step "writing $EnvFile"
	@(
		"STATS_HUB=$HubUrl"
		"STATS_NODE_TOKEN=$Token"
		$(if ($Id) { "STATS_NODE_ID=$Id" })
		$(if ($Name) { "STATS_NODE_NAME=$Name" })
	) | Where-Object { $_ } | Set-Content -Path $EnvFile -Encoding ascii
}

if (-not (Test-Path $ProjectsFile)) {
	Step "writing $ProjectsFile"
	$hubHttp = $HubUrl -replace '^ws://', 'http://' -replace '^wss://', 'https://' -replace '/node$', ''
	@"
{
  "`$schema": "$hubHttp/schema/projects.schema.json",
  "version": 1,
  "projects": []
}
"@ | Set-Content -Path $ProjectsFile -Encoding utf8
}

$execArgs = @("node")
if ($NoTerminal) { $execArgs += "--no-terminal" }
if ($NoControl) { $execArgs += "--no-control" }
if (-not $NoRemoteUpdate) { $execArgs += "--allow-remote-update" }
if (-not $NoHubModules) { $execArgs += "--allow-hub-modules" }

if (-not $NoTask) {
	Step "registering scheduled task '$TaskName'"

	# Env vars set on the Process action don't reach a Scheduled Task the way
	# EnvironmentFile does for systemd; the node reads STATS_AGENT_CONFIG-style
	# flags instead, so the hub URL and token are passed on the command line via
	# a wrapper script that also sources node.env into this process first.
	$wrapper = Join-Path $InstallDir "run-node.ps1"
	@"
Get-Content '$EnvFile' | ForEach-Object {
    if (`$_ -match '^([^=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable(`$Matches[1], `$Matches[2], 'Process')
    }
}
& '$Bin' $($execArgs -join ' ')
"@ | Set-Content -Path $wrapper -Encoding utf8

	$action = New-ScheduledTaskAction -Execute "powershell.exe" `
		-Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`""
	$trigger = New-ScheduledTaskTrigger -AtStartup
	$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
	$settings = New-ScheduledTaskSettingsSet -Restart -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
		-StartWhenAvailable -DontStopOnIdleEnd

	Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
		-Principal $principal -Settings $settings -Force | Out-Null
	Start-ScheduledTask -TaskName $TaskName

	Start-Sleep -Seconds 2
	$state = (Get-ScheduledTask -TaskName $TaskName).State
	if ($state -eq "Running") {
		Write-Host "$TaskName is running." -ForegroundColor Green
	} else {
		Warn "$TaskName didn't start (state: $state). Check Event Viewer or run manually: & '$Bin' node"
	}
}

Write-Host ""
Write-Host "Node is dialling $HubUrl"
Write-Host "Identity:  $(if ($Id) { $Id } else { '(machine GUID)' })  ($(if ($Name) { $Name } else { $env:COMPUTERNAME }))"
Write-Host "Projects:  $ProjectsFile"
Write-Host ""
Write-Host "Running as SYSTEM: the hub may switch modules on and ask this node to" -ForegroundColor Yellow
Write-Host "update itself, same as a root Linux node. Pass -NoRemoteUpdate / -NoHubModules to refuse either." -ForegroundColor Yellow
