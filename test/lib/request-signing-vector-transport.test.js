const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const {
  resolveVectorTransport,
  probeRequestSigningVector,
  SIGNING_VECTORS_UNAVAILABLE_DETAIL,
} = require('../../dist/lib/testing/storyboard/request-signing/probe-dispatch.js');
const { DETAILED_SKIP_TO_CANONICAL } = require('../../dist/lib/testing/storyboard/types.js');

test("vector transport defaults to 'mcp' — the runner reaches agents via tools/call, so raw REST replay 404s on MCP agents by construction (adcp#6548)", () => {
  assert.strictEqual(resolveVectorTransport({}), 'mcp');
});

test("explicit 'raw' opt-in for REST-binding agents is respected", () => {
  assert.strictEqual(resolveVectorTransport({ transport: 'raw' }), 'raw');
});

test("explicit 'mcp' setting is respected", () => {
  assert.strictEqual(resolveVectorTransport({ transport: 'mcp' }), 'mcp');
});

test("an mcp-protocol run still resolves to 'mcp'", () => {
  assert.strictEqual(resolveVectorTransport({}, 'mcp'), 'mcp');
});

test('an a2a-protocol run with no explicit transport has no gradable transport (adcp-client#2954)', () => {
  assert.strictEqual(resolveVectorTransport({}, 'a2a'), undefined);
});

test('an explicit transport still wins on an a2a run — escape hatch for a co-mounted MCP/REST binding', () => {
  assert.strictEqual(resolveVectorTransport({ transport: 'mcp' }, 'a2a'), 'mcp');
  assert.strictEqual(resolveVectorTransport({ transport: 'raw' }, 'a2a'), 'raw');
});

test('a2a vector dispatch reports missing coverage, not agent inapplicability', async () => {
  const result = await probeRequestSigningVector('negative-001-no-signature-header', 'https://agent.invalid/a2a', {
    protocol: 'a2a',
  });

  assert.strictEqual(result.skipped, true);
  // `fixture_unavailable` (not `not_applicable`) is what keeps the track
  // partial — see the aggregate test below.
  assert.strictEqual(result.skip_reason, 'signing_transport_unavailable');
  assert.strictEqual(DETAILED_SKIP_TO_CANONICAL[result.skip_reason], 'fixture_unavailable');
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.error, SIGNING_VECTORS_UNAVAILABLE_DETAIL);
  // The operator has to be able to act on the skip: say it is a gap, and
  // name the remedy.
  assert.match(result.error, /Coverage unavailable/);
  assert.match(result.error, /--signing-transport/);
});

test('an a2a run still grades the in-library vector', async () => {
  // 025 is decided against the library verifier with no wire exchange, so
  // the run's protocol is irrelevant to it.
  const inLibrary = await probeRequestSigningVector('negative-025-jwk-alg-crv-mismatch', 'https://agent.invalid/a2a', {
    protocol: 'a2a',
  });

  assert.strictEqual(inLibrary.skipped, undefined, 'in-library vector must still be graded on a2a');
  assert.strictEqual(inLibrary.error, undefined);
});

test('the protocol-method vector is NOT replayed raw at an A2A endpoint', async () => {
  // Vector 028's body is a complete `tasks/cancel` JSON-RPC envelope, which
  // makes raw replay at an A2A endpoint look safe. It is not: that is a
  // hand-rolled A2A dispatch (AGENTS.md forbids it without exception) and
  // the official `@a2a-js/sdk` handlers reject the unsigned, unauthenticated
  // raw shape anyway. On A2A it is missing coverage like any other probed
  // vector — no allowlist, no verbatim-replay carve-out.
  const result = await probeRequestSigningVector(
    'negative-028-unsigned-protocol-method-required',
    'https://agent.invalid/a2a',
    { protocol: 'a2a' }
  );

  assert.strictEqual(result.skipped, true, 'no raw A2A dispatch may be attempted');
  assert.strictEqual(result.skip_reason, 'signing_transport_unavailable');
  assert.strictEqual(DETAILED_SKIP_TO_CANONICAL[result.skip_reason], 'fixture_unavailable');
});

test('the protocol-method vector still grades on MCP, posting its own JSON-RPC body verbatim', async t => {
  // The coverage 028 exists to prove (`protocol_methods_required_for`) is
  // unaffected on the transport that can carry it: the fixture bytes go to
  // the MCP mount unchanged, with no `tools/call` wrapper.
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': 'Signature error="request_signature_required"',
    });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;

  const result = await probeRequestSigningVector('negative-028-unsigned-protocol-method-required', agentUrl, {
    protocol: 'mcp',
    allow_http: true,
    // Documented sentinel: skip the `initialize` handshake so the probe is
    // the only request this fixture server has to answer.
    request_signing: { mcpSessionId: '' },
  });

  assert.strictEqual(result.skipped, undefined, `expected a graded vector, got skip ${result.skip_reason}`);
  assert.strictEqual(result.status, 401);
  assert.strictEqual(result.error, undefined, `expected a passing grade, got: ${result.error}`);

  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].url, '/mcp');
  const body = JSON.parse(received[0].body);
  assert.strictEqual(body.method, 'tasks/cancel', 'protocol-method body is not wrapped in tools/call');
  assert.deepStrictEqual(body.params, { taskId: 'task_conformance_001' });
});

test('a2a dispatch with an explicit transport does not self-skip (it probes and reports the probe outcome)', async () => {
  // `agent.invalid` never resolves, so the probe reports a network error
  // rather than a skip. The assertion is about which branch was taken.
  const result = await probeRequestSigningVector('negative-001-no-signature-header', 'https://agent.invalid/a2a', {
    protocol: 'a2a',
    request_signing: { transport: 'raw' },
  });

  assert.notStrictEqual(result.skip_reason, 'transport_ungradable');
});

test('the storyboard runner threads its resolved protocol into the vector dispatch', async () => {
  // Step-level proof for the wiring the unit tests above assume: an A2A run
  // reaches `probeRequestSigningVector` with `protocol: 'a2a'` and the step
  // skips before any dispatch. The agent URL never resolves, so a regression
  // that dropped the protocol would surface as a probe error, not a skip.
  const { runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner.js');

  const result = await runStoryboardStep(
    'https://agent.invalid/a2a',
    a2aVectorStoryboard(),
    'negative-001-no-signature-header',
    {
      protocol: 'a2a',
      // Pre-supplied profile: skips capability discovery so the step runs
      // without a live agent.
      profile: A2A_SIGNING_PROFILE,
    }
  );

  assert.strictEqual(result.skipped, true, `expected a skipped step, got: ${JSON.stringify(result.skip ?? result)}`);
  assert.strictEqual(result.skip_reason, 'signing_transport_unavailable');
  assert.strictEqual(result.skip.reason, 'fixture_unavailable');
  assert.match(result.skip.detail, /Coverage unavailable/);
  assert.deepStrictEqual(result.validations, [], 'an ungradable vector must not run its HTTP validations');
});

test('an A2A run reports every ungradable vector as a coverage gap, never a storyboard-wide pass', async () => {
  // The storyboard itself must still run: gating the whole storyboard on the
  // run-level protocol both hides the gap behind one synthetic skip and
  // breaks routed runs (a top-level `a2a` run can carry an MCP seller).
  const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

  const result = await runStoryboard('https://agent.invalid/a2a', a2aVectorStoryboard(), {
    protocol: 'a2a',
    profile: A2A_SIGNING_PROFILE,
  });

  const steps = result.phases.flatMap(phase => phase.steps);
  assert.deepStrictEqual(
    steps.map(step => step.step_id),
    ['negative-001-no-signature-header'],
    'the storyboard runs; the vector step is where the gap is reported'
  );
  assert.strictEqual(steps[0].skipped, true);
  assert.strictEqual(steps[0].skip.reason, 'fixture_unavailable');
  assert.strictEqual(steps[0].skip_reason, 'signing_transport_unavailable');
  assert.match(steps[0].skip.detail, /Coverage unavailable/);
  assert.strictEqual(result.passed_count, 0, 'no verifier behavior was graded');
  assert.strictEqual(
    steps[0].selection_result,
    undefined,
    'a coverage gap is a skipped step, not an out-of-profile exclusion'
  );
});

test('a passing sibling storyboard cannot roll the security_transport track up to pass', async () => {
  // `oauth_setup` and `signed_requests` share the security_transport track.
  // With the ungradable vectors reported as `fixture_unavailable`, the track
  // grades `partial` even though the sibling passed every step — the
  // false-assurance case a whole-storyboard `not_applicable` skip allowed.
  const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
  const { mapStoryboardResultsToTrackResult } = require('../../dist/lib/testing/compliance/storyboard-tracks.js');
  const { computeOverallStatus } = require('../../dist/lib/testing/compliance/comply.js');

  const signing = await runStoryboard('https://agent.invalid/a2a', a2aVectorStoryboard(), {
    protocol: 'a2a',
    profile: A2A_SIGNING_PROFILE,
  });

  const sibling = {
    storyboard_id: 'oauth_setup',
    storyboard_title: 'OAuth setup',
    agent_url: 'https://agent.invalid/a2a',
    overall_passed: true,
    passed_count: 6,
    failed_count: 0,
    skipped_count: 0,
    total_duration_ms: 1,
    phases: [
      {
        phase_id: 'oauth_discovery',
        phase_title: 'OAuth discovery',
        passed: true,
        duration_ms: 1,
        steps: [
          { step_id: 'prm', phase_id: 'oauth_discovery', title: 'PRM', task: 'x', passed: true, validations: [] },
        ],
      },
    ],
    context: {},
    notices: [],
  };

  const track = mapStoryboardResultsToTrackResult('security_transport', [sibling, signing], { name: 'a', tools: [] });
  assert.strictEqual(track.status, 'partial', `expected partial, got ${track.status}`);

  const overall = computeOverallStatus({
    tracks_passed: 3,
    tracks_failed: 0,
    tracks_partial: 1,
    tracks_skipped: 0,
    tracks_silent: 0,
  });
  assert.strictEqual(overall, 'partial', 'a run with an ungraded signing track must not report passing');
});

test('a storyboard whose wire coverage was unavailable cannot report overall_passed', async () => {
  // The in-library self-check (025) grades green while every probed vector is
  // unavailable. Without this rule the storyboard reports `overall_passed:
  // true` off an SDK self-check the agent never saw (adcp-client#2954).
  const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

  const storyboard = {
    id: 'signed_requests',
    title: 'Signed requests',
    phases: [
      {
        id: 'negative_vectors',
        title: 'Negative vectors',
        steps: [
          {
            id: 'negative-025-jwk-alg-crv-mismatch',
            title: 'SDK self-check',
            task: 'request_signing_probe',
            validations: [{ check: 'probe_passed' }],
          },
          {
            id: 'negative-001-no-signature-header',
            title: 'Wire vector',
            task: 'request_signing_probe',
            validations: [{ check: 'http_status', value: 401 }],
          },
        ],
      },
    ],
  };

  const result = await runStoryboard('https://agent.invalid/a2a', storyboard, {
    protocol: 'a2a',
    profile: A2A_SIGNING_PROFILE,
  });

  assert.strictEqual(result.passed_count, 1, 'the in-library self-check still grades');
  assert.strictEqual(result.failed_count, 0);
  assert.strictEqual(
    result.overall_passed,
    false,
    'a storyboard with unverified wire coverage must not report a pass beside an SDK self-check'
  );
});

test('a track whose every step was unavailable stays partial instead of evaporating into skip', async () => {
  // `computeTrackStatus` returned `skip` for an all-skipped track, and
  // `computeOverallStatus` ignores skipped tracks — so sibling tracks alone
  // could carry the run to `passing` while signing verified nothing.
  const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
  const { mapStoryboardResultsToTrackResult } = require('../../dist/lib/testing/compliance/storyboard-tracks.js');
  const { computeOverallStatus } = require('../../dist/lib/testing/compliance/comply.js');

  const signing = await runStoryboard('https://agent.invalid/a2a', a2aVectorStoryboard(), {
    protocol: 'a2a',
    profile: A2A_SIGNING_PROFILE,
  });
  assert.strictEqual(signing.passed_count, 0, 'every step in this track is a coverage gap');
  assert.strictEqual(signing.skipped_count, 1);

  const track = mapStoryboardResultsToTrackResult('security_transport', [signing], { name: 'a', tools: [] });
  assert.strictEqual(track.status, 'partial', `an all-unavailable track must not be skip, got ${track.status}`);

  // And a partial track keeps the whole run off `passing`, however many
  // other tracks passed.
  const overall = computeOverallStatus({
    tracks_passed: 7,
    tracks_failed: 0,
    tracks_partial: 1,
    tracks_skipped: 0,
    tracks_silent: 0,
  });
  assert.strictEqual(overall, 'partial');
});

test('a routed MCP agent still grades its vectors under a top-level a2a run', async t => {
  // adcp-client#2958 review: the run-level protocol is not the dispatch
  // protocol in a routed run. Gating on it would strand a perfectly gradable
  // MCP seller.
  const { probeRequestSigningVector } = require('../../dist/lib/testing/storyboard/request-signing/probe-dispatch.js');
  const { routedAgentOptions } = require('../../dist/lib/testing/storyboard/agent-routing.js');

  const routed = routedAgentOptions(
    { url: 'https://seller.invalid/mcp', transport: 'mcp' },
    { protocol: 'a2a' },
    { name: 'seller', tools: ['get_adcp_capabilities'] }
  );
  assert.strictEqual(routed.protocol, 'mcp', 'routed options carry the entry transport');

  const result = await probeRequestSigningVector(
    'negative-001-no-signature-header',
    'https://seller.invalid/mcp',
    routed
  );
  assert.notStrictEqual(
    result.skip_reason,
    'signing_transport_unavailable',
    'an MCP-routed seller must still be graded'
  );
  t.diagnostic(`routed probe outcome: ${result.skip_reason ?? result.error ?? 'graded'}`);
});

const A2A_SIGNING_PROFILE = {
  name: 'a2a-agent',
  tools: ['get_adcp_capabilities'],
  raw_capabilities: { request_signing: { supported: true } },
};

function a2aVectorStoryboard() {
  return {
    id: 'signed_requests',
    title: 'Signed requests',
    phases: [
      {
        id: 'negative_vectors',
        title: 'Negative vectors',
        steps: [
          {
            id: 'negative-001-no-signature-header',
            title: 'Negative vector',
            task: 'request_signing_probe',
            validations: [{ check: 'http_status', value: 401 }],
          },
        ],
      },
    ],
  };
}

test('operator vector selection is applied before transport availability', async () => {
  // A vector the operator never selected is out of scope, not missing
  // coverage. Reporting it as `fixture_unavailable` would manufacture a gap
  // (and drag the track to partial) over vectors nobody asked to grade.
  const unselected = await probeRequestSigningVector('negative-001-no-signature-header', 'https://agent.invalid/a2a', {
    protocol: 'a2a',
    request_signing: { onlyVectors: ['002-wrong-tag'] },
  });

  assert.strictEqual(unselected.skipped, true);
  assert.strictEqual(unselected.skip_reason, 'not_in_only_vectors');
  assert.strictEqual(DETAILED_SKIP_TO_CANONICAL[unselected.skip_reason], 'not_applicable');
  assert.strictEqual(unselected.error, undefined, 'an unselected vector carries no coverage-gap remedy');

  // …and the vector the operator DID select keeps its truthful verdict.
  const selected = await probeRequestSigningVector('negative-002-wrong-tag', 'https://agent.invalid/a2a', {
    protocol: 'a2a',
    request_signing: { onlyVectors: ['002-wrong-tag'] },
  });
  assert.strictEqual(selected.skip_reason, 'signing_transport_unavailable');
  assert.strictEqual(DETAILED_SKIP_TO_CANONICAL[selected.skip_reason], 'fixture_unavailable');
});

test('skipVectors is also applied before transport availability', async () => {
  const result = await probeRequestSigningVector('negative-001-no-signature-header', 'https://agent.invalid/a2a', {
    protocol: 'a2a',
    request_signing: { skipVectors: ['001-no-signature-header'] },
  });

  assert.strictEqual(result.skip_reason, 'operator_skip', 'an operator exclusion is not a coverage gap');
});

test('the rate-abuse probe count comes from the test-kit contract, not an SDK-chosen number', () => {
  // `rateAbuseCap` drives a `for (i < cap)` probe loop. This PR types the
  // option on `ComplyOptions`; it does not widen its reach — it is public on
  // `StoryboardRunOptions.request_signing` and `GradeOptions` on origin/main,
  // and already flowed through comply()'s rest-spread there. What bounds the
  // default is the shipped contract, asserted here so an SDK-side default can
  // never quietly exceed it.
  const { loadSignedRequestsRunnerContract } = require('../../dist/lib/testing/storyboard/request-signing/test-kit.js');

  const contract = loadSignedRequestsRunnerContract();
  assert.ok(contract, 'expected the bundled signed-requests runner contract');
  const target = contract.stateful_vector_contract.rate_abuse.grading_target_per_keyid_cap_requests;
  assert.strictEqual(typeof target, 'number');
  assert.ok(target > 0 && target <= 1000, `contract cap should be a bounded probe count, got ${target}`);
});

test('--signing-skip-rate-abuse still short-circuits the vector before any lookup of the cap', async () => {
  const result = await probeRequestSigningVector('negative-020-rate-abuse', 'https://agent.invalid/mcp', {
    request_signing: { skipRateAbuse: true, rateAbuseCap: 1_000_000 },
  });

  assert.strictEqual(result.skip_reason, 'rate_abuse_opt_out');
});
