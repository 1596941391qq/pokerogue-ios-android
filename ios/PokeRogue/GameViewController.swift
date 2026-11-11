import UIKit
import WebKit

/// Full-screen WKWebView that runs the bundled offline build of PokeRogue.
/// Saves live in the web view's localStorage (persistent across launches and updates);
/// "Export Data" in the game writes a .prsv file to the app's Documents folder
/// (visible in the Files app) and opens the share sheet.
final class GameViewController: UIViewController {
    private var webView: WKWebView!
    private let schemeHandler = BundleSchemeHandler()
    private var downloadTargets: [ObjectIdentifier: URL] = [:]

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemeHandler, forURLScheme: BundleSchemeHandler.scheme)
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        config.userContentController.addUserScript(WKUserScript(
            source: Self.noSelectionCSS, injectionTime: .atDocumentEnd, forMainFrameOnly: true
        ))
        #if DEBUG
        // Mirror console output and uncaught errors into the system log (Xcode / `log stream`).
        config.userContentController.add(ConsoleLogger(), name: "console")
        config.userContentController.addUserScript(WKUserScript(
            source: ConsoleLogger.script, injectionTime: .atDocumentStart, forMainFrameOnly: true
        ))
        // Dev hook: `SIMCTL_CHILD_PRS_SELFTEST_JS=/path/test.js xcrun simctl launch …` injects a test script.
        if let path = ProcessInfo.processInfo.environment["PRS_SELFTEST_JS"],
           let js = try? String(contentsOfFile: path, encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(
                source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true
            ))
        }
        #endif

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0x48 / 255, green: 0x40 / 255, blue: 0x50 / 255, alpha: 1)
        webView.allowsLinkPreview = false
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        // The game handles notches itself via viewport-fit=cover + env(safe-area-inset-*).
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: BundleSchemeHandler.startURL))
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true // don't dim the screen mid-battle
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        UIDevice.current.userInterfaceIdiom == .pad ? .all : .allButUpsideDown
    }

    /// Stop long-presses from selecting text or popping up callouts over the
    /// touch controls, while keeping text fields usable.
    private static let noSelectionCSS = """
    (function () {
      var style = document.createElement('style');
      style.textContent = 'html, body, canvas, div { -webkit-user-select: none; user-select: none;' +
        ' -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }' +
        ' input, textarea { -webkit-user-select: text; user-select: text; }';
      document.head.appendChild(style);
    })();
    """

    // MARK: - Helpers

    private func openExternally(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return }
        UIApplication.shared.open(url)
    }

    private func presentShareSheet(for file: URL) {
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
        topPresenter.present(sheet, animated: true)
    }

    private var topPresenter: UIViewController {
        var vc: UIViewController = self
        while let next = vc.presentedViewController { vc = next }
        return vc
    }

    private var exportDirectory: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }
}

// MARK: - Navigation & downloads

extension GameViewController: WKNavigationDelegate, WKDownloadDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.cancel)
            return
        }
        switch scheme {
        case BundleSchemeHandler.scheme, "blob", "data", "about":
            decisionHandler(.allow)
        default:
            // Wiki / Discord / GitHub links: hand them to Safari instead of leaving the game.
            if navigationAction.targetFrame?.isMainFrame ?? true {
                openExternally(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let name = suggestedFilename.isEmpty ? "pokerogue-export.prsv" : suggestedFilename
        let target = exportDirectory.appendingPathComponent(name)
        try? FileManager.default.removeItem(at: target)
        downloadTargets[ObjectIdentifier(download)] = target
        completionHandler(target)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloadTargets.removeValue(forKey: ObjectIdentifier(download)) else { return }
        presentShareSheet(for: file)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadTargets.removeValue(forKey: ObjectIdentifier(download))
        let alert = UIAlertController(title: "导出失败 / Export failed", message: error.localizedDescription, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        topPresenter.present(alert, animated: true)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // iOS killed the web process (usually memory pressure). Saves are in localStorage, so just reload.
        webView.load(URLRequest(url: BundleSchemeHandler.startURL))
    }
}

// MARK: - window.open / alert / confirm / prompt

extension GameViewController: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url { openExternally(url) }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        topPresenter.present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        topPresenter.present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        topPresenter.present(alert, animated: true)
    }
}

#if DEBUG
private final class ConsoleLogger: NSObject, WKScriptMessageHandler {
    static let script = """
    (function () {
      function send(level, args) {
        try {
          var text = Array.prototype.map.call(args, function (a) {
            if (a instanceof Error) return a.stack || String(a);
            if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
            return String(a);
          }).join(' ');
          window.webkit.messageHandlers.console.postMessage(level + ': ' + text);
        } catch (e) {}
      }
      ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
        var orig = console[level];
        console[level] = function () { send(level, arguments); return orig.apply(console, arguments); };
      });
      window.addEventListener('error', function (e) { send('uncaught', [e.message + ' @ ' + e.filename + ':' + e.lineno]); });
      window.addEventListener('unhandledrejection', function (e) { send('unhandledrejection', [e.reason]); });
    })();
    """

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        NSLog("[PokeRogue JS] %@", String(describing: message.body))
    }
}
#endif
