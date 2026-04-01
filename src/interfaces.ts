/**
 * fmirror (File Mirror)
 * 
 * A small TypeScript/Node.js utility that watches one or more source folders and mirrors them to one or more destination folders.
 * 
 * Copyright (c) 2026 Daniele Perilli
 */

import type { FSWatcher } from "chokidar";
import ignore from "ignore";

export interface IAppConfig {
    debounceMs?: number;
    fileDebounceMs?: number;
    jobs: IJobConfig[];
}

export interface IJobConfig {
    name: string;
    source: string;
    destinations: string[];
    deleteMissing?: boolean;
    watchHidden?: boolean;
}

export interface IIgnoreFile {
    directory: string;
    matcher: ReturnType<typeof ignore>;
}

export type FileEventName = "add" | "change" | "unlink";

export interface IQueuedFileEvent {
    eventName: FileEventName;
    debounceTimer?: NodeJS.Timeout;
    retryTimer?: NodeJS.Timeout;
    isProcessing: boolean;
    runAfterCurrent: boolean;
    retryCount: number;
}

export interface IPersistedQueueItem {
    path: string;
    eventName: FileEventName;
}

export interface IPersistedQueueState {
    version: number;
    updatedAt: string;
    items: IPersistedQueueItem[];
}

export interface IJobRuntime {
    config: INormalizedJobConfig;
    ignoreFiles: IIgnoreFile[];
    internalIgnoreDirectory: string;
    internalAppDirectory: string;
    errorLogPath: string;
    queueFilePath: string;
    fileEventDebounceMs: number;
    queuedFileEvents: Map<string, IQueuedFileEvent>;
    recoveredQueuePaths: string[];
    queuePersistencePromise: Promise<void>;
    fileEventBurstCount: number;
    watcher?: FSWatcher;
    fullSyncTimer?: NodeJS.Timeout;
    fileEventBurstTimer?: NodeJS.Timeout;
}

export interface INormalizedJobConfig {
    name: string;
    source: string;
    destinations: string[];
    deleteMissing: boolean;
    watchHidden: boolean;
}

export interface ISourceManifest {
    files: Set<string>;
    directories: Set<string>;
}

export type CliCommandName = "watch" | "analyze" | "reconcile" | "install";

export interface ICliArguments {
    command: CliCommandName;
    configPath?: string;
}

export interface IRuntimeAnalysis {
    fileCount: number;
    totalSizeBytes: number;
    logPath: string;
}
