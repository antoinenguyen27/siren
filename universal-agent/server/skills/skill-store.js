import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILLS_DIR = path.join(__dirname, 'data');

function sanitizeSkillName(name) {
  return String(name || 'skill')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || `skill_${Date.now()}`;
}

function sanitizeDomain(domain) {
  return String(domain || 'unknown.site')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '');
}

function parseHeading(content) {
  const headingMatch = content.match(/^#\s+(.+)$/m);
  return headingMatch?.[1]?.trim() || 'Unnamed skill';
}

export async function saveSkill(name, content, domain) {
  await fs.mkdir(SKILLS_DIR, { recursive: true });

  const safeDomain = sanitizeDomain(domain);
  const safeName = sanitizeSkillName(name);
  const filename = `${safeDomain}__${safeName}.md`;
  const fullPath = path.join(SKILLS_DIR, filename);

  await fs.writeFile(fullPath, content, 'utf8');

  return {
    filename,
    path: fullPath,
  };
}

export async function loadSkillsForSite(domain) {
  const safeDomain = sanitizeDomain(domain);
  return loadSkillsMatching((filename) => filename.startsWith(`${safeDomain}__`));
}

export async function loadAllSkills() {
  return loadSkillsMatching(() => true);
}

async function loadSkillsMatching(predicate) {
  try {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    const files = await fs.readdir(SKILLS_DIR);

    const skillFiles = files.filter((filename) => filename.endsWith('.md') && predicate(filename));

    return Promise.all(
      skillFiles.map(async (filename) => {
        const fullPath = path.join(SKILLS_DIR, filename);
        const content = await fs.readFile(fullPath, 'utf8');
        return {
          name: parseHeading(content),
          filename,
          content,
          path: fullPath,
        };
      }),
    );
  } catch {
    return [];
  }
}

export { SKILLS_DIR };
