import AssistantTypes
import Foundation

public enum PluginCapabilityKind: String, Codable, Sendable {
    case toolProvider = "tool-provider"
    case modelProvider = "model-provider"
    case speechProvider = "speech-provider"
    case artifactProcessor = "artifact-processor"
    case eventSource = "event-source"
}

public enum PluginPermission: String, Codable, Sendable {
    case files
    case calendar
    case reminders
    case mailAutomation
    case messagesAutomation
    case microphone
    case speechRecognition
    case network
}

public struct PluginToolDescriptor: Codable, Sendable, Hashable {
    public let id: String
    public let description: String
    public let inputSchema: [String: String]
    public let outputSchema: [String: String]
    public let risk: ActionRisk
    public let sourceTrust: SourceTrust

    public init(
        id: String,
        description: String,
        inputSchema: [String: String],
        outputSchema: [String: String],
        risk: ActionRisk,
        sourceTrust: SourceTrust
    ) {
        self.id = id
        self.description = description
        self.inputSchema = inputSchema
        self.outputSchema = outputSchema
        self.risk = risk
        self.sourceTrust = sourceTrust
    }
}

public struct PluginProviderDescriptor: Codable, Sendable, Hashable {
    public let id: String
    public let kind: String
    public let description: String

    public init(id: String, kind: String, description: String) {
        self.id = id
        self.kind = kind
        self.description = description
    }
}

public struct PluginManifest: Codable, Sendable, Hashable {
    public let id: String
    public let version: String
    public let displayName: String
    public let description: String
    public let entryExecutable: String
    public let capabilities: [PluginCapabilityKind]
    public let tools: [PluginToolDescriptor]
    public let providers: [PluginProviderDescriptor]
    public let eventSources: [String]
    public let requiredPermissions: [PluginPermission]
    public let bundledSkills: [String]

    public init(
        id: String,
        version: String,
        displayName: String,
        description: String,
        entryExecutable: String,
        capabilities: [PluginCapabilityKind],
        tools: [PluginToolDescriptor] = [],
        providers: [PluginProviderDescriptor] = [],
        eventSources: [String] = [],
        requiredPermissions: [PluginPermission] = [],
        bundledSkills: [String] = []
    ) {
        self.id = id
        self.version = version
        self.displayName = displayName
        self.description = description
        self.entryExecutable = entryExecutable
        self.capabilities = capabilities
        self.tools = tools
        self.providers = providers
        self.eventSources = eventSources
        self.requiredPermissions = requiredPermissions
        self.bundledSkills = bundledSkills
    }

    enum CodingKeys: String, CodingKey {
        case id
        case version
        case displayName = "display_name"
        case description
        case entryExecutable = "entry_executable"
        case capabilities
        case tools
        case providers
        case eventSources = "event_sources"
        case requiredPermissions = "required_permissions"
        case bundledSkills = "bundled_skills"
    }
}
