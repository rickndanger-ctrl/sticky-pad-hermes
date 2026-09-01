import AppKit
import Foundation

@MainActor
final class ProjectStore: ObservableObject {
    @Published private(set) var projects: [TaskProject] = []
    @Published private(set) var lastError: String?

    let baseURL: URL
    let projectsURL: URL
    let templatesURL: URL
    var templateURL: URL { templatesURL.appendingPathComponent(TaskTemplate.fileName) }
    private var refreshTimer: Timer?

    init(baseURL: URL? = nil, startsMonitoring: Bool = true) {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        self.baseURL = baseURL ?? documents.appendingPathComponent("Sticky Pad", isDirectory: true)
        self.projectsURL = self.baseURL.appendingPathComponent("Projects", isDirectory: true)
        self.templatesURL = self.baseURL.appendingPathComponent("Templates", isDirectory: true)
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
            try FileManager.default.createDirectory(at: templatesURL, withIntermediateDirectories: true)
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
            let keys: Set<URLResourceKey> = [.contentModificationDateKey, .isRegularFileKey]
            let urls = try FileManager.default.contentsOfDirectory(
                at: projectsURL,
                includingPropertiesForKeys: Array(keys),
                options: [.skipsHiddenFiles]
            )
            projects = urls.compactMap { url in
                guard url.pathExtension.lowercased() == "md",
                      let values = try? url.resourceValues(forKeys: keys),
                      values.isRegularFile == true,
                      let markdown = try? String(contentsOf: url, encoding: .utf8) else { return nil }
                return TaskProject(
                    url: url,
                    title: TaskProject.title(from: markdown, fallback: url.deletingPathExtension().lastPathComponent),
                    modifiedAt: values.contentModificationDate ?? .distantPast
                )
            }
            .sorted { $0.modifiedAt > $1.modifiedAt }
            lastError = nil
        } catch {
            projects = []
            lastError = "Could not read projects: \(error.localizedDescription)"
        }
    }

    @discardableResult
    func createBlankProject(title: String = "Untitled Hermes Task") -> URL? {
        createProject(title: title, markdown: TaskTemplate.content.replacingOccurrences(of: "[PROJECT OR TASK NAME]", with: title))
    }

    @discardableResult
    func createProject(title: String, markdown: String) -> URL? {
        let cleanTitle = Self.safeFileName(title)
        var candidate = projectsURL.appendingPathComponent(cleanTitle).appendingPathExtension("md")
        var counter = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = projectsURL.appendingPathComponent("\(cleanTitle)-\(counter)").appendingPathExtension("md")
            counter += 1
        }
        do {
            try markdown.write(to: candidate, atomically: true, encoding: .utf8)
            reload()
            return candidate
        } catch {
            lastError = "Could not create project: \(error.localizedDescription)"
            return nil
        }
    }

    func importMarkdown(from source: URL) -> URL? {
        guard source.pathExtension.lowercased() == "md" else {
            lastError = "Sticky Pad accepts Markdown (.md) files only."
            return nil
        }
        do {
            let markdown = try String(contentsOf: source, encoding: .utf8)
            return createProject(title: source.deletingPathExtension().lastPathComponent, markdown: markdown)
        } catch {
            lastError = "Could not import file: \(error.localizedDescription)"
            return nil
        }
    }

    func revealProjectsFolder() {
        NSWorkspace.shared.open(projectsURL)
    }

    func openTemplateInTextEdit() {
        prepareFolders()
        let textEditURL = URL(fileURLWithPath: "/System/Applications/TextEdit.app", isDirectory: true)
        let configuration = NSWorkspace.OpenConfiguration()
        NSWorkspace.shared.open(
            [templateURL],
            withApplicationAt: textEditURL,
            configuration: configuration
        ) { [weak self] _, error in
            guard let error else { return }
            Task { @MainActor in
                self?.lastError = "Could not open the project-loop template in TextEdit: \(error.localizedDescription)"
            }
        }
    }

    static func safeFileName(_ value: String) -> String {
        let forbidden = CharacterSet(charactersIn: "/:\\?%*|\"<>")
        let pieces = value.components(separatedBy: forbidden)
        let collapsed = pieces.joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
        return collapsed.isEmpty ? "Untitled Hermes Task" : String(collapsed.prefix(100))
    }
}
