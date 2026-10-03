import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testSystemModalFactsClassifyActionsAndInformativeContent() {
    let frame = CGRect(x: 10, y: 20, width: 100, height: 44)
    let button = SystemModalElementFacts(
      type: .button,
      label: "Allow Once",
      identifier: "allow-once",
      frame: frame,
      enabled: true
    )
    let remoteHostCell = SystemModalElementFacts(
      type: .cell,
      label: "Accessory",
      identifier: "accessory",
      frame: frame,
      enabled: true
    )
    let informative = SystemModalElementFacts(
      type: .staticText,
      label: "Permission explanation",
      identifier: "",
      frame: frame,
      enabled: true
    )

    XCTAssertTrue(SystemModalElementPolicy.isActionCandidate(button, actionableTypes: actionableTypes))
    XCTAssertTrue(SystemModalElementPolicy.isActionCandidate(remoteHostCell, actionableTypes: actionableTypes))
    XCTAssertFalse(SystemModalElementPolicy.isActionCandidate(informative, actionableTypes: actionableTypes))
    XCTAssertTrue(
      SystemModalElementPolicy.isInformative(informative, readableTypes: [.staticText, .textView])
    )
  }

  func testSystemModalTitleUsesLabelIdentifierAndFallback() {
    let frame = CGRect(x: 10, y: 20, width: 100, height: 44)
    XCTAssertEqual(
      SystemModalElementPolicy.preferredTitle(
        SystemModalElementFacts(
          type: .alert,
          label: "Location Access",
          identifier: "location",
          frame: frame,
          enabled: true
        )
      ),
      "Location Access"
    )
    XCTAssertEqual(
      SystemModalElementPolicy.preferredTitle(
        SystemModalElementFacts(
          type: .alert,
          label: "",
          identifier: "location",
          frame: frame,
          enabled: true
        )
      ),
      "location"
    )
    XCTAssertEqual(
      SystemModalElementPolicy.preferredTitle(
        SystemModalElementFacts(
          type: .alert,
          label: "",
          identifier: "",
          frame: frame,
          enabled: true
        )
      ),
      "System Alert"
    )
  }
}
#endif
