using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace VideoDownloadestCompanion;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new CompanionForm());
    }
}

internal sealed class CompanionForm : Form
{
    private readonly Label stateLabel = new() { AutoSize = true, Font = new Font("Segoe UI", 11, FontStyle.Bold) };
    private readonly Label detailLabel = new() { AutoSize = false, Width = 510, Height = 48, ForeColor = Color.DimGray };
    private readonly Label extensionPath = new() { AutoSize = false, Width = 510, Height = 38, ForeColor = Color.DimGray };
    private readonly Label capturesPath = new() { AutoSize = false, Width = 510, Height = 38, ForeColor = Color.DimGray };
    private readonly Label downloadLabel = new() { AutoSize = true, ForeColor = Color.DimGray };
    private readonly ProgressBar progress = new() { Width = 510, Height = 12, Visible = false };
    private readonly Button startButton = new() { Text = "Start server", AutoSize = true, Visible = false };
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromMinutes(5) };
    private readonly string dataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyVideos), "Video Downloadest");
    private readonly string supportDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Video Downloadest");
    private readonly string extensionDirectory;
    private readonly string capturesDirectory;
    private readonly string nodeDirectory;
    private readonly string ffmpegDirectory;
    private readonly string logPath;
    private Process? server;
    private bool preparing;
    private bool shuttingDown;
    private string nodeVersion = "";
    private string ffmpegVersion = "";
    private string? launchNote;

    public CompanionForm()
    {
        Text = "Video Downloadest";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(570, 650);
        MinimumSize = new Size(570, 650);
        Font = new Font("Segoe UI", 9);
        AutoScaleMode = AutoScaleMode.Font;

        capturesDirectory = Path.Combine(dataDirectory, "completed");
        nodeDirectory = Path.Combine(supportDirectory, "Node");
        ffmpegDirectory = Path.Combine(supportDirectory, "FFmpeg");
        logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Video Downloadest", "Logs", "server.log");
        extensionDirectory = InstallExtension();
        Directory.CreateDirectory(capturesDirectory);
        Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);

        var layout = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false,
            AutoScroll = true, Padding = new Padding(24), BackColor = SystemColors.Window
        };
        Controls.Add(layout);

        var header = new FlowLayoutPanel { Width = 510, Height = 52, WrapContents = false };
        var badge = new Label { Text = "●", ForeColor = Color.DarkOrange, Font = new Font("Segoe UI", 22, FontStyle.Bold), AutoSize = true, Margin = new Padding(0, 0, 14, 0) };
        header.Controls.Add(badge);
        var heading = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, Width = 440, Height = 50, WrapContents = false };
        heading.Controls.Add(new Label { Text = "Video Downloadest", Font = new Font("Segoe UI", 16, FontStyle.Bold), AutoSize = true });
        heading.Controls.Add(stateLabel);
        header.Controls.Add(heading);
        layout.Controls.Add(header);
        layout.Controls.Add(detailLabel);
        layout.Controls.Add(downloadLabel);
        layout.Controls.Add(progress);
        layout.Controls.Add(new Label { Text = "────────────────────────────────────────────────────────", ForeColor = Color.LightGray, AutoSize = true, Margin = new Padding(0, 8, 0, 8) });

        layout.Controls.Add(new Label { Text = "Add the extension to Chrome", Font = new Font("Segoe UI", 11, FontStyle.Bold), AutoSize = true });
        layout.Controls.Add(new Label { Text = "1. Copy the extension path with the button below.\n2. Open chrome://extensions in Chrome and turn on Developer mode.\n3. Choose Load unpacked, paste the path into the folder picker, then select the folder.", Width = 510, Height = 64 });
        extensionPath.Text = extensionDirectory;
        layout.Controls.Add(extensionPath);
        var extensionButtons = new FlowLayoutPanel { Width = 520, Height = 36, WrapContents = false };
        extensionButtons.Controls.Add(Button("Open Chrome extensions", OpenExtensionsPage));
        extensionButtons.Controls.Add(Button("Show extension folder", () => ShellOpen(extensionDirectory)));
        extensionButtons.Controls.Add(Button("Copy folder path", () => Clipboard.SetText(extensionDirectory)));
        layout.Controls.Add(extensionButtons);
        layout.Controls.Add(new Label { Text = "Chrome asks you to approve this local extension. This app does not change browser settings for you.", Width = 510, Height = 34, ForeColor = Color.DimGray });
        layout.Controls.Add(new Label { Text = "────────────────────────────────────────────────────────", ForeColor = Color.LightGray, AutoSize = true, Margin = new Padding(0, 6, 0, 8) });

        layout.Controls.Add(new Label { Text = "Saved videos", Font = new Font("Segoe UI", 11, FontStyle.Bold), AutoSize = true });
        capturesPath.Text = capturesDirectory;
        layout.Controls.Add(capturesPath);
        layout.Controls.Add(Button("Open folder", () => ShellOpen(capturesDirectory)));
        layout.Controls.Add(new Label { Text = "Node.js and FFmpeg are downloaded and updated by this app.", ForeColor = Color.DimGray, AutoSize = true, Margin = new Padding(0, 10, 0, 0) });
        var bottom = new FlowLayoutPanel { Width = 520, Height = 40, WrapContents = false, Margin = new Padding(0, 8, 0, 0) };
        bottom.Controls.Add(Button("Open server logs", () => ShellOpen(logPath)));
        startButton.Click += async (_, _) => await StartServerAsync();
        bottom.Controls.Add(startButton);
        layout.Controls.Add(bottom);

        FormClosing += (_, _) => StopServer();
        Shown += async (_, _) => await StartServerAsync();
    }

    private static Button Button(string text, Action action)
    {
        var button = new Button { Text = text, AutoSize = true, Height = 30, Margin = new Padding(0, 0, 8, 0) };
        button.Click += (_, _) => action();
        return button;
    }

    private string InstallExtension()
    {
        var bundled = Path.Combine(AppContext.BaseDirectory, "Extension");
        var target = Path.Combine(supportDirectory, "Extension");
        if (!File.Exists(Path.Combine(bundled, "manifest.json"))) return bundled;
        Directory.CreateDirectory(target);
        foreach (var file in Directory.EnumerateFiles(target))
            if (!File.Exists(Path.Combine(bundled, Path.GetFileName(file)))) File.Delete(file);
        foreach (var file in Directory.EnumerateFiles(bundled)) File.Copy(file, Path.Combine(target, Path.GetFileName(file)), true);
        return target;
    }

    private async Task StartServerAsync()
    {
        if (server is not null || preparing) return;
        preparing = true;
        launchNote = null;
        startButton.Visible = false;
        SetStatus("Checking for the latest Node.js LTS…", "Connecting to the official Node.js release service.");
        try
        {
            string node;
            try
            {
                var release = await LatestNodeRelease();
                node = CachedNode(release.Version)?.Path ?? await DownloadNode(release);
                nodeVersion = release.Version;
            }
            catch (Exception ex)
            {
                AppendLog($"Node.js LTS update check failed: {ex.Message}");
                var cached = CachedNode(null);
                if (cached is null) throw;
                node = cached.Value.Path; nodeVersion = cached.Value.Version;
                launchNote = $"Could not check for a Node.js update. Using cached {nodeVersion}.";
            }

            string ffmpeg;
            try
            {
                SetStatus("Checking for the latest FFmpeg release…", "Connecting to the Windows build provider.");
                var release = await LatestFFmpegRelease();
                ffmpeg = CachedFFmpeg(release.Version)?.Path ?? await DownloadFFmpeg(release);
                ffmpegVersion = release.Version;
            }
            catch (Exception ex)
            {
                AppendLog($"FFmpeg update check failed: {ex.Message}");
                var cached = CachedFFmpeg(null);
                if (cached is null) throw;
                ffmpeg = cached.Value.Path; ffmpegVersion = cached.Value.Version;
                launchNote = string.Join(" ", new[] { launchNote, $"Could not check for an FFmpeg update. Using cached {ffmpegVersion}." }.Where(x => !string.IsNullOrWhiteSpace(x)));
            }
            LaunchServer(node, ffmpeg);
        }
        catch (Exception ex)
        {
            AppendLog($"Runtime setup failed: {ex}");
            SetStatus("Could not prepare Node.js or FFmpeg", $"{ex.Message}\n\nCheck your internet connection, then choose Start server to retry. Open the logs for details.");
            startButton.Visible = true;
        }
        finally { preparing = false; }
    }

    private async Task<(string Version, string Archive)> LatestNodeRelease()
    {
        using var doc = JsonDocument.Parse(await http.GetStringAsync("https://nodejs.org/dist/index.json"));
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            if (!item.TryGetProperty("lts", out var lts) || lts.ValueKind != JsonValueKind.String ||
                !item.GetProperty("files").EnumerateArray().Any(x => x.GetString() == "win-x64-zip")) continue;
            var version = item.GetProperty("version").GetString()!;
            if (!Regex.IsMatch(version, "^v\\d+\\.\\d+\\.\\d+$")) continue;
            return (version, $"node-{version}-win-x64.zip");
        }
        throw new InvalidOperationException("Could not find a Windows x64 Node.js LTS release.");
    }

    private (string Path, string Version)? CachedNode(string? version)
    {
        version ??= ReadVersion(Path.Combine(nodeDirectory, "latest-lts"));
        if (version is null || !Regex.IsMatch(version, "^v\\d+\\.\\d+\\.\\d+$")) return null;
        var path = Path.Combine(nodeDirectory, "versions", version, "node.exe");
        return File.Exists(path) ? (path, version) : null;
    }

    private async Task<string> DownloadNode((string Version, string Archive) release)
    {
        SetStatus($"Downloading Node.js {release.Version} LTS…", "Downloading the official Windows x64 runtime and checking its SHA-256 checksum.");
        Directory.CreateDirectory(nodeDirectory);
        var baseUrl = $"https://nodejs.org/dist/{release.Version}/";
        var archive = await Download(baseUrl + release.Archive, $"Node.js {release.Version} LTS");
        var checksumText = await http.GetStringAsync(baseUrl + "SHASUMS256.txt");
        var line = checksumText.Split('\n').Select(x => x.TrimEnd('\r')).FirstOrDefault(x => x.EndsWith("  " + release.Archive, StringComparison.Ordinal));
        var expected = line?.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        if (expected is null || !await HashMatches(archive, expected)) throw new InvalidDataException("Node.js archive checksum verification failed.");
        SetStatus($"Installing Node.js {release.Version}…", "Extracting the verified runtime.");
        var stage = Path.Combine(nodeDirectory, ".install-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        try
        {
            using var zip = ZipFile.OpenRead(archive);
            foreach (var entry in zip.Entries.Where(e => e.FullName.EndsWith("/node.exe", StringComparison.OrdinalIgnoreCase) || e.FullName.EndsWith("/LICENSE", StringComparison.OrdinalIgnoreCase)))
            {
                var name = Path.GetFileName(entry.FullName);
                if (name is not ("node.exe" or "LICENSE")) continue;
                entry.ExtractToFile(Path.Combine(stage, name), true);
            }
            if (!File.Exists(Path.Combine(stage, "node.exe"))) throw new InvalidDataException("The Node.js archive did not contain node.exe.");
            var versions = Path.Combine(nodeDirectory, "versions"); Directory.CreateDirectory(versions);
            var installed = Path.Combine(versions, release.Version);
            if (Directory.Exists(installed)) Directory.Delete(installed, true);
            Directory.Move(stage, installed);
            await File.WriteAllTextAsync(Path.Combine(nodeDirectory, "latest-lts"), release.Version);
            return Path.Combine(installed, "node.exe");
        }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); File.Delete(archive); }
    }

    private sealed record FFmpegRelease(string Version, string ArchiveUrl, string HashUrl, string ArchiveName);
    private async Task<FFmpegRelease> LatestFFmpegRelease()
    {
        const string page = "https://www.gyan.dev/ffmpeg/builds/";
        using var response = await http.GetAsync(page);
        response.EnsureSuccessStatusCode();
        var html = await response.Content.ReadAsStringAsync();
        var match = Regex.Match(html, "href=[\\\"'](?<url>[^\\\"']*ffmpeg-release-essentials\\.zip)[\\\"']", RegexOptions.IgnoreCase);
        if (!match.Success) throw new InvalidOperationException("Could not find the latest FFmpeg Windows essentials build.");
        var archiveUrl = new Uri(new Uri(page), WebUtility.HtmlDecode(match.Groups["url"].Value)).ToString();
        var archiveName = Path.GetFileName(new Uri(archiveUrl).AbsolutePath);
        var verText = await http.GetStringAsync(archiveUrl + ".ver");
        var version = Regex.Replace(verText.Trim(), "[^A-Za-z0-9._-]", "");
        if (version.Length == 0) version = "latest-" + DateTime.UtcNow.ToString("yyyyMMdd");
        return new FFmpegRelease(version, archiveUrl, archiveUrl + ".sha256", archiveName);
    }

    private (string Path, string Version)? CachedFFmpeg(string? version)
    {
        version ??= ReadVersion(Path.Combine(ffmpegDirectory, "latest-release"));
        if (version is null || !Regex.IsMatch(version, "^[A-Za-z0-9._-]{1,80}$")) return null;
        var path = Path.Combine(ffmpegDirectory, "versions", version, "ffmpeg.exe");
        return File.Exists(path) ? (path, version) : null;
    }

    private async Task<string> DownloadFFmpeg(FFmpegRelease release)
    {
        SetStatus($"Downloading FFmpeg {release.Version}…", "Downloading the latest Windows essentials build and checking its SHA-256 checksum.");
        Directory.CreateDirectory(ffmpegDirectory);
        var archive = await Download(release.ArchiveUrl, $"FFmpeg {release.Version}");
        try
        {
            var hashText = await http.GetStringAsync(release.HashUrl);
            var hash = Regex.Match(hashText, "[0-9a-fA-F]{64}").Value;
            if (hash.Length != 64 || !await HashMatches(archive, hash)) throw new InvalidDataException("FFmpeg archive checksum verification failed.");
            SetStatus($"Installing FFmpeg {release.Version}…", "Extracting the verified ffmpeg.exe binary.");
            var stage = Path.Combine(ffmpegDirectory, ".install-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(stage);
            try
            {
                using var zip = ZipFile.OpenRead(archive);
                var entry = zip.Entries.FirstOrDefault(e => e.FullName.EndsWith("/bin/ffmpeg.exe", StringComparison.OrdinalIgnoreCase));
                if (entry is null) throw new InvalidDataException("The FFmpeg archive did not contain ffmpeg.exe.");
                entry.ExtractToFile(Path.Combine(stage, "ffmpeg.exe"), true);
                var versions = Path.Combine(ffmpegDirectory, "versions"); Directory.CreateDirectory(versions);
                var installed = Path.Combine(versions, release.Version);
                if (Directory.Exists(installed)) Directory.Delete(installed, true);
                Directory.Move(stage, installed);
                await File.WriteAllTextAsync(Path.Combine(ffmpegDirectory, "latest-release"), release.Version);
                return Path.Combine(installed, "ffmpeg.exe");
            }
            finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
        }
        finally { File.Delete(archive); }
    }

    private async Task<string> Download(string url, string label)
    {
        downloadLabel.Text = $"Downloading {label}…"; progress.Visible = true; progress.Style = ProgressBarStyle.Marquee;
        var path = Path.Combine(Path.GetTempPath(), "VideoDownloadest-" + Guid.NewGuid().ToString("N") + ".download");
        try
        {
            using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
            response.EnsureSuccessStatusCode();
            var total = response.Content.Headers.ContentLength;
            await using var input = await response.Content.ReadAsStreamAsync();
            await using var output = File.Create(path);
            var buffer = new byte[128 * 1024]; long readTotal = 0; int read;
            progress.Style = total.HasValue ? ProgressBarStyle.Continuous : ProgressBarStyle.Marquee;
            while ((read = await input.ReadAsync(buffer)) > 0)
            {
                await output.WriteAsync(buffer.AsMemory(0, read)); readTotal += read;
                if (total is > 0) progress.Value = (int)Math.Clamp(readTotal * 100 / total.Value, 0, 100);
            }
            downloadLabel.Text = ""; progress.Visible = false;
            return path;
        }
        catch { downloadLabel.Text = ""; progress.Visible = false; if (File.Exists(path)) File.Delete(path); throw; }
    }

    private static async Task<bool> HashMatches(string path, string expected)
    {
        await using var stream = File.OpenRead(path);
        var actual = Convert.ToHexString(await SHA256.HashDataAsync(stream));
        return CryptographicOperations.FixedTimeEquals(Convert.FromHexString(actual), Convert.FromHexString(expected));
    }

    private static string? ReadVersion(string path) => File.Exists(path) ? File.ReadAllText(path).Trim() : null;

    private void LaunchServer(string node, string ffmpeg)
    {
        var bundled = Path.Combine(AppContext.BaseDirectory, "Server");
        var root = File.Exists(Path.Combine(bundled, "server.js")) ? bundled : Directory.GetParent(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar))?.FullName ?? AppContext.BaseDirectory;
        var start = new ProcessStartInfo(node, $"\"{Path.Combine(root, "server.js")}\"")
        {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        start.Environment["PATH"] = Environment.GetFolderPath(Environment.SpecialFolder.System);
        start.Environment["VIDEO_DOWNLOADEST_DATA_DIR"] = dataDirectory;
        start.Environment["FFMPEG_PATH"] = ffmpeg;
        var log = new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
        var writer = new StreamWriter(log) { AutoFlush = true };
        var process = new Process { StartInfo = start, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) lock (writer) writer.WriteLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) lock (writer) writer.WriteLine(e.Data); };
        process.Exited += (_, _) => BeginInvoke(() => ServerExited(process, writer));
        try
        {
            process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine(); server = process;
            SetStatus("Starting local server…", $"Saving captures to {capturesDirectory}");
            _ = CheckHealthAsync(process);
        }
        catch (Exception ex) { writer.Dispose(); SetStatus("Server could not start", ex.Message + "\n\nOpen the server logs for details, then choose Start server to retry."); startButton.Visible = true; AppendLog(ex.ToString()); }
    }

    private async Task CheckHealthAsync(Process process)
    {
        for (var i = 0; i < 30 && !process.HasExited; i++)
        {
            try
            {
                using var response = await http.GetAsync("http://127.0.0.1:3000/health");
                if (response.IsSuccessStatusCode)
                {
                    using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
                    if (doc.RootElement.GetProperty("ok").GetBoolean())
                    {
                        BeginInvoke(() => SetStatus("Server is running", $"{launchNote ?? ""}{(launchNote is null ? "" : " ")}Keep this app open while capturing. Videos are saved in your Videos folder. Node.js {nodeVersion} and FFmpeg {ffmpegVersion} are managed by this app."));
                        return;
                    }
                }
            }
            catch { }
            await Task.Delay(1000);
        }
        if (!process.HasExited) BeginInvoke(() => SetStatus("Server is starting", "The local health check has not responded yet. See server logs if this continues."));
    }

    private void ServerExited(Process process, StreamWriter writer)
    {
        writer.Dispose();
        if (server == process) server = null;
        if (shuttingDown) return;
        var lines = File.Exists(logPath) ? File.ReadLines(logPath).TakeLast(6) : Enumerable.Empty<string>();
        var tail = string.Join(Environment.NewLine, lines);
        if (tail.Contains("EADDRINUSE", StringComparison.OrdinalIgnoreCase))
            SetStatus("Port 3000 is already in use", "Another server is using port 3000. Close it, then choose Start server again.\n\n" + tail);
        else
            SetStatus("The server stopped unexpectedly", string.IsNullOrWhiteSpace(tail) ? "Open the server logs for details, then choose Start server to retry." : tail + "\n\nOpen the server logs for more detail, then choose Start server to retry.");
        startButton.Visible = true;
    }

    private void StopServer()
    {
        shuttingDown = true;
        if (server is { HasExited: false }) { try { server.Kill(true); } catch { } }
        server?.Dispose(); server = null;
        http.Dispose();
    }

    private void OpenExtensionsPage()
    {
        var chrome = new[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe")
        }.FirstOrDefault(File.Exists);
        if (chrome is not null) Process.Start(new ProcessStartInfo(chrome, "chrome://extensions") { UseShellExecute = false });
        else Process.Start(new ProcessStartInfo("https://chrome.google.com/webstore/category/extensions") { UseShellExecute = true });
    }

    private static void ShellOpen(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path) ?? path);
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
    }

    private void SetStatus(string state, string detail)
    {
        if (InvokeRequired) { BeginInvoke(() => SetStatus(state, detail)); return; }
        stateLabel.Text = state; detailLabel.Text = detail;
    }

    private void AppendLog(string message)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
        File.AppendAllText(logPath, $"[{DateTimeOffset.Now:O}] {message}{Environment.NewLine}");
    }
}
