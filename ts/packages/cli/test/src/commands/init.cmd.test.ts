import { afterEach } from 'vitest';
import { describe, expect, layer } from '@effect/vitest';
import { Effect } from 'effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import { cli, TestLive, MockConsole } from 'test/__utils__';
import { makeOrgProject, makeSessionInfo } from 'test/__utils__/models/account';
import { NodeProcess } from 'src/services/node-process';
import { redirectedTerminalUI } from 'test/__utils__/services/redirected-terminal-ui';

describe('CLI: composio dev init', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  describe('dev init --help', () => {
    layer(TestLive({ fixture: 'typescript-project' }))(it => {
      it.effect('[Then] shows --no-browser and --yes, no --org-id or --project-id', () =>
        Effect.gen(function* () {
          yield* cli(['dev', 'init', '--help']);
          const lines = yield* MockConsole.getLines({ stripAnsi: true });
          const output = lines.join('\n');
          expect(output).toContain('--no-browser');
          expect(output).toContain('--yes');
          expect(output).not.toContain('--org-id');
          expect(output).not.toContain('--project-id');
        })
      );
    });
  });

  describe('dev init without a usable login', () => {
    layer(TestLive({ fixture: 'user-config-example' }))(it => {
      it.effect('[Given] an API key but no org [Then] fails with a usage error', () =>
        Effect.gen(function* () {
          const failure = yield* cli(['dev', 'init', '--yes']).pipe(Effect.flip);

          // `cli-main.ts` prints the message on stderr and exits 1.
          expect(failure).toMatchObject({
            _tag: 'commands/CommandInputError',
            command: 'dev init',
            message: 'No global API key or org ID found. Please try `composio login` first.',
          });
        })
      );
    });
  });

  describe('dev init in an org without projects', () => {
    layer(TestLive({ fixture: 'user-config-with-global-context', accountData: { projects: [] } }))(
      it => {
        it.effect('[Given] no projects [Then] says so on a redirected stderr and exits 1', () =>
          Effect.gen(function* () {
            const terminal = redirectedTerminalUI();
            yield* cli(['dev', 'init', '--yes']).pipe(Effect.provide(terminal.layer));

            expect(terminal.stderr()).toBe(
              'No projects found for your organization.\nCreate a project at https://platform.composio.dev, then run `composio dev init` again.\n'
            );
            expect(terminal.stdout()).toBe('');
            expect(process.exitCode).toBe(1);
          })
        );
      }
    );
  });

  describe('dev init with the API unreachable', () => {
    const projectGuidance =
      'Create a project at https://platform.composio.dev, then run `composio dev init` again.';

    layer(TestLive({ fixture: 'user-config-with-global-context' }))(it => {
      it.effect('[Given] no project list [Then] fails with the project guidance', () =>
        Effect.gen(function* () {
          const result = yield* Effect.result(cli(['dev', 'init', '--yes']));
          const lines = yield* MockConsole.getLines({ stripAnsi: true });

          expect(result._tag).toBe('Failure');
          expect(lines).toEqual([
            '-- composio dev init --',
            'Could not fetch projects from the server.',
            projectGuidance,
            '--  --',
            'Unexpected response from the server.',
            projectGuidance,
            '--  --',
          ]);
        })
      );
    });

    layer(
      TestLive({
        fixture: 'user-config-with-global-context',
        accountData: { projects: [makeOrgProject({ id: 'p1', name: 'One' })] },
      })
    )(it => {
      it.effect('[Given] no session info [Then] warns with the transport reason and finishes', () =>
        Effect.gen(function* () {
          yield* cli(['dev', 'init', '--yes']);
          const lines = yield* MockConsole.getLines({ stripAnsi: true });

          expect(lines.slice(0, 4)).toEqual([
            '-- composio dev init --',
            'Using developer project "One"',
            'Could not create .env.local from session info.',
            'No test data for auth.session.retrieveInfo',
          ]);
          expect(lines[4]).toMatch(/^Project initialized in /);
        })
      );
    });
  });

  describe('dev init .env.local hardening (M-3)', () => {
    const INJECTED = 'uak_evil\nCOMPOSIO_BASE_URL=https://attacker.example\n#';

    layer(
      TestLive({
        fixture: 'user-config-with-global-context',
        accountData: {
          projects: [makeOrgProject({ id: 'p1', name: 'One' })],
          sessionInfo: makeSessionInfo({ apiKey: INJECTED }),
        },
      })
    )(it => {
      it.effect(
        '[Given] a server key containing a newline [Then] no injected line is written',
        () =>
          Effect.gen(function* () {
            const proc = yield* NodeProcess;
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;

            // init finishes (env creation is best-effort) but must refuse the key.
            yield* cli(['dev', 'init', '--yes']);

            const envPath = path.join(proc.cwd, '.env.local');
            const content = yield* fs
              .readFileString(envPath, 'utf8')
              .pipe(Effect.catch(() => Effect.succeed('')));
            expect(content).not.toContain('COMPOSIO_BASE_URL');
            expect(content).not.toContain('attacker.example');
          })
      );
    });

    layer(
      TestLive({
        fixture: 'user-config-with-global-context',
        accountData: {
          projects: [makeOrgProject({ id: 'p1', name: 'One' })],
          sessionInfo: makeSessionInfo({ apiKey: 'uak_clean_key', orgMemberId: 'member_42' }),
        },
      })
    )(it => {
      it.effect('[Given] a clean server key [Then] .env.local is written 0600 and gitignored', () =>
        Effect.gen(function* () {
          const proc = yield* NodeProcess;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          yield* cli(['dev', 'init', '--yes']);

          const envPath = path.join(proc.cwd, '.env.local');
          const content = yield* fs.readFileString(envPath, 'utf8');
          expect(content).toContain('COMPOSIO_API_KEY=uak_clean_key');
          expect(content).toContain('COMPOSIO_TEST_USER_ID=pg-test-member_42');

          const info = yield* fs.stat(envPath);
          expect(Number(info.mode) & 0o777).toBe(0o600);

          const gitignore = yield* fs
            .readFileString(path.join(proc.cwd, '.gitignore'), 'utf8')
            .pipe(Effect.catch(() => Effect.succeed('')));
          expect(gitignore.split('\n').map(l => l.trim())).toContain('.env.local');
        })
      );
    });
  });
});
