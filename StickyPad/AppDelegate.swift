import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let store = ProjectStore()
    private var windowManager: WindowManager!
    private var statusItem: NSStatusItem!
    private var enabledMenuItem: NSMenuItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        windowManager = WindowManager(store: store)
        configureMenuBar()
        windowManager.showProjects()
    }

    private func configureMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "note.text", accessibilityDescription: "Sticky Pad")
        statusItem.button?.toolTip = "Sticky Pad"

        let menu = NSMenu()
        let projects = NSMenuItem(title: "Projects…", action: #selector(showProjects), keyEquivalent: "p")
        projects.target = self
        menu.addItem(projects)

        let newTask = NSMenuItem(title: "New Blank Hermes Task", action: #selector(newTask), keyEquivalent: "n")
        newTask.target = self
        menu.addItem(newTask)
        menu.addItem(.separator())

        enabledMenuItem = NSMenuItem(title: "Hide Sticky Notes", action: #selector(toggleNotes), keyEquivalent: "h")
        enabledMenuItem.target = self
        menu.addItem(enabledMenuItem)

        let folder = NSMenuItem(title: "Show Projects Folder", action: #selector(showFolder), keyEquivalent: "")
        folder.target = self
        menu.addItem(folder)
        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit Sticky Pad", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu
    }

    @objc private func showProjects() { windowManager.showProjects() }

    @objc private func newTask() {
        if let url = store.createBlankProject() { windowManager.showNote(url) }
    }

    @objc private func toggleNotes() {
        windowManager.toggleNotesEnabled()
        enabledMenuItem.title = windowManager.notesEnabled ? "Hide Sticky Notes" : "Show Sticky Notes"
    }

    @objc private func showFolder() { store.revealProjectsFolder() }
    @objc private func quitApp() { NSApp.terminate(nil) }
}

