import CryptoKit
import Foundation

struct DeliveryReceipt: Codable, Equatable {
    let version: Int
    let filename: String
    let taskId: String
    let board: String
    let sha256: String
    let importance: String
    let status: String
    let assignee: String?
    let displayState: HermesDisplayState
    let queuedAt: String
    let updatedAt: String
    let lastError: String?
    let consecutiveFailures: Int?
}

enum DeliveryReceiptStore {
    static func receiptURL(for documentURL: URL) -> URL {
        let baseURL = documentURL.deletingLastPathComponent().deletingLastPathComponent()
        return baseURL
            .appendingPathComponent("Delivery Receipts", isDirectory: true)
            .appendingPathComponent(receiptFileName(for: documentURL.lastPathComponent))
    }

    static func receiptFileName(for filename: String) -> String {
        let encoded = Data(filename.utf8).base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "=", with: "")
        return "\(encoded).json"
    }

    static func load(for documentURL: URL) throws -> DeliveryReceipt? {
        let url = receiptURL(for: documentURL)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let contents = try StickyPadFileIO.readUTF8(from: url, maximumBytes: 64 * 1_024)
        let receipt = try JSONDecoder().decode(DeliveryReceipt.self, from: Data(contents.utf8))
        guard receipt.version == 1,
              receipt.filename == documentURL.lastPathComponent,
              receipt.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let currentMarkdown = try StickyPadFileIO.readUTF8(from: documentURL)
        guard receipt.sha256 == sha256(for: currentMarkdown) else { return nil }
        return receipt
    }

    static func sha256(for markdown: String) -> String {
        SHA256.hash(data: Data(markdown.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func invalidateIfSourceChanged(for documentURL: URL, markdown: String) throws {
        let url = receiptURL(for: documentURL)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        let contents = try StickyPadFileIO.readUTF8(from: url, maximumBytes: 64 * 1_024)
        let receipt = try JSONDecoder().decode(DeliveryReceipt.self, from: Data(contents.utf8))
        guard receipt.sha256 != sha256(for: markdown) else { return }
        try FileManager.default.removeItem(at: url)
    }
}
