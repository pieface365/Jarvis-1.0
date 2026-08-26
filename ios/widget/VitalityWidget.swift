import WidgetKit
import SwiftUI

// A static widget — it never needs to change, it just sits there looking like
// the gem and opens the Vitality app when tapped (that's the default behavior
// of a StaticConfiguration widget; no deep link needed).

struct GemEntry: TimelineEntry { let date = Date() }

struct GemProvider: TimelineProvider {
    func placeholder(in context: Context) -> GemEntry { GemEntry() }
    func getSnapshot(in context: Context, completion: @escaping (GemEntry) -> Void) {
        completion(GemEntry())
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<GemEntry>) -> Void) {
        // One entry, never reload — it's a static launcher.
        completion(Timeline(entries: [GemEntry()], policy: .never))
    }
}

struct VitalityWidgetView: View {
    @Environment(\.widgetFamily) var family

    // Brand near-black for the home-screen tile background.
    private let brandDark = Color(red: 4 / 255, green: 6 / 255, blue: 10 / 255)

    var body: some View {
        switch family {
        case .accessoryCircular:
            // Lock Screen: iOS forces a monochrome/vibrant render, so we feed it a
            // clean white gem silhouette and let the system tint it.
            ZStack {
                AccessoryWidgetBackground()
                Image("GemGlyph")
                    .resizable()
                    .scaledToFit()
                    .padding(8)
            }
            .widgetAccentable()
            .containerBackground(.clear, for: .widget)

        default:
            // Home Screen (systemSmall): full-color gem on the brand background.
            Image("GemColor")
                .resizable()
                .scaledToFit()
                .padding(20)
                .containerBackground(for: .widget) { brandDark }
        }
    }
}

@main
struct VitalityWidget: Widget {
    let kind = "VitalityWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: GemProvider()) { _ in
            VitalityWidgetView()
        }
        .configurationDisplayName("Vitality")
        .description("Tap the gem to open Vitality.")
        .supportedFamilies([.systemSmall, .accessoryCircular])
    }
}
