import Foundation

private final class StickyPadBundleToken {}

enum TaskTemplate {
    static let fileName = "Hermes-Task-Template.md"

    static var content: String {
        let bundle = Bundle(for: StickyPadBundleToken.self)
        if let url = bundle.url(forResource: "Hermes-Task-Template", withExtension: "md"),
           let value = try? String(contentsOf: url, encoding: .utf8) {
            return value
        }
        return fallback
    }

    private static let fallback = """
    # [PROJECT NAME] AUTONOMOUS BUILD LOOP

    Fill every bracketed field. The agent must persist state, run Build → Review → Test → Review Again → Decide, and choose REPEAT whenever required evidence is missing. Completion requires the final regression gate to return ADVANCE.

    ## Role
    [ROLE]

    ## Goal
    [GOAL]

    ## Success criteria
    - [MEASURABLE RESULT]

    ## Constraints
    - [CONSTRAINT]
    """
}
