import type { HttpProbeResult, RunnerDetailedSkipReason, StoryboardRunOptions } from '../types';
import type { NegativeVector } from './types';
import { gradeOneVector } from './grader';
import { parseRequestSigningStepId } from './synthesize';
import { loadRequestSigningVectors } from './vector-loader';

/**
 * Detail surfaced on each vector step an A2A run cannot frame. Written for
 * the operator reading a conformance report: it has to say what coverage is
 * missing and what would restore it.
 *
 * Reported as `signing_transport_unavailable` → canonical
 * `fixture_unavailable`, so the security_transport track grades `partial`
 * rather than letting a sibling storyboard's passes roll it up green.
 */
export const SIGNING_VECTORS_UNAVAILABLE_DETAIL =
  'Coverage unavailable: the request-signing vectors ship REST request bodies that the grader can replay ' +
  'verbatim (`raw`) or re-frame as an MCP `tools/call` envelope (`mcp`), and neither shape is an A2A ' +
  "request — no A2A framing is defined for these fixtures, so nothing about this agent's verifier was " +
  "graded (adcontextprotocol/adcp-client#2954). Remedy: grade the verifier through the agent's MCP or " +
  'REST binding, or set `request_signing.transport` (CLI `--signing-transport`) when that binding answers ' +
  'at this same URL.';

/**
 * Resolve the vector transport for a graded agent.
 *
 * Defaults to `'mcp'`: the storyboard runner reaches MCP agents through
 * `tools/call` — never through per-task HTTP paths — so replaying the
 * vectors' recorded REST targets (`/adcp/create_media_buy`, raw task body)
 * verbatim guarantees a routing 404 on every MCP-transport agent before its
 * verifier can run (adcontextprotocol/adcp#6548). Operators grading a
 * REST-binding agent opt back in with `request_signing.transport: 'raw'`.
 *
 * Returns `undefined` on an A2A run that didn't pick a transport explicitly:
 * neither shipped shape is an A2A request, so the vectors are not gradable
 * and the caller skips them as `signing_transport_unavailable` (canonical
 * `fixture_unavailable`) instead of POSTing an MCP envelope at an A2A
 * endpoint and grading the resulting 405 as a signature failure
 * (adcp-client#2954). An explicit `transport` still wins —
 * that's the escape hatch for an agent whose MCP or REST binding answers on
 * the same URL as its A2A card.
 *
 * Adding a real `'a2a'` member is blocked upstream, not here: the shipped
 * fixtures carry REST request bodies only, and no AdCP spec text defines an
 * A2A framing for them (including how a verifier would scope `required_for`
 * over `message/send`). Synthesizing an envelope in the SDK would bake an
 * invented binding into every adopter's conformance run. The only vectors
 * that still grade are the ones needing no framing at all — see
 * `gradableWithoutVectorTransport`.
 */
export function resolveVectorTransport(
  rsOpts: { transport?: 'raw' | 'mcp' },
  protocol?: 'mcp' | 'a2a'
): 'raw' | 'mcp' | undefined {
  if (rsOpts.transport) return rsOpts.transport;
  if (protocol === 'a2a') return undefined;
  return 'mcp';
}

/**
 * Dispatch a synthesized request-signing step. The step ID encodes the vector
 * (`positive-<id>` / `negative-<id>`); this helper decodes it, runs the
 * grader's per-vector logic, and maps the `VectorGradeResult` to an
 * `HttpProbeResult`-shaped return so the HTTP validation pipeline
 * (`http_status`, `http_status_in`) works unchanged for probed vectors.
 *
 * Vectors the grader decides in-library rather than over HTTP (the
 * `jwks_override` negatives) carry `http_status: 0` by contract — there is no
 * wire exchange to report. Their verdict travels on `error`: unset when the
 * library verifier produced the expected rejection, set to the grader's
 * diagnostic otherwise. `synthesizeNegativeStep` pairs those vectors with a
 * `probe_passed` validation that reads exactly that field; asserting an HTTP
 * status against them would compare a grade to a status code that no
 * implementation can move (adcp-client#2955).
 */
export async function probeRequestSigningVector(
  stepId: string,
  agentUrl: string,
  options: StoryboardRunOptions
): Promise<HttpProbeResult> {
  const parsed = parseRequestSigningStepId(stepId);
  if (!parsed) {
    return {
      url: agentUrl,
      status: 0,
      headers: {},
      body: null,
      error: `request_signing_probe: step id "${stepId}" does not match positive-/negative- prefix`,
    };
  }
  const rsOpts = options.request_signing ?? {};
  const transport = resolveVectorTransport(rsOpts, options.protocol);
  // Operator selection first, in the grader's own precedence (`onlyVectors`
  // over `skipVectors`, per `preflightSkip`). A vector the operator never
  // selected is out of scope — reporting it as a coverage gap would
  // manufacture one, inflating the run's unavailable count and dragging the
  // track to `partial` over vectors nobody asked to grade (adcp-client#2954).
  if (rsOpts.onlyVectors && !rsOpts.onlyVectors.includes(parsed.vector_id)) {
    return skipProbe(agentUrl, 'not_in_only_vectors');
  }
  if (rsOpts.skipVectors?.includes(parsed.vector_id)) {
    return skipProbe(agentUrl, 'operator_skip');
  }
  // Vector-id lookup so we skip by the vector's own fields, not by hardcoded
  // vector id — keeps the dispatch resilient to upstream renames. Loaded only
  // when a decision actually needs it: the grader loads the vectors again.
  let vector: NegativeVector | undefined;
  if (parsed.kind === 'negative' && (rsOpts.skipRateAbuse === true || !transport)) {
    try {
      const loaded = loadRequestSigningVectors({
        version: options.adcpVersion,
        complianceDir: options.complianceDir,
      });
      vector = loaded.negative.find(v => v.id === parsed.vector_id);
    } catch {
      // fall through — surfaces as a grader error below
    }
  }
  if (parsed.kind === 'negative' && rsOpts.skipRateAbuse && vector?.requires_contract === 'rate_abuse') {
    return skipProbe(agentUrl, 'rate_abuse_opt_out');
  }
  // No transport can frame this run's vectors (A2A, no explicit override).
  // Skip before any network work and report the gap as missing coverage, not
  // as agent inapplicability — but only for the vectors that actually need a
  // framing.
  if (!transport && !gradableWithoutVectorTransport(vector)) {
    return skipProbe(agentUrl, 'signing_transport_unavailable', SIGNING_VECTORS_UNAVAILABLE_DETAIL);
  }
  try {
    const result = await gradeOneVector(parsed.vector_id, parsed.kind, agentUrl, {
      ...(options.adcpVersion && { version: options.adcpVersion }),
      ...(options.complianceDir && { complianceDir: options.complianceDir }),
      allowPrivateIp: options.allow_http === true,
      rateAbuseCap: rsOpts.rateAbuseCap,
      allowLiveSideEffects: rsOpts.allowLiveSideEffects,
      onlyVectors: rsOpts.onlyVectors,
      skipVectors: rsOpts.skipVectors,
      skipRateAbuse: rsOpts.skipRateAbuse,
      // A vector reaching here without a resolved transport is in-library
      // only (`gradableWithoutVectorTransport`); the grader never probes it,
      // so the value is inert.
      transport: transport ?? 'mcp',
      // The auto-initialize handshake authenticates like any MCP client;
      // agents commonly require auth on `initialize` (the signed vectors
      // themselves stay bearer-less — the signature is their auth).
      ...(options.auth?.type === 'bearer' && options.auth.token
        ? { initializeHeaders: { authorization: `Bearer ${options.auth.token}` } }
        : {}),
      mcpSessionId: rsOpts.mcpSessionId,
      mcpProtocolVersion: rsOpts.mcpProtocolVersion,
    });
    if (result.skipped) {
      return skipProbe(agentUrl, (result.skip_reason as RunnerDetailedSkipReason | undefined) ?? 'grader_skipped');
    }
    const headers: Record<string, string> = {};
    if (result.actual_error_code) {
      headers['www-authenticate'] = `Signature error="${result.actual_error_code}"`;
    }
    return {
      url: agentUrl,
      status: result.http_status,
      headers,
      body: result.diagnostic ?? null,
      error: result.passed ? undefined : (result.diagnostic ?? 'vector grade failed'),
    };
  } catch (err) {
    return {
      url: agentUrl,
      status: 0,
      headers: {},
      body: null,
      error: `request_signing_probe threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Whether a vector still grades when the run has no vector transport.
 *
 * Only the `jwks_override` negatives qualify: the grader decides them against
 * the library verifier with no HTTP exchange at all, so the run's protocol is
 * irrelevant to them.
 *
 * Nothing else does. A protocol-method negative such as
 * `028-unsigned-protocol-method-required` ships a complete `tasks/cancel`
 * JSON-RPC envelope, and replaying those bytes straight at an A2A endpoint
 * looks tempting — but that is a hand-rolled A2A dispatch, which AGENTS.md
 * forbids without exception, and the official `@a2a-js/sdk` handlers reject
 * that request shape anyway (unsigned, unauthenticated, raw). Until the
 * vector can be driven through the official client without the SDK inventing
 * framing, it is missing coverage on A2A like every other probed vector.
 */
function gradableWithoutVectorTransport(vector: NegativeVector | undefined): boolean {
  return vector?.jwks_override !== undefined;
}

function skipProbe(url: string, reason: RunnerDetailedSkipReason, detail?: string): HttpProbeResult {
  // The runner builds `skip.detail` from `CANONICAL_SKIP_DETAILS[reason] ??
  // error ?? …`, so a supplied detail is what the operator reads — as long as
  // the reason has no entry in that contract-mandated map. Add one there and
  // this argument stops being visible.
  return {
    url,
    status: 0,
    headers: {},
    body: null,
    skipped: true,
    skip_reason: reason,
    ...(detail && { error: detail }),
  };
}
