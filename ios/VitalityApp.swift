import SwiftUI

// Entry point. One window, one full-screen web view of your live site.
@main
struct VitalityApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .ignoresSafeArea()          // let the web app paint edge-to-edge
                .preferredColorScheme(.dark) // matches the dashboard's dark chrome
        }
    }
}
