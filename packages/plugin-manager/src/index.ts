import type { PluginManifest } from "@andy/plugin-sdk";

export type PluginInstallSource =
  | {
      type: "github";
      repository: string;
      ref: string;
    }
  | {
      type: "marketplace";
      packageId: string;
      version: string;
    }
  | {
      type: "local";
      path: string;
    };

export interface InstalledPluginRecord {
  manifest: PluginManifest;
  source: PluginInstallSource;
  enabled: boolean;
  installedAt: Date;
}

export interface PluginInstallPlan {
  source: PluginInstallSource;
  manifest: PluginManifest;
  capabilityChanges: string[];
  permissionChanges: string[];
  requiresApproval: boolean;
}

export function createInstallPlan(
  source: PluginInstallSource,
  manifest: PluginManifest,
  existing?: InstalledPluginRecord,
): PluginInstallPlan {
  return {
    source,
    manifest,
    capabilityChanges: diffList(
      existing?.manifest.capabilities ?? [],
      manifest.capabilities,
    ),
    permissionChanges: diffPermissions(existing?.manifest, manifest),
    requiresApproval: true,
  };
}

function diffList(previous: string[], next: string[]): string[] {
  const previousSet = new Set(previous);
  return next.filter((item) => !previousSet.has(item)).sort();
}

function diffPermissions(
  previous: PluginManifest | undefined,
  next: PluginManifest,
): string[] {
  const changes: string[] = [];
  const previousHosts = previous?.permissions?.network?.allowedHosts ?? [];
  const nextHosts = next.permissions?.network?.allowedHosts ?? [];
  for (const host of diffList(previousHosts, nextHosts)) {
    changes.push(`network:${host}`);
  }

  const previousReadRoots = previous?.permissions?.filesystem?.readRoots ?? [];
  const nextReadRoots = next.permissions?.filesystem?.readRoots ?? [];
  for (const root of diffList(previousReadRoots, nextReadRoots)) {
    changes.push(`filesystem.read:${root}`);
  }

  const previousWriteRoots = previous?.permissions?.filesystem?.writeRoots ?? [];
  const nextWriteRoots = next.permissions?.filesystem?.writeRoots ?? [];
  for (const root of diffList(previousWriteRoots, nextWriteRoots)) {
    changes.push(`filesystem.write:${root}`);
  }

  return changes.sort();
}
