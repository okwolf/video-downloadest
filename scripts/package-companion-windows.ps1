param(
    [string]$Configuration = "Release",
    [string]$RuntimeIdentifier = "win-x64",
    [string]$Version = "0.1.0"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Project = Join-Path $Root "companion\windows\VideoDownloadestCompanion.csproj"
$Dist = Join-Path $Root "dist\windows"
$App = Join-Path $Dist "Video Downloadest"
$Zip = Join-Path $Dist "Video Downloadest-$Version-windows-x64.zip"

if (-not (Test-Path (Join-Path $Root "node_modules\express\package.json"))) {
    throw "Run npm ci in the repository before packaging the Windows companion."
}

Remove-Item $App -Recurse -Force -ErrorAction SilentlyContinue
New-Item $App -ItemType Directory -Force | Out-Null
dotnet publish $Project -c $Configuration -r $RuntimeIdentifier --self-contained false -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -o $App

$Server = Join-Path $App "Server"
$Extension = Join-Path $App "Extension"
New-Item $Server -ItemType Directory -Force | Out-Null
New-Item $Extension -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $Root "server.js") (Join-Path $Server "server.js")
Copy-Item (Join-Path $Root "capture-store.js") (Join-Path $Server "capture-store.js")
Copy-Item (Join-Path $Root "package.json") (Join-Path $Server "package.json")
Copy-Item (Join-Path $Root "node_modules") (Join-Path $Server "node_modules") -Recurse
Copy-Item (Join-Path $Root "manifest.json") (Join-Path $Extension "manifest.json")
Copy-Item (Join-Path $Root "injected-script.js") (Join-Path $Extension "injected-script.js")
Copy-Item (Join-Path $Root "content-script.js") (Join-Path $Extension "content-script.js")
Copy-Item (Join-Path $Root "iframe.html") (Join-Path $Extension "iframe.html")
Copy-Item (Join-Path $Root "iframe.js") (Join-Path $Extension "iframe.js")

@"
Video Downloadest for Windows

1. Extract this folder to a location where you want to keep the app.
2. Install the .NET 8 Desktop Runtime (x64) if it is not already installed: https://dotnet.microsoft.com/en-us/download/dotnet/8.0/runtime
3. Run VideoDownloadestCompanion.exe. On first launch, it downloads Node.js and FFmpeg.
4. In the app, choose Copy folder path.
5. Open Chrome extensions and turn on Developer mode.
6. Choose Load unpacked, paste the copied folder path into the picker, and select the folder.

Requirements: Windows 10/11 x64, .NET 8 Desktop Runtime x64, Google Chrome, and an internet connection for the initial runtime downloads.
"@ | Set-Content (Join-Path $App "Install Guide.txt") -Encoding UTF8

Remove-Item $Zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $App "*") -DestinationPath $Zip -CompressionLevel Optimal
Write-Host "Packaged $Zip"
