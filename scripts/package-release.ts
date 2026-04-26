import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

interface ReleasePlugin {
  id: string;
  name: string;
  version: string;
  path: string;
  binary: string;
  bundledSkills: string[];
}

interface ReleaseManifest {
  name: string;
  version: string;
  platform: string;
  arch: string;
  createdAt: string;
  binaries: {
    cli: string;
    daemon: string;
  };
  web: {
    path: string;
  };
  plugins: ReleasePlugin[];
  skills: Array<{
    id: string;
    name: string;
    version: string;
    path: string;
  }>;
}

const root = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(await readText(join(root, "package.json"))) as {
  name?: string;
  version?: string;
};
const releaseName = `${packageJson.name ?? "andy"}-${packageJson.version ?? "0.0.0"}-${platform()}-${arch()}`;
const releaseRoot = join(root, "dist", "release", releaseName);

await rm(releaseRoot, { force: true, recursive: true });
await mkdir(join(releaseRoot, "bin"), { recursive: true });
await mkdir(join(releaseRoot, "plugins"), { recursive: true });
await mkdir(join(releaseRoot, "skills"), { recursive: true });

await copyRequired(join(root, "dist", "andy"), join(releaseRoot, "bin", "andy"));
await copyRequired(
  join(root, "dist", "andy-daemon"),
  join(releaseRoot, "bin", "andy-daemon"),
);
await copyRequired(join(root, "apps", "web", "dist"), join(releaseRoot, "web"));

const plugins = await packagePlugins();
const skills = await packageGlobalSkills();
const manifest: ReleaseManifest = {
  name: packageJson.name ?? "andy",
  version: packageJson.version ?? "0.0.0",
  platform: platform(),
  arch: arch(),
  createdAt: new Date().toISOString(),
  binaries: {
    cli: "bin/andy",
    daemon: "bin/andy-daemon",
  },
  web: {
    path: "web",
  },
  plugins,
  skills,
};

await writeFile(
  join(releaseRoot, "release.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(
  JSON.stringify(
    { releaseRoot, plugins: plugins.length, skills: skills.length },
    null,
    2,
  ),
);

async function packagePlugins(): Promise<ReleasePlugin[]> {
  const pluginsRoot = join(root, "plugins");
  const entries = await readdir(pluginsRoot, { withFileTypes: true });
  const plugins: ReleasePlugin[] = [];

  for (const entry of entries.toSorted((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourceRoot = join(pluginsRoot, entry.name);
    const manifestPath = join(sourceRoot, "plugin.json");
    if (!(await exists(manifestPath))) {
      continue;
    }

    const manifest = JSON.parse(await readText(manifestPath)) as {
      id?: string;
      name?: string;
      version?: string;
      binaryEntrypoint?: string;
      bundledSkills?: string[];
    };
    const pluginId = requiredString(manifest.id, `${manifestPath} id`);
    const pluginTargetRoot = join(releaseRoot, "plugins", entry.name);
    const binaryEntrypoint = manifest.binaryEntrypoint ?? "./dist/plugin";
    const binarySource = resolve(sourceRoot, binaryEntrypoint);
    const binaryTarget = join(pluginTargetRoot, binaryEntrypoint);

    await copyRequired(manifestPath, join(pluginTargetRoot, "plugin.json"));
    await copyRequired(binarySource, binaryTarget);

    const bundledSkills = await copyBundledSkills(
      sourceRoot,
      pluginTargetRoot,
      manifest,
    );
    plugins.push({
      id: pluginId,
      name: requiredString(manifest.name, `${manifestPath} name`),
      version: requiredString(manifest.version, `${manifestPath} version`),
      path: `plugins/${entry.name}/plugin.json`,
      binary: `plugins/${entry.name}/${binaryEntrypoint.replace(/^\.\//, "")}`,
      bundledSkills,
    });
  }

  return plugins;
}

async function copyBundledSkills(
  sourceRoot: string,
  pluginTargetRoot: string,
  manifest: { bundledSkills?: string[] },
): Promise<string[]> {
  const copied: string[] = [];
  for (const skillPath of manifest.bundledSkills ?? []) {
    const source = resolve(sourceRoot, skillPath);
    const target = join(pluginTargetRoot, skillPath);
    await copyRequired(source, target);
    copied.push(skillPath);
  }

  const skillsRoot = join(sourceRoot, "skills");
  if (await exists(skillsRoot)) {
    await copyRequired(skillsRoot, join(pluginTargetRoot, "skills"));
  }

  return copied;
}

async function packageGlobalSkills(): Promise<ReleaseManifest["skills"]> {
  const skillsRoot = join(root, "skills");
  if (!(await exists(skillsRoot))) {
    return [];
  }

  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skills: ReleaseManifest["skills"] = [];
  for (const entry of entries.toSorted((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourceRoot = join(skillsRoot, entry.name);
    const manifestPath = join(sourceRoot, "skill.json");
    if (!(await exists(manifestPath))) {
      continue;
    }

    const manifest = JSON.parse(await readText(manifestPath)) as {
      id?: string;
      name?: string;
      version?: string;
    };
    const targetRoot = join(releaseRoot, "skills", entry.name);
    await copyRequired(sourceRoot, targetRoot);
    skills.push({
      id: requiredString(manifest.id, `${manifestPath} id`),
      name: requiredString(manifest.name, `${manifestPath} name`),
      version: requiredString(manifest.version, `${manifestPath} version`),
      path: `skills/${entry.name}/skill.json`,
    });
  }

  return skills;
}

async function copyRequired(source: string, target: string): Promise<void> {
  if (!(await exists(source))) {
    throw new Error(`Required release artifact is missing: ${source}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${label} to be a non-empty string.`);
  }
  return value;
}
