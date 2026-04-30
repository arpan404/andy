import SwiftUI

public struct OnboardingView: View {
    public let onContinue: () -> Void

    public init(onContinue: @escaping () -> Void) {
        self.onContinue = onContinue
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Welcome to Andy")
                .font(.largeTitle.bold())
            Text("Set permissions, provider preferences, hotkey, and safety profile.")
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 8) {
                Label("Microphone and Speech", systemImage: "mic.fill")
                Label("Calendar and Reminders", systemImage: "calendar")
                Label("Automation (Mail/Messages)", systemImage: "bolt.horizontal")
                Label("Balanced safety profile", systemImage: "checkmark.shield")
            }
            .font(.headline)

            Button("Continue") {
                onContinue()
            }
            .buttonStyle(.borderedProminent)
            .padding(.top, 8)
        }
        .padding(28)
        .frame(minWidth: 700, minHeight: 460, alignment: .topLeading)
    }
}
