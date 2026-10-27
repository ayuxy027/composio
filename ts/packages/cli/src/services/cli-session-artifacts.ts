import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import { Effect, Option } from 'effect';
import { APP_CONFIG } from 'src/config';
import { getOrCreateProbablyMyCliSessionIdForCurrentCwd } from 'src/services/consumer-short-term-cache';
import { ComposioCliUserConfig } from 'src/services/cli-user-config';
import { NodeOs } from 'src/services/node-os';

export const resolveArtifactsRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  const os = yield* NodeOs;
  const cliUserConfig = yield* ComposioCliUserConfig;
  const sessionDirectory = yield* APP_CONFIG.SESSION_DIR;
  const cacheDirectory = yield* APP_CONFIG.CACHE_DIR;

  return (
    sessionDirectory ||
    cacheDirectory ||
    cliUserConfig.data.artifactDirectory?.trim() ||
    path.join(os.homedir, '.composio', 'artifacts')
  );
});

const SESSION_HISTORY_FILE = 'session-history.jsonl';

// Session artifacts hold raw tool arguments, outputs and trigger payloads, so
// they are created private to the current user: 0700 directories and 0600
// files. Combined with the user-owned ~/.composio default root (above), this
// keeps them unreadable by other local users and removes the shared-/tmp
// symlink pre-creation vector.
const ARTIFACT_DIR_MODE = 0o700;
const ARTIFACT_FILE_MODE = 0o600;

const makePrivateDirectory = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dir, { recursive: true });
    // chmod is defense-in-depth over the private root; a filesystem that cannot
    // honor it (e.g. a non-POSIX mount) still gets the private location.
    yield* fs.chmod(dir, ARTIFACT_DIR_MODE).pipe(Effect.ignore);
  });

export type CliSessionArtifacts = {
  readonly sessionId: string;
  readonly directoryPath: string;
  readonly historyFilePath: string;
};

const randomToken = (length = 8) => crypto.randomUUID().replace(/-/g, '').slice(0, length);

const sanitizeArtifactName = (value: string): string =>
  value.replace(/[^A-Z0-9_]+/gi, '_').replace(/^_+|_+$/g, '') || 'ARTIFACT';

export const resolveCliSessionArtifacts = (params?: {
  readonly orgId?: string;
  readonly consumerUserId?: string;
}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const sessionIdOption = yield* getOrCreateProbablyMyCliSessionIdForCurrentCwd(params).pipe(
      Effect.option,
      Effect.map(Option.flatten)
    );
    if (Option.isNone(sessionIdOption)) {
      return Option.none<CliSessionArtifacts>();
    }

    const directoryPath = path.join(yield* resolveArtifactsRoot, sessionIdOption.value);
    const directoryCreated = yield* makePrivateDirectory(directoryPath).pipe(
      Effect.option,
      Effect.map(Option.isSome)
    );
    if (!directoryCreated) {
      return Option.none<CliSessionArtifacts>();
    }

    return Option.some({
      sessionId: sessionIdOption.value,
      directoryPath,
      historyFilePath: path.join(directoryPath, SESSION_HISTORY_FILE),
    } satisfies CliSessionArtifacts);
  });

export const appendCliSessionHistory = (params: {
  readonly entry: Record<string, unknown>;
  readonly orgId?: string;
  readonly consumerUserId?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const artifactsOption = yield* resolveCliSessionArtifacts({
      orgId: params.orgId,
      consumerUserId: params.consumerUserId,
    });
    if (Option.isNone(artifactsOption)) {
      return;
    }

    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionId: artifactsOption.value.sessionId,
      ...params.entry,
    });
    yield* fs
      .writeFileString(artifactsOption.value.historyFilePath, `${line}\n`, {
        flag: 'a',
        mode: ARTIFACT_FILE_MODE,
      })
      .pipe(Effect.ignore);
  });

export const storeCliSessionArtifact = (params: {
  readonly contents: string;
  readonly name: string;
  readonly extension?: string;
  readonly directoryPath?: string;
  readonly orgId?: string;
  readonly consumerUserId?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directoryPath = yield* Effect.gen(function* () {
      if (params.directoryPath) {
        return params.directoryPath;
      }

      const artifactsOption = yield* resolveCliSessionArtifacts({
        orgId: params.orgId,
        consumerUserId: params.consumerUserId,
      });
      if (Option.isSome(artifactsOption)) {
        return artifactsOption.value.directoryPath;
      }

      return path.join(yield* resolveArtifactsRoot, `adhoc_${randomToken(12)}`);
    });

    return yield* Effect.gen(function* () {
      yield* makePrivateDirectory(directoryPath);
      const extension = (params.extension ?? 'json').replace(/^\.+/, '') || 'json';
      const filePath = path.join(
        directoryPath,
        `${sanitizeArtifactName(params.name)}_${randomToken()}.${extension}`
      );
      yield* fs.writeFileString(filePath, params.contents, { mode: ARTIFACT_FILE_MODE });
      return filePath;
    }).pipe(Effect.option, Effect.map(Option.getOrUndefined));
  });
