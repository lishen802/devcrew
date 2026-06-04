import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../../core/src/index.js";

export interface GeneratedPlugin {
  name: "devcrew";
  path: string;
}

export interface GeneratedMarketplace {
  name: "devcrew";
  path: string;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeRoleAgents(root: string, format: "codex" | "claude"): Promise<void> {
  const roles = [
    ["pm", "Product manager. Clarifies requirements, scope boundaries, success criteria, and requester approvals."],
    ["architect", "technical architecture specialist. Designs implementation, deployment, interfaces, and review criteria."],
    ["implementer", "Implementation engineer. Writes code according to approved architecture and discovered standards."],
    ["tester", "Testing and acceptance specialist. Verifies functionality, regressions, and acceptance evidence."],
  ] as const;

  if (format === "claude") {
    const agentDir = join(root, "agents");
    await mkdir(agentDir, { recursive: true });
    for (const [name, description] of roles) {
      await writeFile(
        join(agentDir, `${name}.md`),
        `---\nname: ${name}\ndescription: ${description}\ntools: Read, Grep, Glob, Bash\n---\n\nYou are the DevCrew ${name} role. ${description} Return concise Markdown and keep inherited host permissions.\n`,
        "utf8",
      );
    }
    return;
  }

  const agentDir = join(root, "agents");
  await mkdir(agentDir, { recursive: true });
  for (const [name, description] of roles) {
    await writeFile(
      join(agentDir, `${name}.toml`),
      `name = "${name}"\ndescription = "${description}"\ndeveloper_instructions = """\nYou are the DevCrew ${name} role. ${description}\nReturn concise Markdown and keep inherited host permissions.\n"""\n`,
      "utf8",
    );
  }
}

function entrySkill(): string {
  return `---\nname: devcrew\ndescription: Run the DevCrew PM -> architecture -> implementation -> testing workflow. Use when the user asks for structured feature or product development across Codex or Claude Code.\n---\n\nUse the DevCrew MCP tools to manage the workflow:\n\n1. Start with \`devcrew_start\` using the current repository cwd, host, mode, and request.\n2. Use \`devcrew_status\` to show the current phase and pending gate.\n3. Use \`devcrew_answer\` when the requester gives clarification.\n4. Use \`devcrew_approve\` or \`devcrew_reject\` for each gate.\n5. Use \`devcrew_continue\` after approvals to create the next phase artifact.\n6. Use \`devcrew_artifact\` to read generated requirements, architecture, implementation-plan, test-report, or acceptance files.\n\nDo not bypass host sandbox, approval, or tool permissions.\n`;
}

export async function generateCodexPlugin(root: string): Promise<GeneratedPlugin> {
  const pluginRoot = join(root, "plugins", "devcrew-codex");
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "skills", "devcrew"), { recursive: true });
  await writeJson(join(pluginRoot, ".codex-plugin", "plugin.json"), {
    name: "devcrew",
    version: "0.1.0",
    description: "DevCrew gated multi-role workflow service for Codex.",
    author: {
      name: "DevCrew Contributors",
      url: "https://github.com/lishen802/devcrew",
    },
    homepage: "https://github.com/lishen802/devcrew#readme",
    repository: "https://github.com/lishen802/devcrew",
    license: "Apache-2.0",
    keywords: ["codex", "agents", "workflow", "mcp", "skills"],
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: {
      displayName: "DevCrew",
      shortDescription: "Run gated PM, architecture, implementation, and testing workflows.",
      longDescription:
        "DevCrew helps Codex run feature and product development through explicit requirements, architecture, implementation planning, and testing gates.",
      developerName: "DevCrew Contributors",
      category: "Productivity",
      capabilities: ["Interactive", "Write"],
      websiteURL: "https://github.com/lishen802/devcrew",
      defaultPrompt: [
        "Use DevCrew to plan this feature.",
        "Use DevCrew to build this product.",
        "Use DevCrew to review this implementation plan.",
      ],
      brandColor: "#2563EB",
    },
  });
  await writeFile(join(pluginRoot, "skills", "devcrew", "SKILL.md"), entrySkill(), "utf8");
  await writeJson(join(pluginRoot, ".mcp.json"), {
    mcpServers: {
      devcrew: {
        command: "npx",
        args: ["-y", "github:lishen802/devcrew", "serve", "--stdio"],
      },
    },
  });
  await writeRoleAgents(pluginRoot, "codex");
  return { name: "devcrew", path: pluginRoot };
}

export async function generateCodexMarketplace(root: string): Promise<GeneratedMarketplace> {
  const marketplacePath = join(root, ".agents", "plugins", "marketplace.json");
  await mkdir(join(root, ".agents", "plugins"), { recursive: true });
  await writeJson(marketplacePath, {
    name: "devcrew",
    interface: {
      displayName: "DevCrew",
    },
    plugins: [
      {
        name: "devcrew",
        source: {
          source: "local",
          path: "./plugins/devcrew-codex",
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category: "Productivity",
      },
    ],
  });
  return { name: "devcrew", path: marketplacePath };
}

export async function generateClaudePlugin(root: string): Promise<GeneratedPlugin> {
  const pluginRoot = join(root, "plugins", "devcrew-claude");
  await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "skills", "devcrew"), { recursive: true });
  await writeJson(join(pluginRoot, ".claude-plugin", "plugin.json"), {
    name: "devcrew",
    description: "DevCrew gated multi-role workflow service for Claude Code.",
    version: "0.1.0",
    author: { name: "DevCrew Contributors" },
  });
  await writeFile(join(pluginRoot, "skills", "devcrew", "SKILL.md"), entrySkill(), "utf8");
  await writeJson(join(pluginRoot, ".mcp.json"), {
    mcpServers: {
      devcrew: {
        command: "devcrew",
        args: ["serve", "--stdio"],
      },
    },
  });
  await writeRoleAgents(pluginRoot, "claude");
  return { name: "devcrew", path: pluginRoot };
}

export async function initProject(root: string): Promise<{ codex: GeneratedPlugin; claude: GeneratedPlugin }> {
  await mkdir(join(root, ".devcrew"), { recursive: true });
  await mkdir(join(root, "docs", "devcrew"), { recursive: true });
  await writeJson(join(root, ".devcrew", "config.json"), DEFAULT_CONFIG);
  await writeFile(
    join(root, ".devcrew", "standards.md"),
    "# DevCrew Standards\n\nAdd project-specific coding, testing, documentation, and deployment rules here.\n",
    "utf8",
  );
  const codex = await generateCodexPlugin(root);
  await generateCodexMarketplace(root);
  const claude = await generateClaudePlugin(root);
  return { codex, claude };
}
