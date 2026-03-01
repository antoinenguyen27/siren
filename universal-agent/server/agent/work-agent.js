import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { MemorySaver } from '@langchain/langgraph';
import { ChatMistralAI } from '@langchain/mistralai';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  actOnPage,
  deepLocateOnPage,
  extractFromPage,
  getPage,
  navigateTo,
  observePage,
} from '../stagehand-manager.js';
import { loadAllSkills, loadSkillsForSite } from '../skills/skill-store.js';
import { getSessionMemory } from '../memory/session-memory.js';
import { WORK_AGENT_SYSTEM_PROMPT } from './system-prompts.js';

const MAX_RETRIES_PER_STEP = 3;

function createLogger(debugLog) {
  return (message) => {
    if (typeof debugLog === 'function') {
      debugLog(message);
    }
  };
}

function buildTools({ debugLog } = {}) {
  const log = createLogger(debugLog);
  const retryByStep = new Map();
  let observeCalls = 0;
  let lastObserveSignature = '';
  let sameObserveSignatureCount = 0;
  const runActionWithRetry = async ({ stepDescription, stepKey, execute, toolName }) => {
    try {
      await execute();
      retryByStep.delete(stepKey);
      log(`[tool:${toolName}] success step="${stepDescription}"`);
      return `Success: ${stepDescription}`;
    } catch (error) {
      const retries = (retryByStep.get(stepKey) || 0) + 1;
      retryByStep.set(stepKey, retries);
      log(`[tool:${toolName}] failure step="${stepDescription}" attempt=${retries} error="${error?.message || error}"`);

      let stateHints = [];
      try {
        const state = await observePage(
          'What interactive elements are currently visible and available?',
          { iframes: true },
        );
        stateHints = state
          .slice(0, 8)
          .map((element) => element.description)
          .filter(Boolean);
      } catch {
        stateHints = [];
      }

      if (retries >= MAX_RETRIES_PER_STEP) {
        log(`[tool:${toolName}] giving up step="${stepDescription}" after ${MAX_RETRIES_PER_STEP} retries`);
        return `Failed permanently after ${MAX_RETRIES_PER_STEP} retries for step "${stepDescription}". Last error: ${error?.message || error}. Current page hints: ${stateHints.join(' | ') || 'none'}. Stop retrying this step and report failure in final response.`;
      }

      return `Failed attempt ${retries}/${MAX_RETRIES_PER_STEP} for step "${stepDescription}". Error: ${error?.message || error}. Current page hints: ${stateHints.join(' | ') || 'none'}. Adapt your next act() instruction using these hints.`;
    }
  };

  const actTool = tool(
    async ({ actInstruction, stepDescription }) => {
      log(`[tool:act] step="${stepDescription}" instruction="${actInstruction}"`);
      const page = await getPage();
      const stepKey = stepDescription.trim().toLowerCase();
      return runActionWithRetry({
        stepDescription,
        stepKey,
        toolName: 'act',
        execute: async () => {
          await actOnPage(actInstruction, { page });
        },
      });
    },
    {
      name: 'act',
      description:
        "Execute one atomic browser action in the agent's Chrome using natural language. One interaction only per call.",
      schema: z.object({
        actInstruction: z
          .string()
          .describe('Specific action text with label + location + purpose context.'),
        stepDescription: z.string().describe('Human-readable description of the current step.'),
      }),
    },
  );

  const actObservedTool = tool(
    async ({ observedAction, stepDescription }) => {
      const stepKey = stepDescription.trim().toLowerCase();
      log(
        `[tool:act_observed] step="${stepDescription}" action="${observedAction?.description || ''}" method="${observedAction?.method || ''}" selector="${observedAction?.selector || ''}"`,
      );
      return runActionWithRetry({
        stepDescription,
        stepKey,
        toolName: 'act_observed',
        execute: async () => {
          await actOnPage(observedAction, {});
        },
      });
    },
    {
      name: 'act_observed',
      description:
        'Execute one observed action object with higher specificity. Use this only after observe_page has returned and you have selected the exact target action.',
      schema: z.object({
        observedAction: z.object({
          selector: z.string().optional().describe('Observed selector for the target element, if available.'),
          description: z.string().describe('Observed element description.'),
          method: z.string().describe('Observed recommended method (click/fill/type/select/etc).'),
          arguments: z.array(z.any()).optional().describe('Observed arguments for the method.'),
        }),
        stepDescription: z.string().describe('Human-readable description of the current step.'),
      }),
    },
  );

  const observeTool = tool(
    async ({ query }) => {
      observeCalls += 1;
      log(`[tool:observe_page] query="${query}"`);
      if (observeCalls > 12) {
        return 'OBSERVE_GUARDRAIL: observe_page call budget exceeded for this task. Stop calling observe_page and proceed with best-effort act() or report failure.';
      }
      const elements = await observePage(query, { iframes: true });
      log(`[tool:observe_page] found=${elements.length}`);
      const mapped = elements.slice(0, 10).map((element) => ({
        selector: element.selector,
        description: element.description,
        method: element.method,
        arguments: element.arguments,
      }));

      const signature = mapped
        .map((item) => `${item.description}|${item.method}|${item.selector || ''}`)
        .join('||');
      if (signature && signature === lastObserveSignature) {
        sameObserveSignatureCount += 1;
      } else {
        sameObserveSignatureCount = 0;
        lastObserveSignature = signature;
      }

      if (sameObserveSignatureCount >= 2) {
        return `OBSERVE_STALE: results unchanged across repeated calls. Stop calling observe_page repeatedly. Execute a fallback action (for example scroll, open filters, or act on best candidate) or report failure.\n${JSON.stringify(mapped)}`;
      }

      return JSON.stringify(mapped);
    },
    {
      name: 'observe_page',
      description: 'Observe current semantic page state with iframe-aware extraction.',
      schema: z.object({
        query: z.string().describe('What to inspect on the page.'),
      }),
    },
  );

  const extractTool = tool(
    async ({ query }) => {
      log(`[tool:extract_page_data] query="${query}"`);
      const result = await extractFromPage(query, { iframes: true });
      return JSON.stringify(result ?? {});
    },
    {
      name: 'extract_page_data',
      description:
        'Extract non-interaction data from the current page (titles, values, summaries). Use this for data-oriented questions instead of observe_page.',
      schema: z.object({
        query: z.string().describe('Specific data extraction request.'),
      }),
    },
  );

  const deepLocatorActionTool = tool(
    async ({ selector, operation, value, stepDescription }) => {
      const stepKey = stepDescription.trim().toLowerCase();
      log(
        `[tool:deep_locator_action] step="${stepDescription}" selector="${selector}" operation="${operation}"`,
      );
      return runActionWithRetry({
        stepDescription,
        stepKey,
        toolName: 'deep_locator_action',
        execute: async () => {
          await deepLocateOnPage(selector, operation, value);
        },
      });
    },
    {
      name: 'deep_locator_action',
      description:
        'Execute a precise selector-based action via Stagehand deepLocator(). Use only after a target is confirmed (from observe_page or captured DOM timeline) and natural-language act() is insufficient.',
      schema: z.object({
        selector: z
          .string()
          .describe('deepLocator selector. Use iframe hop syntax with >> when needed.'),
        operation: z
          .enum(['click', 'fill', 'type', 'hover', 'selectOption', 'scrollTo'])
          .describe('Operation to execute with deepLocator.'),
        value: z
          .string()
          .optional()
          .describe('Value payload for fill/type/selectOption/scrollTo operations.'),
        stepDescription: z.string().describe('Human-readable description of the current step.'),
      }),
    },
  );

  const readSkillsTool = tool(
    async ({ query, siteHint }) => {
      log(`[tool:read_skills] siteHint="${siteHint || ''}" query="${query}"`);
      const skills = siteHint ? await loadSkillsForSite(siteHint) : await loadAllSkills();
      if (skills.length === 0) {
        log('[tool:read_skills] no skills found');
        return 'No skills recorded for this site.';
      }

      const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.length > 2);

      const relevant = skills.filter((skill) => {
        const haystack = `${skill.name}\n${skill.content}`.toLowerCase();
        return words.some((word) => haystack.includes(word));
      });

      const chosen = relevant.length > 0 ? relevant : skills.slice(0, 8);
      log(`[tool:read_skills] returned=${chosen.length}`);
      return chosen
        .map((skill) => `## SKILL: ${skill.name}\n${skill.content}`)
        .join('\n\n---\n\n');
    },
    {
      name: 'read_skills',
      description:
        'Read recorded SKILL.md files. Always call this first to ground execution before act().',
      schema: z.object({
        query: z.string().describe('User task description.'),
        siteHint: z.string().optional().describe('Domain hint, e.g. slides.google.com.'),
      }),
    },
  );

  const readMemoryTool = tool(
    async () => {
      log('[tool:read_session_memory] called');
      const memory = getSessionMemory();
      if (memory.length === 0) return 'No tasks completed yet this session.';
      return memory
        .map((entry) => `[${new Date(entry.timestamp).toLocaleTimeString()}] ${entry.task} => ${entry.result}`)
        .join('\n');
    },
    {
      name: 'read_session_memory',
      description: 'Read in-process memory from prior completed work-mode tasks in this server session.',
      schema: z.object({}),
    },
  );

  const navigateTool = tool(
    async ({ url }) => {
      log(`[tool:navigate] url="${url}"`);
      await navigateTo(url);
      log(`[tool:navigate] success url="${url}"`);
      return `Navigated to ${url}`;
    },
    {
      name: 'navigate',
      description: 'Navigate to a URL only when the user explicitly asks.',
      schema: z.object({
        url: z.string().describe('Absolute URL.'),
      }),
    },
  );

  return [
    actTool,
    actObservedTool,
    deepLocatorActionTool,
    observeTool,
    extractTool,
    readSkillsTool,
    readMemoryTool,
    navigateTool,
  ];
}

export function buildWorkAgent() {
  return buildWorkAgentWithOptions();
}

export function buildWorkAgentWithOptions({ debugLog } = {}) {
  const llm = new ChatMistralAI({
    model: 'mistral-large-latest',
    apiKey: process.env.MISTRAL_API_KEY,
    temperature: 0.1,
  });

  return createReactAgent({
    llm,
    tools: buildTools({ debugLog }),
    checkpointSaver: new MemorySaver(),
    messageModifier: WORK_AGENT_SYSTEM_PROMPT,
  });
}

export function extractFinalAgentResponse(result) {
  const message = result?.messages?.[result.messages.length - 1];
  const content = typeof message?.content === 'string' ? message.content : '';
  const cleaned = content.trim();
  if (!cleaned) return 'Done.';

  const sentences = cleaned
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);

  return sentences.slice(0, 2).join(' ').trim() || 'Done.';
}
