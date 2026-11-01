require('./bootstrap.cjs');
/**
 * Minotari L1 -> Ootle L2 burn-and-claim: the parts Shadow Swap can honestly do.
 *
 * The claim transaction itself cannot be built by any dApp (walletd's own claim path signs with
 * a stealth key derived from the account SECRET and decrypts the output's encrypted data), and
 * Sapient advertises no burn or claim capability at all. What is checked here is what a browser
 * CAN establish before a user attempts an irreversible claim: the proof's public structure,
 * whether it is even made out to the connected account, whether L2 has synced far enough, and
 * — afterwards — whether the funds actually arrived.
 *
 * The account's own public key comes from the ENGINE-PRODUCED account component in
 * `ootle-v048-account-inventory.json` (`owner_rule: { ByPublicKey }`), so the destination check
 * is wired to real chain state rather than to a hand-written constant.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/ootle-v048-account-inventory.json');
const { loadOotleWasmBor } = require('./support/ootleWasmBor.cjs');
const pc = require('@tari-ootle/protocol-client');

const KEY_A = 'aa'.repeat(32);
const SIG = 'cd'.repeat(64);

/** A burn proof file with the exact shape of upstream's `CompleteClaimBurnProof`. */
function proofFile(overrides = {}) {
  const claim = {
    burn_public_key: KEY_A,
    ownership_proof: SIG,
    value: 1_000_000,
    output_proof: {
      block_hash: '11'.repeat(32),
      block_height: 42,
      output: {
        version: 0,
        features: 'ff00',
        commitment: '22'.repeat(32),
        rangeproof_hash: '33'.repeat(32),
        script: '7e',
        sender_offset_public_key: '44'.repeat(32),
        metadata_signature: 'ab'.repeat(32),
        covenant: '',
        encrypted_data: 'ee'.repeat(80),
        minimum_value_promise: 0,
      },
      normal_output_proof: { leaf_index: 7, mmr_size: 15, path: ['55'.repeat(32)], peaks: ['66'.repeat(32)] },
      normal_output_mr: '77'.repeat(32),
      block_output_proof: { leaf_index: 3, mmr_size: 7, path: [], peaks: ['88'.repeat(32)] },
    },
    ...(overrides.claim ?? {}),
  };
  if (overrides.output !== undefined) Object.assign(claim.output_proof.output, overrides.output);
  if (overrides.outputProof !== undefined) Object.assign(claim.output_proof, overrides.outputProof);
  const root = { claim_proof: claim, encrypted_data: 'ZW5jcnlwdGVk', mined_in_epoch: 100, ...(overrides.root ?? {}) };
  return JSON.stringify(root);
}

async function accountKey() {
  const d = await loadOotleWasmBor();
  return pc.accountOwnerPublicKey(d.decodeSubstateValue(fixture.substates[fixture.account].value));
}

test('destination: the L2 account public key is read from the account\'s own component header', async () => {
  const key = await accountKey();
  assert.match(key, /^[0-9a-f]{64}$/);
  // It is the key the account's own owner rule names, so the user never transcribes it.
  const d = await loadOotleWasmBor();
  const header = d.decodeSubstateValue(fixture.substates[fixture.account].value).Component.header;
  assert.equal(key, header.owner_rule.ByPublicKey.toLowerCase());
  // A component with no owner public key cannot yield a burn destination.
  assert.throws(() => pc.accountOwnerPublicKey({ Component: { header: { owner_rule: 'None' } } }), /does not state an owner public key/);
});

test('proof: a well-formed file yields exactly the public facts, and never the encrypted data', () => {
  const facts = pc.parseBurnClaimProof(proofFile());
  assert.equal(facts.burnPublicKey, KEY_A);
  assert.equal(facts.value, '1000000');
  assert.equal(facts.commitment, '22'.repeat(32));
  assert.equal(facts.blockHash, '11'.repeat(32));
  assert.equal(facts.blockHeight, '42');
  assert.equal(facts.minedInEpoch, '100');
  assert.equal(facts.senderOffsetPublicKey, '44'.repeat(32));
  assert.equal(facts.normalOutputProof.pathLength, 1);
  assert.equal(facts.blockOutputProof.peaksLength, 1);
  assert.equal(facts.hasEncryptedData, true);
  // The output's own encrypted data never leaves the parser: only a boolean saying it was
  // there, which is what the claimability check needs.
  assert.equal(JSON.stringify(facts).includes('ee'.repeat(80)), false);
  assert.equal(typeof facts.hasEncryptedData, 'boolean');
  // The only key-shaped values are the two that are public by definition: the destination
  // account key and the burn output's sender offset nonce.
  const keyLike = Object.entries(facts).filter(([, v]) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)).map(([k]) => k).sort();
  assert.deepEqual(keyLike, ['blockHash', 'burnPublicKey', 'commitment', 'senderOffsetPublicKey']);
});

test('proof: malformed, oversized and out-of-bound files are refused, never half-read', () => {
  assert.throws(() => pc.parseBurnClaimProof(''), /No burn proof/);
  assert.throws(() => pc.parseBurnClaimProof('not json'), /not a JSON burn proof/);
  assert.throws(() => pc.parseBurnClaimProof('{}'), /claim_proof is not an object/);
  assert.throws(() => pc.parseBurnClaimProof('x'.repeat(pc.MAX_BURN_PROOF_CHARS + 1)), /larger than any burn proof/);
  assert.throws(() => pc.parseBurnClaimProof(proofFile({ claim: { burn_public_key: 'ab' } })), /burn_public_key is not 32 bytes/);
  assert.throws(() => pc.parseBurnClaimProof(proofFile({ claim: { value: 0 } })), /burned value of zero/);
  assert.throws(() => pc.parseBurnClaimProof(proofFile({ claim: { value: -5 } })), /not an exact non-negative integer/);
  assert.throws(() => pc.parseBurnClaimProof(proofFile({ claim: { ownership_proof: 'zz' } })), /ownership_proof is missing or is not a hex signature/);
  // Upstream's own length caps, so the browser refuses what the engine would.
  assert.throws(() => pc.parseBurnClaimProof(proofFile({ output: { script: 'ab'.repeat(4099) } })), /script is longer than 4098 bytes/);
  assert.throws(() => pc.parseBurnClaimProof(proofFile({ output: { encrypted_data: 'ab'.repeat(341) } })), /encrypted_data is longer than 340 bytes/);
  assert.throws(() => pc.parseBurnClaimProof(proofFile({ outputProof: { normal_output_proof: { leaf_index: 1, mmr_size: 2, path: Array(65).fill('11'.repeat(32)), peaks: [] } } })), /more than 64 hashes/);
  assert.throws(() => pc.parseBurnClaimProof(proofFile({ outputProof: { normal_output_proof: { leaf_index: 1, mmr_size: 2, path: ['ab'], peaks: [] } } })), /hash 0 is not 32 bytes/);
  assert.throws(() => pc.parseBurnClaimProof(proofFile({ output: { metadata_signature: null } })), /metadata_signature is missing/);
});

test('verify: a burn made out to ANOTHER account can never be claimed here, and says so', async () => {
  const key = await accountKey();
  const facts = pc.parseBurnClaimProof(proofFile());
  const v = pc.verifyBurnClaim(facts, { accountOwnerPublicKey: key, currentEpoch: '200' });
  assert.equal(v.intendedForThisAccount, false);
  assert.equal(v.claimable, false);
  assert.match(v.blockers.join(' '), /made out to L2 account key/);
  assert.match(v.blockers.join(' '), new RegExp(key));
});

test('verify: the connected account, past the epoch, is claimable — with the irreversibility stated', async () => {
  const key = await accountKey();
  const facts = pc.parseBurnClaimProof(proofFile({ claim: { burn_public_key: key } }));
  const v = pc.verifyBurnClaim(facts, { accountOwnerPublicKey: key, currentEpoch: '200' });
  assert.equal(v.intendedForThisAccount, true);
  assert.deepEqual(v.blockers, []);
  assert.equal(v.claimable, true);
  assert.match(v.warnings.join(' '), /irreversible/);
  assert.match(v.warnings.join(' '), /not an atomic swap/);
  assert.match(v.warnings.join(' '), /no browser wallet exposes a burn claim/);
  // The fee is revealed OUT OF the claimed amount and a positive remainder is required
  // (ClaimBurn::prepare -> BurnClaimFeeTooHigh), so a burn worth less than the fee is
  // permanently unclaimable. That is a precondition no proof check can catch, so it is stated.
  assert.equal(v.warnings.includes(pc.CLAIM_FEE_RULE), true, 'the fee-out-of-the-claim rule is stated');
  assert.match(pc.CLAIM_FEE_RULE, /taken out of the claimed amount/);
  // And the limit of what was actually checked: the engine delegates burn-proof authenticity to
  // the validator nodes (claim_burn_authorization x01), so this app must never imply it verified
  // that a burn happened.
  assert.match(v.warnings.join(' '), /cannot tell you whether this burn really happened|delegates that to the validator nodes/);
  assert.match(v.warnings.join(' '), /proof's structure and whether it names your account/);
});

test('verify: no warning or blocker claims that the burn itself was verified', async () => {
  // The engine asks a ClaimProofVerifier supplied by a validator node; it performs no base-layer
  // check of its own. So nothing user-facing may say the burn was confirmed, proven or verified
  // — only that the PROOF's structure was checked.
  const key = await accountKey();
  const facts = pc.parseBurnClaimProof(proofFile({ claim: { burn_public_key: key } }));
  const v = pc.verifyBurnClaim(facts, { accountOwnerPublicKey: key, currentEpoch: '200' });
  const text = [...v.warnings, ...v.blockers].join(' ');
  assert.doesNotMatch(text, /burn (is|was) (verified|confirmed|proven)/i);
  assert.doesNotMatch(text, /we (verified|confirmed)/i);
});

test('verify: before the burn\'s L1 epoch, and with an unknown epoch, a claim is refused', async () => {
  const key = await accountKey();
  const facts = pc.parseBurnClaimProof(proofFile({ claim: { burn_public_key: key } }));
  const early = pc.verifyBurnClaim(facts, { accountOwnerPublicKey: key, currentEpoch: '100' });
  assert.equal(early.claimable, false);
  assert.match(early.blockers.join(' '), /epoch 100 and this burn was mined in L1 epoch 100/);
  assert.match(early.blockers.join(' '), /permanently rejected/);
  const unknown = pc.verifyBurnClaim(facts, { accountOwnerPublicKey: key });
  assert.equal(unknown.claimable, false);
  assert.match(unknown.blockers.join(' '), /current epoch is unknown/);
  // An incomplete file (no encrypted_data) cannot be claimed by any wallet.
  const incomplete = pc.parseBurnClaimProof(proofFile({ claim: { burn_public_key: key }, root: { encrypted_data: '' } }));
  const v = pc.verifyBurnClaim(incomplete, { accountOwnerPublicKey: key, currentEpoch: '200' });
  assert.match(v.blockers.join(' '), /carries no encrypted_data/);
});

test('state machine: every stage is reached from evidence, and the user\'s word is named as such', async () => {
  const key = await accountKey();
  let record = pc.startCrossLayer('esmeralda', fixture.account, key);
  assert.equal(record.stage, 'DESTINATION_READY');

  const facts = pc.parseBurnClaimProof(proofFile({ claim: { burn_public_key: key } }));
  // Too early -> AWAITING_L2_EPOCH, with the reason, never CLAIM_READY.
  const early = pc.withBurnProof(record, pc.verifyBurnClaim(facts, { accountOwnerPublicKey: key, currentEpoch: '50' }), '0');
  assert.equal(early.stage, 'AWAITING_L2_EPOCH');
  assert.match(pc.describeCrossLayer(early), /Not claimable yet/);

  // A proof for someone else -> BLOCKED.
  const other = pc.withBurnProof(record, pc.verifyBurnClaim(pc.parseBurnClaimProof(proofFile()), { accountOwnerPublicKey: key, currentEpoch: '200' }), '0');
  assert.equal(other.stage, 'BLOCKED');

  // Past the epoch -> CLAIM_READY, and the blockers are cleared rather than carried forward.
  record = pc.withBurnProof(record, pc.verifyBurnClaim(facts, { accountOwnerPublicKey: key, currentEpoch: '200' }), '500');
  assert.equal(record.stage, 'CLAIM_READY');
  assert.equal(record.blockers, undefined);
  assert.equal(record.baselineBalance, '500');
  assert.match(pc.describeCrossLayer(record), /Claim it in your own wallet/);

  // The user says they submitted: recorded, but explicitly NOT confirmation.
  record = pc.reportClaimSubmitted(record);
  assert.equal(record.stage, 'CLAIM_REPORTED_BY_USER');
  assert.match(pc.describeCrossLayer(record), /not confirmation/);

  // A balance that has not risen enough leaves the stage alone: no hopeful completion.
  assert.equal(pc.confirmClaimReceipt(record, '500').stage, 'CLAIM_REPORTED_BY_USER');
  assert.equal(pc.confirmClaimReceipt(record, '1000499').stage, 'CLAIM_REPORTED_BY_USER');
  // The exact burned value arriving is confirmation.
  const done = pc.confirmClaimReceipt(record, String(500 + 1_000_000));
  assert.equal(done.stage, 'CLAIMED_CONFIRMED_ON_CHAIN');
  assert.match(pc.describeCrossLayer(done), /Confirmed on chain/);
  // Confirmation is terminal: a later read cannot walk it back, and there is no "reversed" state.
  assert.equal(pc.confirmClaimReceipt(done, '0').stage, 'CLAIMED_CONFIRMED_ON_CHAIN');
  assert.equal(pc.reportClaimSubmitted(done).stage, 'CLAIMED_CONFIRMED_ON_CHAIN');
});

test('durability: the record carries only public identifiers, and refuses anything secret-shaped', async () => {
  const key = await accountKey();
  const facts = pc.parseBurnClaimProof(proofFile({ claim: { burn_public_key: key } }));
  const record = pc.withBurnProof(pc.startCrossLayer('esmeralda', fixture.account, key), pc.verifyBurnClaim(facts, { accountOwnerPublicKey: key, currentEpoch: '200' }), '0');
  // Everything stored is public chain data.
  assert.deepEqual(Object.keys(record).sort(), ['account', 'accountOwnerPublicKey', 'baselineBalance', 'blockHash', 'commitment', 'minedInEpoch', 'network', 'stage', 'updatedAtUnixMs', 'value']);
  const json = JSON.stringify(record);
  assert.equal(json.includes('ZW5jcnlwdGVk'), false, 'the proof file\'s encrypted_data is never stored');
  assert.equal(json.includes(SIG), false, 'the ownership proof is never stored');
  pc.assertNoSecrets(record);
  for (const key2 of ['encrypted_data', 'mask', 'seedPhrase', 'privateKey', 'viewKey', 'ownership_proof']) {
    assert.throws(() => pc.assertNoSecrets({ ...record, [key2]: 'x' }), /may never carry/, key2);
  }
});

test('claim instructions: the walletd call is described for the user, never performed by this app', () => {
  const record = pc.startCrossLayer('esmeralda', fixture.account, KEY_A);
  const call = pc.claimBurnInstructions(record);
  assert.equal(call.method, 'accounts.claim_burn');
  assert.equal(call.params.account, fixture.account);
  assert.equal(call.params.dry_run, true, 'a dry run first');
  assert.match(call.note, /your own walletd/);
  // The note must name the key that actually SEALS the claim. "a key derived from your account
  // secret" was too loose: the transaction is sealed by the stealth burn-claim key
  // s = H(R.p) + p, and the engine rejects a claim signed by the account key alone with
  // AccessDenied (claim_burn_authorization x02). Getting this wrong would tell a reader that
  // their ordinary wallet signature is enough, which it is not.
  assert.match(call.note, /SEALED by the stealth burn-claim key/);
  assert.match(call.note, /not by the account key itself/);
  assert.match(call.note, /AccessDenied/);
  assert.match(call.note, /never sees p or s/);
  // No URL, host or token is implied: this app has no access to a wallet daemon.
  assert.equal(/127\.0\.0\.1|localhost|http/.test(JSON.stringify(call)), false);
});

// ---------------------------------------------------------------------------------------------
// Recovery. A user who reloads AFTER an irreversible burn but BEFORE claiming depends on this,
// so every rejection path is pinned rather than left to a catch-all.
// ---------------------------------------------------------------------------------------------

test('recovery: a conversion survives a reload, and the restored record is the one that was saved', async () => {
  const key = await accountKey();
  const facts = pc.parseBurnClaimProof(proofFile({ claim: { burn_public_key: key } }));
  const verdict = pc.verifyBurnClaim(facts, { accountOwnerPublicKey: key, currentEpoch: '200' });
  const saved = pc.withBurnProof(pc.startCrossLayer('esmeralda', fixture.account, key), verdict, '1000');
  assert.equal(saved.stage, 'CLAIM_READY');

  const restored = pc.restoreCrossLayer(pc.serializeCrossLayer(saved), { network: 'esmeralda', account: fixture.account });
  assert.deepEqual(restored, saved);
  // And the conversion can be carried on from the restored record, not just displayed.
  assert.equal(pc.reportClaimSubmitted(restored).stage, 'CLAIM_REPORTED_BY_USER');
  assert.equal(pc.confirmClaimReceipt(restored, '1000').stage, 'CLAIM_READY', 'no balance gain is not a confirmation');
  assert.equal(
    pc.confirmClaimReceipt(restored, String(1000n + BigInt(saved.value))).stage,
    'CLAIMED_CONFIRMED_ON_CHAIN',
  );
});

test('recovery: a record is refused unless it belongs to THIS account and network', async () => {
  const key = await accountKey();
  const raw = pc.serializeCrossLayer(pc.startCrossLayer('esmeralda', fixture.account, key));
  // Switching accounts or networks must never resurrect another conversion and show it as this
  // one: the destination of a burn is an account key, so a mismatched record is misleading in
  // exactly the place it matters.
  assert.equal(pc.restoreCrossLayer(raw, { network: 'esmeralda', account: 'component_' + 'ff'.repeat(32) }), undefined);
  assert.equal(pc.restoreCrossLayer(raw, { network: 'localnet', account: fixture.account }), undefined);
  assert.notEqual(pc.restoreCrossLayer(raw, { network: 'esmeralda', account: fixture.account }), undefined);
});

test('recovery: unreadable, tampered and secret-carrying records are dropped, never thrown or trusted', async () => {
  const key = await accountKey();
  const good = pc.startCrossLayer('esmeralda', fixture.account, key);
  const expect = { network: 'esmeralda', account: fixture.account };

  // Storage is attacker-writable in a shared browser, so none of these may throw: a conversion's
  // truth is on chain, and an unusable aid must degrade to "no record" rather than to an error
  // the user cannot act on.
  for (const raw of [null, undefined, '', 'not json', '[]', 'null', '"a string"', '42']) {
    assert.equal(pc.restoreCrossLayer(raw, expect), undefined, JSON.stringify(raw));
  }
  // An unknown stage cannot be rendered honestly.
  assert.equal(pc.restoreCrossLayer(JSON.stringify({ ...good, stage: 'ALMOST_DONE' }), expect), undefined);
  assert.equal(pc.restoreCrossLayer(JSON.stringify({ ...good, stage: undefined }), expect), undefined);
  // A timestamp is what orders the record against a fresh read.
  assert.equal(pc.restoreCrossLayer(JSON.stringify({ ...good, updatedAtUnixMs: 'recently' }), expect), undefined);
  // A secret-shaped field written by an older build or by hand: reading it back is the moment
  // to refuse, not to propagate.
  for (const field of ['encrypted_data', 'spendKey', 'mask', 'seedPhrase', 'ownership_proof']) {
    assert.equal(pc.restoreCrossLayer(JSON.stringify({ ...good, [field]: 'x' }), expect), undefined, field);
  }
  // Writing one is refused loudly, because that is a programming error in this app.
  assert.throws(() => pc.serializeCrossLayer({ ...good, viewKey: 'x' }), /may never carry/);
});

test('recovery: every stage name the state machine can produce is restorable', async () => {
  // CROSS_LAYER_STAGES is the allow-list `restoreCrossLayer` filters on, so a stage added to
  // the machine without being added there would silently become unrecoverable.
  const key = await accountKey();
  const good = pc.startCrossLayer('esmeralda', fixture.account, key);
  const expect = { network: 'esmeralda', account: fixture.account };
  for (const stage of pc.CROSS_LAYER_STAGES) {
    const restored = pc.restoreCrossLayer(JSON.stringify({ ...good, stage }), expect);
    assert.equal(restored?.stage, stage, stage);
    // And each one describes itself, so no restored stage can render blank.
    assert.ok(pc.describeCrossLayer({ ...good, stage }).length > 0, stage);
  }
});
