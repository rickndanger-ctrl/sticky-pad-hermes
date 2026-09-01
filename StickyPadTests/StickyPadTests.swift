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
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.templatesURL.appendingPathComponent(TaskTemplate.fileName).path))
        XCTAssertTrue(TaskTemplate.content.contains("Build → Review → Test"))
        XCTAssertTrue(TaskTemplate.content.contains("## Finished looks like"))
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

    func testTitleFallsBackToFilename() {
        XCTAssertEqual(TaskProject.title(from: "No heading", fallback: "Fallback"), "Fallback")
        XCTAssertEqual(TaskProject.title(from: "# Heading\nBody", fallback: "Fallback"), "Heading")
    }
}
