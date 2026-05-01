import Foundation

func fixtureURL(components: [String]) throws -> URL {
    let testFileURL = URL(fileURLWithPath: #filePath)
    let testsDirectory =
        testFileURL
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    return components.reduce(testsDirectory) { partialURL, component in
        partialURL.appendingPathComponent(component)
    }
}
