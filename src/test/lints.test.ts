import * as assert from 'assert';
import * as path from 'path';
import { test } from 'node:test';
import { parseCompose, parsePortShort, isComposeFileName } from '../parser';
import { lint, LintContext } from '../linter';

const composeDir = path.join(__dirname, '..', 'fixtures');
const envFileName = '.env';

function ctx(overrides?: Partial<LintContext>): LintContext {
  return {
    config: { checkEnvVars: true, checkDeprecated: true, envFileName },
    composeDir,
    envFileContents: {},
    resolveEnvPath: (rel) => path.isAbsolute(rel) ? rel : path.resolve(composeDir, rel),
    machineEnv: {},
    ...overrides,
  };
}

function rulesFor(text: string, context?: LintContext): string[] {
  const parse = parseCompose(text);
  return lint(parse, context ?? ctx()).map((d) => d.rule);
}

test('detects published host port conflict between services', () => {
  const text = `
services:
  web:
    image: nginx
    ports:
      - "8080:80"
  api:
    image: node
    ports:
      - "8080:3000"
`;
  const d = lint(parseCompose(text), ctx());
  const conflicts = d.filter((x) => x.rule === 'port-conflict');
  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(conflicts[0].severity, 'error');
  assert.match(conflicts[0].message, /8080/);
});

test('detects port conflict with overlapping ranges', () => {
  const text = `
services:
  a:
    image: x
    ports:
      - "8080-8090:80"
  b:
    image: y
    ports:
      - "8085:80"
`;
  const d = lint(parseCompose(text), ctx());
  assert.strictEqual(d.filter((x) => x.rule === 'port-conflict').length, 1);
});

test('does not flag distinct host ports', () => {
  const text = `
services:
  a:
    image: x
    ports:
      - "8080:80"
  b:
    image: y
    ports:
      - "8081:3000"
`;
  const d = lint(parseCompose(text), ctx());
  assert.strictEqual(d.filter((x) => x.rule === 'port-conflict').length, 0);
});

test('detects circular depends_on', () => {
  const text = `
services:
  a:
    image: x
    depends_on:
      - b
  b:
    image: y
    depends_on:
      - c
  c:
    image: z
    depends_on:
      - a
`;
  const d = lint(parseCompose(text), ctx());
  const cycles = d.filter((x) => x.rule === 'circular-depends-on');
  assert.strictEqual(cycles.length, 3);
  assert.strictEqual(cycles[0].severity, 'error');
});

test('detects self dependency', () => {
  const text = `
services:
  a:
    image: x
    depends_on:
      - a
`;
  const d = lint(parseCompose(text), ctx());
  assert.strictEqual(d.filter((x) => x.rule === 'circular-depends-on').length, 1);
});

test('does not flag acyclic depends_on', () => {
  const text = `
services:
  db:
    image: postgres
  web:
    image: nginx
    depends_on:
      - db
`;
  const d = lint(parseCompose(text), ctx());
  assert.strictEqual(d.filter((x) => x.rule === 'circular-depends-on').length, 0);
});

test('flags obsolete top-level version', () => {
  const text = `
version: "3.9"
services:
  web:
    image: nginx
`;
  const d = lint(parseCompose(text), ctx());
  const v = d.filter((x) => x.rule === 'obsolete-version');
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].severity, 'warning');
  assert.ok(v[0].fixes && v[0].fixes.some((f) => f.kind === 'delete'));
});

test('flags deprecated links', () => {
  const text = `
services:
  web:
    image: nginx
    links:
      - db:database
`;
  const d = lint(parseCompose(text), ctx());
  assert.strictEqual(d.filter((x) => x.rule === 'deprecated-option').length, 1);
});

test('warns on undefined env var referenced without .env', () => {
  const text = `
services:
  web:
    image: nginx
    environment:
      - PORT=\${WEB_PORT}
`;
  const d = lint(parseCompose(text), ctx({ machineEnv: {} }));
  const undef = d.filter((x) => x.rule === 'undefined-env-var');
  assert.ok(undef.length >= 1);
  assert.match(undef[0].message, /WEB_PORT/);
});

test('no warning when env var defined in .env content', () => {
  const text = `
services:
  web:
    image: nginx
    environment:
      - PORT=\${WEB_PORT}
`;
  const envAbs = path.resolve(composeDir, envFileName);
  const c = ctx({ envFileContents: { [envAbs]: 'WEB_PORT=8080\n' } });
  const d = lint(parseCompose(text), c);
  assert.strictEqual(d.filter((x) => x.rule === 'undefined-env-var').length, 0);
});

test('no warning when env var defined in service environment map', () => {
  const text = `
services:
  web:
    image: nginx
    environment:
      WEB_PORT: 8080
    command: echo \${WEB_PORT}
`;
  const d = lint(parseCompose(text), ctx({ machineEnv: {} }));
  assert.strictEqual(d.filter((x) => x.rule === 'undefined-env-var').length, 0);
});

test('warns on missing env_file', () => {
  const text = `
services:
  web:
    image: nginx
    env_file:
      - ./not-here.env
`;
  const d = lint(parseCompose(text), ctx());
  assert.strictEqual(d.filter((x) => x.rule === 'missing-env-file').length, 1);
});

test('reports YAML syntax errors', () => {
  const text = `
services:
  web:
    ports:
      - "8080:80
    image: nginx
`;
  const d = lint(parseCompose(text), ctx());
  assert.ok(d.some((x) => x.rule === 'yaml-syntax'));
});

test('warns when services section is missing', () => {
  const d = lint(parseCompose('networks:\n  default:\n'), ctx());
  assert.strictEqual(d.filter((x) => x.rule === 'missing-services').length, 1);
});

test('parsePortShort handles ip:host:container', () => {
  const p = parsePortShort('127.0.0.1:8080:80');
  assert.deepStrictEqual(p, { host: '8080', container: '80' });
});

test('parsePortShort handles single container port', () => {
  const p = parsePortShort('80/udp');
  assert.deepStrictEqual(p, { host: undefined, container: '80' });
});

test('isComposeFileName', () => {
  assert.ok(isComposeFileName('docker-compose.yml'));
  assert.ok(isComposeFileName('compose.override.yaml'));
  assert.ok(!isComposeFileName('docker-compose.txt'));
  assert.ok(!isComposeFileName('app.yaml'));
});

test('port conflict fix suggests a free port', () => {
  const text = `
services:
  a:
    image: x
    ports:
      - "8080:80"
  b:
    image: y
    ports:
      - "8080:3000"
`;
  const d = lint(parseCompose(text), ctx());
  const conflict = d.find((x) => x.rule === 'port-conflict');
  assert.ok(conflict);
  const fix = conflict.fixes?.find((f) => f.kind === 'replace');
  assert.ok(fix, 'expected a replace fix');
  assert.ok(fix?.newText, 'expected newText');
  assert.ok(!fix!.newText!.startsWith('8080:'), 'should move off the conflicting host port');
  assert.match(fix!.newText!, /:3000$/);
});