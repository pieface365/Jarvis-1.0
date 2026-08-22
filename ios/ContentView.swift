import SwiftUI
import WebKit

// Your production URL. Change this one line if the deploy URL ever changes.
private let siteURL = URL(string: "https://jarvis-1-0.vercel.app/")!

// Brand near-black (#04060a) — matches the dashboard background so there's no flash.
private let brandDark = Color(red: 4 / 255, green: 6 / 255, blue: 10 / 255)

struct ContentView: View {
    @State private var isLoading = true

    var body: some View {
        ZStack {
            brandDark.ignoresSafeArea() // dark base behind everything

            WebView(url: siteURL, isLoading: $isLoading)
                .ignoresSafeArea()
                .opacity(isLoading ? 0 : 1) // reveal the site once it's painted

            if isLoading {
                SplashView()
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.35), value: isLoading)
    }
}

// The gem logo on the brand background, shown until the web app finishes loading.
struct SplashView: View {
    var body: some View {
        ZStack {
            brandDark.ignoresSafeArea()
            VStack(spacing: 26) {
                Image("SplashLogo")           // asset added in Assets.xcassets
                    .resizable()
                    .scaledToFit()
                    .frame(width: 132, height: 132)
                ProgressView()
                    .tint(Color(red: 110 / 255, green: 231 / 255, blue: 183 / 255)) // #6EE7B7 mint
            }
        }
    }
}

/// A full-screen WKWebView that behaves like the app:
/// - persists login / localStorage across launches
/// - allows the camera (closet snap, fuel barcode + plate scanner) and inline video
/// - keeps target=_blank links inside the app instead of dropping them
/// - reports first paint so the splash can fade out
struct WebView: UIViewRepresentable {
    let url: URL
    @Binding var isLoading: Bool

    func makeCoordinator() -> Coordinator { Coordinator(isLoading: $isLoading) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true                 // video plays in place, not fullscreen
        config.mediaTypesRequiringUserActionForPlayback = []    // camera can start without an extra tap
        config.websiteDataStore = .default()                    // cookies + localStorage survive relaunch

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true      // swipe-from-edge to go back
        webView.scrollView.contentInsetAdjustmentBehavior = .never // let the site's own safe-area CSS win
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        @Binding var isLoading: Bool
        init(isLoading: Binding<Bool>) { _isLoading = isLoading }

        // Site finished painting → drop the splash.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            isLoading = false
        }

        // If the first load fails (e.g. offline), don't trap the user on the splash.
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            isLoading = false
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            isLoading = false
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
}
