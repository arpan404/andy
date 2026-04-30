import Foundation
import PluginSDK
import Testing

@Test
func decodesPluginManifestFixture() throws {
    let fixtureURL = try fixtureURL(
        components: ["Fixtures", "ExamplePlugin", "plugin.json"]
    )
    let data = try Data(contentsOf: fixtureURL)
    let manifest = try JSONDecoder().decode(PluginManifest.self, from: data)

    #expect(manifest.id == "com.andy.example-plugin")
    #expect(manifest.capabilities.contains(.toolProvider))
    #expect(manifest.tools.count == 1)
    #expect(manifest.bundledSkills == ["meeting-brief"])
}
