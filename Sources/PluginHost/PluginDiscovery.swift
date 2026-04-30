import Foundation
import PluginSDK

public struct DiscoveredPlugin: Sendable {
    public let manifest: PluginManifest
    public let installURL: URL

    public init(manifest: PluginManifest, installURL: URL) {
        self.manifest = manifest
        self.installURL = installURL
    }
}

public enum PluginDiscoveryError: LocalizedError, Equatable {
    case missingEntryExecutable(String)

    public var errorDescription: String? {
        switch self {
        case .missingEntryExecutable(let pluginID):
            return "Plugin entry executable is missing for \(pluginID)."
        }
    }
}

public enum PluginDiscovery {
    public static func discover(at rootURL: URL) throws -> [DiscoveredPlugin] {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: rootURL.path) else {
            return []
        }

        let childURLs = try fileManager.contentsOfDirectory(
            at: rootURL,
            includingPropertiesForKeys: nil
        )

        return try childURLs.compactMap { pluginURL in
            let manifestURL = pluginURL.appendingPathComponent("plugin.json")
            guard fileManager.fileExists(atPath: manifestURL.path) else {
                return nil
            }
            let data = try Data(contentsOf: manifestURL)
            let manifest = try JSONDecoder().decode(PluginManifest.self, from: data)
            try PluginValidator.validate(manifest)
            let executableURL = pluginURL.appendingPathComponent(manifest.entryExecutable)
            guard fileManager.fileExists(atPath: executableURL.path) else {
                throw PluginDiscoveryError.missingEntryExecutable(manifest.id)
            }
            return DiscoveredPlugin(manifest: manifest, installURL: pluginURL)
        }
    }
}
