import AppKit
import AssistantTypes
import Foundation
import Observability

public struct MailToolAdapter: IntegrationToolAdapter {
    public let toolID = "mail.compose"
    public let schema: [String: String] = [
        "to": "recipient email",
        "subject": "subject",
        "body": "message body",
    ]

    private let observability: ObservabilityStore

    public init(observability: ObservabilityStore) {
        self.observability = observability
    }

    public func execute(input: [String: String], context: ToolContext) async throws -> ToolOutput {
        let to = input["to"] ?? ""
        let subject = input["subject"] ?? ""
        let body = input["body"] ?? ""
        await observability.append(name: "tool.mail.execute", details: to)

        let script = """
            tell application "Mail"
                set newMessage to make new outgoing message with properties {subject:"\(subject)", content:"\(body)"}
                tell newMessage
                    make new to recipient at end of to recipients with properties {address:"\(to)"}
                    activate
                end tell
            end tell
            """

        let appleScript = NSAppleScript(source: script)
        var error: NSDictionary?
        _ = appleScript?.executeAndReturnError(&error)
        if error != nil {
            throw IntegrationError.permissionDenied("Mail automation")
        }

        return ToolOutput(
            data: ["status": "draft-opened", "to": to],
            sourceTrust: .trustedSystem,
            summary: "Mail draft opened for review."
        )
    }
}

public struct MessagesToolAdapter: IntegrationToolAdapter {
    public let toolID = "messages.send"
    public let schema: [String: String] = [
        "recipient": "phone or handle",
        "text": "message body",
    ]

    private let observability: ObservabilityStore

    public init(observability: ObservabilityStore) {
        self.observability = observability
    }

    public func execute(input: [String: String], context: ToolContext) async throws -> ToolOutput {
        let recipient = input["recipient"] ?? ""
        let text = input["text"] ?? ""
        await observability.append(name: "tool.messages.execute", details: recipient)

        let script = """
            tell application "Messages"
                set targetService to 1st service whose service type = iMessage
                set targetBuddy to buddy "\(recipient)" of targetService
                send "\(text)" to targetBuddy
            end tell
            """

        let appleScript = NSAppleScript(source: script)
        var error: NSDictionary?
        _ = appleScript?.executeAndReturnError(&error)
        if error != nil {
            throw IntegrationError.permissionDenied("Messages automation")
        }

        return ToolOutput(
            data: ["status": "sent", "recipient": recipient],
            sourceTrust: .trustedSystem,
            summary: "Message sent through Messages."
        )
    }
}
