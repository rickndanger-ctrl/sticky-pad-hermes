import AppKit
import SwiftUI

@MainActor
final class WindowManager: NSObject, NSWindowDelegate {
    let store: ProjectStore
    private var noteWindows: [String: NSWindowController] = [:]
    private var noteDocuments: [Int: NoteDocumentModel] = [:]
    private var noteDocumentsByPath: [String: NoteDocumentModel] = [:]
    private var hiddenByToggle: Set<String> = []
    private var projectWindow: NSWindowController?
    private(set) var notesEnabled = true

    static let desktopLevel = NSWindow.Level(
        rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1
    )

    static func noteLevel(isHovering: Bool) -> NSWindow.Level {
        isHovering ? .floating : desktopLevel
    }

    private static func hoverPreferenceKey(for url: URL) -> String {
        "StickyPad.hoverMode.\(url.standardizedFileURL.path)"
    }

    init(store: ProjectStore) {
        self.store = store
        super.init()
        store.onOpenRequest = { [weak self] url in self?.showNote(url, kind: .hermesTask) }
        store.processOpenRequests()
    }

    func showProjects() {
        store.reload()
        if projectWindow == nil {
            let view = ProjectsView(
                store: store,
                openProject: { [weak self] url in self?.showNote(url, kind: .hermesTask) },
                createRegularNote: { [weak self] in
                    guard let self, let url = self.store.createRegularNote() else { return }
                    self.showRegularNote(url)
                },
                deleteProject: { [weak self] url in _ = self?.moveProjectToTrash(url) }
            )
            let window = NSWindow(contentViewController: NSHostingController(rootView: view))
            window.title = "Sticky Pad Projects"
            window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            window.setContentSize(NSSize(width: 900, height: 500))
            window.minSize = NSSize(width: 900, height: 420)
            window.center()
            window.isReleasedWhenClosed = false
            window.setFrameAutosaveName("StickyPadProjects")
            projectWindow = NSWindowController(window: window)
        }
        NSApp.activate(ignoringOtherApps: true)
        projectWindow?.showWindow(nil)
        projectWindow?.window?.makeKeyAndOrderFront(nil)
    }

    func showNote(_ url: URL, kind: NoteKind = .hermesTask) {
        if !notesEnabled {
            setNotesEnabled(true)
        }
        let key = url.standardizedFileURL.path
        if let existing = noteWindows[key] {
            if let document = noteDocumentsByPath[key] {
                if !document.isDirty {
                    document.reload()
                }
                document.reloadDeliveryReceipt()
                existing.window?.title = document.title
            }
            NSApp.activate(ignoringOtherApps: true)
            existing.showWindow(nil)
            existing.window?.makeKeyAndOrderFront(nil)
            return
        }

        let document = NoteDocumentModel(url: url, kind: kind)
        let preferenceKey = Self.hoverPreferenceKey(for: url)
        let savedMode = UserDefaults.standard.object(forKey: preferenceKey) as? Bool
        let isHovering = savedMode ?? true
        let window = NSWindow()
        let view = TaskNoteView(
            document: document,
            isHovering: isHovering,
            onSaved: { [weak store] in store?.reload() },
            onHoverModeChanged: { [weak window] hovering in
                window?.level = Self.noteLevel(isHovering: hovering)
                UserDefaults.standard.set(hovering, forKey: preferenceKey)
            }
        )
        window.contentViewController = NSHostingController(rootView: view)
        window.title = document.title
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(red: 1.0, green: 0.94, blue: 0.42, alpha: 1)
        window.level = Self.noteLevel(isHovering: isHovering)
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.setContentSize(NSSize(width: 320, height: 320))
        window.minSize = NSSize(width: 260, height: 240)
        window.isMovableByWindowBackground = false
        window.isReleasedWhenClosed = false
        window.delegate = self
        let frameName = "StickyPad-\(url.lastPathComponent)"
        if !window.setFrameUsingName(frameName) {
            window.center()
            let cascade = CGFloat(noteWindows.count % 10) * 26
            window.setFrameOrigin(NSPoint(x: window.frame.origin.x + cascade, y: window.frame.origin.y - cascade))
        }
        window.setFrameAutosaveName(frameName)

        let controller = NSWindowController(window: window)
        noteWindows[key] = controller
        noteDocuments[window.windowNumber] = document
        noteDocumentsByPath[key] = document
        NSApp.activate(ignoringOtherApps: true)
        controller.showWindow(nil)
        window.makeKeyAndOrderFront(nil)
    }

    func showRegularNote(_ url: URL) {
        showNote(url, kind: .regular)
    }

    func setNotesEnabled(_ enabled: Bool) {
        notesEnabled = enabled
        if enabled {
            for key in hiddenByToggle {
                noteWindows[key]?.window?.orderFrontRegardless()
            }
            hiddenByToggle.removeAll()
        } else {
            hiddenByToggle = Set(noteWindows.compactMap { key, controller in
                controller.window?.isVisible == true ? key : nil
            })
            for key in hiddenByToggle {
                noteWindows[key]?.window?.orderOut(nil)
            }
        }
    }

    func toggleNotesEnabled() { setNotesEnabled(!notesEnabled) }

    @discardableResult
    func moveProjectToTrash(_ url: URL) -> TrashedProjectFiles? {
        let key = url.standardizedFileURL.path
        if let document = noteDocumentsByPath[key], document.isDirty, !document.save() {
            return nil
        }
        guard let trashedFiles = store.moveProjectToTrash(url) else { return nil }
        if let window = noteWindows[key]?.window {
            noteDocuments.removeValue(forKey: window.windowNumber)
            window.delegate = nil
            window.close()
        }
        noteDocumentsByPath.removeValue(forKey: key)
        noteWindows.removeValue(forKey: key)
        hiddenByToggle.remove(key)
        return trashedFiles
    }

    var hiddenNoteCount: Int { hiddenByToggle.count }

    var visibleNoteCount: Int {
        noteWindows.values.filter { $0.window?.isVisible == true }.count
    }

    func document(for url: URL) -> NoteDocumentModel? {
        noteDocumentsByPath[url.standardizedFileURL.path]
    }

    @discardableResult
    func saveAllDirtyDocuments() -> Bool {
        var allSaved = true
        for document in noteDocumentsByPath.values where document.isDirty {
            if !document.save() { allSaved = false }
        }
        if allSaved { store.reload() }
        return allSaved
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard let document = noteDocuments[sender.windowNumber], document.isDirty else { return true }
        return document.save()
    }
}
