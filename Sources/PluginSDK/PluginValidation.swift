import Foundation

public enum PluginValidationError: LocalizedError, Equatable {
    case emptyID
    case emptyVersion
    case emptyEntryExecutable
    case duplicateToolID(String)

    public var errorDescription: String? {
        switch self {
        case .emptyID:
            return "Plugin manifest ID cannot be empty."
        case .emptyVersion:
            return "Plugin manifest version cannot be empty."
        case .emptyEntryExecutable:
            return "Plugin manifest entry executable cannot be empty."
        case .duplicateToolID(let id):
            return "Duplicate plugin tool ID: \(id)"
        }
    }
}

public enum PluginValidator {
    public static func validate(_ manifest: PluginManifest) throws {
        guard !manifest.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw PluginValidationError.emptyID
        }
        guard !manifest.version.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw PluginValidationError.emptyVersion
        }
        guard !manifest.entryExecutable.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw PluginValidationError.emptyEntryExecutable
        }

        var seen = Set<String>()
        for tool in manifest.tools {
            let inserted = seen.insert(tool.id).inserted
            if !inserted {
                throw PluginValidationError.duplicateToolID(tool.id)
            }
        }
    }
}
