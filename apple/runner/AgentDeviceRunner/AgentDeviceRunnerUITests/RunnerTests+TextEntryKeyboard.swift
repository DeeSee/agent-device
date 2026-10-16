import XCTest

extension RunnerTests {
#if os(iOS)
  @MainActor
  func prepareKeyboardForSecureASCIIText(app: XCUIApplication, text: String) -> Bool {
    let asciiLetters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
    guard text.unicodeScalars.allSatisfy({ $0.isASCII }),
      text.rangeOfCharacter(from: asciiLetters) != nil,
      isKeyboardVisible(app: app)
    else { return true }
    let secureInput = app.secureTextFields.matching(NSPredicate(format: "hasKeyboardFocus == 1")).firstMatch
    guard secureInput.exists else { return true }

    var visitedLayouts: Set<String> = []
    while true {
      guard let keyboard = try? app.keyboards.firstMatch.snapshot() else {
        NSLog("AGENT_DEVICE_RUNNER_TEXT_ENTRY_KEYBOARD outcome=snapshot_unavailable")
        return false
      }
      let letters = Set(keyboardLetters(keyboard))
      if letters.isEmpty || letters.contains(where: { $0.rangeOfCharacter(from: asciiLetters) != nil }) { return true }
      let nextKeyboard = app.buttons["Next keyboard"]
      guard nextKeyboard.exists else {
        NSLog("AGENT_DEVICE_RUNNER_TEXT_ENTRY_KEYBOARD outcome=no_switch_control")
        return false
      }
      let layout = letters.sorted().joined() + "|" + (nextKeyboard.value as? String ?? "")
      // XCTest can acknowledge Latin text while a secure field on a non-Latin keyboard drops it.
      guard visitedLayouts.insert(layout).inserted else {
        NSLog("AGENT_DEVICE_RUNNER_TEXT_ENTRY_KEYBOARD outcome=no_ascii_layout layouts=%d", visitedLayouts.count)
        return false
      }
      nextKeyboard.tap()
      NSLog("AGENT_DEVICE_RUNNER_TEXT_ENTRY_KEYBOARD outcome=switched layouts=%d", visitedLayouts.count)
    }
  }

  private func keyboardLetters(_ snapshot: XCUIElementSnapshot) -> [String] {
    if snapshot.elementType == .key, snapshot.label.count == 1,
      snapshot.label.rangeOfCharacter(from: .letters) != nil {
      return [snapshot.label.lowercased()]
    }
    return snapshot.children.flatMap(keyboardLetters)
  }
#endif
}
