import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { devcrewDir, repositoryLockPath } from "./paths.js";

interface RepositoryLockMetadata {
  ownerId: string;
  pid: number;
  createdAt: string;
}

function metadataPath(cwd: string): string {
  return `${repositoryLockPath(cwd)}/lock.json`;
}

async function readMetadata(cwd: string): Promise<RepositoryLockMetadata | undefined> {
  try {
    const parsed = JSON.parse(await readFile(metadataPath(cwd), "utf8")) as Partial<RepositoryLockMetadata>;
    const pid = parsed.pid;
    if (
      typeof parsed.ownerId !== "string" ||
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      typeof parsed.createdAt !== "string"
    ) {
      return undefined;
    }
    return {
      ownerId: parsed.ownerId,
      pid,
      createdAt: parsed.createdAt,
    };
  } catch {
    return undefined;
  }
}

function processIsLive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function releaseRepositoryLock(cwd: string, ownerId: string): Promise<void> {
  const metadata = await readMetadata(cwd);
  if (metadata?.ownerId === ownerId) {
    await rm(repositoryLockPath(cwd), { recursive: true, force: true });
  }
}

export async function withRepositoryLock<T>(cwd: string, action: () => Promise<T>): Promise<T> {
  await mkdir(devcrewDir(cwd), { recursive: true });
  const ownerId = randomUUID();
  try {
    await mkdir(repositoryLockPath(cwd));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const metadata = await readMetadata(cwd);
    if (metadata && processIsLive(metadata.pid)) {
      throw new Error("A DevCrew operation is already in progress for this repository");
    }
    throw new Error("A stale DevCrew repository lock exists; use devcrew_recover for explicit recovery");
  }

  await writeFile(
    metadataPath(cwd),
    `${JSON.stringify({ ownerId, pid: process.pid, createdAt: new Date().toISOString() } satisfies RepositoryLockMetadata, null, 2)}\n`,
    "utf8",
  );
  try {
    return await action();
  } finally {
    await releaseRepositoryLock(cwd, ownerId);
  }
}

export async function recoverRepositoryLock(cwd: string): Promise<boolean> {
  const lockPath = repositoryLockPath(cwd);
  const metadata = await readMetadata(cwd);
  if (!metadata) {
    try {
      await rm(lockPath, { recursive: true, force: false });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
  if (processIsLive(metadata.pid)) {
    throw new Error("Cannot recover a DevCrew repository lock held by a live process");
  }
  await rm(lockPath, { recursive: true, force: true });
  return true;
}
