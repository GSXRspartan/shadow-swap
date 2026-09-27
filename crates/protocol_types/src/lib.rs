use pool_math::{DEFAULT_FEE, FEE_DENOMINATOR};
use serde::{Deserialize, Serialize};

/// Pool identifier derived deterministically from pair and fee tier.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PoolId {
    pub pair_ordered: String,
    pub fee_tier: u32,
}

impl PoolId {
    pub fn new(resource_a: &str, resource_b: &str, fee_tier: u32) -> Self {
        // Canonical ordering: sort lexicographically by resource address string
        let (a, b) = if resource_a < resource_b {
            (resource_a, resource_b)
        } else {
            (resource_b, resource_a)
        };
        Self {
            pair_ordered: format!("{}:{}", a, b),
            fee_tier,
        }
    }

    pub fn resource_pair(&self) -> (String, String) {
        let parts: Vec<&str> = self.pair_ordered.split(':').collect();
        (parts[0].to_string(), parts[1].to_string())
    }
}

/// Resource address representation (simplified for protocol layer).
/// Actual on-chain resource address is a hex string or structured address.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ResourceAddress(pub String);

impl ResourceAddress {
    pub fn new(addr: &str) -> Self {
        Self(addr.to_string())
    }
}

/// Fee tier in basis points out of 10_000.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeeTier {
    pub basis_points: u32,
}

impl FeeTier {
    pub fn default_fee() -> Self {
        Self {
            basis_points: DEFAULT_FEE,
        }
    }

    pub fn is_valid(&self) -> bool {
        self.basis_points < FEE_DENOMINATOR && self.basis_points > 0
    }
}

/// Route capability status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RouteStatus {
    EngineTested,
    WalletTested,
    EsmeraldaTested,
    Experimental,
    DesignOnly,
    Blocked,
    Disabled,
}

/// Market primitives are intentionally separate: an NFT inventory or a revealed stealth
/// boundary must never be silently routed through the public-fungible AMM.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MarketClass {
    PublicFungibleConstantProduct,
    StealthRevealedBoundary,
    NftInventoryBondingCurve,
    StablecoinGateway,
    Unsupported,
}

/// Visibility that must be disclosed before signing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PrivacyBoundary {
    Public,
    PublicWrappedStablecoin,
    PrivateWalletPublicMarketBoundary,
    PrivateStablecoinConversion,
    UnknownUnsupported,
}

/// A liquidity-backed XTM L1 ↔ canonical TARI L2 atomic swap. This is not a bridge: it
/// exchanges the two participants' existing inventory and must never appear as an AMM reserve.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FastXtmTariSwapState {
    QuoteRequested,
    QuoteReceived,
    QuoteAccepted,
    InventoryReserved,
    LongDeadlineLegFunded,
    BothLegsFunded,
    ClaimArmed,
    PreimageRevealed,
    Completed,
    QuoteExpired,
    RefundWait,
    Refunded,
    TerminalFailure,
}

/// Settlement-critical terms supplied by an authenticated provider quote. The identical SHA-256
/// hashlock is committed on both chains; L1 and L2 deadlines are deliberately separate units.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FastXtmTariSwapTerms {
    pub sha256_hashlock_hex: String,
    pub xtm_amount: u64,
    pub tari_amount: u64,
    pub l1_refund_height: u64,
    pub l2_refund_epoch: u64,
    pub quote_expiry_unix: u64,
    pub provider_quote_id: String,
}

impl FastXtmTariSwapTerms {
    /// The L1 funder is refunded later than the L2 funder. Actual height/epoch conversion and
    /// confirmation policy are adapter responsibilities; equal or inverted deadlines are unsafe.
    pub fn has_asymmetric_refunds(&self) -> bool {
        self.l1_refund_height > self.l2_refund_epoch
    }
}

/// Crash-recoverable, idempotent protocol state. Network adapters must record verified L1/L2
/// transaction IDs separately and may only advance this machine after finality policy succeeds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FastXtmTariSwap {
    pub terms: FastXtmTariSwapTerms,
    pub state: FastXtmTariSwapState,
}

impl FastXtmTariSwap {
    pub fn new(terms: FastXtmTariSwapTerms) -> Self {
        Self {
            terms,
            state: FastXtmTariSwapState::QuoteRequested,
        }
    }

    /// Rejects skipping the inventory/funding barrier or exposing a preimage before both HTLCs.
    pub fn advance(&mut self, next: FastXtmTariSwapState) -> bool {
        use FastXtmTariSwapState::*;
        let valid = matches!(
            (self.state, next),
            (QuoteRequested, QuoteReceived)
                | (QuoteReceived, QuoteAccepted)
                | (QuoteAccepted, InventoryReserved)
                | (InventoryReserved, LongDeadlineLegFunded)
                | (LongDeadlineLegFunded, BothLegsFunded)
                | (BothLegsFunded, ClaimArmed)
                | (ClaimArmed, PreimageRevealed)
                | (PreimageRevealed, Completed)
                | (_, QuoteExpired)
                | (
                    LongDeadlineLegFunded | BothLegsFunded | ClaimArmed,
                    RefundWait
                )
                | (RefundWait, Refunded)
        );
        if valid {
            self.state = next;
        }
        valid
    }
}

/// Deployment-pinned stablecoin facts. Addresses are configuration, not metadata-derived identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StablecoinAdapter {
    pub issuer_component: String,
    pub private_resource: ResourceAddress,
    pub wrapped_public_resource: ResourceAddress,
    pub issuer_controlled: bool,
    pub user_permissionless_conversion: bool,
    pub holder_revealed_bucket_supported: bool,
    pub source_revision: String,
}

impl StablecoinAdapter {
    pub fn private_conversion_is_usable(&self) -> bool {
        self.user_permissionless_conversion && !self.issuer_controlled
    }

    pub fn direct_revealed_boundary_is_usable(&self) -> bool {
        self.holder_revealed_bucket_supported
    }
}

/// Route description for the capability matrix.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteDescriptor {
    pub from: String,
    pub to: String,
    pub status: RouteStatus,
    pub notes: String,
    pub fee_tier_available: Option<u32>,
    pub market_class: MarketClass,
    pub privacy_boundary: PrivacyBoundary,
}

/// Capability-only planner. Discovery, quotes, and transaction construction remain wallet and
/// indexer responsibilities; this prevents blocked paths being presented as executable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoutePlan {
    pub hops: Vec<(String, String)>,
    pub status: RouteStatus,
    pub market_class: MarketClass,
    pub privacy_boundary: PrivacyBoundary,
}

pub fn plan_route(from: &str, to: &str) -> RoutePlan {
    let direct_public_quote = |boundary| RoutePlan {
        hops: vec![(from.to_string(), to.to_string())],
        status: RouteStatus::Experimental,
        market_class: MarketClass::PublicFungibleConstantProduct,
        privacy_boundary: boundary,
    };

    match (from, to) {
        ("PublicFungible", "WrappedStablecoin")
        | ("WrappedStablecoin", "PublicFungible")
        | ("TariNative", "WrappedStablecoin")
        | ("WrappedStablecoin", "TariNative") => {
            direct_public_quote(PrivacyBoundary::PublicWrappedStablecoin)
        }
        ("PublicFungible", "TariNative") | ("TariNative", "PublicFungible") => {
            direct_public_quote(PrivacyBoundary::PrivateWalletPublicMarketBoundary)
        }
        ("PrivateStablecoin", "WrappedStablecoin") | ("WrappedStablecoin", "PrivateStablecoin") => {
            RoutePlan {
                hops: vec![(from.to_string(), to.to_string())],
                status: RouteStatus::Blocked,
                market_class: MarketClass::StablecoinGateway,
                privacy_boundary: PrivacyBoundary::PrivateStablecoinConversion,
            }
        }
        ("PrivateStablecoin", "TariNative")
        | ("TariNative", "PrivateStablecoin")
        | ("PrivateStablecoin", "PublicFungible")
        | ("PublicFungible", "PrivateStablecoin") => RoutePlan {
            hops: vec![(from.to_string(), to.to_string())],
            status: RouteStatus::DesignOnly,
            market_class: MarketClass::StealthRevealedBoundary,
            privacy_boundary: PrivacyBoundary::PrivateWalletPublicMarketBoundary,
        },
        _ => RoutePlan {
            hops: vec![(from.to_string(), to.to_string())],
            status: RouteStatus::Blocked,
            market_class: MarketClass::Unsupported,
            privacy_boundary: PrivacyBoundary::UnknownUnsupported,
        },
    }
}

/// Pool metadata (read-only, non-authoritative from indexer).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolInfo {
    pub pool_id: PoolId,
    pub resource_a: ResourceAddress,
    pub resource_b: ResourceAddress,
    pub fee_tier: FeeTier,
    pub reserve_a: u64,
    pub reserve_b: u64,
    pub lp_total_supply: Option<u64>,
    pub timestamp_created_approx: Option<u64>,
    pub route_status: RouteStatus,
}

/// Transaction preview result for adapter display.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionPreview {
    pub from_account: String,
    pub to_component: String,
    pub resources_involved: Vec<String>,
    pub amounts: Vec<u64>,
    pub fee_tier: u32,
    pub estimated_output: Option<u64>,
    pub max_epoch: u64,
    pub privacy_disclosure: String,
}

/// Resource type as reported by the Ootle engine (`ResourceType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ResourceKind {
    Fungible,
    Confidential,
    Stealth,
    NonFungible,
}

/// Authoritative-as-possible facts about a resource, used to classify pool eligibility (OPUS-08).
///
/// `is_canonical_tari` and `kind` are on-chain-authoritative (address identity and
/// `ResourceType`, exactly what the pool template itself checks). The `*_allowed` / `*_mutable`
/// fields describe recall/freeze authority; the pool template CANNOT read these in Ootle v0.41.1,
/// so they can only be populated off-chain from indexer substate and are therefore ADVISORY
/// (indexer-trusted), never a security guarantee. `None` means "not inspected / unknown".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceSecurityFacts {
    pub address: String,
    /// Exact-address match against the canonical native Tari resource. Authoritative.
    pub is_canonical_tari: bool,
    /// Engine `ResourceType`. Authoritative (on-chain enforced by the pool template).
    pub kind: ResourceKind,
    /// Recall rule permits recall by someone other than a non-existent owner. Advisory (indexer).
    pub recall_possible: Option<bool>,
    /// Freeze rule permits freezing a vault of this resource. Advisory (indexer).
    pub freeze_possible: Option<bool>,
    /// Recall/freeze rules are mutable (could be enabled later). Advisory (indexer).
    pub security_rules_mutable: Option<bool>,
}

/// Pool eligibility verdict. The protocol/client derives this from [`ResourceSecurityFacts`];
/// the frontend MUST NOT invent its own classification.
///
/// On-chain-ENFORCED verdicts (the pool template rejects at `Pool::new`):
///   * [`CanonicalTari`](ResourceEligibility::CanonicalTari)
///   * [`EligiblePublicFungible`](ResourceEligibility::EligiblePublicFungible)
///   * [`UnsupportedResourceType`](ResourceEligibility::UnsupportedResourceType)
///
/// ADVISORY-only verdicts (cannot be enforced by the template in v0.41.1 — see OPUS-08; derived
/// from indexer substate, which is untrusted):
///   * [`UnsafeRecallable`](ResourceEligibility::UnsafeRecallable)
///   * [`UnsafeFreezable`](ResourceEligibility::UnsafeFreezable)
///   * [`UnsafeMutableRules`](ResourceEligibility::UnsafeMutableRules)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ResourceEligibility {
    CanonicalTari,
    EligiblePublicFungible,
    UnsafeRecallable,
    UnsafeFreezable,
    UnsafeMutableRules,
    UnsupportedResourceType,
    Unknown,
}

impl ResourceEligibility {
    /// True only for verdicts the on-chain pool template itself enforces at creation.
    pub fn is_on_chain_enforced(&self) -> bool {
        matches!(
            self,
            ResourceEligibility::CanonicalTari
                | ResourceEligibility::EligiblePublicFungible
                | ResourceEligibility::UnsupportedResourceType
        )
    }

    /// True if a resource with this verdict must never be routed into a public-fungible pool.
    pub fn is_unsafe(&self) -> bool {
        matches!(
            self,
            ResourceEligibility::UnsafeRecallable
                | ResourceEligibility::UnsafeFreezable
                | ResourceEligibility::UnsafeMutableRules
                | ResourceEligibility::UnsupportedResourceType
        )
    }
}

/// Classify a resource for public-fungible pool eligibility from authoritative facts.
///
/// Precedence mirrors the real threat: the on-chain type boundary is decided first (canonical
/// Tari, then type), then — only for otherwise type-eligible fungibles — the advisory recall/
/// freeze/mutability signals (when available from the indexer) can DOWNGRADE the verdict to an
/// `Unsafe*` value. When those advisory signals are absent (`None`) the verdict stays at the
/// type-derived value, because the template does not (and cannot) reject on them.
pub fn classify_resource(facts: &ResourceSecurityFacts) -> ResourceEligibility {
    // Authoritative, on-chain-enforced boundary first.
    if facts.is_canonical_tari {
        return ResourceEligibility::CanonicalTari;
    }
    if facts.kind != ResourceKind::Fungible {
        return ResourceEligibility::UnsupportedResourceType;
    }
    // Type-eligible public fungible. Apply advisory downgrades if (and only if) the indexer
    // supplied the relevant rule facts. A mutable-rules signal is the most dangerous because a
    // currently-safe resource could be made recallable/freezable later.
    if facts.security_rules_mutable == Some(true) {
        return ResourceEligibility::UnsafeMutableRules;
    }
    if facts.recall_possible == Some(true) {
        return ResourceEligibility::UnsafeRecallable;
    }
    if facts.freeze_possible == Some(true) {
        return ResourceEligibility::UnsafeFreezable;
    }
    ResourceEligibility::EligiblePublicFungible
}

/// Capability matrix for the protocol.
/// Source of truth: this file and docs/ROUTE_MATRIX.md.
pub fn initial_route_matrix() -> Vec<RouteDescriptor> {
    vec![
        RouteDescriptor {
            from: "PublicFungible".to_string(),
            to: "TariNative".to_string(),
            status: RouteStatus::Experimental,
            notes: "Requires native Tari resource validation; TariSwap template supports fungible pairs including Tari resource.".to_string(),
            fee_tier_available: Some(DEFAULT_FEE),
            market_class: MarketClass::PublicFungibleConstantProduct,
            privacy_boundary: PrivacyBoundary::PrivateWalletPublicMarketBoundary,
        },
        RouteDescriptor {
            from: "PublicFungible".to_string(),
            to: "PublicFungible".to_string(),
            status: RouteStatus::Experimental,
            notes: "Standard AMM route; tested with integer math; requires pool deployment and indexer integration.".to_string(),
            fee_tier_available: Some(DEFAULT_FEE),
            market_class: MarketClass::PublicFungibleConstantProduct,
            privacy_boundary: PrivacyBoundary::Public,
        },
        RouteDescriptor {
            from: "PublicFungible".to_string(),
            to: "WrappedStablecoin".to_string(),
            status: RouteStatus::Experimental,
            notes: "Uses the existing public-fungible pool only after the exact wrapper is configured as a reviewed issuer-controlled quote asset; no private conversion is implied.".to_string(),
            fee_tier_available: Some(DEFAULT_FEE),
            market_class: MarketClass::PublicFungibleConstantProduct,
            privacy_boundary: PrivacyBoundary::PublicWrappedStablecoin,
        },
        RouteDescriptor {
            from: "TariNative".to_string(),
            to: "WrappedStablecoin".to_string(),
            status: RouteStatus::Experimental,
            notes: "Uses the existing canonical-Tari/public-fungible pool; the AMM boundary is public and the wrapper remains issuer-controlled.".to_string(),
            fee_tier_available: Some(DEFAULT_FEE),
            market_class: MarketClass::PublicFungibleConstantProduct,
            privacy_boundary: PrivacyBoundary::PublicWrappedStablecoin,
        },
        RouteDescriptor {
            from: "StealthAsset".to_string(),
            to: "TariNative".to_string(),
            status: RouteStatus::Blocked,
            notes: "Stealth resource enters public pool; amounts revealed at boundary; upstream TariSwap allows stealth/fungible but AMM privacy leakage must be explicitly disclosed.".to_string(),
            fee_tier_available: Some(DEFAULT_FEE),
            market_class: MarketClass::StealthRevealedBoundary,
            privacy_boundary: PrivacyBoundary::PrivateWalletPublicMarketBoundary,
        },
        RouteDescriptor {
            from: "StealthAsset".to_string(),
            to: "PublicFungible".to_string(),
            status: RouteStatus::Blocked,
            notes: "Similar privacy leakage as stealth/Tari route; requires feature gate and user disclosure.".to_string(),
            fee_tier_available: Some(DEFAULT_FEE),
            market_class: MarketClass::StealthRevealedBoundary,
            privacy_boundary: PrivacyBoundary::PrivateWalletPublicMarketBoundary,
        },
        RouteDescriptor {
            from: "WrappedStablecoin".to_string(),
            to: "TariNative".to_string(),
            status: RouteStatus::Experimental,
            notes: "The public wrapper uses the existing canonical-Tari/public-fungible AMM; it remains an issuer-controlled quote asset.".to_string(),
            fee_tier_available: Some(DEFAULT_FEE),
            market_class: MarketClass::PublicFungibleConstantProduct,
            privacy_boundary: PrivacyBoundary::PublicWrappedStablecoin,
        },
        RouteDescriptor {
            from: "PrivateStablecoin".to_string(),
            to: "PublicFungible".to_string(),
            status: RouteStatus::DesignOnly,
            notes: "Holder-controlled revealed same-resource buckets are source-proven; a dedicated revealed-boundary adapter and issuer-risk engine tests are still required.".to_string(),
            fee_tier_available: Some(DEFAULT_FEE),
            market_class: MarketClass::StealthRevealedBoundary,
            privacy_boundary: PrivacyBoundary::PrivateWalletPublicMarketBoundary,
        },
        RouteDescriptor {
            from: "PrivateStablecoin".to_string(),
            to: "TariNative".to_string(),
            status: RouteStatus::DesignOnly,
            notes: "Holder-controlled revealed same-resource buckets are source-proven; a dedicated revealed-boundary adapter and issuer-risk engine tests are still required.".to_string(),
            fee_tier_available: Some(DEFAULT_FEE),
            market_class: MarketClass::StealthRevealedBoundary,
            privacy_boundary: PrivacyBoundary::PrivateWalletPublicMarketBoundary,
        },
        RouteDescriptor {
            from: "PrivateStablecoin".to_string(),
            to: "WrappedStablecoin".to_string(),
            status: RouteStatus::Blocked,
            notes: "The inspected wrapper conversion is issuer-admin-gated and per-user limited; this is distinct from direct revealed-boundary trading.".to_string(),
            fee_tier_available: None,
            market_class: MarketClass::StablecoinGateway,
            privacy_boundary: PrivacyBoundary::PrivateStablecoinConversion,
        },
        RouteDescriptor {
            from: "NFTCollection".to_string(),
            to: "TariNative".to_string(),
            status: RouteStatus::Blocked,
            notes: "NFT liquidity requires separate non-fungible design; no upstream NFT pool template exists.".to_string(),
            fee_tier_available: None,
            market_class: MarketClass::NftInventoryBondingCurve,
            privacy_boundary: PrivacyBoundary::UnknownUnsupported,
        },
    ]
}

#[cfg(test)]
mod eligibility_tests {
    use super::*;

    fn facts(kind: ResourceKind, tari: bool) -> ResourceSecurityFacts {
        ResourceSecurityFacts {
            address: "resource_test".to_string(),
            is_canonical_tari: tari,
            kind,
            recall_possible: None,
            freeze_possible: None,
            security_rules_mutable: None,
        }
    }

    #[test]
    fn canonical_tari_is_eligible_regardless_of_type() {
        // Native Tari is Stealth-typed; the exact-address match must win.
        let f = facts(ResourceKind::Stealth, true);
        assert_eq!(classify_resource(&f), ResourceEligibility::CanonicalTari);
        assert!(classify_resource(&f).is_on_chain_enforced());
    }

    #[test]
    fn plain_public_fungible_is_eligible() {
        let f = facts(ResourceKind::Fungible, false);
        assert_eq!(
            classify_resource(&f),
            ResourceEligibility::EligiblePublicFungible
        );
        assert!(classify_resource(&f).is_on_chain_enforced());
    }

    #[test]
    fn confidential_stealth_nft_are_unsupported() {
        for k in [
            ResourceKind::Confidential,
            ResourceKind::Stealth,
            ResourceKind::NonFungible,
        ] {
            let f = facts(k, false);
            assert_eq!(
                classify_resource(&f),
                ResourceEligibility::UnsupportedResourceType
            );
            assert!(classify_resource(&f).is_unsafe());
        }
    }

    #[test]
    fn recallable_fungible_is_advisory_unsafe() {
        let mut f = facts(ResourceKind::Fungible, false);
        f.recall_possible = Some(true);
        assert_eq!(classify_resource(&f), ResourceEligibility::UnsafeRecallable);
        // Advisory only: NOT enforced on-chain by the template.
        assert!(!classify_resource(&f).is_on_chain_enforced());
        assert!(classify_resource(&f).is_unsafe());
    }

    #[test]
    fn freezable_fungible_is_advisory_unsafe() {
        let mut f = facts(ResourceKind::Fungible, false);
        f.freeze_possible = Some(true);
        assert_eq!(classify_resource(&f), ResourceEligibility::UnsafeFreezable);
    }

    #[test]
    fn mutable_rules_take_precedence_over_current_safe_state() {
        let mut f = facts(ResourceKind::Fungible, false);
        f.recall_possible = Some(false);
        f.freeze_possible = Some(false);
        f.security_rules_mutable = Some(true);
        assert_eq!(
            classify_resource(&f),
            ResourceEligibility::UnsafeMutableRules
        );
    }

    #[test]
    fn missing_advisory_facts_keep_type_verdict() {
        // With no indexer rule facts, a type-eligible fungible stays eligible (the template
        // does not reject on unknown recall/freeze state).
        let f = facts(ResourceKind::Fungible, false);
        assert_eq!(
            classify_resource(&f),
            ResourceEligibility::EligiblePublicFungible
        );
    }

    #[test]
    fn wrapped_stablecoin_routes_are_public_and_private_conversion_is_blocked() {
        let public_quote = plan_route("TariNative", "WrappedStablecoin");
        assert_eq!(public_quote.status, RouteStatus::Experimental);
        assert_eq!(
            public_quote.privacy_boundary,
            PrivacyBoundary::PublicWrappedStablecoin
        );

        let private_conversion = plan_route("PublicFungible", "PrivateStablecoin");
        assert_eq!(private_conversion.status, RouteStatus::DesignOnly);
        assert_eq!(
            private_conversion.privacy_boundary,
            PrivacyBoundary::PrivateWalletPublicMarketBoundary
        );

        let wrapper_gateway = plan_route("PrivateStablecoin", "WrappedStablecoin");
        assert_eq!(wrapper_gateway.status, RouteStatus::Blocked);
    }

    #[test]
    fn issuer_controlled_gateway_is_not_permissionless() {
        let adapter = StablecoinAdapter {
            issuer_component: "component_issuer".to_string(),
            private_resource: ResourceAddress::new("resource_private"),
            wrapped_public_resource: ResourceAddress::new("resource_wrapped"),
            issuer_controlled: true,
            user_permissionless_conversion: false,
            holder_revealed_bucket_supported: true,
            source_revision: "bef1a89".to_string(),
        };
        assert!(!adapter.private_conversion_is_usable());
        assert!(adapter.direct_revealed_boundary_is_usable());
    }

    #[test]
    fn fast_xtm_tari_swap_never_reveals_before_both_legs_are_armed() {
        let terms = FastXtmTariSwapTerms {
            sha256_hashlock_hex: "00".repeat(32),
            xtm_amount: 1,
            tari_amount: 1,
            l1_refund_height: 200,
            l2_refund_epoch: 100,
            quote_expiry_unix: 1,
            provider_quote_id: "quote".to_string(),
        };
        assert!(terms.has_asymmetric_refunds());
        let mut swap = FastXtmTariSwap::new(terms);
        assert!(!swap.advance(FastXtmTariSwapState::PreimageRevealed));
        for state in [
            FastXtmTariSwapState::QuoteReceived,
            FastXtmTariSwapState::QuoteAccepted,
            FastXtmTariSwapState::InventoryReserved,
            FastXtmTariSwapState::LongDeadlineLegFunded,
            FastXtmTariSwapState::BothLegsFunded,
            FastXtmTariSwapState::ClaimArmed,
            FastXtmTariSwapState::PreimageRevealed,
            FastXtmTariSwapState::Completed,
        ] {
            assert!(swap.advance(state));
        }
    }
}
