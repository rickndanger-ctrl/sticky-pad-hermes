import Foundation

@MainActor
final class NoteDocumentModel: ObservableObject {
    let url: URL
    let kind: NoteKind
    @Published var text = ""
    @Published var isEditing = false
    @Published var isDirty = false
    @Published var lastError: String?
    @Published private(set) var statusError: String?
    @Published private(set) var hermesState: HermesDisplayState = .notQueued
    @Published private(set) var deliveryReceipt: DeliveryReceipt?
    private var autoSaveTask: Task<Void, Never>?
    private var baselineSHA256: String?

    init(url: URL, kind: NoteKind = .hermesTask) {
        self.url = url
        self.kind = kind
        self.isEditing = kind.startsEditing
        reload()
        reloadDeliveryReceipt()
    }

    var title: String {
        TaskProject.title(from: text, fallback: url.deletingPathExtension().lastPathComponent)
    }

    func textChanged() {
        isDirty = true
        if kind.monitorsHermesStatus {
            deliveryReceipt = nil
            hermesState = .notQueued
            statusError = nil
        }
        guard kind == .regular else { return }
        autoSaveTask?.cancel()
        autoSaveTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            _ = self?.save()
        }
    }

    @discardableResult
    func save() -> Bool {
        do {
            guard Data(text.utf8).count <= StickyPadFileIO.maximumNoteBytes else {
                throw CocoaError(.fileWriteOutOfSpace)
            }
            let diskText = try StickyPadFileIO.readUTF8(from: url)
            guard let baselineSHA256,
                  DeliveryReceiptStore.sha256(for: diskText) == baselineSHA256 else {
                lastError = "Save stopped because this file changed outside Sticky Pad. Reload it and merge your unsaved edit."
                return false
            }
            try text.write(to: url, atomically: true, encoding: .utf8)
            try? DeliveryReceiptStore.invalidateIfSourceChanged(for: url, markdown: text)
            self.baselineSHA256 = DeliveryReceiptStore.sha256(for: text)
            isDirty = false
            lastError = nil
            reloadDeliveryReceipt()
            return true
        } catch {
            lastError = "Save failed: \(error.localizedDescription)"
            return false
        }
    }

    func reload() {
        do {
            text = try StickyPadFileIO.readUTF8(from: url)
            baselineSHA256 = DeliveryReceiptStore.sha256(for: text)
            isDirty = false
            lastError = nil
        } catch {
            baselineSHA256 = nil
            lastError = "Open failed: \(error.localizedDescription)"
        }
    }

    func reloadDeliveryReceipt() {
        guard kind.monitorsHermesStatus else {
            deliveryReceipt = nil
            hermesState = .notQueued
            statusError = nil
            return
        }
        guard !isDirty else {
            deliveryReceipt = nil
            hermesState = .notQueued
            statusError = nil
            return
        }
        do {
            deliveryReceipt = try DeliveryReceiptStore.load(for: url)
            hermesState = deliveryReceipt?.displayState ?? .notQueued
            statusError = nil
        } catch {
            deliveryReceipt = nil
            hermesState = .notQueued
            statusError = "Status receipt could not be read: \(error.localizedDescription)"
        }
    }
}
