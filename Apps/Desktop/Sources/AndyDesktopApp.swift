import AppShell
import MemoryStore
import SwiftData
import SwiftUI

@main
struct AndyDesktopApp: App {
    private let modelContainer: ModelContainer
    private let rootViewModel: AssistantAppViewModel

    init() {
        do {
            modelContainer = try ModelContainer(for: MemoryEntity.self)
            rootViewModel = AssistantAppContainer.makeViewModel(context: modelContainer.mainContext)
        }
        catch {
            fatalError("Unable to initialize ModelContainer: \(error)")
        }
    }

    var body: some Scene {
        WindowGroup {
            AssistantRootView(viewModel: rootViewModel)
                .modelContainer(modelContainer)
        }
    }
}
