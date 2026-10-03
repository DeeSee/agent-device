import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  func testNavigationBackControlRankPrefersBackThenCloseThenCancel() {
    XCTAssertEqual(Self.navigationBackControlRank(label: "Back", identifier: ""), 0)
    XCTAssertEqual(Self.navigationBackControlRank(label: "Close", identifier: ""), 1)
    XCTAssertEqual(Self.navigationBackControlRank(label: "Cancel search", identifier: ""), 2)
    XCTAssertEqual(
      Self.navigationBackControlRank(
        label: "",
        identifier: "AccessibilityID_Omnibox_backButton"
      ),
      0
    )
    XCTAssertNil(Self.navigationBackControlRank(label: "Search for more feeds", identifier: ""))
  }

  func testNavigationBackControlRankRejectsNonBackNavigationButtons() {
    XCTAssertNil(Self.navigationBackControlRank(label: "Edit", identifier: "editButton"))
    XCTAssertNil(Self.navigationBackControlRank(label: "Feedback", identifier: "feedbackButton"))
    XCTAssertNil(Self.navigationBackControlRank(label: "Backup Now", identifier: "backupButton"))
  }

  func testNavigationBackControlRankRecognizesLocalizedSystemDismissTitles() {
    let localizedRank = Self.navigationBackKeywords.count

    XCTAssertEqual(
      Self.navigationBackControlRank(
        label: "Отмена",
        identifier: "",
        localizedDismissTitles: ["Отмена"]
      ),
      localizedRank
    )
    XCTAssertEqual(
      Self.navigationBackControlRank(
        label: "Готово",
        identifier: "",
        localizedDoneTitle: "Готово",
        isSoleNavigationButton: true
      ),
      localizedRank
    )
    XCTAssertNil(
      Self.navigationBackControlRank(
        label: "Готово",
        identifier: "",
        localizedDoneTitle: "Готово",
        isSoleNavigationButton: false
      )
    )
    XCTAssertNil(
      Self.navigationBackControlRank(
        label: "Изменить",
        identifier: "editButton",
        localizedDoneTitle: "Готово",
        isSoleNavigationButton: true
      )
    )
  }

#if os(iOS)
  func testNavigationBackControlRankUsesUIKitSystemNames() throws {
    let localizedTitles = Self.localizedNavigationSystemNames()
    let done = try XCTUnwrap(localizedTitles.done)

    XCTAssertFalse(localizedTitles.dismiss.isEmpty)
    for dismiss in localizedTitles.dismiss {
      XCTAssertEqual(
        Self.navigationBackControlRank(
          label: dismiss,
          identifier: "",
          localizedDismissTitles: localizedTitles.dismiss
        ),
        Self.navigationBackKeywords.count
      )
    }
    XCTAssertEqual(
      Self.navigationBackControlRank(
        label: done,
        identifier: "",
        localizedDismissTitles: localizedTitles.dismiss,
        localizedDoneTitle: done,
        isSoleNavigationButton: true
      ),
      Self.navigationBackKeywords.count
    )
  }
#endif

  func testNavigationSystemAccessibilityNamePrefersLabelAndFallsBackToTitle() {
    XCTAssertEqual(
      Self.navigationSystemAccessibilityName(
        accessibilityLabel: "  Готово  ",
        title: "Done"
      ),
      "Готово"
    )
    XCTAssertEqual(
      Self.navigationSystemAccessibilityName(
        accessibilityLabel: " \n ",
        title: "  Done  "
      ),
      "Done"
    )
    XCTAssertNil(
      Self.navigationSystemAccessibilityName(
        accessibilityLabel: nil,
        title: "  "
      )
    )
  }

  func testNavigationBackControlRankRecognizesSheetDismissIdentifiers() {
    let sheetDismissRank = Self.navigationBackKeywords.count

    XCTAssertEqual(
      Self.navigationBackControlRank(label: "Закрыть", identifier: "sheetDragHandle"),
      sheetDismissRank
    )
    XCTAssertEqual(
      Self.navigationBackControlRank(label: "Fermer", identifier: "presentationDragIndicator"),
      sheetDismissRank
    )
    XCTAssertEqual(
      Self.navigationBackControlRank(label: "閉じる", identifier: "sliderDragView"),
      sheetDismissRank
    )
    XCTAssertNil(
      Self.navigationBackControlRank(label: "Закрыть", identifier: "opaqueButton")
    )
  }

  func testNavigationBackControlRankRejectsIncompleteSheetDismissIdentifiers() {
    XCTAssertNil(
      Self.navigationBackControlRank(label: "Move", identifier: "dragToReorderButton")
    )
    XCTAssertNil(Self.navigationBackControlRank(label: "Volume", identifier: "volumeSlider"))
    XCTAssertNil(Self.navigationBackControlRank(label: "Details", identifier: "sheetTitle"))
  }

  func testNavigationSheetDismissIdentityExcludesKeywordOnlyAndDivKitControls() {
    XCTAssertTrue(Self.isNavigationSheetDismissIdentifier("sliderDragView"))
    XCTAssertTrue(Self.isNavigationSheetDismissIdentifier("sheetDragHandle"))
    XCTAssertFalse(Self.isNavigationSheetDismissIdentifier("closeButton"))
    XCTAssertFalse(Self.isNavigationSheetDismissIdentifier("morda_bottomSheet_button"))
  }

  func testNavigationBackPredicateUsesTheSharedKeywordTable() {
    let predicate = Self.navigationBackPredicate()

    XCTAssertTrue(predicate.evaluate(with: ["label": "Back", "identifier": ""]))
    XCTAssertTrue(predicate.evaluate(with: ["label": "", "identifier": "close-button"]))
    XCTAssertTrue(predicate.evaluate(with: ["label": "Закрыть", "identifier": "sliderDragView"]))
    XCTAssertFalse(predicate.evaluate(with: ["label": "Search for more feeds", "identifier": ""]))
    XCTAssertFalse(predicate.evaluate(with: ["label": "Move", "identifier": "dragToReorderButton"]))
    XCTAssertFalse(predicate.evaluate(with: ["label": "Volume", "identifier": "volumeSlider"]))
  }

  func testNavigationChromeControlFrameAcceptsOnlyEdgeBands() {
    let window = CGRect(x: 0, y: 0, width: 430, height: 932)

    XCTAssertTrue(
      Self.isNavigationChromeControlFrame(
        CGRect(x: 340, y: 84, width: 72, height: 44),
        in: window
      )
    )
    XCTAssertTrue(
      Self.isNavigationChromeControlFrame(
        CGRect(x: 20, y: 820, width: 72, height: 44),
        in: window
      )
    )
    XCTAssertFalse(
      Self.isNavigationChromeControlFrame(
        CGRect(x: 20, y: 430, width: 72, height: 44),
        in: window
      )
    )
    XCTAssertFalse(Self.isNavigationChromeControlFrame(.infinite, in: window))
    XCTAssertFalse(Self.isNavigationChromeControlFrame(.zero, in: window))
  }
#endif
}
