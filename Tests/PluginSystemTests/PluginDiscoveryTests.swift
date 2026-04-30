import Foundation
import PluginHost
import Testing

@Test
func discoversInstalledPluginManifest() throws {
    let pluginsRootURL = try fixtureURL(
        components: ["Fixtures"]
    )
    let discovered = try PluginDiscovery.discover(at: pluginsRootURL)

    #expect(discovered.count == 1)
    #expect(discovered.first?.manifest.id == "com.andy.example-plugin")
}
