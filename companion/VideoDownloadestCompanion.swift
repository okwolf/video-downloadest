import AppKit
import CryptoKit
import SwiftUI

@MainActor
final class CompanionModel: ObservableObject {
    @Published var serverState = "Starting local server…"
    @Published var serverIsRunning = false
    @Published var detail = "The server accepts connections only from this Mac."
    @Published var startupFailed = false
    @Published var isPreparing = false
    @Published var downloadLabel: String?
    @Published var downloadProgress: Double?

    private var process: Process?
    private var healthTimer: Timer?
    private var logHandle: FileHandle?
    private var stoppingIntentionally = false
    private var launchNote: String?
    private var nodeVersion = ""
    private var ffmpegVersion = ""
    private let networkSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 300
        return URLSession(configuration: configuration)
    }()

    let extensionDirectory: URL
    let capturesDirectory: URL
    private let dataDirectory: URL
    private let runtimeDirectory: URL
    private let ffmpegRuntimeDirectory: URL
    let logURL: URL

    init() {
        let resources = Bundle.main.resourceURL
        let bundledExtension = resources?.appendingPathComponent("Extension", isDirectory: true)
        let developmentRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let home = FileManager.default.homeDirectoryForCurrentUser
        dataDirectory = home.appendingPathComponent("Videos/Video Downloadest", isDirectory: true)
        capturesDirectory = dataDirectory.appendingPathComponent("completed", isDirectory: true)
        try? FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let appSupport = support.appendingPathComponent("Video Downloadest", isDirectory: true)
        runtimeDirectory = appSupport.appendingPathComponent("Node", isDirectory: true)
        ffmpegRuntimeDirectory = appSupport.appendingPathComponent("FFmpeg", isDirectory: true)
        let installedExtension = appSupport.appendingPathComponent("Extension", isDirectory: true)
        if let bundledExtension, FileManager.default.fileExists(atPath: bundledExtension.appendingPathComponent("manifest.json").path) {
            do {
                try FileManager.default.createDirectory(at: installedExtension, withIntermediateDirectories: true)
                let sources = try FileManager.default.contentsOfDirectory(at: bundledExtension, includingPropertiesForKeys: nil)
                let currentNames = Set(sources.map(\.lastPathComponent))
                for existing in try FileManager.default.contentsOfDirectory(at: installedExtension, includingPropertiesForKeys: nil)
                    where !currentNames.contains(existing.lastPathComponent) {
                    try FileManager.default.removeItem(at: existing)
                }
                for source in sources {
                    let destination = installedExtension.appendingPathComponent(source.lastPathComponent)
                    if FileManager.default.fileExists(atPath: destination.path) {
                        if (try? Data(contentsOf: source)) == (try? Data(contentsOf: destination)) { continue }
                        try FileManager.default.removeItem(at: destination)
                    }
                    try FileManager.default.copyItem(at: source, to: destination)
                }
                extensionDirectory = installedExtension
            } catch {
                extensionDirectory = bundledExtension
            }
        } else {
            extensionDirectory = developmentRoot
        }
        let logDirectory = home.appendingPathComponent("Library/Logs/Video Downloadest", isDirectory: true)
        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        logURL = logDirectory.appendingPathComponent("server.log")
        startServer()
    }

    func startServer() {
        guard process == nil, !isPreparing else { return }
        startupFailed = false
        stoppingIntentionally = false
        isPreparing = true
        serverIsRunning = false
        serverState = "Checking for the latest Node.js LTS…"
        detail = "Connecting to the official Node.js release service."
        Task { await prepareRuntimeAndStartServer() }
    }

    private func prepareRuntimeAndStartServer() async {
        do {
            let node: URL
            do {
                serverState = "Checking for the latest Node.js LTS…"
                let release = try await latestLTSRelease()
                if let cached = cachedNode(version: release.version) {
                    node = cached.url
                } else {
                    node = try await downloadNode(release)
                }
                nodeVersion = release.version
            } catch {
                appendLog("Node.js LTS update check failed: \(error.localizedDescription)")
                guard let cached = cachedNode() else { throw error }
                node = cached.url
                nodeVersion = cached.version
                launchNote = "Could not check for a Node.js update. Using cached \(cached.version)."
            }

            let ffmpeg: URL
            do {
                serverState = "Checking for the latest FFmpeg release…"
                let release = try await latestFFmpegRelease()
                defer {
                    if let prefetchedArchive = release.prefetchedArchive {
                        try? FileManager.default.removeItem(at: prefetchedArchive)
                    }
                }
                if let cached = cachedFFmpeg(version: release.version) {
                    ffmpeg = cached.url
                } else {
                    ffmpeg = try await downloadFFmpeg(release)
                }
                ffmpegVersion = release.version
            } catch {
                appendLog("FFmpeg update check failed: \(error.localizedDescription)")
                guard let cached = cachedFFmpeg() else { throw error }
                ffmpeg = cached.url
                ffmpegVersion = cached.version
                let note = "Could not check for an FFmpeg update. Using cached \(cached.version)."
                launchNote = [launchNote, note].compactMap { $0 }.joined(separator: " ")
            }
            launchServer(using: node, ffmpeg: ffmpeg)
        } catch {
            appendLog("Runtime setup failed: \(error.localizedDescription)")
            isPreparing = false
            startupFailed = true
            serverState = "Could not prepare Node.js or FFmpeg"
            detail = "\(error.localizedDescription)\n\nCheck your internet connection, then choose Start server to retry. Open the logs for details."
        }
    }

    private func latestLTSRelease() async throws -> (version: String, archiveName: String) {
        let indexURL = URL(string: "https://nodejs.org/dist/index.json")!
        let (data, response) = try await networkSession.data(from: indexURL)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw CompanionError.download("Node.js release list returned an unsuccessful response.")
        }
        guard let releases = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              let release = releases.first(where: {
                  ($0["lts"] as? String) != nil && (($0["files"] as? [String])?.contains("osx-arm64-tar") == true)
              }),
              let version = release["version"] as? String,
              version.range(of: #"^v\d+\.\d+\.\d+$"#, options: .regularExpression) != nil else {
            throw CompanionError.download("Could not find an Apple Silicon Node.js LTS release.")
        }
        return (version, "node-\(version)-darwin-arm64.tar.xz")
    }

    private func cachedNode(version: String? = nil) -> (url: URL, version: String)? {
        let version = version ?? (try? String(contentsOf: runtimeDirectory.appendingPathComponent("latest-lts"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let version, version.range(of: #"^v\d+\.\d+\.\d+$"#, options: .regularExpression) != nil else { return nil }
        let url = runtimeDirectory.appendingPathComponent("versions/\(version)/bin/node")
        guard FileManager.default.isExecutableFile(atPath: url.path) else { return nil }
        return (url, version)
    }

    private func cachedFFmpeg(version: String? = nil) -> (url: URL, version: String)? {
        let version = version ?? (try? String(contentsOf: ffmpegRuntimeDirectory.appendingPathComponent("latest-release"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let version, version.range(of: #"^[A-Za-z0-9._-]{1,80}$"#, options: .regularExpression) != nil else { return nil }
        let url = ffmpegRuntimeDirectory.appendingPathComponent("versions/\(version)/ffmpeg")
        guard FileManager.default.isExecutableFile(atPath: url.path) else { return nil }
        return (url, version)
    }

    private func latestFFmpegRelease() async throws -> FFmpegRelease {
        let redirect = URL(string: "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip")!
        var request = URLRequest(url: redirect, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = "HEAD"
        do {
            let (_, response) = try await networkSession.data(for: request)
            if let http = response as? HTTPURLResponse,
               (200..<300).contains(http.statusCode),
               let finalURL = http.url,
               let release = parseFFmpegReleaseURL(finalURL) {
                return release
            }
            let http = response as? HTTPURLResponse
            appendLog("FFmpeg release HEAD lookup returned HTTP \(http?.statusCode ?? -1) at \(response.url?.absoluteString ?? "unknown URL"); retrying with a ranged GET.")
        } catch {
            appendLog("FFmpeg release HEAD lookup failed (\(error.localizedDescription)); retrying with a ranged GET.")
        }

        var rangeRequest = URLRequest(url: redirect, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 120)
        rangeRequest.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        let (partialDownload, response) = try await downloadFile(request: rangeRequest, label: "FFmpeg release check")
        endDownload()
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              let finalURL = response.url,
              let release = parseFFmpegReleaseURL(finalURL) else {
            let http = response as? HTTPURLResponse
            throw CompanionError.download("Could not resolve the latest Apple Silicon FFmpeg release (HTTP \(http?.statusCode ?? -1), \(response.url?.absoluteString ?? "unknown URL")).")
        }
        if http.statusCode == 206 {
            try? FileManager.default.removeItem(at: partialDownload)
        } else {
            appendLog("FFmpeg server ignored the one-byte range request; retaining the fetched archive for installation.")
            return FFmpegRelease(version: release.version, archiveURL: release.archiveURL, prefetchedArchive: partialDownload)
        }
        return release
    }

    private func parseFFmpegReleaseURL(_ url: URL) -> FFmpegRelease? {
        guard url.host == "ffmpeg.martin-riedl.de" else { return nil }
        let components = url.pathComponents
        guard components.count >= 6,
              components[1] == "download", components[2] == "macos", components[3] == "arm64",
              components.last == "ffmpeg.zip",
              let buildID = components.dropLast().last,
              let version = buildID.split(separator: "_").last.map(String.init),
              version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil else {
            return nil
        }
        return FFmpegRelease(version: version, archiveURL: url, prefetchedArchive: nil)
    }

    private func downloadNode(_ release: (version: String, archiveName: String)) async throws -> URL {
        serverState = "Downloading Node.js \(release.version) LTS…"
        detail = "Downloading the official Apple Silicon runtime and checking its SHA-256 checksum. This may take a minute."
        try FileManager.default.createDirectory(at: runtimeDirectory, withIntermediateDirectories: true)
        let archiveURL = URL(string: "https://nodejs.org/dist/\(release.version)/\(release.archiveName)")!
        let checksumURL = URL(string: "https://nodejs.org/dist/\(release.version)/SHASUMS256.txt")!

        let (downloadURL, downloadResponse) = try await downloadFile(from: archiveURL, label: "Node.js \(release.version) LTS")
        endDownload()
        guard let downloadHTTP = downloadResponse as? HTTPURLResponse, (200..<300).contains(downloadHTTP.statusCode) else {
            throw CompanionError.download("Node.js archive download returned an unsuccessful response.")
        }
        let storedArchive = runtimeDirectory.appendingPathComponent(".\(UUID().uuidString)-\(release.archiveName)")
        try FileManager.default.copyItem(at: downloadURL, to: storedArchive)
        defer { try? FileManager.default.removeItem(at: storedArchive) }

        let (checksumData, checksumResponse) = try await networkSession.data(from: checksumURL)
        guard let checksumHTTP = checksumResponse as? HTTPURLResponse, (200..<300).contains(checksumHTTP.statusCode) else {
            throw CompanionError.download("Could not download the official Node.js checksums.")
        }
        let checksumText = String(decoding: checksumData, as: UTF8.self)
        guard let checksumLine = checksumText.split(whereSeparator: \.isNewline).first(where: { $0.hasSuffix("  \(release.archiveName)") }),
              let expected = checksumLine.split(whereSeparator: { $0 == " " || $0 == "\t" }).first else {
            throw CompanionError.download("The official checksum list does not contain the downloaded archive.")
        }
        let archiveData = try Data(contentsOf: storedArchive, options: .mappedIfSafe)
        let actual = SHA256.hash(data: archiveData).map { String(format: "%02x", $0) }.joined()
        guard actual.caseInsensitiveCompare(String(expected)) == .orderedSame else {
            throw CompanionError.download("Node.js archive checksum verification failed.")
        }

        serverState = "Installing Node.js \(release.version)…"
        let staging = runtimeDirectory.appendingPathComponent(".install-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        do {
            let extraction = Process()
            extraction.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
            extraction.arguments = ["-xJf", storedArchive.path, "-C", staging.path, "--strip-components", "1",
                                    "node-\(release.version)-darwin-arm64/bin/node",
                                    "node-\(release.version)-darwin-arm64/LICENSE"]
            let errors = Pipe()
            extraction.standardError = errors
            try extraction.run()
            extraction.waitUntilExit()
            guard extraction.terminationStatus == 0 else {
                let message = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                throw CompanionError.download("Could not extract the Node.js runtime. \(message)")
            }
            let node = staging.appendingPathComponent("bin/node")
            guard FileManager.default.isExecutableFile(atPath: node.path) else {
                throw CompanionError.download("The Node.js archive did not contain an executable runtime.")
            }
            let versions = runtimeDirectory.appendingPathComponent("versions", isDirectory: true)
            try FileManager.default.createDirectory(at: versions, withIntermediateDirectories: true)
            let installed = versions.appendingPathComponent(release.version, isDirectory: true)
            try FileManager.default.moveItem(at: staging, to: installed)
            try Data(release.version.utf8).write(to: runtimeDirectory.appendingPathComponent("latest-lts"), options: .atomic)
            return installed.appendingPathComponent("bin/node")
        } catch {
            try? FileManager.default.removeItem(at: staging)
            throw error
        }
    }

    private func downloadFFmpeg(_ release: FFmpegRelease) async throws -> URL {
        serverState = "Downloading FFmpeg \(release.version)…"
        detail = "Downloading the latest stable Apple Silicon build and checking its SHA-256 checksum."
        try FileManager.default.createDirectory(at: ffmpegRuntimeDirectory, withIntermediateDirectories: true)

        let storedArchive = ffmpegRuntimeDirectory.appendingPathComponent(".\(UUID().uuidString)-ffmpeg.zip")
        defer { try? FileManager.default.removeItem(at: storedArchive) }
        if let prefetchedArchive = release.prefetchedArchive {
            try FileManager.default.copyItem(at: prefetchedArchive, to: storedArchive)
        } else {
            let (downloadURL, downloadResponse) = try await downloadFile(from: release.archiveURL, label: "FFmpeg \(release.version)")
            endDownload()
            guard let http = downloadResponse as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  downloadResponse.url?.host == "ffmpeg.martin-riedl.de" else {
                throw CompanionError.download("The FFmpeg archive download returned an unsuccessful response.")
            }
            try FileManager.default.copyItem(at: downloadURL, to: storedArchive)
        }

        let checksumURL = release.archiveURL.appendingPathExtension("sha256")
        let (checksumData, checksumResponse) = try await networkSession.data(from: checksumURL)
        guard let checksumHTTP = checksumResponse as? HTTPURLResponse, (200..<300).contains(checksumHTTP.statusCode) else {
            throw CompanionError.download("Could not download the FFmpeg build's SHA-256 checksum.")
        }
        let checksumText = String(decoding: checksumData, as: UTF8.self)
        let expression = try NSRegularExpression(pattern: #"[0-9a-fA-F]{64}"#)
        let checksumRange = NSRange(checksumText.startIndex..<checksumText.endIndex, in: checksumText)
        guard let match = expression.firstMatch(in: checksumText, range: checksumRange),
              let range = Range(match.range, in: checksumText) else {
            throw CompanionError.download("The FFmpeg checksum file did not contain a SHA-256 hash.")
        }
        let expected = String(checksumText[range])
        let archiveData = try Data(contentsOf: storedArchive, options: .mappedIfSafe)
        let actual = SHA256.hash(data: archiveData).map { String(format: "%02x", $0) }.joined()
        guard actual.caseInsensitiveCompare(expected) == .orderedSame else {
            throw CompanionError.download("FFmpeg archive checksum verification failed.")
        }

        serverState = "Installing FFmpeg \(release.version)…"
        let (listStatus, listData, listError) = try runCommand("/usr/bin/unzip", ["-Z1", storedArchive.path])
        guard listStatus == 0 else {
            throw CompanionError.download("Could not inspect the FFmpeg archive. \(String(decoding: listError, as: UTF8.self))")
        }
        let entries = String(decoding: listData, as: UTF8.self).split(whereSeparator: \.isNewline).map(String.init)
        guard let binaryEntry = entries.first(where: {
            let path = URL(fileURLWithPath: $0)
            return path.lastPathComponent == "ffmpeg" && !$0.hasPrefix("/") && !path.pathComponents.contains("..")
        }) else {
            throw CompanionError.download("The FFmpeg archive did not contain an ffmpeg executable.")
        }

        let staging = ffmpegRuntimeDirectory.appendingPathComponent(".install-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        do {
            let binary = staging.appendingPathComponent("ffmpeg")
            guard FileManager.default.createFile(atPath: binary.path, contents: nil),
                  let output = try? FileHandle(forWritingTo: binary) else {
                throw CompanionError.download("Could not create the FFmpeg executable file.")
            }
            let extraction = Process()
            extraction.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
            extraction.arguments = ["-p", storedArchive.path, binaryEntry]
            let errors = Pipe()
            extraction.standardOutput = output
            extraction.standardError = errors
            try extraction.run()
            extraction.waitUntilExit()
            try? output.close()
            guard extraction.terminationStatus == 0 else {
                let message = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                throw CompanionError.download("Could not extract FFmpeg. \(message)")
            }
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
            let (versionStatus, _, versionError) = try runCommand(binary.path, ["-version"])
            guard versionStatus == 0 else {
                throw CompanionError.download("The downloaded FFmpeg binary could not run. \(String(decoding: versionError, as: UTF8.self))")
            }
            let versions = ffmpegRuntimeDirectory.appendingPathComponent("versions", isDirectory: true)
            try FileManager.default.createDirectory(at: versions, withIntermediateDirectories: true)
            let installed = versions.appendingPathComponent(release.version, isDirectory: true)
            try FileManager.default.moveItem(at: staging, to: installed)
            try Data(release.version.utf8).write(to: ffmpegRuntimeDirectory.appendingPathComponent("latest-release"), options: .atomic)
            return installed.appendingPathComponent("ffmpeg")
        } catch {
            try? FileManager.default.removeItem(at: staging)
            throw error
        }
    }

    private func downloadFile(from url: URL, label: String) async throws -> (URL, URLResponse) {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 300)
        request.httpMethod = "GET"
        return try await downloadFile(request: request, label: label)
    }

    private func downloadFile(request: URLRequest, label: String) async throws -> (URL, URLResponse) {
        downloadLabel = label
        downloadProgress = 0
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent("VideoDownloadest-\(UUID().uuidString).download")
        let delegate = ProgressDownloadDelegate(destination: destination)
        delegate.progress = { [weak self] written, expected in
            Task { @MainActor in
                guard let self, self.downloadLabel != nil else { return }
                self.downloadProgress = expected > 0 ? min(1, Double(written) / Double(expected)) : nil
            }
        }
        do {
            return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<(URL, URLResponse), Error>) in
                delegate.completion = { result in continuation.resume(with: result) }
                let configuration = URLSessionConfiguration.default
                configuration.timeoutIntervalForRequest = 20
                configuration.timeoutIntervalForResource = 300
                let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
                delegate.session = session
                session.downloadTask(with: request).resume()
            }
        } catch {
            endDownload()
            throw error
        }
    }

    private func endDownload() {
        downloadLabel = nil
        downloadProgress = nil
    }

    private func runCommand(_ executable: String, _ arguments: [String]) throws -> (Int32, Data, Data) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: executable)
        task.arguments = arguments
        let output = Pipe()
        let errors = Pipe()
        task.standardOutput = output
        task.standardError = errors
        try task.run()
        task.waitUntilExit()
        return (task.terminationStatus,
                output.fileHandleForReading.readDataToEndOfFile(),
                errors.fileHandleForReading.readDataToEndOfFile())
    }

    private func launchServer(using node: URL, ffmpeg: URL) {
        let resources = Bundle.main.resourceURL
        let bundledServer = resources?.appendingPathComponent("Server/server.js")
        let developmentRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let serverRoot = (bundledServer.map { FileManager.default.fileExists(atPath: $0.path) } == true)
            ? resources!.appendingPathComponent("Server", isDirectory: true)
            : developmentRoot
        let serverScript = serverRoot.appendingPathComponent("server.js")

        let task = Process()
        task.executableURL = node
        task.arguments = [serverScript.path]
        task.currentDirectoryURL = serverRoot
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        environment["VIDEO_DOWNLOADEST_DATA_DIR"] = dataDirectory.path
        environment["FFMPEG_PATH"] = ffmpeg.path
        task.environment = environment
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        if let handle = try? FileHandle(forWritingTo: logURL) {
            handle.seekToEndOfFile()
            task.standardOutput = handle
            task.standardError = handle
            logHandle = handle
        }
        task.terminationHandler = { [weak self] terminatedTask in
            Task { @MainActor in
                guard let self else { return }
                let failed = !self.stoppingIntentionally
                self.logHandle?.synchronizeFile()
                try? self.logHandle?.close()
                self.logHandle = nil
                self.process = nil
                self.serverIsRunning = false
                self.isPreparing = false
                self.healthTimer?.invalidate()
                self.healthTimer = nil
                if failed {
                    let logText = (try? String(contentsOf: self.logURL, encoding: .utf8)) ?? ""
                    let lastLines = logText.split(separator: "\n").suffix(6).joined(separator: "\n")
                    self.startupFailed = true
                    if logText.localizedCaseInsensitiveContains("EADDRINUSE") {
                        self.serverState = "Port 3000 is already in use"
                        self.detail = "Another server is using port 3000. Quit it, then choose Start server again.\n\n\(lastLines)"
                    } else {
                        self.serverState = "The server stopped unexpectedly (exit \(terminatedTask.terminationStatus))"
                        self.detail = lastLines.isEmpty
                            ? "Open the server logs for details, then choose Start server to retry."
                            : "\(lastLines)\n\nOpen the server logs for more detail, then choose Start server to retry."
                    }
                } else {
                    self.serverState = "Server stopped"
                    self.detail = "Choose Start server when you are ready to capture again."
                }
            }
        }
        do {
            try task.run()
            process = task
            isPreparing = false
            serverState = "Starting local server…"
            detail = "Saving captures to \(capturesDirectory.path)"
            healthTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.checkHealth() }
            }
            checkHealth()
        } catch {
            isPreparing = false
            startupFailed = true
            serverState = "Server could not start"
            detail = "\(error.localizedDescription)\n\nOpen the server logs for details, then choose Start server to retry."
            appendLog("Capture server failed to launch: \(error.localizedDescription)")
        }
    }

    func checkHealth() {
        guard process?.isRunning == true, !serverIsRunning else { return }
        guard let url = URL(string: "http://127.0.0.1:3000/health") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data, (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["ok"] as? Bool == true else { return }
            Task { @MainActor in
                guard self?.process?.isRunning == true else { return }
                let note = self?.launchNote ?? ""
                let nodeVersion = self?.nodeVersion ?? ""
                self?.serverIsRunning = true
                self?.startupFailed = false
                self?.serverState = "Server is running"
                let ffmpegVersion = self?.ffmpegVersion ?? ""
                self?.detail = "\(note.isEmpty ? "" : note + " ")Keep this app open while capturing. Videos are saved in your Videos folder. Node.js \(nodeVersion) and FFmpeg \(ffmpegVersion) are managed by this app."
                self?.healthTimer?.invalidate()
                self?.healthTimer = nil
            }
        }.resume()
    }

    func openExtensionsPage() {
        let opener = Process()
        opener.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        opener.arguments = ["-a", "Google Chrome", "chrome://extensions"]
        try? opener.run()
    }

    func revealExtensionFolder() {
        if !NSWorkspace.shared.open(extensionDirectory) {
            NSWorkspace.shared.selectFile(extensionDirectory.path,
                                          inFileViewerRootedAtPath: extensionDirectory.deletingLastPathComponent().path)
        }
    }

    func copyExtensionPath() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(extensionDirectory.path, forType: .string)
    }

    func openCapturesFolder() {
        NSWorkspace.shared.open(capturesDirectory)
    }

    func openLogs() {
        NSWorkspace.shared.open(logURL)
    }

    private func appendLog(_ message: String) {
        let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        if let handle = try? FileHandle(forWritingTo: logURL) {
            handle.seekToEndOfFile()
            try? handle.write(contentsOf: data)
            try? handle.close()
        }
    }

    func quit() {
        stoppingIntentionally = true
        healthTimer?.invalidate()
        process?.terminate()
        process = nil
        try? logHandle?.close()
    }
}

enum CompanionError: LocalizedError {
    case download(String)
    var errorDescription: String? {
        if case let .download(message) = self { return message }
        return nil
    }
}

private struct FFmpegRelease {
    let version: String
    let archiveURL: URL
    let prefetchedArchive: URL?
}

private final class ProgressDownloadDelegate: NSObject, URLSessionDownloadDelegate {
    let destination: URL
    var progress: ((Int64, Int64) -> Void)?
    var completion: ((Result<(URL, URLResponse), Error>) -> Void)?
    var session: URLSession?

    private var downloadedFile: URL?
    private var response: URLResponse?
    private var fileError: Error?

    init(destination: URL) {
        self.destination = destination
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        progress?(totalBytesWritten, totalBytesExpectedToWrite)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        response = downloadTask.response
        do {
            try FileManager.default.moveItem(at: location, to: destination)
            downloadedFile = destination
        } catch {
            fileError = error
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error {
            completion?(.failure(error))
        } else if let fileError {
            completion?(.failure(fileError))
        } else if let downloadedFile, let response {
            completion?(.success((downloadedFile, response)))
        } else {
            completion?(.failure(CompanionError.download("The download finished without a response file.")))
        }
        completion = nil
        progress = nil
        session.finishTasksAndInvalidate()
    }

    func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        self.session = nil
    }
}

struct CompanionView: View {
    @ObservedObject var model: CompanionModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 14) {
                Image(systemName: model.startupFailed ? "exclamationmark.triangle.fill" : (model.serverIsRunning ? "checkmark.circle.fill" : "arrow.triangle.2.circlepath"))
                    .font(.system(size: 30))
                    .foregroundStyle(model.startupFailed ? .red : (model.serverIsRunning ? .green : .orange))
                VStack(alignment: .leading, spacing: 4) {
                    Text("Video Downloadest").font(.title2.bold())
                    Text(model.serverState).font(.headline)
                }
                Spacer()
            }
            Text(model.detail).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let downloadLabel = model.downloadLabel {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Downloading \(downloadLabel)").font(.subheadline)
                        Spacer()
                        if let progress = model.downloadProgress {
                            Text("\(Int(progress * 100))%")
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                    if let progress = model.downloadProgress {
                        ProgressView(value: progress)
                    } else {
                        ProgressView()
                    }
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                Text("Add the extension to Chrome").font(.headline)
                Label("Copy the extension path with the button below.", systemImage: "1.circle.fill")
                Label("Open chrome://extensions in Chrome and turn on Developer mode.", systemImage: "2.circle.fill")
                Label("Choose Load unpacked. In the picker, press / and paste the copied path.", systemImage: "3.circle.fill")
                Label("Press Return, then choose Select.", systemImage: "4.circle.fill")
                Text(model.extensionDirectory.path)
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                HStack {
                    Button("Open Chrome extensions") { model.openExtensionsPage() }
                    Button("Show extension folder") { model.revealExtensionFolder() }
                    Button("Copy folder path") { model.copyExtensionPath() }
                }
                Text("Chrome asks you to approve this local extension. This app does not change browser settings for you.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Saved videos").font(.headline)
                    Text(model.capturesDirectory.path).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Open folder") { model.openCapturesFolder() }
            }
            Text("Node.js and FFmpeg are downloaded and updated by this app.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Open server logs") { model.openLogs() }
                if model.startupFailed || (!model.serverIsRunning && !model.isPreparing) {
                    Button("Start server") { model.startServer() }
                }
            }
            if model.isPreparing {
                ProgressView().controlSize(.small)
            }
            if !model.serverIsRunning && !model.isPreparing {
                Text("An internet connection is needed to download or update the runtimes.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(24)
        .frame(width: 560, height: 560)
    }
}

@main
struct VideoDownloadestCompanionApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model: CompanionModel

    init() {
        let model = CompanionModel()
        _model = StateObject(wrappedValue: model)
        AppDelegate.model = model
    }

    var body: some Scene {
        WindowGroup {
            CompanionView(model: model)
        }
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    static var model: CompanionModel?
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
    }
    func applicationWillTerminate(_ notification: Notification) { Self.model?.quit() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
