import { Mistral } from '@mistralai/mistralai';
import { saveSkill } from './skill-store.js';
import { SKILL_WRITER_SYSTEM_PROMPT } from '../agent/system-prompts.js';

const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

export function formatObservedElements(elements) {
  if (!Array.isArray(elements) || elements.length === 0) {
    return 'No observed elements were returned.';
  }

  return elements
    .map((element, index) => {
      const description = element?.description || 'Unknown element';
      const method = element?.method || 'unknown';
      const args = JSON.stringify(element?.arguments ?? []);
      return `[${index + 1}] Description: "${description}" | Method: ${method} | Args: ${args}`;
    })
    .join('\n');
}

export function extractSkillName(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || `skill-${Date.now()}`;
}

function scrubSensitiveData(text) {
  let scrubCount = 0;
  let value = text;

  const patterns = [
    { regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[redacted_email]' },
    { regex: /\b[a-z0-9]{16,}\b/gi, replacement: '[redacted_id]' },
    {
      regex: /\b[\w.-]+\.(pdf|doc|docx|ppt|pptx|xls|xlsx|csv|txt|zip)\b/gi,
      replacement: '[redacted_file]',
    },
  ];

  for (const pattern of patterns) {
    value = value.replace(pattern.regex, () => {
      scrubCount += 1;
      return pattern.replacement;
    });
  }

  return { value, scrubCount };
}

function setConfidence(markdown, confidence) {
  if (/^confidence:\s*(high|medium|low)/im.test(markdown)) {
    return markdown.replace(/^confidence:\s*(high|medium|low)/im, `confidence: ${confidence}`);
  }
  return markdown;
}

function ensureSelfHealingNotes(markdown, notes) {
  if (!notes) return markdown;

  const block = /^## Self-Healing Notes\n([\s\S]*?)(\n## |\n---|$)/m;
  const match = markdown.match(block);

  if (match) {
    const current = match[1].trim();
    if (current.toLowerCase().includes(notes.toLowerCase())) return markdown;
    return markdown.replace(block, `## Self-Healing Notes\n${current}\n${notes}$2`);
  }

  return `${markdown}\n\n## Self-Healing Notes\n${notes}\n`;
}

function ensureConfidenceRationale(markdown, note) {
  if (!note) return markdown;

  const block = /^## Confidence Rationale\n([\s\S]*?)(\n---|$)/m;
  const match = markdown.match(block);

  if (match) {
    const current = match[1].trim();
    if (current.toLowerCase().includes(note.toLowerCase())) return markdown;
    return markdown.replace(block, `## Confidence Rationale\n${current}\n${note}$2`);
  }

  return `${markdown}\n\n## Confidence Rationale\n${note}\n`;
}

function enforceVerbatimElementDescriptions(markdown, observedElements) {
  const descriptions = (observedElements || [])
    .map((element) => String(element?.description || '').trim())
    .filter(Boolean);

  if (descriptions.length === 0) {
    return { markdown, correctedCount: 0 };
  }

  let correctedCount = 0;
  let index = 0;

  const updated = markdown.replace(/element:\s*"([^"]*)"/g, (fullMatch, existing) => {
    const cleanExisting = String(existing || '').trim();
    if (descriptions.includes(cleanExisting)) {
      index += 1;
      return fullMatch;
    }

    const fallback = descriptions[Math.min(index, descriptions.length - 1)] || cleanExisting;
    index += 1;
    correctedCount += 1;
    return `element: "${fallback}"`;
  });

  return { markdown: updated, correctedCount };
}

export async function writeSkillFromSegment(transcript, observedElements, pageUrl) {
  const domain = new URL(pageUrl).hostname;

  const transcriptScrubbed = scrubSensitiveData(transcript || '');
  const observedContext = formatObservedElements(observedElements || []);
  const observedScrubbed = scrubSensitiveData(observedContext);

  const response = await mistral.chat.complete({
    model: 'mistral-large-latest',
    temperature: 0.1,
    messages: [
      { role: 'system', content: SKILL_WRITER_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Voice narration: "${transcriptScrubbed.value}"\n\nSite: ${domain}\n\nObserved interactive elements on page:\n${observedScrubbed.value}`,
      },
    ],
  });

  let skillMarkdown = response?.choices?.[0]?.message?.content?.trim() || '';
  if (!skillMarkdown) {
    throw new Error('Skill writer returned empty output.');
  }

  const enforced = enforceVerbatimElementDescriptions(skillMarkdown, observedElements || []);
  skillMarkdown = enforced.markdown;

  const needsLowConfidence =
    !Array.isArray(observedElements) ||
    observedElements.length === 0 ||
    (transcript || '').trim().split(/\s+/).length < 3;

  if (needsLowConfidence) {
    skillMarkdown = setConfidence(skillMarkdown, 'low');
    skillMarkdown = ensureSelfHealingNotes(
      skillMarkdown,
      'Narration/context was partial. Re-observe the page and retry with a clearer one-step instruction.',
    );
    skillMarkdown = ensureConfidenceRationale(
      skillMarkdown,
      'Confidence reduced because narration was ambiguous or observed elements were limited.',
    );
  }

  if (transcriptScrubbed.scrubCount > 0 || observedScrubbed.scrubCount > 0) {
    skillMarkdown = setConfidence(skillMarkdown, 'medium');
    skillMarkdown = ensureConfidenceRationale(
      skillMarkdown,
      'Confidence reduced because user-specific data was scrubbed to enforce privacy constraints.',
    );
  }

  if (enforced.correctedCount > 0) {
    skillMarkdown = ensureConfidenceRationale(
      skillMarkdown,
      `Adjusted ${enforced.correctedCount} action element description(s) to exact observe() text.`,
    );
  }

  const skillName = extractSkillName(skillMarkdown);
  await saveSkill(skillName, skillMarkdown, domain);
  return skillName;
}
