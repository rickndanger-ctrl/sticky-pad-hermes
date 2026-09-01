import SwiftUI

struct TaskNoteView: View {
    @ObservedObject var document: NoteDocumentModel
    let onSaved: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider().overlay(Color.black.opacity(0.18))
            if document.isEditing {
                TextEditor(text: $document.text)
                    .font(.system(size: 14, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .padding(10)
                    .onChange(of: document.text) { _, _ in document.textChanged() }
            } else {
                MarkdownView(markdown: document.text)
            }
            if let error = document.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(6)
            }
        }
        .background(Color(red: 1.0, green: 0.94, blue: 0.42))
        .frame(minWidth: 260, minHeight: 240)
    }

    private var toolbar: some View {
        HStack(spacing: 8) {
            Image(systemName: "note.text")
            Text(document.title)
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .lineLimit(1)
            Spacer()
            if document.isDirty {
                Circle().fill(.orange).frame(width: 7, height: 7).help("Unsaved changes")
            }
            Button(document.isEditing ? "Done" : "Edit") {
                if document.isEditing && document.isDirty {
                    if document.save() { onSaved() }
                }
                document.isEditing.toggle()
            }
            .keyboardShortcut("e", modifiers: [.command])
            if document.isEditing {
                Button("Save") {
                    if document.save() { onSaved() }
                }
                .keyboardShortcut("s", modifiers: [.command])
                .disabled(!document.isDirty)
            } else {
                Button {
                    document.reload()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help("Reload from Markdown file")
            }
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 12)
        .frame(height: 34)
        .background(Color(red: 0.98, green: 0.85, blue: 0.18).opacity(0.88))
    }
}

