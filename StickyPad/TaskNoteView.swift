import SwiftUI

struct TaskNoteView: View {
    @ObservedObject var document: NoteDocumentModel
    let onSaved: () -> Void
    let onHoverModeChanged: (Bool) -> Void
    @State private var isHovering: Bool
    @FocusState private var editorFocused: Bool
    private let statusTimer = Timer.publish(every: 1.0, on: .main, in: .common).autoconnect()

    init(
        document: NoteDocumentModel,
        isHovering: Bool,
        onSaved: @escaping () -> Void,
        onHoverModeChanged: @escaping (Bool) -> Void
    ) {
        self.document = document
        self.onSaved = onSaved
        self.onHoverModeChanged = onHoverModeChanged
        _isHovering = State(initialValue: isHovering)
    }

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                toolbar
                Divider().overlay(Color.black.opacity(0.18))
                if document.isEditing {
                    TextEditor(text: $document.text)
                        .font(.system(size: 14, design: document.kind == .regular ? .rounded : .monospaced))
                        .scrollContentBackground(.hidden)
                        .focused($editorFocused)
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
                if let error = document.statusError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(6)
                }
            }
            if document.kind == .hermesTask && document.hermesState == .completed {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 104, weight: .bold))
                    .foregroundStyle(.green)
                    .shadow(color: .black.opacity(0.18), radius: 3, y: 2)
                    .accessibilityLabel("Hermes task completed")
                    .allowsHitTesting(false)
            }
        }
        .background(noteColor)
        .frame(minWidth: 260, minHeight: 240)
        .onAppear {
            document.reloadDeliveryReceipt()
            if document.kind == .regular { editorFocused = true }
        }
        .onReceive(statusTimer) { _ in document.reloadDeliveryReceipt() }
    }

    private var toolbar: some View {
        HStack(spacing: 8) {
            Image(systemName: "note.text")
            Button {
                isHovering.toggle()
                onHoverModeChanged(isHovering)
            } label: {
                Image(systemName: isHovering ? "pin.fill" : "pin.slash")
            }
            .fixedSize()
            .layoutPriority(10)
            .help(isHovering ? "Hover mode: keep this note above other windows" : "Desktop mode: keep this note on the desktop behind app windows")
            .accessibilityLabel(isHovering ? "Switch to Desktop mode" : "Switch to Hover mode")
            Text(document.title)
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .lineLimit(1)
            Spacer()
            if document.isDirty {
                Circle().fill(.orange).frame(width: 7, height: 7).help("Unsaved changes")
            }
            if document.kind == .hermesTask {
                Button(document.isEditing ? "Done" : "Edit") {
                    if document.isEditing && document.isDirty {
                        guard document.save() else { return }
                        onSaved()
                    }
                    document.isEditing.toggle()
                }
                .keyboardShortcut("e", modifiers: [.command])
            }
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
        .background(toolbarColor.opacity(0.88))
        .accessibilityValue(statusAccessibilityValue)
    }

    private var noteColor: Color {
        switch document.hermesState {
        case .started: Color(red: 0.55, green: 0.90, blue: 0.55)
        case .stalled: Color(red: 1.0, green: 0.55, blue: 0.50)
        case .notQueued, .queued, .completed: Color(red: 1.0, green: 0.94, blue: 0.42)
        }
    }

    private var toolbarColor: Color {
        switch document.hermesState {
        case .started: Color(red: 0.25, green: 0.72, blue: 0.30)
        case .stalled: Color(red: 0.90, green: 0.28, blue: 0.24)
        case .notQueued, .queued, .completed: Color(red: 0.98, green: 0.85, blue: 0.18)
        }
    }

    private var statusAccessibilityValue: String {
        document.kind == .regular ? "Regular note" : "Hermes task \(document.hermesState.rawValue)"
    }
}
