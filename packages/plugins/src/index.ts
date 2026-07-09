import { constants } from "node:fs";
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG, DEVCREW_NPM_PACKAGE, DEVCREW_VERSION, ROLE_SECTIONS } from "../../core/src/index.js";

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

async function bundledAssetPath(name: string): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, "..", "assets", name),
    join(moduleDir, "..", "..", "..", "..", "packages", "plugins", "assets", name),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Try the next layout: source tree first, compiled package second.
    }
  }

  throw new Error(`Missing bundled DevCrew plugin asset: ${name}`);
}

async function writeCodexAssets(pluginRoot: string): Promise<void> {
  const assetDir = join(pluginRoot, "assets");
  await mkdir(assetDir, { recursive: true });
  await copyFile(await bundledAssetPath("logo.png"), join(assetDir, "logo.png"));
  await copyFile(await bundledAssetPath("composer-icon.png"), join(assetDir, "composer-icon.png"));
}

function roleExpectations(name: string): string {
  const sections = ROLE_SECTIONS[name as keyof typeof ROLE_SECTIONS];
  if (!sections || sections.length === 0) {
    return "";
  }
  return sections.map((s) => `- ${s.heading} (${s.description})`).join("\n");
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
        `---\nname: ${name}\ndescription: ${description}\ntools: Read, Grep, Glob, Bash\n---\n\nYou are the DevCrew ${name} role. ${description} Return concise Markdown and keep inherited host permissions.\n\nProduce these required sections:\n\n${roleExpectations(name)}\n`,
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
      `name = "${name}"\ndescription = "${description}"\ndeveloper_instructions = """\nYou are the DevCrew ${name} role. ${description}\nReturn concise Markdown and keep inherited host permissions.\n\nProduce these required sections:\n${roleExpectations(name)}\n"""\n`,
      "utf8",
    );
  }
}

function entrySkill(): string {
  return `---\nname: devcrew\ndescription: Run the DevCrew PM -> architecture -> implementation -> testing workflow. Use when the user asks for structured feature or product development, requirements clarification, architecture review, implementation planning, testing acceptance, or Chinese requests such as 完整研发流程, 需求澄清, 产品经理, 架构师, 开发测试流程.\n---\n\nUse the DevCrew MCP tools to manage the workflow:\n\n1. Start with \`devcrew_start\` using the current repository cwd, mode, request, and optional executionMode. Host is inferred from the plugin's \`DEVCREW_HOST\`; pass host only for an explicit override. Omit executionMode unless the requester explicitly asks DevCrew to apply changes; the default safe mode is \`plan\`.\n2. After start, DevCrew records the active run for this repository. For follow-up tools, omit runId unless you need to target a different run explicitly.\n3. Use \`executionMode: "apply"\` only when the requester explicitly wants DevCrew to write code or run validation commands. This still inherits host sandbox, approval, and tool permissions.\n4. Use \`devcrew_status\` to show the current phase and pending gate.\n5. Use \`devcrew_answer\` when the requester gives clarification.\n6. Use \`devcrew_approve\` or \`devcrew_reject\` for each gate.\n7. Use \`devcrew_continue\` after approvals. This executes the next phase role, writes the phase artifact, and opens the next gate. The implementation phase also writes \`implementation-review\` for diff and architecture compliance review.\n8. Use \`devcrew_artifact\` to read generated requirements, architecture, implementation-plan, implementation-review, test-report, or acceptance files.\n\nDo not bypass host sandbox, approval, or tool permissions.\n`;
}

function npmPackageSpecifier(): string {
  return `${DEVCREW_NPM_PACKAGE}@${DEVCREW_VERSION}`;
}

function npmExecCliWrapper(): string {
  const [scope, name] = DEVCREW_NPM_PACKAGE.split("/");
  return [
    "const path = require('node:path');",
    "const { pathToFileURL } = require('node:url');",
    "const binDir = process.env.PATH.split(path.delimiter)[0];",
    `const packageRoot = path.join(binDir.replace(/[\\\\/]\\.bin$/u, ''), ${JSON.stringify(scope)}, ${JSON.stringify(name)});`,
    "process.argv = ['node', 'devcrew', ...process.argv.slice(1)];",
    "import(pathToFileURL(path.join(packageRoot, 'dist/packages/cli/src/index.js')).href);",
  ].join(" ");
}

function mcpServerConfig(host: "codex" | "claude"): unknown {
  return {
    command: "npm",
    args: [
      "exec",
      "--silent",
      "--yes",
      `--package=${npmPackageSpecifier()}`,
      "--",
      "node",
      "-e",
      npmExecCliWrapper(),
      "--",
      "serve",
      "--stdio",
    ],
    env: { DEVCREW_HOST: host },
  };
}

export async function generateCodexPlugin(root: string): Promise<GeneratedPlugin> {
  const pluginRoot = join(root, "plugins", "devcrew-codex");
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "skills", "devcrew"), { recursive: true });
  await writeCodexAssets(pluginRoot);
  await writeJson(join(pluginRoot, ".codex-plugin", "plugin.json"), {
    name: "devcrew",
    version: DEVCREW_VERSION,
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
      composerIcon: "./assets/composer-icon.png",
      logo: "./assets/logo.png",
    },
  });
  await writeFile(join(pluginRoot, "skills", "devcrew", "SKILL.md"), entrySkill(), "utf8");
  await writeJson(join(pluginRoot, ".mcp.json"), {
    mcpServers: {
      devcrew: mcpServerConfig("codex"),
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
    version: DEVCREW_VERSION,
    author: { name: "DevCrew Contributors" },
  });
  await writeFile(join(pluginRoot, "skills", "devcrew", "SKILL.md"), entrySkill(), "utf8");
  await writeJson(join(pluginRoot, ".mcp.json"), {
    mcpServers: {
      devcrew: mcpServerConfig("claude"),
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
