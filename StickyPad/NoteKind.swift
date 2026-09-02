import Darwin
import Foundation

enum StickyPadFileIO {
    static let maximumNoteBytes = 1_024 * 1_024
    static let maximumRequestBytes = 4_096

    static func readUTF8(from url: URL, maximumBytes: Int = maximumNoteBytes) throws -> String {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }

        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        guard (metadata.st_mode & S_IFMT) == S_IFREG else {
            throw CocoaError(.fileReadInvalidFileName)
        }
        guard metadata.st_size <= maximumBytes else {
            throw CocoaError(.fileReadTooLarge)
        }
        let data = try handle.read(upToCount: maximumBytes + 1) ?? Data()
        guard data.count <= maximumBytes else {
            throw CocoaError(.fileReadTooLarge)
        }
        guard let value = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadInapplicableStringEncoding)
        }
        return value
    }

    static func writeNewUTF8(_ value: String, to target: URL) throws {
        let data = Data(value.utf8)
        guard data.count <= maximumNoteBytes else {
            throw CocoaError(.fileWriteOutOfSpace)
        }

        let temporary = target.deletingLastPathComponent()
            .appendingPathComponent(".\(target.lastPathComponent).\(UUID().uuidString).tmp")
        try data.write(to: temporary, options: .atomic)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        try FileManager.default.linkItem(at: temporary, to: target)
    }
}

enum NoteKind: Equatable {
    case hermesTask
    case regular

    var startsEditing: Bool { self == .regular }
    var monitorsHermesStatus: Bool { self == .hermesTask }
}

enum HermesDisplayState: String, Codable, Equatable {
    case notQueued
    case queued
    case started
    case stalled
    case completed
}
