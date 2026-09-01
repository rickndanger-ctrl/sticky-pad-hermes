import AppKit
import SwiftUI

@MainActor
final class WindowManager: NSObject, NSWindowDelegate {
    let store: ProjectStore
    private var noteWindows: [String: NSWindowController] = [:]
    private var noteDocuments: [Int: NoteDocumentModel] = [:]
    private var hiddenByToggle: Set<String> = []
    private var projectWindow: NSWindowController?
    private(set) var notesEnabled = true

    init(store: ProjectStore) {
        self.store = store
        super.init()
    }

    func showProjects() {
        store.reload()
        if projectWindow == nil {
            let view = ProjectsView(store: store) { [weak self] url in self?.showNote(url) }
            let window = NSWindow(contentViewController: NSHostingController(rootView: view))
            window.title = "Sticky Pad Projects"
            window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            window.setContentSize(NSSize(width: 760, height: 500))
            window.center()
            window.isReleasedWhenClosed = false
            window.setFrameAutosaveName("StickyPadProjects")
            projectWindow = NSWindowController(window: window)
        }
        NSApp.activate(ignoringOtherApps: true)
        projectWindow?.showWindow(nil)
        projectWindow?.window?.makeKeyAndOrderFront(nil)
    }

    func showNote(_ url: URL) {
        notesEnabled = true
        let key = url.standardizedFileURL.path
        if let existing = noteWindows[key] {
            NSApp.activate(ignoringOtherApps: true)
            existing.showWindow(nil)
            existing.window?.makeKeyAndOrderFront(nil)
            return
        }

        let document = NoteDocumentModel(url: url)
        let view = TaskNoteView(document: document) { [weak store] in store?.reload() }
        let window = NSWindow(contentViewController: NSHostingController(rootView: view))
        window.title = document.title
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(red: 1.0, green: 0.94, blue: 0.42, alpha: 1)
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.setContentSize(NSSize(width: 320, height: 320))
        window.minSize = NSSize(width: 260, height: 240)
        window.isMovableByWindowBackground = false
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.setFrameAutosaveName("StickyPad-\(url.lastPathComponent)")
        if window.frame.origin == .zero { window.center() }

        let controller = NSWindowController(window: window)
        noteWindows[key] = controller
        noteDocuments[window.windowNumber] = document
        NSApp.activate(ignoringOtherApps: true)
        controller.showWindow(nil)
        window.makeKeyAndOrderFront(nil)
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

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard let document = noteDocuments[sender.windowNumber], document.isDirty else { return true }
        return document.save()
    }
}
