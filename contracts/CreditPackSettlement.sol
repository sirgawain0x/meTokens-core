// SPDX-License-Identifier: MIT
pragma solidity 0.8.9;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IFoundryFacet} from "./interfaces/IFoundryFacet.sol";

/// @title CreditPackSettlement
/// @notice Single-transaction, curve-aware credit-pack settlement for CRTVAI.
///
/// A user buys a fixed-price "credit pack" (a prepaid compute/utility bundle).
/// The pack price is denominated in the CRTVAI hub's connector asset (USDC,
/// 6 decimals). In ONE transaction the contract:
///   1. pulls the pack's fiat amount of USDC from the buyer,
///   2. mints CRTVAI on the meTokens bonding curve (FoundryFacet.mint),
///   3. burns that CRTVAI back (FoundryFacet.burn) — the refundRatio (80%)
///      means ~20% of the deposit is permanently donated to the curve,
///      which is deliberate deflationary buyback pressure for CRTVAI holders,
///   4. emits PackSettled so off-chain systems credit the buyer's compute
///      credits.
///
/// The user's price is fixed; the treasury absorbs the curve exposure. The
/// only fluctuation is the treasury's net cost (deposit minus refund), which
/// is a pricing decision controlled via setPackPrice, not a market read.
///
/// NOTE: the connector asset is an ERC20 (USDC), NOT native ETH. The buyer
/// must approve this contract to spend USDC before calling settlePack. The
/// contract does NOT accept msg.value.
contract CreditPackSettlement is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The meTokens Diamond (FoundryFacet lives here).
    address public immutable foundry;
    /// @notice The CRTVAI meToken the settlement mints/burns against.
    address public immutable meToken;
    /// @notice The hub connector asset (USDC) that denominates pack prices.
    address public immutable asset;
    /// @notice The hub's vault that holds the connector asset.
    address public immutable vault;

    /// @notice packId -> fiat price in the connector asset's native units.
    mapping(uint256 => uint256) public packPrice;
    /// @notice packId -> compute credits granted on settlement.
    mapping(uint256 => uint256) public packCredits;

    event PackSettled(
        address indexed buyer,
        uint256 packId,
        uint256 fiatAmount,
        uint256 assetDeposited,
        uint256 meTokensMinted,
        uint256 meTokensBurned,
        uint256 assetRefunded,
        uint256 creditsMinted
    );

    event PackConfigured(uint256 packId, uint256 fiatAmount, uint256 credits);
    event Swept(address asset, address to, uint256 amount);

    constructor(
        address _foundry,
        address _meToken,
        address _asset,
        address _vault
    ) {
        require(_foundry != address(0), "!foundry");
        require(_meToken != address(0), "!meToken");
        require(_asset != address(0), "!asset");
        require(_vault != address(0), "!vault");
        foundry = _foundry;
        meToken = _meToken;
        asset = _asset;
        vault = _vault;
    }

    /// @notice Settle a credit pack in a single atomic transaction.
    /// @param buyer       The address to credit with compute credits.
    /// @param packId      The pack being purchased.
    /// @param slippageBps  Slippage tolerance for the burn refund (bps).
    /// @return meTokensBurned  The amount of CRTVAI burned to back the pack.
    function settlePack(
        address buyer,
        uint256 packId,
        uint256 slippageBps
    ) external nonReentrant returns (uint256 meTokensBurned) {
        require(buyer != address(0), "!buyer");
        uint256 fiat = packPrice[packId];
        uint256 credits = packCredits[packId];
        require(fiat > 0 && credits > 0, "!pack");

        // 1. Pull the pack's fiat amount of USDC from the buyer.
        IERC20(asset).safeTransferFrom(msg.sender, address(this), fiat);

        // 2. Approve the hub vault to pull the deposit from this contract.
        IERC20(asset).safeApprove(vault, fiat);

        // 3. Mint CRTVAI on the curve (this contract is the depositor and
        //    receives the minted meTokens).
        uint256 minted = IFoundryFacet(foundry).mint(
            meToken,
            fiat,
            address(this)
        );

        // 4. Quote the burn refund, then burn everything. The refundRatio
        //    (80%) means ~20% of the deposit stays in the pool.
        uint256 expectedRefund = IFoundryFacet(foundry).calculateAssetsReturned(
            meToken,
            minted,
            address(this)
        );
        uint256 refunded = IFoundryFacet(foundry).burn(
            meToken,
            minted,
            address(this)
        );

        // 5. Slippage guard: the realized refund must be within tolerance of
        //    the quote (protects against a hub reconfigure mid-flight).
        uint256 minRefund = (expectedRefund * (10000 - slippageBps)) / 10000;
        require(refunded >= minRefund, "slippage");

        // 6. Reset any residual allowance to zero (defensive).
        IERC20(asset).safeApprove(vault, 0);

        emit PackSettled(
            buyer,
            packId,
            fiat,
            fiat,
            minted,
            minted,
            refunded,
            credits
        );
        return minted;
    }

    /// @notice Configure (or re-price) a pack. The "capture fluctuations" lever.
    function setPack(
        uint256 packId,
        uint256 fiatAmount,
        uint256 credits
    ) external onlyOwner {
        require(fiatAmount > 0, "!fiat");
        require(credits > 0, "!credits");
        packPrice[packId] = fiatAmount;
        packCredits[packId] = credits;
        emit PackConfigured(packId, fiatAmount, credits);
    }

    /// @notice Sweep the refunded connector asset (the treasury's 80% back)
    ///         to a recipient. Only the owner can call.
    function sweep(address to) external onlyOwner {
        require(to != address(0), "!to");
        uint256 balance = IERC20(asset).balanceOf(address(this));
        require(balance > 0, "!balance");
        IERC20(asset).safeTransfer(to, balance);
        emit Swept(asset, to, balance);
    }
}
