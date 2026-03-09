import type { LLMRouter } from '../llm/router.js';

/** Minimal interface satisfied by both ProfileMemory and MemoryManager. */
interface IProfileStore {
  readProfile(ns: string): string;
  readSelf(ns: string): string;
  appendToProfile(ns: string, facts: string): void;
  appendToSelf(ns: string, facts: string): void;
  writeProfile(ns: string, content: string): void;
  writeSelf(ns: string, content: string): void;
}

const USER_SYS = `You are a memory extraction agent.
Given a single conversation exchange, extract any NEW factual information about the USER (not the assistant).
Output a concise bullet list (one fact per line starting with "- ").
Only include specific, non-obvious facts — preferences, habits, background, projects, relationships, devices, opinions, etc.
Do NOT repeat facts that are common knowledge. Do NOT include facts about the assistant.
If nothing new or noteworthy was revealed, respond with exactly: NOTHING`;

const SELF_SYS = `You are a memory extraction agent.
Given a single conversation exchange, extract what the ASSISTANT learned about ITSELF.
This includes: corrections the user made, preferences about how the assistant should behave,
approaches that worked well or poorly, tasks it successfully completed, or capabilities it discovered.
Output a concise bullet list (one fact per line starting with "- ").
If nothing significant, respond with exactly: NOTHING`;

const CONSOLIDATE_USER_SYS = `You are consolidating a user profile memory file.
Merge duplicate facts, remove contradictions (keep the most recent), and organize into clear sections such as:
## Personal, ## Work & Projects, ## Preferences & Habits, ## Tech & Setup.
Keep it concise. Preserve all unique facts. Return only the cleaned markdown file content.
Start with: # User Profile`;

const CONSOLIDATE_SELF_SYS = `You are consolidating an agent self-knowledge file.
Merge duplicates, remove outdated entries, and organize into sections such as:
## Capabilities, ## User Preferences About Me, ## Lessons Learned.
Keep it concise. Return only the cleaned markdown file content.
Start with: # Agent Self-Knowledge`;

/**
 * After each conversation turn, extracts facts about the user and about
 * the agent itself, and appends them to the persistent profile files.
 *
 * All methods are safe to call without await — errors are swallowed so they
 * never interrupt the main conversation loop.
 */
export class MemoryExtractor {
  constructor(
    private readonly llm:     LLMRouter,
    private readonly profile: IProfileStore,
  ) {}

  /** Fire-and-forget: extract facts from one exchange and persist them. */
  async extractAndStore(ns: string, userText: string, assistantText: string): Promise<void> {
    const exchange = `User: ${userText}\n\nAssistant: ${assistantText}`;
    try {
      const [userFacts, selfFacts] = await Promise.all([
        this.extract(USER_SYS, exchange),
        this.extract(SELF_SYS, exchange),
      ]);
      if (userFacts !== 'NOTHING') {
        this.profile.appendToProfile(ns, userFacts);
        console.debug(`[Extractor] Learned about user (${ns})`);
      }
      if (selfFacts !== 'NOTHING') {
        this.profile.appendToSelf(ns, selfFacts);
        console.debug(`[Extractor] Learned about self (${ns})`);
      }
    } catch (err) {
      // Silent — extraction must never crash the main flow
      console.debug('[Extractor] error:', err instanceof Error ? err.message : err);
    }
  }

  /** Deduplicate and reorganise both profile files. */
  async consolidate(ns: string): Promise<void> {
    await Promise.all([
      this.consolidateOne(ns, 'user'),
      this.consolidateOne(ns, 'self'),
    ]);
  }

  private async consolidateOne(ns: string, which: 'user' | 'self'): Promise<void> {
    const content = which === 'user'
      ? this.profile.readProfile(ns)
      : this.profile.readSelf(ns);
    if (!content.trim()) return;

    const system = which === 'user' ? CONSOLIDATE_USER_SYS : CONSOLIDATE_SELF_SYS;
    try {
      const response = await this.llm.complete('simple', {
        system,
        messages: [{ role: 'user', content }],
        max_tokens: 2000,
      });
      const consolidated = response.text.trim();
      if (consolidated.length > 50) {
        if (which === 'user') this.profile.writeProfile(ns, consolidated);
        else                  this.profile.writeSelf(ns, consolidated);
        console.log(`[Extractor] Consolidated ${which} profile (${ns})`);
      }
    } catch (err) {
      console.debug('[Extractor] consolidate error:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Directly write tool failure notes to self-knowledge — no LLM call needed
   * since the error message is already factual.
   */
  learnFromErrors(ns: string, errors: Array<{ tool: string; error: string }>): void {
    if (errors.length === 0) return;
    const note = errors
      .map(e => `- Tool "${e.tool}" failed: ${e.error.slice(0, 200)}`)
      .join('\n');
    this.profile.appendToSelf(ns, note);
    console.debug(`[Extractor] Recorded ${errors.length} tool error(s) to self-knowledge (${ns})`);
  }

  private async extract(system: string, exchange: string): Promise<string> {
    try {
      const resp = await this.llm.complete('simple', {
        system,
        messages: [{ role: 'user', content: exchange }],
        max_tokens: 400,
      });
      return resp.text.trim() || 'NOTHING';
    } catch {
      return 'NOTHING';
    }
  }
}
