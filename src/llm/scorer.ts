/**
 * Dynamic message complexity scorer — inspired by claw-llm-router.
 * Scores a message across multiple dimensions in <1ms (no LLM call) and
 * returns the suggested LLM tier. ~80% of traffic is resolved here.
 *
 * Tier thresholds (cumulative score):
 *   simple   < 0.25  — factual queries, greetings, status checks
 *   complex  ≥ 0.25  — reasoning, code, multi-step, long analysis
 *
 * Note: 'vision', 'creative', 'offline' tiers are set upstream (image attached,
 * user preference, etc.) and are not affected by this scorer.
 */

export type LLMTier = 'simple' | 'complex' | 'vision' | 'creative' | 'offline' | 'local_vision';

interface ScoredDimension {
  name:   string;
  weight: number;
  hit:    boolean;
}

export interface ScoreResult {
  tier:       LLMTier;
  score:      number;
  dimensions: ScoredDimension[];
}

// ── Dimension patterns ────────────────────────────────────────────────────────

const DIM_CODE          = /```|`[^`]+`|\bfunction\b|\bclass\b|\bdef\b|\bimport\b|\bconst\b|\bvar\b|\breturn\b/i;
const DIM_MULTI_STEP    = /\b(then|after that|also|first|next|finally|step \d|steps?:|and then|followed by)\b/i;
const DIM_REASONING     = /\b(why|how (does|do|would|should)|analyze|analyse|explain|compare|evaluate|reason|think through|assess|diagnose|review|critique|refactor|architect|design)\b/i;
const DIM_DEBUG         = /\b(debug|error|bug|fix|issue|problem|failing|broken|not working|investigate|trace|log)\b/i;
const DIM_CREATIVE      = /\b(write (me |a |an )|draft|generate|create|compose|imagine|brainstorm|story|poem|essay|script)\b/i;
const DIM_TECHNICAL     = /\b(algorithm|architecture|performance|optimiz|scalab|distribut|concurrent|async|parallel|schema|database|api|endpoint|latency|throughput)\b/i;
const DIM_GREETING      = /^(hi|hello|hey|yo|sup|howdy|good (morning|afternoon|evening|night)|thanks|thank you|ok|okay|yes|no|nope|yep|cool|great|got it|sure|alright|sounds good)[\s!.]*$/i;
const DIM_SHORT_QUERY   = /^(what (is|are|was)|who is|where is|when (is|was|did)|how (much|many|long|far)|show me|list|get|fetch|check|status|price|balance|quote)[\s\w?]+$/i;
const DIM_ACKNOWLEDGEMENT = /^(yes|no|confirm|cancel|ok|okay|y|n|done|stop|go|proceed|continue|abort)[\s!.]*$/i;

// ── Scorer ────────────────────────────────────────────────────────────────────

export function scoreMessage(text: string): ScoreResult {
  const t = text.trim();
  const len = t.length;

  const dimensions: ScoredDimension[] = [
    // Complexity signals (add to score)
    { name: 'code_present',    weight:  0.30, hit: DIM_CODE.test(t) },
    { name: 'multi_step',      weight:  0.20, hit: DIM_MULTI_STEP.test(t) },
    { name: 'reasoning_verb',  weight:  0.25, hit: DIM_REASONING.test(t) },
    { name: 'debug_request',   weight:  0.20, hit: DIM_DEBUG.test(t) },
    { name: 'technical_terms', weight:  0.15, hit: DIM_TECHNICAL.test(t) },
    { name: 'creative_task',   weight:  0.15, hit: DIM_CREATIVE.test(t) },
    { name: 'long_message',    weight:  0.15, hit: len > 400 },
    { name: 'very_long',       weight:  0.10, hit: len > 900 },

    // Simplicity signals (subtract from score)
    { name: 'greeting',        weight: -0.40, hit: DIM_GREETING.test(t) },
    { name: 'acknowledgement', weight: -0.35, hit: DIM_ACKNOWLEDGEMENT.test(t) },
    { name: 'short_query',     weight: -0.15, hit: DIM_SHORT_QUERY.test(t) && len < 120 },
    { name: 'very_short',      weight: -0.10, hit: len < 30 },
  ];

  const score = dimensions
    .filter(d => d.hit)
    .reduce((sum, d) => sum + d.weight, 0);

  const tier: LLMTier = score >= 0.25 ? 'complex' : 'simple';

  return { tier, score: Math.round(score * 100) / 100, dimensions };
}
