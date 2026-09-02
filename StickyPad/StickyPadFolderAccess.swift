import AppKit
import Foundation

@MainActor
enum StickyPadFolderAccess {
    private static let bookmarkKey = "StickyPad.libraryBookmark"
    private static var activeURL: URL?

    nonisolated static func expectedLibraryURL(
        homeURL: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        homeURL
            .appendingPathComponent("Documents", isDirectory: true)
            .appendingPathComponent("Sticky Pad", isDirectory: true)
    }

    nonisolated static func isExpectedLibraryURL(
        _ candidate: URL,
        homeURL: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> Bool {
        candidate.standardizedFileURL.resolvingSymlinksInPath().path ==
            expectedLibraryURL(homeURL: homeURL).standardizedFileURL.resolvingSymlinksInPath().path
    }

    static func resolveOrChoose() -> URL? {
        if let data = UserDefaults.standard.data(forKey: bookmarkKey) {
            var stale = false
            if let url = try? URL(
                resolvingBookmarkData: data,
                options: [.withSecurityScope],
                relativeTo: nil,
                bookmarkDataIsStale: &stale
            ), isExpectedLibraryURL(url), url.startAccessingSecurityScopedResource() {
                activeURL = url
                if stale { saveBookmark(for: url) }
                return url
            }
            UserDefaults.standard.removeObject(forKey: bookmarkKey)
        }

        let expectedURL = expectedLibraryURL()
        try? FileManager.default.createDirectory(at: expectedURL, withIntermediateDirectories: true)

        while true {
            let panel = NSOpenPanel()
            panel.title = "Allow Access to the Sticky Pad Folder"
            panel.message = "Select exactly Documents/Sticky Pad so the app, ChatGPT, Codex, and Hermes all use the same project library."
            panel.prompt = "Use Sticky Pad Folder"
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            panel.canCreateDirectories = true
            panel.directoryURL = expectedURL
            guard panel.runModal() == .OK, let url = panel.url else { return nil }
            guard isExpectedLibraryURL(url) else {
                let alert = NSAlert()
                alert.alertStyle = .warning
                alert.messageText = "Choose Documents/Sticky Pad"
                alert.informativeText = "A different folder would disconnect the native app from the Sticky Pad MCP."
                alert.runModal()
                continue
            }
            _ = url.startAccessingSecurityScopedResource()
            activeURL = url
            saveBookmark(for: url)
            return url
        }
    }

    private static func saveBookmark(for url: URL) {
        guard let data = try? url.bookmarkData(
            options: [.withSecurityScope],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        ) else { return }
        UserDefaults.standard.set(data, forKey: bookmarkKey)
    }
}
