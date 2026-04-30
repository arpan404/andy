import AssistantTypes
import Foundation

public struct PluginContext: Sendable {
    public let pluginID: String
    public let installURL: URL

    public init(pluginID: String, installURL: URL) {
        self.pluginID = pluginID
        self.installURL = installURL
    }
}

public protocol Plugin: Sendable {
    var manifest: PluginManifest { get }
}

public protocol PluginToolProvider: Plugin {
    func makeTools(context: PluginContext) -> [any ToolAdapter]
}

public struct RegisteredPlugin {
    public let manifest: PluginManifest
    public let installURL: URL
    public let toolAdapters: [any ToolAdapter]

    public init(
        manifest: PluginManifest,
        installURL: URL,
        toolAdapters: [any ToolAdapter] = []
    ) {
        self.manifest = manifest
        self.installURL = installURL
        self.toolAdapters = toolAdapters
    }
}
