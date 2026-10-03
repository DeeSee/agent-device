import AgentDeviceSnapshotPresentation
import XCTest
#if canImport(UIKit)
import UIKit
#endif

extension RunnerTests {
  static let navigationBackKeywords = ["back", "close", "cancel"]
  static let navigationSheetDismissIdentifierTokenGroups = [
    ["grabber"],
    ["dismiss"],
    ["drag", "handle"],
    ["drag", "indicator"],
    ["drag", "sheet"],
    ["drag", "slider"],
    ["sheet", "handle"],
  ]

  @MainActor
  func activateInAppBackControl(app: XCUIApplication) -> RunnerInteractionOutcome? {
#if os(macOS)
    if let back = macOSNavigationBackElement(app: app) {
      tapElementCenter(app: app, element: back)
      return .performed
    }
    return nil
#elseif os(tvOS)
    _ = pressTvRemote(.menu)
    return .performed
#else
    let buttons = app.navigationBars.buttons.allElementsBoundByIndex
    let localizedTitles = Self.localizedNavigationSystemNames()
    if let back = bestNavigationBackElement(
      in: buttons,
      localizedDismissTitles: localizedTitles.dismiss,
      localizedDoneTitle: localizedTitles.done
    ) {
      if Self.isNavigationSheetDismissIdentifier(back.identifier) {
        return activateElementSemantically(back)
      }
      return activateElement(app: app, element: back, action: "in-app back")
    }
    if isSnapshotXCTestChannelPenalized(bundleId: mainOwned.bundleId) {
      NSLog("AGENT_DEVICE_RUNNER_IN_APP_BACK_SKIPPED_XCTEST_ENUMERATION bundle=%@", mainOwned.bundleId ?? "")
    } else if let back = navigationBackElement(app: app) {
      if Self.isNavigationSheetDismissIdentifier(back.identifier) {
        return activateElementSemantically(back)
      }
      return activateElement(app: app, element: back, action: "in-app back")
    }
    return nil
#endif
  }

  private func tapElementCenter(app: XCUIApplication, element: XCUIElement) {
    let frame = element.frame
    if !frame.isEmpty {
      _ = tapAt(app: app, x: frame.midX, y: frame.midY)
      return
    }
#if !os(tvOS)
    element.tap()
#endif
  }

  private func navigationBackElement(app: XCUIApplication) -> XCUIElement? {
#if os(iOS)
    let frame = onScreenWindowFrame(app: app)
    let buttons = app.buttons.matching(Self.navigationBackPredicate()).allElementsBoundByIndex
    return bestNavigationBackElement(in: buttons, navigationWindow: frame)
#else
    return nil
#endif
  }

  private func bestNavigationBackElement(
    in elements: [XCUIElement],
    navigationWindow: CGRect? = nil,
    localizedDismissTitles: [String] = [],
    localizedDoneTitle: String? = nil
  ) -> XCUIElement? {
    let actionable = elements.filter { element in
      guard element.exists, element.isEnabled, element.isHittable else { return false }
      if let navigationWindow,
         !Self.isNavigationChromeControlFrame(element.frame, in: navigationWindow)
      {
        return false
      }
      return true
    }
    let candidates = actionable.compactMap {
      element -> (XCUIElement, Int)? in
      guard let rank = Self.navigationBackControlRank(
        label: element.label,
        identifier: element.identifier,
        localizedDismissTitles: localizedDismissTitles,
        localizedDoneTitle: localizedDoneTitle,
        isSoleNavigationButton: actionable.count == 1
      ) else {
        return nil
      }
      return (element, rank)
    }
    return candidates.sorted { lhs, rhs in
      if lhs.1 != rhs.1 { return lhs.1 < rhs.1 }
      let leftFrame = lhs.0.frame
      let rightFrame = rhs.0.frame
      if leftFrame.minY != rightFrame.minY { return leftFrame.minY < rightFrame.minY }
      return leftFrame.minX < rightFrame.minX
    }.first?.0
  }

  static func navigationBackPredicate() -> NSPredicate {
    var clauses = navigationBackKeywords.flatMap { _ in
      ["label CONTAINS[c] %@", "identifier CONTAINS[c] %@"]
    }
    var arguments = navigationBackKeywords.flatMap { [$0, $0] }
    for group in navigationSheetDismissIdentifierTokenGroups {
      clauses.append(
        group.map { _ in "identifier CONTAINS[c] %@" }.joined(separator: " AND ")
      )
      arguments.append(contentsOf: group)
    }
    return NSPredicate(format: clauses.joined(separator: " OR "), argumentArray: arguments)
  }

  static func navigationBackControlRank(
    label: String,
    identifier: String,
    localizedDismissTitles: [String] = [],
    localizedDoneTitle: String? = nil,
    isSoleNavigationButton: Bool = false
  ) -> Int? {
    let labelTokens = navigationBackTokens(label)
    let identifierTokens = navigationBackTokens(identifier)
    if let rank = navigationBackKeywords.firstIndex(where: {
      labelTokens.contains($0) || identifierTokens.contains($0)
    }) {
      return rank
    }
    if navigationTitle(label, matchesAny: localizedDismissTitles) {
      return navigationBackKeywords.count
    }
    if isSoleNavigationButton,
       let localizedDoneTitle,
       navigationTitle(label, matchesAny: [localizedDoneTitle])
    {
      return navigationBackKeywords.count
    }
    return isNavigationSheetDismissIdentifier(identifier) ? navigationBackKeywords.count : nil
  }

  static func localizedNavigationSystemNames() -> (dismiss: [String], done: String?) {
#if os(iOS)
    func title(for item: UIBarButtonItem.SystemItem) -> String? {
      let button = UIBarButtonItem(
        barButtonSystemItem: item,
        target: nil,
        action: nil
      )
      return navigationSystemAccessibilityName(
        accessibilityLabel: button.accessibilityLabel,
        title: button.title
      )
    }
    return ([.cancel, .close].compactMap(title), title(for: .done))
#else
    return ([], nil)
#endif
  }

  static func navigationSystemAccessibilityName(
    accessibilityLabel: String?,
    title: String?
  ) -> String? {
    [accessibilityLabel, title].lazy.compactMap {
      $0?.trimmingCharacters(in: .whitespacesAndNewlines)
    }.first { !$0.isEmpty }
  }

  private static func navigationTitle(_ label: String, matchesAny titles: [String]) -> Bool {
    let normalizedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedLabel.isEmpty else { return false }
    return titles.contains {
      normalizedLabel.localizedCaseInsensitiveCompare($0) == .orderedSame
    }
  }

  static func isNavigationSheetDismissIdentifier(_ identifier: String) -> Bool {
    let identifierTokens = navigationBackTokens(identifier)
    return navigationSheetDismissIdentifierTokenGroups.contains(where: { group in
      group.allSatisfy(identifierTokens.contains)
    })
  }

  private static func navigationBackTokens(_ value: String) -> [String] {
    let camelSeparated = value.replacingOccurrences(
      of: "([a-z0-9])([A-Z])",
      with: "$1 $2",
      options: .regularExpression
    )
    return camelSeparated.lowercased().split {
      !$0.isLetter && !$0.isNumber
    }.map(String.init)
  }

  static func isNavigationChromeControlFrame(_ candidate: CGRect, in window: CGRect) -> Bool {
    guard SnapshotGeometry.isPositiveFinite(candidate), SnapshotGeometry.isPositiveFinite(window) else {
      return false
    }
    // Accept navigation chrome at either edge without matching back-like content controls.
    let depth = min(max(window.height * 0.22, 96), 180)
    let inTopChrome = candidate.midY >= window.minY && candidate.midY <= window.minY + depth
    let inBottomChrome = candidate.midY >= window.maxY - depth && candidate.midY <= window.maxY
    return inTopChrome || inBottomChrome
  }

  private func macOSNavigationBackElement(app: XCUIApplication) -> XCUIElement? {
    let predicate = NSPredicate(
      format: "identifier == %@ OR label == %@",
      "go back",
      "Back"
    )
    let element = app.descendants(matching: .any).matching(predicate).firstMatch
    return element.exists ? element : nil
  }
}
