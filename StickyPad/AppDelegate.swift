import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var store: ProjectStore!
    private var windowManager: WindowManager!
    private var statusItem: NSStatusItem!
    private var enabledMenuItem: NSMenuItem!
    private let hermesStatusMonitor = HermesStatusMonitor()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        guard let baseURL = StickyPadFolderAccess.resolveOrChoose() else {
            NSApp.terminate(nil)
            return
        }
        store = ProjectStore(baseURL: baseURL)
        windowManager = WindowManager(store: store)
        configureApplicationMenu()
        configureMenuBar()
        hermesStatusMonitor.start()
        windowManager.showProjects()
    }

    func applicationWillTerminate(_ notification: Notification) {
        hermesStatusMonitor.stop()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard windowManager?.saveAllDirtyDocuments() ?? true else { return .terminateCancel }
        return .terminateNow
    }

    private func configureMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "note.text", accessibilityDescription: "Sticky Pad")
        statusItem.button?.toolTip = "Sticky Pad"

        let menu = NSMenu()
        let newNote = NSMenuItem(title: "New Regular Sticky Note", action: #selector(newRegularNote), keyEquivalent: "n")
        newNote.target = self
        menu.addItem(newNote)

        let projects = NSMenuItem(title: "Projects…", action: #selector(showProjects), keyEquivalent: "p")
        projects.target = self
        menu.addItem(projects)

        let template = NSMenuItem(title: "Copy Entire Template for ChatGPT", action: #selector(copyTemplate), keyEquivalent: "c")
        template.target = self
        menu.addItem(template)
        menu.addItem(.separator())

        enabledMenuItem = NSMenuItem(title: "Hide Sticky Notes", action: #selector(toggleNotes), keyEquivalent: "h")
        enabledMenuItem.target = self
        menu.addItem(enabledMenuItem)

        let folder = NSMenuItem(title: "Show Projects Folder", action: #selector(showFolder), keyEquivalent: "")
        folder.target = self
        menu.addItem(folder)
        let notesFolder = NSMenuItem(title: "Show Regular Notes Folder", action: #selector(showNotesFolder), keyEquivalent: "")
        notesFolder.target = self
        menu.addItem(notesFolder)
        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit Sticky Pad", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu
    }

    private func configureApplicationMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "Sticky Pad")
        let newNote = NSMenuItem(title: "New Regular Sticky Note", action: #selector(newRegularNote), keyEquivalent: "n")
        newNote.target = self
        appMenu.addItem(newNote)
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)
        NSApp.mainMenu = mainMenu
    }

    @objc private func showProjects() { windowManager.showProjects() }

    @objc private func newRegularNote() {
        guard let url = store.createRegularNote() else { return }
        windowManager.showRegularNote(url)
    }

    @objc private func copyTemplate() { store.copyTemplateForChatGPT() }

    @objc private func toggleNotes() {
        windowManager.toggleNotesEnabled()
        enabledMenuItem.title = windowManager.notesEnabled ? "Hide Sticky Notes" : "Show Sticky Notes"
    }

    @objc private func showFolder() { store.revealProjectsFolder() }
    @objc private func showNotesFolder() { store.revealNotesFolder() }
    @objc private func quitApp() { NSApp.terminate(nil) }
}
