import AppKit
import Foundation

@MainActor
public final class HotkeyMonitor {
    private var monitor: Any?
    private let handler: () -> Void

    public init(handler: @escaping () -> Void) {
        self.handler = handler
    }

    public func start() {
        guard monitor == nil else { return }
        monitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "k" else {
                return
            }
            self?.handler()
        }
    }

    public func stop() {
        guard let monitor else { return }
        NSEvent.removeMonitor(monitor)
        self.monitor = nil
    }
}
