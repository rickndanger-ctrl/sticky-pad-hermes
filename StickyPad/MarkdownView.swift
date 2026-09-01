import SwiftUI

struct MarkdownView: View {
    let markdown: String

    var body: some View {
        ScrollView {
            Text(rendered)
                .textSelection(.enabled)
                .font(.system(size: 14, design: .rounded))
                .foregroundStyle(Color(red: 0.20, green: 0.18, blue: 0.08))
                .lineSpacing(4)
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .padding(16)
        }
    }

    private var rendered: AttributedString {
        (try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .full)
        )) ?? AttributedString(markdown)
    }
}

