import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Mistral from '@mistralai/mistralai';
import { loadAllSkills } from '../server/skills/skill-store.js';

const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

function extractFirstActHint(skillContent) {
  const match = skillContent.match(/act_hint:\s*"([^"]+)"/i);
  return match?.[1]?.trim() || '';
}

function safeParseArray(value) {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item)).filter(Boolean);
    }
    return [];
  } catch {
    return [];
  }
}

async function generateTrainingExamples(skill, numVariants = 15) {
  const response = await mistral.chat.complete({
    model: 'mistral-large-latest',
    temperature: 0.8,
    messages: [
      {
        role: 'user',
        content: `Given this skill:\n\n${skill.content}\n\nGenerate ${numVariants} different natural language voice instructions a user might say to trigger this skill. Vary phrasing and specificity. Output as JSON array of strings only.`,
      },
    ],
  });

  const raw = response?.choices?.[0]?.message?.content || '[]';
  const variants = safeParseArray(raw);
  const targetInstruction = extractFirstActHint(skill.content);

  return variants.map((voice) => ({
    messages: [
      {
        role: 'system',
        content:
          'You are a browser action instruction generator. Given a voice command and a skill file, output only the precise act() instruction string for the first skill action.',
      },
      {
        role: 'user',
        content: `Voice: "${voice}"\n\nSkill:\n${skill.content}`,
      },
      {
        role: 'assistant',
        content: targetInstruction,
      },
    ],
  }));
}

async function main() {
  if (!process.env.MISTRAL_API_KEY) {
    throw new Error('MISTRAL_API_KEY is required to generate training data.');
  }

  const skills = await loadAllSkills();
  if (skills.length === 0) {
    console.log('No skills found in server/skills/data. Nothing to generate.');
    return;
  }

  const examples = [];

  for (const skill of skills) {
    const generated = await generateTrainingExamples(skill, 15);
    const valid = generated.filter((entry) => entry.messages[2].content.trim());
    examples.push(...valid);
    console.log(`Generated ${valid.length} examples for ${skill.name}`);
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const outputPath = path.join(__dirname, 'training-data.jsonl');

  await fs.writeFile(outputPath, examples.map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');

  console.log(`Wrote ${examples.length} examples to ${outputPath}`);
}

main().catch((error) => {
  console.error('generate-training-data failed:', error);
  process.exit(1);
});
