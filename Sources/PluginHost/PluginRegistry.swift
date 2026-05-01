import AssistantTypes
import Foundation
import Observability
import PluginSDK
import ToolEngine

@MainActor
public final class PluginRegistry {
    private let observability: ObservabilityStore
    private var registeredPlugins: [String: RegisteredPlugin] = [:]

    public init(observability: ObservabilityStore) {
        self.observability = observability
    }

    public func register(
        provider: any PluginToolProvider,
        installURL: URL
    ) async throws {
        let context = PluginContext(
            pluginID: provider.manifest.id,
            installURL: installURL
        )
        let plugin = RegisteredPlugin(
            manifest: provider.manifest,
            installURL: installURL,
            toolAdapters: provider.makeTools(context: context)
        )
        try await register(plugin)
    }

    public func register(_ plugin: RegisteredPlugin) async throws {
        try PluginValidator.validate(plugin.manifest)
        registeredPlugins[plugin.manifest.id] = plugin
        await observability.append(
            name: "plugin.registered",
            details: plugin.manifest.id
        )
    }

    public func loadDiscoveredPlugins(from rootURL: URL) async throws {
        let discovered = try PluginDiscovery.discover(at: rootURL)
        for item in discovered {
            let plugin = RegisteredPlugin(
                manifest: item.manifest,
                installURL: item.installURL
            )
            try await register(plugin)
        }
    }

    public func allManifests() -> [PluginManifest] {
        registeredPlugins.values
            .map(\.manifest)
            .sorted(by: { $0.id < $1.id })
    }

    public func allToolAdapters() -> [any ToolAdapter] {
        registeredPlugins.values.flatMap(\.toolAdapters)
    }
}

public enum PluginHostBootstrap {
    @MainActor
    public static func registerTools(
        from registry: PluginRegistry,
        into toolEngine: ToolEngine
    ) {
        let adapters = registry.allToolAdapters()
        for adapter in adapters {
            toolEngine.register(adapter)
        }
    }
}
