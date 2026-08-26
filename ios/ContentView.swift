import SwiftUI
import WebKit
import Combine  // @Published / ObservableObject live here

// Your production URL. Change this one line if the deploy URL ever changes.
private let siteURL = URL(string: "https://jarvis-1-0.vercel.app/")!

// Brand palette.
private let brandDark = Color(red: 4 / 255, green: 6 / 255, blue: 10 / 255)   // #04060a
private let brandInk  = Color(red: 4 / 255, green: 20 / 255, blue: 13 / 255)  // #04140d (on-mint text)
private let mint      = Color(red: 110 / 255, green: 231 / 255, blue: 183 / 255) // #6EE7B7

// MARK: - Gem drawn in code (no image asset needed)

/// The Vitality gem, rendered from its facet polygons so it never depends on an
/// asset-catalog image resolving correctly. Coordinate space is the original
/// SVG's 460×460 box with origin (282, 328).
struct GemMark: View {
    private static let facets: [([CGPoint], Color)] = [
        // base silhouette (drawn first, painter's order)
        ([CGPoint(x: 392, y: 372), CGPoint(x: 632, y: 372), CGPoint(x: 724, y: 470),
          CGPoint(x: 512, y: 744), CGPoint(x: 300, y: 470)], Color(red: 31 / 255, green: 77 / 255, blue: 61 / 255)),
        ([CGPoint(x: 392, y: 372), CGPoint(x: 300, y: 470), CGPoint(x: 392, y: 470)],
         Color(red: 167 / 255, green: 243 / 255, blue: 208 / 255)),
        ([CGPoint(x: 392, y: 372), CGPoint(x: 632, y: 372), CGPoint(x: 632, y: 470), CGPoint(x: 392, y: 470)],
         Color(red: 201 / 255, green: 247 / 255, blue: 225 / 255)),
        ([CGPoint(x: 632, y: 372), CGPoint(x: 724, y: 470), CGPoint(x: 632, y: 470)],
         Color(red: 70 / 255, green: 180 / 255, blue: 136 / 255)),
        ([CGPoint(x: 300, y: 470), CGPoint(x: 392, y: 470), CGPoint(x: 512, y: 744)],
         Color(red: 110 / 255, green: 231 / 255, blue: 183 / 255)),
        ([CGPoint(x: 392, y: 470), CGPoint(x: 512, y: 470), CGPoint(x: 512, y: 744)],
         Color(red: 70 / 255, green: 180 / 255, blue: 136 / 255)),
        ([CGPoint(x: 512, y: 470), CGPoint(x: 632, y: 470), CGPoint(x: 512, y: 744)],
         Color(red: 31 / 255, green: 77 / 255, blue: 61 / 255)),
        ([CGPoint(x: 632, y: 470), CGPoint(x: 724, y: 470), CGPoint(x: 512, y: 744)],
         Color(red: 31 / 255, green: 77 / 255, blue: 61 / 255)),
    ]

    var body: some View {
        Canvas { ctx, size in
            let s = min(size.width, size.height) / 460
            let ox = (size.width - 460 * s) / 2
            let oy = (size.height - 460 * s) / 2
            func map(_ p: CGPoint) -> CGPoint { CGPoint(x: ox + (p.x - 282) * s, y: oy + (p.y - 328) * s) }
            for (pts, color) in GemMark.facets {
                var path = Path()
                path.move(to: map(pts[0]))
                for p in pts.dropFirst() { path.addLine(to: map(p)) }
                path.closeSubpath()
                ctx.fill(path, with: .color(color))
            }
        }
    }
}

/// The gem flipping in 3D around its vertical axis — like a real gem catching
/// the light. It IS the loading indicator.
struct SpinningGem: View {
    @State private var flip = false
    var body: some View {
        GemMark()
            .frame(width: 116, height: 116)
            .rotation3DEffect(
                .degrees(flip ? 360 : 0),
                axis: (x: 0, y: 1, z: 0),   // spin around the vertical axis
                perspective: 0.55            // a little depth so the flip reads as 3D
            )
            .animation(.linear(duration: 1.8).repeatForever(autoreverses: false), value: flip)
            .onAppear { flip = true }
    }
}

// MARK: - Web model

/// Owns the WKWebView and publishes its state so SwiftUI can swap between the
/// splash, the offline screen, and the live site. Keeping the web view here
/// (rather than recreating it) lets the retry button just reload in place.
final class WebModel: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    @Published var isLoading = true
    @Published var failed = false
    let webView: WKWebView

    override init() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true                 // video plays in place, not fullscreen
        config.mediaTypesRequiringUserActionForPlayback = []    // camera can start without an extra tap
        config.websiteDataStore = .default()                    // cookies + localStorage survive relaunch
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true      // swipe-from-edge to go back
        webView.scrollView.contentInsetAdjustmentBehavior = .never // let the site's own safe-area CSS win
        webView.isOpaque = false
        webView.backgroundColor = .black
        load()
    }

    /// (Re)load the site — used on launch and by the Try-again button.
    func load() {
        failed = false
        isLoading = true
        webView.load(URLRequest(url: siteURL))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoading = false
        failed = false
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showFailure(error)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showFailure(error)
    }
    private func showFailure(_ error: Error) {
        // -999 = a load was cancelled/superseded (e.g. a redirect) — not a real failure.
        if (error as NSError).code == NSURLErrorCancelled { return }
        isLoading = false
        failed = true
    }

    // Keep popups / target=_blank navigations inside the same web view.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }

    // Auto-grant the camera/mic prompt inside the web view (iOS still shows the
    // one-time system permission dialog the first time).
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }
}

// MARK: - Screens

struct ContentView: View {
    @StateObject private var model = WebModel()

    var body: some View {
        ZStack {
            brandDark.ignoresSafeArea() // dark base behind everything

            WebContainer(webView: model.webView)
                .ignoresSafeArea()
                .opacity(model.isLoading || model.failed ? 0 : 1) // reveal only when loaded

            if model.isLoading && !model.failed {
                SplashView()
                    .transition(.opacity)
            }
            if model.failed {
                OfflineView(retry: { model.load() })
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.35), value: model.isLoading)
        .animation(.easeOut(duration: 0.25), value: model.failed)
    }
}

/// Thin wrapper that hands the model's web view to SwiftUI.
struct WebContainer: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ webView: WKWebView, context: Context) {}
}

/// The pulsing gem on the brand background, shown until the web app finishes loading.
struct SplashView: View {
    var body: some View {
        ZStack {
            brandDark.ignoresSafeArea()
            SpinningGem() // the spinning gem is the loader — no separate spinner
        }
    }
}

/// Shown when the site can't be reached — gem + message + a native Try-again button.
struct OfflineView: View {
    let retry: () -> Void

    var body: some View {
        ZStack {
            brandDark.ignoresSafeArea()
            VStack(spacing: 18) {
                GemMark()
                    .frame(width: 88, height: 88)
                    .opacity(0.9)
                Text("Can’t reach Vitality")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(.white)
                Text("Check your internet connection and try again.")
                    .font(.system(size: 15))
                    .foregroundColor(.white.opacity(0.6))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)
                Button(action: retry) {
                    Text("Try again")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(brandInk)
                        .padding(.horizontal, 28)
                        .padding(.vertical, 13)
                        .background(mint)
                        .clipShape(Capsule())
                }
                .padding(.top, 6)
            }
        }
    }
}
