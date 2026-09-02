import AppKit
import Foundation

struct TrashedProjectFiles {
    let projectURL: URL
    let receiptURL: URL?
}

@MainActor
final class ProjectStore: ObservableObject {
    @Published private(set) var projects: [TaskProject] = []
    @Published private(set) var lastError: String?
    var onOpenRequest: ((URL) -> Void)?

    let baseURL: URL
    let projectsURL: URL
    let notesURL: URL
    let templatesURL: URL
    let openRequestsURL: URL
    let deliveryReceiptsURL: URL
    var templateURL: URL { templatesURL.appendingPathComponent(TaskTemplate.fileName) }
    private var refreshTimer: Timer?

    init(baseURL: URL? = nil, startsMonitoring: Bool = true) {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        self.baseURL = baseURL ?? documents.appendingPathComponent("Sticky Pad", isDirectory: true)
        self.projectsURL = self.baseURL.appendingPathComponent("Projects", isDirectory: true)
        self.notesURL = self.baseURL.appendingPathComponent("Notes", isDirectory: true)
        self.templatesURL = self.baseURL.appendingPathComponent("Templates", isDirectory: true)
        self.openRequestsURL = self.baseURL.appendingPathComponent("Open Requests", isDirectory: true)
        self.deliveryReceiptsURL = self.baseURL.appendingPathComponent("Delivery Receipts", isDirectory: true)
        prepareFolders()
        reload()
        if startsMonitoring {
            refreshTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.reload() }
            }
        }
    }

    func prepareFolders() {
        do {
            try FileManager.default.createDirectory(at: projectsURL, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: notesURL, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: templatesURL, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: openRequestsURL, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: deliveryReceiptsURL, withIntermediateDirectories: true)
            let templateURL = self.templateURL
            let legacyTemplateURL = templatesURL.appendingPathComponent(TaskTemplate.legacyFileName)
            if FileManager.default.fileExists(atPath: legacyTemplateURL.path),
               !FileManager.default.fileExists(atPath: templateURL.path) {
                try FileManager.default.moveItem(at: legacyTemplateURL, to: templateURL)
            }
            if !FileManager.default.fileExists(atPath: templateURL.path) {
                try TaskTemplate.content.write(to: templateURL, atomically: true, encoding: .utf8)
            }
            lastError = nil
        } catch {
            lastError = "Could not prepare Sticky Pad folders: \(error.localizedDescription)"
        }
    }

    func reload() {
        do {
            let keys: Set<URLResourceKey> = [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey]
            let urls = try FileManager.default.contentsOfDirectory(
                at: projectsURL,
                includingPropertiesForKeys: Array(keys),
                options: [.skipsHiddenFiles]
            )
            projects = urls.compactMap { url in
                guard url.pathExtension.lowercased() == "md",
                      let values = try? url.resourceValues(forKeys: keys),
                      values.isRegularFile == true,
                      values.isSymbolicLink != true,
                      let fileSize = values.fileSize,
                      fileSize <= StickyPadFileIO.maximumNoteBytes,
                      let markdown = try? StickyPadFileIO.readUTF8(from: url) else { return nil }
                return TaskProject(
                    url: url,
                    title: TaskProject.title(from: markdown, fallback: url.deletingPathExtension().lastPathComponent),
                    modifiedAt: values.contentModificationDate ?? .distantPast
                )
            }
            .sorted { $0.modifiedAt > $1.modifiedAt }
            lastError = nil
            processOpenRequests()
        } catch {
            projects = []
            lastError = "Could not read projects: \(error.localizedDescription)"
        }
    }

    func processOpenRequests() {
        guard let onOpenRequest else { return }
        do {
            let requestURLs = try FileManager.default.contentsOfDirectory(
                at: openRequestsURL,
                includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey],
                options: [.skipsHiddenFiles]
            )
            .filter { $0.pathExtension.lowercased() == "request" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }

            for requestURL in requestURLs {
                let values = try requestURL.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
                guard values.isRegularFile == true,
                      values.isSymbolicLink != true,
                      let fileSize = values.fileSize,
                      fileSize <= StickyPadFileIO.maximumRequestBytes else {
                    try? FileManager.default.removeItem(at: requestURL)
                    continue
                }
                let filename = try StickyPadFileIO.readUTF8(
                    from: requestURL,
                    maximumBytes: StickyPadFileIO.maximumRequestBytes
                )
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let projectURL = projectsURL.appendingPathComponent(filename).standardizedFileURL
                guard filename == URL(fileURLWithPath: filename).lastPathComponent,
                      projectURL.deletingLastPathComponent() == projectsURL.standardizedFileURL,
                      projectURL.pathExtension.lowercased() == "md",
                      FileManager.default.fileExists(atPath: projectURL.path) else {
                    try? FileManager.default.removeItem(at: requestURL)
                    continue
                }
                let projectValues = try projectURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                guard projectValues.isRegularFile == true, projectValues.isSymbolicLink != true else {
                    try? FileManager.default.removeItem(at: requestURL)
                    continue
                }
                try FileManager.default.removeItem(at: requestURL)
                onOpenRequest(projectURL)
            }
        } catch {
            lastError = "Could not process a Sticky Pad open request: \(error.localizedDescription)"
        }
    }

    @discardableResult
    func createBlankProject(title: String = "Untitled Hermes Task") -> URL? {
        createProject(title: title, markdown: TaskTemplate.content.replacingOccurrences(of: "[PROJECT OR TASK NAME]", with: title))
    }

    @discardableResult
    func createProject(title: String, markdown: String) -> URL? {
        let cleanTitle = Self.safeFileName(title)
        for counter in 1...10_000 {
            let stem = counter == 1 ? cleanTitle : "\(cleanTitle)-\(counter)"
            let candidate = projectsURL.appendingPathComponent(stem).appendingPathExtension("md")
            do {
                try StickyPadFileIO.writeNewUTF8(markdown, to: candidate)
                reload()
                return candidate
            } catch {
                if FileManager.default.fileExists(atPath: candidate.path) { continue }
                lastError = "Could not create project: \(error.localizedDescription)"
                return nil
            }
        }
        lastError = "Could not create project: no unique filename was available."
        return nil
    }

    @discardableResult
    func createRegularNote(now: Date = Date()) -> URL? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH.mm.ss"
        let stem = "Sticky Note \(formatter.string(from: now))"
        for counter in 1...10_000 {
            let candidateStem = counter == 1 ? stem : "\(stem)-\(counter)"
            let candidate = notesURL.appendingPathComponent(candidateStem).appendingPathExtension("txt")
            do {
                try StickyPadFileIO.writeNewUTF8("", to: candidate)
                lastError = nil
                return candidate
            } catch {
                if FileManager.default.fileExists(atPath: candidate.path) { continue }
                lastError = "Could not create regular sticky note: \(error.localizedDescription)"
                return nil
            }
        }
        lastError = "Could not create regular sticky note: no unique filename was available."
        return nil
    }

    func importMarkdown(from source: URL) -> URL? {
        guard source.pathExtension.lowercased() == "md" else {
            lastError = "Sticky Pad accepts Markdown (.md) files only."
            return nil
        }
        do {
            let markdown = try StickyPadFileIO.readUTF8(from: source)
            return createProject(title: source.deletingPathExtension().lastPathComponent, markdown: markdown)
        } catch {
            lastError = "Could not import file: \(error.localizedDescription)"
            return nil
        }
    }

    func revealProjectsFolder() {
        NSWorkspace.shared.open(projectsURL)
    }

    func revealNotesFolder() {
        NSWorkspace.shared.open(notesURL)
    }

    func revealTemplateFile() {
        prepareFolders()
        NSWorkspace.shared.activateFileViewerSelecting([templateURL])
    }

    @discardableResult
    func copyTemplateForChatGPT() -> Bool {
        prepareFolders()
        do {
            let content = try StickyPadFileIO.readUTF8(from: templateURL)
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            guard pasteboard.writeObjects([content as NSString]) else {
                lastError = "Could not copy the project-loop template."
                return false
            }
            lastError = nil
            return true
        } catch {
            lastError = "Could not read the project-loop template: \(error.localizedDescription)"
            return false
        }
    }

    @discardableResult
    func moveProjectToTrash(_ url: URL) -> TrashedProjectFiles? {
        let projectURL = url.standardizedFileURL
        guard projectURL.deletingLastPathComponent() == projectsURL.standardizedFileURL,
              projectURL.pathExtension.lowercased() == "md",
              FileManager.default.fileExists(atPath: projectURL.path) else {
            lastError = "Could not delete project: the selected file is not a Sticky Pad project."
            return nil
        }

        let receiptURL = DeliveryReceiptStore.receiptURL(for: projectURL)
        var trashedReceiptURL: URL?
        do {
            let projectValues = try projectURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard projectValues.isRegularFile == true, projectValues.isSymbolicLink != true else {
                lastError = "Could not delete project: the selected file is not a regular Sticky Pad project."
                return nil
            }

            if FileManager.default.fileExists(atPath: receiptURL.path) {
                let receiptValues = try receiptURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                guard receiptValues.isRegularFile == true, receiptValues.isSymbolicLink != true else {
                    lastError = "Could not delete project: its Hermes delivery receipt is not a regular file."
                    return nil
                }
                var resultingReceiptURL: NSURL?
                try FileManager.default.trashItem(at: receiptURL, resultingItemURL: &resultingReceiptURL)
                trashedReceiptURL = resultingReceiptURL as URL?
            }

            var trashedProjectURL: NSURL?
            try FileManager.default.trashItem(at: projectURL, resultingItemURL: &trashedProjectURL)
            guard let trashedProjectURL = trashedProjectURL as URL? else {
                throw CocoaError(.fileWriteUnknown)
            }
            reload()
            return TrashedProjectFiles(projectURL: trashedProjectURL, receiptURL: trashedReceiptURL)
        } catch {
            var rollbackError: Error?
            if let trashedReceiptURL,
               !FileManager.default.fileExists(atPath: receiptURL.path) {
                do {
                    try FileManager.default.moveItem(at: trashedReceiptURL, to: receiptURL)
                } catch {
                    rollbackError = error
                }
            }
            reload()
            if let rollbackError {
                lastError = "Could not move project to Trash, and its delivery receipt remains recoverable in Trash: \(rollbackError.localizedDescription)"
            } else {
                lastError = "Could not move project to Trash: \(error.localizedDescription)"
            }
            return nil
        }
    }

    static func safeFileName(_ value: String) -> String {
        let forbidden = CharacterSet(charactersIn: "/:\\?%*|\"<>")
        let pieces = value.components(separatedBy: forbidden)
        let collapsed = pieces.joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
        let truncated = String(collapsed.prefix(100))
            .trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
        return truncated.isEmpty ? "Untitled Hermes Task" : truncated
    }
}
