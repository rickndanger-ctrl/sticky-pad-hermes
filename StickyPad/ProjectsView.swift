import AppKit
import SwiftUI

struct ProjectsView: View {
    @ObservedObject var store: ProjectStore
    let openProject: (URL) -> Void
    let deleteProject: (URL) -> Void
    @State private var projectPendingDeletion: TaskProject?
    @State private var templateCopied = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sticky Pad Projects").font(.title2.bold())
                    Text("Markdown tasks available to Richard and Hermes")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Menu(templateCopied ? "Copied for ChatGPT" : "Project Loop for ChatGPT") {
                    Button("Open in TextEdit") { store.openTemplateInTextEdit() }
                    Button("Show File in Finder") { store.revealTemplateFile() }
                    Divider()
                    Button("Copy Entire Template") {
                        guard store.copyTemplateForChatGPT() else { return }
                        templateCopied = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                            templateCopied = false
                        }
                    }
                }
                Button("New Task") {
                    if let url = store.createBlankProject() { openProject(url) }
                }
                Button("Import MD…", action: importMarkdown)
                Button {
                    store.reload()
                } label: { Image(systemName: "arrow.clockwise") }
                .help("Refresh")
            }
            .padding(16)

            Divider()

            if store.projects.isEmpty {
                ContentUnavailableView(
                    "No Projects Yet",
                    systemImage: "note.text",
                    description: Text("Create a blank task or let the Sticky Pad MCP deposit a Markdown file.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(store.projects) { project in
                    HStack(spacing: 12) {
                        Image(systemName: "doc.richtext.fill").foregroundStyle(.yellow)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(project.title).font(.headline).lineLimit(1)
                            Text(project.url.lastPathComponent)
                                .font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(project.modifiedAt, style: .relative)
                            .font(.caption).foregroundStyle(.secondary)
                        Button("Open Sticky") { openProject(project.url) }
                        Button(role: .destructive) {
                            projectPendingDeletion = project
                        } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.borderless)
                        .help("Move \(project.url.lastPathComponent) to Trash")
                    }
                    .padding(.vertical, 5)
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2) { openProject(project.url) }
                }
            }

            Divider()
            HStack {
                if let error = store.lastError {
                    Text(error).font(.caption).foregroundStyle(.red).lineLimit(1)
                } else {
                    Text(store.projectsURL.path).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Show Projects Folder") { store.revealProjectsFolder() }
            }
            .padding(12)
        }
        .frame(minWidth: 820, minHeight: 420)
        .alert(
            "Move Project to Trash?",
            isPresented: Binding(
                get: { projectPendingDeletion != nil },
                set: { if !$0 { projectPendingDeletion = nil } }
            ),
            presenting: projectPendingDeletion
        ) { project in
            Button("Move to Trash", role: .destructive) {
                deleteProject(project.url)
                projectPendingDeletion = nil
            }
            Button("Cancel", role: .cancel) { projectPendingDeletion = nil }
        } message: { project in
            Text("\(project.url.lastPathComponent) will be moved to the macOS Trash and can be recovered there.")
        }
    }

    private func importMarkdown() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.plainText]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        if panel.runModal() == .OK, let source = panel.url,
           let imported = store.importMarkdown(from: source) {
            openProject(imported)
        }
    }
}
