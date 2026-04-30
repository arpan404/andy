import AssistantTypes
import SwiftUI

public struct AssistantRootView: View {
    @StateObject private var viewModel: AssistantAppViewModel

    public init(viewModel: AssistantAppViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel)
    }

    public var body: some View {
        if !viewModel.onboardingComplete {
            OnboardingView {
                viewModel.completeOnboarding()
            }
        }
        else {
            mainLayout
        }
    }

    private var mainLayout: some View {
        HStack(spacing: 12) {
            conversationPane
            rightPane
        }
        .padding(16)
        .frame(minWidth: 1100, minHeight: 760)
    }

    private var conversationPane: some View {
        VStack(spacing: 10) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(viewModel.messages) { message in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(message.role.rawValue.uppercased())
                                .font(.caption.bold())
                                .foregroundStyle(.secondary)
                            Text(message.content)
                                .textSelection(.enabled)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.gray.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                }
            }
            HStack {
                TextField("Ask Andy…", text: $viewModel.draftInput)
                    .textFieldStyle(.roundedBorder)
                Button("Send") {
                    viewModel.submitText()
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }

    private var rightPane: some View {
        VStack(alignment: .leading, spacing: 12) {
            voiceCard
            approvalsCard
            timelineCard
        }
        .frame(width: 360)
    }

    private var voiceCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Voice")
                .font(.headline)
            Text("State: \(viewModel.voiceState.rawValue)")
                .foregroundStyle(.secondary)
            HStack {
                Button("PTT Start") { viewModel.pushToTalkStart() }
                Button("PTT Stop") { viewModel.pushToTalkStop() }
            }
        }
        .padding(12)
        .background(Color.gray.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var approvalsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Pending Approvals")
                .font(.headline)
            if viewModel.pendingApprovals.isEmpty {
                Text("No pending actions.")
                    .foregroundStyle(.secondary)
            }
            else {
                ForEach(viewModel.pendingApprovals) { approval in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(approval.action.details)
                            .font(.subheadline)
                        Text(approval.action.risk.rawValue)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button("Approve") {
                            viewModel.approve(actionID: approval.id)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .padding(12)
        .background(Color.gray.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var timelineCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Activity")
                .font(.headline)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(viewModel.timeline.enumerated()), id: \.offset) { _, entry in
                        Text(entry)
                            .font(.caption)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .padding(12)
        .background(Color.gray.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
