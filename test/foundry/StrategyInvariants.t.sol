// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { SimpleStrategy } from "../../contracts/strategies/SimpleStrategy.sol";
import { CompoundDailyStrategy } from "../../contracts/strategies/CompoundDailyStrategy.sol";
import { TieredStrategy } from "../../contracts/strategies/TieredStrategy.sol";
import { FloatingStrategy } from "../../contracts/strategies/FloatingStrategy.sol";
import { KpiLinkedStrategy } from "../../contracts/strategies/KpiLinkedStrategy.sol";
import { TwoTrackStrategy } from "../../contracts/strategies/TwoTrackStrategy.sol";
import { MockRateOracle } from "../../contracts/mocks/MockRateOracle.sol";
import { MockKpiOracle } from "../../contracts/mocks/MockKpiOracle.sol";
import { DayCount } from "../../contracts/lib/DayCount.sol";

/// @notice Property-based fuzz tests asserting structural invariants of every
/// strategy. Run with: `forge test`. Default 256 runs per test (foundry.toml).
contract StrategyInvariants is Test {
    SimpleStrategy simple;
    CompoundDailyStrategy compoundDaily;
    TieredStrategy tiered;
    FloatingStrategy floating;
    KpiLinkedStrategy kpi;
    TwoTrackStrategy twoTrack;
    MockRateOracle rateOracle;
    MockKpiOracle kpiOracle;

    uint64 constant FROM = 1_700_000_000;
    uint64 constant DAY = 86_400;

    function setUp() public {
        simple = new SimpleStrategy(350, DayCount.Basis.ACT_360);
        compoundDaily = new CompoundDailyStrategy(300, DayCount.Basis.ACT_365);

        uint256[] memory upTos = new uint256[](2);
        uint256[] memory bps = new uint256[](2);
        upTos[0] = 1_000_000 * 1e18;
        upTos[1] = type(uint256).max;
        bps[0] = 200;
        bps[1] = 350;
        tiered = new TieredStrategy(upTos, bps, DayCount.Basis.ACT_360);

        rateOracle = new MockRateOracle(350, "ESTR");
        floating = new FloatingStrategy(rateOracle, 50, DayCount.Basis.ACT_360, -10001, 10001);

        kpiOracle = new MockKpiOracle(0, "GHG");
        kpi = new KpiLinkedStrategy(kpiOracle, 400, -100, 100, DayCount.Basis.ACT_360);

        twoTrack = new TwoTrackStrategy(350, 5000, 5000, 1000, DayCount.Basis.ACT_360);
    }

    // === Property: zero balance → zero interest, every strategy ===

    function testFuzz_zeroBalanceReturnsZero_simple(uint64 daysCount) public view {
        daysCount = uint64(bound(daysCount, 0, 3650));
        assertEq(simple.previewAccrual(0, FROM, FROM + daysCount * DAY), 0);
    }

    function testFuzz_zeroBalanceReturnsZero_compound(uint64 daysCount) public view {
        daysCount = uint64(bound(daysCount, 0, 3650));
        assertEq(compoundDaily.previewAccrual(0, FROM, FROM + daysCount * DAY), 0);
    }

    function testFuzz_zeroBalanceReturnsZero_tiered(uint64 daysCount) public view {
        daysCount = uint64(bound(daysCount, 0, 3650));
        assertEq(tiered.previewAccrual(0, FROM, FROM + daysCount * DAY), 0);
    }

    // === Property: zero days → zero interest ===

    function testFuzz_zeroDaysReturnsZero_simple(uint256 balance) public view {
        balance = bound(balance, 0, 1e36);
        assertEq(simple.previewAccrual(balance, FROM, FROM), 0);
    }

    function testFuzz_zeroDaysReturnsZero_compound(uint256 balance) public view {
        balance = bound(balance, 0, 1e36);
        assertEq(compoundDaily.previewAccrual(balance, FROM, FROM), 0);
    }

    // === Property: monotonic in balance — bigger balance → bigger interest ===

    function testFuzz_monotonicInBalance_simple(uint256 b1, uint256 b2, uint64 daysCount) public view {
        b1 = bound(b1, 0, 1e30);
        b2 = bound(b2, b1, 1e30); // b2 >= b1
        daysCount = uint64(bound(daysCount, 1, 3650));
        uint64 to = FROM + daysCount * DAY;
        assertLe(simple.previewAccrual(b1, FROM, to), simple.previewAccrual(b2, FROM, to));
    }

    function testFuzz_monotonicInBalance_compound(uint256 b1, uint256 b2, uint64 daysCount) public view {
        b1 = bound(b1, 0, 1e24);
        b2 = bound(b2, b1, 1e24);
        daysCount = uint64(bound(daysCount, 1, 3650));
        uint64 to = FROM + daysCount * DAY;
        assertLe(compoundDaily.previewAccrual(b1, FROM, to), compoundDaily.previewAccrual(b2, FROM, to));
    }

    function testFuzz_monotonicInBalance_tiered(uint256 b1, uint256 b2, uint64 daysCount) public view {
        b1 = bound(b1, 0, 1e30);
        b2 = bound(b2, b1, 1e30);
        daysCount = uint64(bound(daysCount, 1, 3650));
        uint64 to = FROM + daysCount * DAY;
        assertLe(tiered.previewAccrual(b1, FROM, to), tiered.previewAccrual(b2, FROM, to));
    }

    // === Property: monotonic in time — longer period → more interest ===

    function testFuzz_monotonicInTime_simple(uint256 balance, uint64 d1, uint64 d2) public view {
        balance = bound(balance, 1, 1e30);
        d1 = uint64(bound(d1, 0, 3650));
        d2 = uint64(bound(d2, d1, 3650));
        assertLe(simple.previewAccrual(balance, FROM, FROM + d1 * DAY), simple.previewAccrual(balance, FROM, FROM + d2 * DAY));
    }

    function testFuzz_monotonicInTime_compound(uint256 balance, uint64 d1, uint64 d2) public view {
        balance = bound(balance, 1, 1e24);
        d1 = uint64(bound(d1, 0, 3650));
        d2 = uint64(bound(d2, d1, 3650));
        assertLe(
            compoundDaily.previewAccrual(balance, FROM, FROM + d1 * DAY),
            compoundDaily.previewAccrual(balance, FROM, FROM + d2 * DAY)
        );
    }

    // === Property: compound > simple over 1 year at same headline rate (act/365) ===

    function test_compoundExceedsSimpleOver1Year() public {
        SimpleStrategy s = new SimpleStrategy(300, DayCount.Basis.ACT_365);
        uint256 balance = 1e24;
        uint64 to = FROM + 365 * DAY;
        uint256 simpleInterest = s.previewAccrual(balance, FROM, to);
        uint256 compoundInterest = compoundDaily.previewAccrual(balance, FROM, to);
        assertGt(compoundInterest, simpleInterest);
    }

    // === Property: floor on FloatingStrategy enforces minimum rate ===

    function testFuzz_floorEnforced(int256 oracleBps) public {
        oracleBps = bound(oracleBps, -1000, 1000);
        rateOracle.set(oracleBps);
        FloatingStrategy floored = new FloatingStrategy(rateOracle, 0, DayCount.Basis.ACT_360, 0, 10001);
        uint256 result = floored.previewAccrual(1e18, FROM, FROM + 360 * DAY);
        // With floor=0, even at oracle=-1000+spread=0 → effective ≤ 0 → result == 0
        if (oracleBps <= 0) assertEq(result, 0);
        else assertGt(result, 0);
    }

    // === Property: cap on FloatingStrategy enforces maximum rate ===

    function testFuzz_capEnforced(int256 oracleBps) public {
        oracleBps = bound(oracleBps, -100, 5000);
        rateOracle.set(oracleBps);
        FloatingStrategy capped = new FloatingStrategy(rateOracle, 0, DayCount.Basis.ACT_360, -10001, 1000);
        uint256 result = capped.previewAccrual(1e18, FROM, FROM + 360 * DAY);
        // Cap at 1000bps (10%) → result on 1e18 over 1 year ≤ 0.1e18 = 1e17
        assertLe(result, 1e17 + 1); // allow off-by-one rounding
    }

    // === Property: KPI delta clamped to declared range ===

    function testFuzz_kpiClampedToRange(int16 delta) public {
        kpiOracle.set(delta);
        // baseSpreadBps=400, range=[-100,100] → effective in [300,500] for non-extreme deltas
        uint256 r = kpi.previewAccrual(1e18, FROM, FROM + 360 * DAY);
        // With base 400 and range ±100, effective rate ∈ [300, 500] bps unless delta < -400 (then floored to 0)
        // Max possible: 1e18 * 500 * 360 / (10000 * 360) = 5e16
        assertLe(r, 5e16 + 1);
    }

    // === Property: TwoTrack hard portion ≤ all-rate equivalent simple ===

    function testFuzz_twoTrackHardLeqSimple(uint256 balance, uint64 daysCount) public {
        balance = bound(balance, 0, 1e24);
        daysCount = uint64(bound(daysCount, 0, 3650));
        uint64 to = FROM + daysCount * DAY;
        SimpleStrategy referenceSimple = new SimpleStrategy(350, DayCount.Basis.ACT_360);
        uint256 hardResult = twoTrack.previewAccrual(balance, FROM, to);
        uint256 simpleResult = referenceSimple.previewAccrual(balance, FROM, to);
        // hardPortion=50% so twoTrack hard ≤ simple at same rate
        assertLe(hardResult, simpleResult + 1);
    }
}
