import Foundation
import OSLog

@MainActor
final class HermesStatusMonitor {
    nonisolated private static let logger = Logger(subsystem: "com.richardholguin.StickyPad", category: "HermesStatus")
    private var timer: Timer?
    private var syncInProgress = false
    private var configurationWarningEmitted = false

    func start() {
        syncNow()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.syncNow() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func syncNow() {
        guard !syncInProgress else { return }
        guard let nodeURL = Self.nodeURL else {
            reportConfigurationWarning("Node.js 20 or newer was not found; Hermes delivery status cannot refresh.")
            return
        }
        guard FileManager.default.isExecutableFile(atPath: Self.workerURL.path) else {
            reportConfigurationWarning("The Hermes status worker is not installed. Run the Hermes bridge installer.")
            return
        }
        configurationWarningEmitted = false
        syncInProgress = true
        Task.detached(priority: .utility) {
            let process = Process()
            process.executableURL = nodeURL
            process.arguments = [Self.workerURL.path, "--once"]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                process.waitUntilExit()
                if process.terminationStatus != 0 {
                    Self.logger.error("Hermes status refresh failed with exit status \(process.terminationStatus)")
                }
            } catch {
                Self.logger.error("Hermes status refresh could not start: \(error.localizedDescription, privacy: .public)")
            }
            await MainActor.run { [weak self] in self?.syncInProgress = false }
        }
    }

    private func reportConfigurationWarning(_ message: String) {
        guard !configurationWarningEmitted else { return }
        configurationWarningEmitted = true
        Self.logger.notice("\(message, privacy: .public)")
    }

    nonisolated private static var workerURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Sticky Pad/MCP/status-sync.mjs")
    }

    nonisolated private static var nodeURL: URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let candidates = [
            home.appendingPathComponent(".local/bin/node"),
            URL(fileURLWithPath: "/opt/homebrew/bin/node"),
            URL(fileURLWithPath: "/opt/homebrew/opt/node@20/bin/node"),
            URL(fileURLWithPath: "/opt/homebrew/opt/node/bin/node"),
            URL(fileURLWithPath: "/usr/local/bin/node"),
            URL(fileURLWithPath: "/usr/local/opt/node@20/bin/node"),
            URL(fileURLWithPath: "/usr/local/opt/node/bin/node"),
            URL(fileURLWithPath: "/usr/bin/node")
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0.path) }
    }
}
