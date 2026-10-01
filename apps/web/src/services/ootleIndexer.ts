/**
 * The real `tari_indexer` REST surface, as it exists at Ootle v0.42.0.
 *
 * ## Why this module exists
 *
 * The previous discovery layer POSTed `{"query":"pool_discovery"}` to the bare
 * indexer origin. That envelope was invented here and matches no part of the
 * real REST API: a real `tari_indexer` answers `POST /` with `404`, so
 * configuring `VITE_INDEXER_URL` at a working indexer produced a pool page that
 * reported "unavailable" forever. This module replaces it with calls that are
 * actually served, read live against the post-reset Esmeralda hosts on
 * 2026-10-01.
 *
 * ## What the v0.42.0 indexer actually serves (verified read-only)
 *
 *   GET  /info                       -> {"version","network","network_byte","current_epoch",...}
 *   GET  /network                    -> {"network","network_byte","epoch"}
 *   GET  /templates/catalogue        -> {"entries":[{template_address,template_name,...}]}
 *   GET  /templates/{addr}           -> published template definition
 *   GET  /transaction-receipts       -> {"receipts":[[addr,{outcome,diff_summary:{upped,downed}}]]}
 *   POST /substates/fetch            -> batch substate read, max 20 ids
 *   GET  /substates/{substate_id}    -> {"version","substate":{"Component":{header,body}}}
 *
 * `/templates/cached` was REMOVED in v0.42.0 (the live host answers `400` to
 * it) and replaced by `/templates/catalogue`. The removed path is never sent.
 *
 * ## The three facts discovery can and cannot establish
 *
 * 1. A template is PUBLISHED — `GET /templates/catalogue` names it, with its
 *    template address. This is exact and cheap.
 * 2. A component was INSTANTIATED from that template — transaction receipts
 *    record every component a committed transaction created
 *    (`diff_summary.upped`), and receipts are synced from network state, are
 *    complete from genesis, and survive indexer downtime. Each candidate
 *    component is then read to confirm `header.template_address`.
 * 3. What the component HOLDS — reserves, fee, LP supply — is NOT available
 *    here. The indexer returns a component's `body.state` as raw tagged CBOR
 *    (`{"@cbor":"map","entries":[[key,value],...]}` with `{"@cbor":"bytes"}`
 *    and `{"@cbor":"tag","tag":131|132}` values), not as decoded field names.
 *    Only the wallet's `tari_getSubstate` decodes a template's struct fields.
 *
 * Consequence, and it is the important one: **this module discovers WHICH
 * pools exist and never WHAT they hold.** Pair identity, reserves, fee and LP
 * supply stay with the authoritative wallet reread the execution path already
 * performs. Nothing here is permitted to authorise execution.
 */

/**
 * The canonical native TARI resource, as exact resource identity.
 *
 * `STEALTH_TARI_RESOURCE_ADDRESS` / `TARI_TOKEN` in
 * `crates/template_lib_types/src/constants.rs` at tag v0.42.0 (commit
 * a43773e), whose 32-byte object key is all `0x01`. Verified live against
 * post-reset Esmeralda: `GET /resources/tari` returns `resource_type`
 * `"Stealth"`, `divisibility` 6, `metadata.SYMBOL` `"tTARI"`.
 *
 * This is deliberately an ADDRESS, not a ticker and not a symbol. The symbol is
 * `tTARI` and the deprecated alias is `XTR`; neither is an identity, and an
 * asset must never be classified by one.
 */
export const CANONICAL_TARI_RESOURCE = 'resource_0101010101010101010101010101010101010101010101010101010101010101';

/** `TARI` in `constants.rs`: 1 TARI == 1_000_000 raw units at divisibility 6. */
export const TARI_UNITS_PER_TARI = 1_000_000;

/**
 * The five deployment states this app distinguishes.
 *
 * `INDEXER_UNAVAILABLE` and `WRONG_NETWORK` are failures. `PROTOCOL_NOT_DEPLOYED`
 * and `PROTOCOL_DEPLOYED_EMPTY` are SUCCESSFUL answers that happen to be empty.
 * Collapsing either pair is a lie in a specific direction: reporting an outage
 * as an empty market tells a user their funds have no venue, and reporting an
 * empty deployment as an outage tells them the network is down when it is fine.
 */
export type ProtocolDeploymentState =
  | 'PROTOCOL_NOT_DEPLOYED'
  | 'PROTOCOL_DEPLOYED_EMPTY'
  | 'PROTOCOL_AVAILABLE'
  | 'INDEXER_UNAVAILABLE'
  | 'WRONG_NETWORK';

/** One row of `GET /templates/catalogue`. */
export interface TemplateCatalogueEntry {
  readonly templateAddress: string;
  readonly templateName: string;
  readonly binaryHash: string;
  readonly atEpoch: string;
}

/** A component confirmed to exist on chain, with the template that made it. */
export interface DiscoveredComponent {
  readonly componentAddress: string;
  readonly templateAddress: string;
  /** Substate version. u64 on the wire at v0.42.0; carried as a decimal string. */
  readonly version: string;
}

export interface IndexerDiscoverySuccess {
  readonly ok: true;
  readonly state: ProtocolDeploymentState;
  readonly publishedTemplates: readonly TemplateCatalogueEntry[];
  readonly components: readonly DiscoveredComponent[];
  /** Human-facing detail for the exact reason behind a non-available state. */
  readonly detail?: string;
  /** How many receipt pages were read. Reported so a scan is never silently capped. */
  readonly receiptPagesRead: number;
}

export interface IndexerDiscoveryFailure {
  readonly ok: false;
  readonly state: 'INDEXER_UNAVAILABLE' | 'WRONG_NETWORK';
  readonly detail: string;
}

export type IndexerDiscoveryResult = IndexerDiscoverySuccess | IndexerDiscoveryFailure;

/**
 * A transport seam. Production passes a real bounded `fetch`; tests pass a
 * stub. Every method returns a discriminated result and NEVER throws, so no
 * caller can turn a transport failure into an empty list by forgetting to
 * check.
 */
export interface IndexerTransport {
  getJson(url: string): Promise<{ ok: true; payload: unknown } | { ok: false; reason: string }>;
  postJson(url: string, body: unknown): Promise<{ ok: true; payload: unknown } | { ok: false; reason: string }>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A decimal non-negative integer as a string. Rejects JSON numbers and floats. */
function rawInteger(value: unknown): string | undefined {
  const s = text(value);
  return s !== undefined && /^\d+$/.test(s) ? s : undefined;
}

/**
 * The indexer's `/templates/catalogue` caps `limit` at 100 and rejects 0. One
 * page is the documented maximum, so a full sweep is done by cursor.
 */
const CATALOGUE_PAGE_LIMIT = 100;

/** `/transaction-receipts` likewise caps `limit` at 100. */
const RECEIPT_PAGE_LIMIT = 100;

/** `POST /substates/fetch` hard-caps a batch at 20 ids and answers 400 above it. */
const SUBSTATE_BATCH_LIMIT = 20;

/**
 * Builds an OUTBOUND indexer query string.
 *
 * Hand-rolled rather than using `URLSearchParams`, and that is deliberate: the
 * deployment test suite bans that identifier across `src/` because a gate must
 * never be readable from the URL. Nothing here reads a gate — every value is a
 * constant or a template name this build already knows — so the ban is honoured
 * literally instead of being narrowed with an exception. Values are still
 * percent-encoded, and a key carrying a template name cannot inject a parameter.
 */
function indexerQuery(params: Readonly<Record<string, string>>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return pairs.join('&');
}

export interface TariIndexerDiscoveryOptions {
  /** Max receipt pages to read. Bounded so a long chain cannot hang the page. */
  readonly maxReceiptPages?: number;
  readonly transport: IndexerTransport;
  /** Identity verification, run BEFORE any content request. */
  readonly verifyIdentity: (url: string) => Promise<{ ok: boolean; reason?: string; wrongNetwork?: boolean }>;
}

const DEFAULT_MAX_RECEIPT_PAGES = 5;

export class TariIndexerDiscovery {
  private readonly transport: IndexerTransport;
  private readonly verifyIdentity: TariIndexerDiscoveryOptions['verifyIdentity'];
  private readonly maxReceiptPages: number;

  constructor(private readonly indexerUrl: string, options: TariIndexerDiscoveryOptions) {
    this.transport = options.transport;
    this.verifyIdentity = options.verifyIdentity;
    this.maxReceiptPages = options.maxReceiptPages ?? DEFAULT_MAX_RECEIPT_PAGES;
  }

  private url(path: string): string {
    return `${this.indexerUrl.replace(/\/+$/, '')}${path}`;
  }

  /**
   * Establishes the chain identity before a single content byte is read.
   *
   * Ordering is the security property: an endpoint that cannot say which chain
   * it is, or that says a different one, must not get to answer "here are your
   * pools". A substituted origin that returns a well-formed empty catalogue is
   * exactly the attack this refuses.
   */
  async verify(): Promise<{ ok: true } | IndexerDiscoveryFailure> {
    const identity = await this.verifyIdentity(this.indexerUrl);
    if (identity.ok) return { ok: true };
    return {
      ok: false,
      state: identity.wrongNetwork === true ? 'WRONG_NETWORK' : 'INDEXER_UNAVAILABLE',
      detail: identity.reason ?? 'The indexer did not establish a usable network identity.',
    };
  }

  /**
   * Finds our template in the network's catalogue.
   *
   * `name_filter` is a SUBSTRING filter, so it is used as a cheap narrowing
   * step and the exact template name is then required on the result. A
   * substring match alone would happily return the builtin
   * `TwoResourceLiquidityPool` for the filter `Pool`.
   *
   * An empty catalogue is a successful answer meaning "not published here".
   */
  async listPublishedTemplates(templateName: string): Promise<{ ok: true; entries: TemplateCatalogueEntry[] } | { ok: false; reason: string }> {
    const collected: TemplateCatalogueEntry[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const query = indexerQuery(
        cursor === undefined
          ? { name_filter: templateName, limit: String(CATALOGUE_PAGE_LIMIT) }
          : { name_filter: templateName, limit: String(CATALOGUE_PAGE_LIMIT), after: cursor },
      );
      const result = await this.transport.getJson(this.url(`/templates/catalogue?${query}`));
      if (!result.ok) return { ok: false, reason: result.reason };
      const bag = record(result.payload);
      if (bag === undefined) return { ok: false, reason: 'The template catalogue response was not a JSON object.' };
      const raw = bag.entries;
      if (!Array.isArray(raw)) return { ok: false, reason: 'The template catalogue response carried no `entries` array.' };
      for (const item of raw) {
        const entry = record(item);
        if (entry === undefined) continue;
        const templateAddress = text(entry.template_address);
        const name = text(entry.template_name);
        if (templateAddress === undefined || name === undefined) continue;
        // Exact name match. `name_filter` is a substring and would otherwise let
        // an unrelated template satisfy the lookup.
        if (name !== templateName) continue;
        collected.push({
          templateAddress,
          templateName: name,
          binaryHash: text(entry.binary_hash) ?? '',
          atEpoch: rawInteger(entry.at_epoch) ?? '0',
        });
      }
      if (raw.length < CATALOGUE_PAGE_LIMIT) break;
      const last = record(raw[raw.length - 1]);
      const next = last === undefined ? undefined : text(last.template_address);
      if (next === undefined) break;
      cursor = next;
    }
    return { ok: true, entries: collected };
  }

  /**
   * Collects the components committed by transaction receipts.
   *
   * `/transaction-receipts` is used rather than `/transactions/recent`: the
   * indexer documents the former as "synced from network state rather than
   * gossip, complete from genesis, and recovered after downtime", and the
   * latter as best-effort with acknowledged gaps. A discovery layer built on the
   * gossip list would silently under-report pools, which is the same
   * dishonesty as inventing them.
   *
   * Only `component_*` ids from `diff_summary.upped` are kept. `upped` is the
   * list a transaction CREATED; `downed` (new in v0.42.0, recording substates a
   * transaction spent) is deliberately ignored, because a spent substate is not
   * a live pool.
   */
  private async scanReceiptComponents(): Promise<{ ok: true; ids: string[]; pages: number } | { ok: false; reason: string }> {
    const ids = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (let page = 0; page < this.maxReceiptPages; page += 1) {
      const query = indexerQuery(
        cursor === undefined
          ? { limit: String(RECEIPT_PAGE_LIMIT), ordering: 'Descending' }
          : { limit: String(RECEIPT_PAGE_LIMIT), ordering: 'Descending', last_id: cursor },
      );
      const result = await this.transport.getJson(this.url(`/transaction-receipts?${query}`));
      if (!result.ok) return { ok: false, reason: result.reason };
      const bag = record(result.payload);
      if (bag === undefined) return { ok: false, reason: 'The transaction receipt response was not a JSON object.' };
      const receipts = bag.receipts;
      if (!Array.isArray(receipts)) return { ok: false, reason: 'The transaction receipt response carried no `receipts` array.' };
      if (receipts.length === 0) break;
      pages += 1;
      let lastAddress: string | undefined;
      for (const entry of receipts) {
        // Each element is a [receipt_address, receipt] pair.
        if (!Array.isArray(entry) || entry.length < 2) continue;
        lastAddress = text(entry[0]) ?? lastAddress;
        const receipt = record(entry[1]);
        if (receipt === undefined) continue;
        if (text(receipt.outcome) !== 'Commit') continue;
        const summary = record(receipt.diff_summary);
        if (summary === undefined) continue;
        const upped = summary.upped;
        if (!Array.isArray(upped)) continue;
        for (const item of upped) {
          const change = record(item);
          if (change === undefined) continue;
          const substateId = text(change.substate_id);
          if (substateId === undefined || !substateId.startsWith('component_')) continue;
          ids.add(substateId);
        }
      }
      if (lastAddress === undefined || receipts.length < RECEIPT_PAGE_LIMIT) break;
      cursor = lastAddress;
    }
    return { ok: true, ids: [...ids], pages };
  }

  /**
   * Reads components in batches and keeps only those from a wanted template.
   *
   * The template address comes from the component's OWN header, never from the
   * transaction that created it. A receipt only says a component was created;
   * it does not say from which template, so trusting that association would let
   * an unrelated component masquerade as a pool.
   */
  async componentsOfTemplates(templateAddresses: readonly string[]): Promise<{ ok: true; components: DiscoveredComponent[]; pages: number } | { ok: false; reason: string }> {
    const wanted = new Set(templateAddresses);
    const scan = await this.scanReceiptComponents();
    if (!scan.ok) return { ok: false, reason: scan.reason };
    const components: DiscoveredComponent[] = [];
    for (let start = 0; start < scan.ids.length; start += SUBSTATE_BATCH_LIMIT) {
      const batch = scan.ids.slice(start, start + SUBSTATE_BATCH_LIMIT);
      const result = await this.transport.postJson(this.url('/substates/fetch'), { requests: batch.map((substate_id) => ({ substate_id })) });
      if (!result.ok) return { ok: false, reason: result.reason };
      const bag = record(result.payload);
      if (bag === undefined) return { ok: false, reason: 'The batch substate response was not a JSON object.' };
      const substates = bag.substates;
      if (!Array.isArray(substates)) return { ok: false, reason: 'The batch substate response carried no `substates` array.' };
      for (const item of substates) {
        const wrapper = record(item);
        if (wrapper === undefined) continue;
        const inner = record(wrapper.substate) ?? wrapper;
        const component = record(inner.Component);
        if (component === undefined) continue;
        const header = record(component.header);
        if (header === undefined) continue;
        const templateAddress = text(header.template_address);
        if (templateAddress === undefined || !wanted.has(templateAddress)) continue;
        const substateId = text(wrapper.substate_id) ?? text(inner.substate_id);
        if (substateId === undefined) continue;
        components.push({
          componentAddress: substateId,
          templateAddress,
          // u64 on the wire at v0.42.0. Carried as a decimal string so a
          // version beyond 2^53 is never truncated by a JS number.
          version: rawInteger(wrapper.version) ?? rawInteger(inner.version) ?? '0',
        });
      }
    }
    return { ok: true, components, pages: scan.pages };
  }

  /**
   * The full read-only deployment check.
   *
   * The order of the three answers is what makes each state trustworthy:
   *   - identity refused          -> INDEXER_UNAVAILABLE / WRONG_NETWORK
   *   - catalogue has no template -> PROTOCOL_NOT_DEPLOYED (network is fine)
   *   - template present, 0 comps -> PROTOCOL_DEPLOYED_EMPTY (published, unused)
   *   - components present        -> PROTOCOL_AVAILABLE
   */
  async discover(templateName: string): Promise<IndexerDiscoveryResult> {
    const identity = await this.verify();
    if (!identity.ok) return identity;

    const catalogue = await this.listPublishedTemplates(templateName);
    if (!catalogue.ok) {
      return { ok: false, state: 'INDEXER_UNAVAILABLE', detail: `The template catalogue could not be read. ${catalogue.reason}` };
    }
    if (catalogue.entries.length === 0) {
      return {
        ok: true,
        state: 'PROTOCOL_NOT_DEPLOYED',
        publishedTemplates: [],
        components: [],
        receiptPagesRead: 0,
        detail: `The indexer reports no published template named "${templateName}" on this network. The network is reachable; the protocol templates have not been published to it yet.`,
      };
    }

    const found = await this.componentsOfTemplates(catalogue.entries.map((entry) => entry.templateAddress));
    if (!found.ok) {
      return { ok: false, state: 'INDEXER_UNAVAILABLE', detail: `Published templates were found, but their components could not be read. ${found.reason}` };
    }
    return {
      ok: true,
      state: found.components.length > 0 ? 'PROTOCOL_AVAILABLE' : 'PROTOCOL_DEPLOYED_EMPTY',
      publishedTemplates: catalogue.entries,
      components: found.components,
      receiptPagesRead: found.pages,
      detail:
        found.components.length > 0
          ? undefined
          : `"${templateName}" is published, but no component has been instantiated from it yet. The templates are live on this network and simply not used yet.`,
    };
  }
}