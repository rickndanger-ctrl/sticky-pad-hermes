import XCTest
@testable import StickyPad

@MainActor
final class StickyPadTests: XCTestCase {
    nonisolated(unsafe) private var temporaryURL: URL!

    override func setUpWithError() throws {
        temporaryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("StickyPadTests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temporaryURL)
    }

    func testCreatesFoldersAndTemplate() {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.projectsURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.notesURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.deliveryReceiptsURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.templatesURL.appendingPathComponent(TaskTemplate.fileName).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.openRequestsURL.path))
        XCTAssertEqual(TaskTemplate.fileName, "Hermes-Task-Template.txt")
        XCTAssertEqual(store.templateURL.pathExtension, "txt")
        XCTAssertTrue(TaskTemplate.content.contains("Build → Review → Test"))
        XCTAssertTrue(TaskTemplate.content.contains("## Finished looks like"))
    }

    func testRegularNotesAreSeparateDirectlyEditableAndUnlimited() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let first = try XCTUnwrap(store.createRegularNote(now: now))
        let second = try XCTUnwrap(store.createRegularNote(now: now))

        XCTAssertEqual(first.deletingLastPathComponent(), store.notesURL)
        XCTAssertEqual(first.pathExtension, "txt")
        XCTAssertNotEqual(first, second)
        XCTAssertTrue(store.projects.isEmpty)
        XCTAssertTrue(NoteDocumentModel(url: first, kind: .regular).isEditing)
    }

    func testDeliveryReceiptControlsHermesStatusButNeverRegularNotes() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let taskURL = try XCTUnwrap(store.createProject(title: "Status Task", markdown: "# Status Task"))
        let receiptURL = DeliveryReceiptStore.receiptURL(for: taskURL)
        let receipt = DeliveryReceipt(
            version: 1, filename: taskURL.lastPathComponent, taskId: "t_status123", board: "sticky-pad-inbox",
            sha256: DeliveryReceiptStore.sha256(for: "# Status Task"), importance: "high", status: "running", assignee: "Commander",
            displayState: .started, queuedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:01:00Z",
            lastError: nil, consecutiveFailures: 0
        )
        try JSONEncoder().encode(receipt).write(to: receiptURL, options: .atomic)

        let task = NoteDocumentModel(url: taskURL, kind: .hermesTask)
        XCTAssertEqual(task.hermesState, .started)
        XCTAssertEqual(task.deliveryReceipt?.taskId, "t_status123")

        try "{}".write(to: receiptURL, atomically: true, encoding: .utf8)
        task.reloadDeliveryReceipt()
        XCTAssertNil(task.deliveryReceipt)
        XCTAssertEqual(task.hermesState, .notQueued)
        XCTAssertNotNil(task.statusError)
        try FileManager.default.removeItem(at: receiptURL)
        task.reloadDeliveryReceipt()
        XCTAssertNil(task.statusError)

        let regularURL = try XCTUnwrap(store.createRegularNote())
        let regular = NoteDocumentModel(url: regularURL, kind: .regular)
        XCTAssertEqual(regular.hermesState, .notQueued)
        XCTAssertNil(regular.deliveryReceipt)
        XCTAssertNotEqual(DeliveryReceiptStore.receiptURL(for: taskURL).deletingLastPathComponent(), store.projectsURL)
    }

    func testMigratesLegacyMarkdownTemplateToTextFile() throws {
        let templatesURL = temporaryURL.appendingPathComponent("Templates", isDirectory: true)
        try FileManager.default.createDirectory(at: templatesURL, withIntermediateDirectories: true)
        let legacyURL = templatesURL.appendingPathComponent(TaskTemplate.legacyFileName)
        try "legacy template".write(to: legacyURL, atomically: true, encoding: .utf8)

        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let textURL = store.templatesURL.appendingPathComponent(TaskTemplate.fileName)
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertEqual(try String(contentsOf: textURL, encoding: .utf8), "legacy template")
    }

    func testCreatesAndDiscoversMarkdownProject() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let url = try XCTUnwrap(store.createProject(title: "Daily / Agent Task", markdown: "# Ship It\n\nDo work."))
        XCTAssertEqual(url.lastPathComponent, "Daily - Agent Task.md")
        XCTAssertEqual(store.projects.count, 1)
        XCTAssertEqual(store.projects.first?.title, "Ship It")
    }

    func testDuplicateNamesAreNeverOverwritten() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let first = try XCTUnwrap(store.createProject(title: "Task", markdown: "# One"))
        let second = try XCTUnwrap(store.createProject(title: "Task", markdown: "# Two"))
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(store.projects.count, 2)
        XCTAssertEqual(try String(contentsOf: first), "# One")
    }

    func testExternalCreatorCannotBeOverwritten() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let externalURL = store.projectsURL.appendingPathComponent("Shared Task.md")
        try "# Created by MCP".write(to: externalURL, atomically: true, encoding: .utf8)

        let nativeURL = try XCTUnwrap(store.createProject(title: "Shared Task", markdown: "# Created by app"))

        XCTAssertEqual(nativeURL.lastPathComponent, "Shared Task-2.md")
        XCTAssertEqual(try String(contentsOf: externalURL, encoding: .utf8), "# Created by MCP")
        XCTAssertEqual(try String(contentsOf: nativeURL, encoding: .utf8), "# Created by app")
    }

    func testOversizedProjectsAreIgnoredAndCannotBeOpenedOrImported() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let oversized = String(repeating: "x", count: StickyPadFileIO.maximumNoteBytes + 1)
        let externalURL = temporaryURL.appendingPathComponent("Oversized.md")
        try oversized.write(to: externalURL, atomically: true, encoding: .utf8)
        let libraryURL = store.projectsURL.appendingPathComponent("Oversized.md")
        try FileManager.default.copyItem(at: externalURL, to: libraryURL)

        store.reload()
        let document = NoteDocumentModel(url: libraryURL)

        XCTAssertTrue(store.projects.isEmpty)
        XCTAssertNil(store.importMarkdown(from: externalURL))
        XCTAssertTrue(document.text.isEmpty)
        XCTAssertNotNil(document.lastError)
    }

    func testSupportsManyIndependentStickyProjects() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        for index in 1...100 {
            XCTAssertNotNil(store.createProject(title: "Task \(index)", markdown: "# Task \(index)"))
        }

        XCTAssertEqual(store.projects.count, 100)
        XCTAssertEqual(Set(store.projects.map(\.url)).count, 100)
    }

    func testConsumesOpenRequestAndDispatchesProject() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let projectURL = try XCTUnwrap(store.createProject(title: "Visible", markdown: "# Visible"))
        let requestURL = store.openRequestsURL.appendingPathComponent("001.request")
        try "Visible.md\n".write(to: requestURL, atomically: true, encoding: .utf8)
        var openedURL: URL?
        store.onOpenRequest = { openedURL = $0 }

        store.processOpenRequests()

        XCTAssertEqual(openedURL, projectURL)
        XCTAssertFalse(FileManager.default.fileExists(atPath: requestURL.path))
    }

    func testRejectsOpenRequestOutsideProjectsFolder() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let requestURL = store.openRequestsURL.appendingPathComponent("invalid.request")
        try "../Outside.md\n".write(to: requestURL, atomically: true, encoding: .utf8)
        var openedURL: URL?
        store.onOpenRequest = { openedURL = $0 }

        store.processOpenRequests()

        XCTAssertNil(openedURL)
        XCTAssertFalse(FileManager.default.fileExists(atPath: requestURL.path))
    }

    func testMovesProjectToTrashAndRemovesItFromProjects() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let projectURL = try XCTUnwrap(store.createProject(title: "Disposable", markdown: "# Disposable"))
        let receiptURL = DeliveryReceiptStore.receiptURL(for: projectURL)
        let receipt = DeliveryReceipt(
            version: 1, filename: projectURL.lastPathComponent, taskId: "t_dispose123", board: "sticky-pad-inbox",
            sha256: DeliveryReceiptStore.sha256(for: "# Disposable"), importance: "low", status: "blocked", assignee: nil,
            displayState: .queued, queuedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:01:00Z",
            lastError: nil, consecutiveFailures: 0
        )
        try JSONEncoder().encode(receipt).write(to: receiptURL, options: .atomic)
        let trashedFiles = try XCTUnwrap(store.moveProjectToTrash(projectURL))
        defer {
            try? FileManager.default.removeItem(at: trashedFiles.projectURL)
            if let receiptURL = trashedFiles.receiptURL { try? FileManager.default.removeItem(at: receiptURL) }
        }

        XCTAssertFalse(FileManager.default.fileExists(atPath: projectURL.path))
        XCTAssertNotNil(trashedFiles.receiptURL)
        XCTAssertTrue(store.projects.isEmpty)
    }

    func testTrashSavesDirtyOpenProjectAndMovesItsHermesReceipt() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let projectURL = try XCTUnwrap(store.createProject(title: "Dirty", markdown: "# Saved version"))
        let receiptURL = DeliveryReceiptStore.receiptURL(for: projectURL)
        let receipt = DeliveryReceipt(
            version: 1, filename: projectURL.lastPathComponent, taskId: "t_delete123", board: "sticky-pad-inbox",
            sha256: String(repeating: "b", count: 64), importance: "medium", status: "blocked", assignee: nil,
            displayState: .queued, queuedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:01:00Z",
            lastError: nil, consecutiveFailures: 0
        )
        try JSONEncoder().encode(receipt).write(to: receiptURL, options: .atomic)
        let manager = WindowManager(store: store)
        manager.showNote(projectURL)
        let document = try XCTUnwrap(manager.document(for: projectURL))
        document.text = "# Unsaved version"
        document.textChanged()

        let trashedFiles = try XCTUnwrap(manager.moveProjectToTrash(projectURL))
        defer {
            try? FileManager.default.removeItem(at: trashedFiles.projectURL)
            if let receiptURL = trashedFiles.receiptURL {
                try? FileManager.default.removeItem(at: receiptURL)
            }
        }

        XCTAssertEqual(try String(contentsOf: trashedFiles.projectURL, encoding: .utf8), "# Unsaved version")
        XCTAssertNil(trashedFiles.receiptURL)
        XCTAssertFalse(FileManager.default.fileExists(atPath: projectURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: receiptURL.path))
        XCTAssertNil(manager.document(for: projectURL))
        XCTAssertTrue(store.projects.isEmpty)
    }

    func testProjectLibraryIgnoresSymbolicLinks() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let outsideURL = temporaryURL.appendingPathComponent("Outside.md")
        try "# Outside".write(to: outsideURL, atomically: true, encoding: .utf8)
        let linkedURL = store.projectsURL.appendingPathComponent("Linked.md")
        try FileManager.default.createSymbolicLink(at: linkedURL, withDestinationURL: outsideURL)

        store.reload()

        XCTAssertTrue(store.projects.isEmpty)
        XCTAssertNil(store.moveProjectToTrash(linkedURL))
        XCTAssertTrue(FileManager.default.fileExists(atPath: outsideURL.path))
    }

    func testDocumentSaveIsAtomicAndReloadable() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let url = try XCTUnwrap(store.createProject(title: "Task", markdown: "# Old"))
        let document = NoteDocumentModel(url: url)
        document.text = "# New\n\nUpdated"
        document.textChanged()
        XCTAssertTrue(document.isDirty)
        XCTAssertTrue(document.save())
        XCTAssertFalse(document.isDirty)
        XCTAssertEqual(try String(contentsOf: url), "# New\n\nUpdated")
    }

    func testEditingQueuedSourceInvalidatesItsHermesReceipt() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let original = "# Queued source"
        let projectURL = try XCTUnwrap(store.createProject(title: "Queued source", markdown: original))
        let receiptURL = DeliveryReceiptStore.receiptURL(for: projectURL)
        let receipt = DeliveryReceipt(
            version: 1, filename: projectURL.lastPathComponent, taskId: "t_stale123", board: "sticky-pad-inbox",
            sha256: DeliveryReceiptStore.sha256(for: original), importance: "high", status: "done", assignee: "Commander",
            displayState: .completed, queuedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:01:00Z",
            lastError: nil, consecutiveFailures: 0
        )
        try JSONEncoder().encode(receipt).write(to: receiptURL, options: .atomic)
        let document = NoteDocumentModel(url: projectURL)
        XCTAssertEqual(document.hermesState, .completed)

        document.text = "# Revised source"
        document.textChanged()
        XCTAssertTrue(document.save())

        XCTAssertFalse(FileManager.default.fileExists(atPath: receiptURL.path))
        XCTAssertNil(document.deliveryReceipt)
        XCTAssertEqual(document.hermesState, .notQueued)
    }

    func testTerminationSavePassPersistsEveryDirtyNote() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let projectURL = try XCTUnwrap(store.createProject(title: "Quit Project", markdown: "# Before"))
        let regularURL = try XCTUnwrap(store.createRegularNote())
        let manager = WindowManager(store: store)
        manager.showNote(projectURL)
        manager.showRegularNote(regularURL)
        let project = try XCTUnwrap(manager.document(for: projectURL))
        let regular = try XCTUnwrap(manager.document(for: regularURL))
        project.text = "# Saved at quit"
        project.textChanged()
        regular.text = "Saved before the 500 ms autosave"
        regular.textChanged()

        XCTAssertTrue(manager.saveAllDirtyDocuments())
        XCTAssertEqual(try String(contentsOf: projectURL, encoding: .utf8), "# Saved at quit")
        XCTAssertEqual(try String(contentsOf: regularURL, encoding: .utf8), "Saved before the 500 ms autosave")
        XCTAssertFalse(project.isDirty)
        XCTAssertFalse(regular.isDirty)
    }

    func testTitleFallsBackToFilename() {
        XCTAssertEqual(TaskProject.title(from: "No heading", fallback: "Fallback"), "Fallback")
        XCTAssertEqual(TaskProject.title(from: "# Heading\nBody", fallback: "Fallback"), "Heading")
    }

    func testDesktopModeSitsAboveDesktopIconsAndBelowAppWindows() {
        let desktopIconLevel = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)))

        XCTAssertGreaterThan(WindowManager.desktopLevel.rawValue, desktopIconLevel.rawValue)
        XCTAssertLessThan(WindowManager.desktopLevel.rawValue, NSWindow.Level.normal.rawValue)
        XCTAssertEqual(WindowManager.noteLevel(isHovering: false), WindowManager.desktopLevel)
        XCTAssertEqual(WindowManager.noteLevel(isHovering: true), NSWindow.Level.floating)
    }

    func testOpeningOneNoteAfterGlobalHideRestoresAllNotes() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let first = try XCTUnwrap(store.createProject(title: "First", markdown: "# First"))
        let second = try XCTUnwrap(store.createProject(title: "Second", markdown: "# Second"))
        let manager = WindowManager(store: store)

        manager.showNote(first)
        manager.showNote(second)
        XCTAssertEqual(manager.visibleNoteCount, 2)

        manager.setNotesEnabled(false)
        XCTAssertFalse(manager.notesEnabled)
        XCTAssertEqual(manager.hiddenNoteCount, 2)
        XCTAssertEqual(manager.visibleNoteCount, 0)

        manager.showNote(first)
        XCTAssertTrue(manager.notesEnabled)
        XCTAssertEqual(manager.hiddenNoteCount, 0)
        XCTAssertEqual(manager.visibleNoteCount, 2)
    }

    func testReopeningCleanNoteReloadsExternalMarkdownWithoutDiscardingUnsavedEdits() throws {
        let store = ProjectStore(baseURL: temporaryURL, startsMonitoring: false)
        let url = try XCTUnwrap(store.createProject(title: "Reload", markdown: "# Original"))
        let manager = WindowManager(store: store)

        manager.showNote(url)
        let document = try XCTUnwrap(manager.document(for: url))
        try "# External update".write(to: url, atomically: true, encoding: .utf8)
        manager.showNote(url)
        XCTAssertEqual(document.text, "# External update")

        document.text = "# Unsaved local edit"
        document.textChanged()
        try "# Second external update".write(to: url, atomically: true, encoding: .utf8)
        manager.showNote(url)
        XCTAssertEqual(document.text, "# Unsaved local edit")
        XCTAssertTrue(document.isDirty)
        XCTAssertFalse(document.save())
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "# Second external update")
        XCTAssertEqual(document.text, "# Unsaved local edit")
        XCTAssertTrue(document.isDirty)
        XCTAssertNotNil(document.lastError)
    }

    func testFolderAccessAcceptsOnlyCanonicalStickyPadLibrary() {
        let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)
        let expected = home.appendingPathComponent("Documents/Sticky Pad", isDirectory: true)
        let wrong = home.appendingPathComponent("Documents", isDirectory: true)

        XCTAssertTrue(StickyPadFolderAccess.isExpectedLibraryURL(expected, homeURL: home))
        XCTAssertTrue(StickyPadFolderAccess.isExpectedLibraryURL(expected.appendingPathComponent("..", isDirectory: true).appendingPathComponent("Sticky Pad", isDirectory: true), homeURL: home))
        XCTAssertFalse(StickyPadFolderAccess.isExpectedLibraryURL(wrong, homeURL: home))
        XCTAssertFalse(StickyPadFolderAccess.isExpectedLibraryURL(home.appendingPathComponent("Desktop/Sticky Pad", isDirectory: true), homeURL: home))
    }
}
