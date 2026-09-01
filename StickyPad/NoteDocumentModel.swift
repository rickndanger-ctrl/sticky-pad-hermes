import Foundation

@MainActor
final class NoteDocumentModel: ObservableObject {
    let url: URL
    @Published var text = ""
    @Published var isEditing = false
    @Published var isDirty = false
    @Published var lastError: String?

    init(url: URL) {
        self.url = url
        reload()
    }

    var title: String {
        TaskProject.title(from: text, fallback: url.deletingPathExtension().lastPathComponent)
    }

    func textChanged() { isDirty = true }

    @discardableResult
    func save() -> Bool {
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
            isDirty = false
            lastError = nil
            return true
        } catch {
            lastError = "Save failed: \(error.localizedDescription)"
            return false
        }
    }

    func reload() {
        do {
            text = try String(contentsOf: url, encoding: .utf8)
            isDirty = false
            lastError = nil
        } catch {
            lastError = "Open failed: \(error.localizedDescription)"
        }
    }
}

