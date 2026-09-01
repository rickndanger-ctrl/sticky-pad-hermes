import Foundation

struct TaskProject: Identifiable, Hashable {
    let url: URL
    let title: String
    let modifiedAt: Date

    var id: String { url.path }

    static func title(from markdown: String, fallback: String) -> String {
        for line in markdown.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("# ") {
                let candidate = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                if !candidate.isEmpty { return candidate }
            }
        }
        return fallback
    }
}

