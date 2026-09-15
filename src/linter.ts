import * as path from 'path';
import * as YAML from 'yaml';
import {
  ParseResult,
  PortEntry,
  parseHostRange,
  scalarString,
  walkScalars,
} from './parser';

export type Severity = 'error' | 'warning' | 'info';

export interface LintConfig {
  checkEnvVars: boolean;
  checkDeprecated: boolean;
  envFileName: string;
}

export interface EnvFileContents {
  [absPath: string]: string | undefined;
}

export interface LintContext {
  config: LintConfig;
  composeDir: string;
  envFileContents: EnvFileContents;
  resolveEnvPath: (relative: string) => string;
  machineEnv: Record<string, string | undefined>;
}

interface Range {
  offset: number;
  length: number;
}

export interface LintDiagnostic {
  range: Range;
  message: string;
  severity: Severity;
  rule: string;
  id?: string;
  fixes?: LintFix[];
}

export interface LintFix {
  kind: 'replace' | 'delete' | 'createFile';
  range?: Range;
  newText?: string;
  filePath?: string;
  content?: string;
  title: string;
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

interface Interval {
  start: number;
  end: number;
  service: string;
  entry: PortEntry;
}

export function lint(parse: ParseResult, ctx: LintContext): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];

  // -- YAML syntax errors (highest priority) --
  if (parse.doc) {
    for (const error of parse.doc.errors) {
      const offset = error.pos && error.pos[0] >= 0 ? error.pos[0] : 0;
      diagnostics.push({
        range: { offset, length: 1 },
        message: error.message,
        severity: 'error',
        rule: 'yaml-syntax',
      });
    }
  }

  const rootNode = parse.doc?.contents;
  if (rootNode && !YAML.isMap(rootNode)) {
    diagnostics.push({
      range: { offset: 0, length: Math.max(1, Math.min(parse.text.length, 10)) },
      message: 'Compose file must be a YAML mapping at the top level.',
      severity: 'error',
      rule: 'root-type',
    });
  }

  if (parse.servicesNode === undefined) {
    diagnostics.push({
      range: { offset: 0, length: Math.max(1, Math.min(parse.text.length, 10)) },
      message:
        'No `services` section found. Add a `services:` mapping to define your application.',
      severity: 'warning',
      rule: 'missing-services',
    });
  }

  if (ctx.config.checkDeprecated && parse.versionNode) {
    diagnostics.push({
      range: nodeRange(parse.versionNode, parse.doc),
      message:
        'The top-level `version` field is obsolete in the Compose Specification. Compose v2 ignores it — remove it.',
      severity: 'warning',
      rule: 'obsolete-version',
      fixes: parse.versionNode.range
        ? [
            {
              kind: 'delete',
              range: { offset: parse.versionNode.range[0], length: rangeLength(parse.versionNode) },
              title: 'Remove obsolete `version` field',
            },
          ]
        : [],
    });
  }

  const envVars = new Set<string>();
  if (ctx.config.checkEnvVars) {
    collectEnvVarsDefined(parse, ctx, envVars);
    const defaultEnvContent = ctx.envFileContents[ctx.resolveEnvPath(ctx.config.envFileName)];

    const allScalars: { node: YAML.Scalar; value: string }[] = [];
    walkScalars(rootNode, (s) => {
      if (typeof s.value === 'string') allScalars.push({ node: s, value: s.value });
    });

    const missingByScalar = new Map<YAML.Scalar, Set<string>>();
    for (const { node, value } of allScalars) {
      const uses = extractVars(value);
      if (uses.size === 0) continue;
      const missing = new Set<string>();
      for (const v of uses) {
        if (envVars.has(v)) continue;
        if (defaultEnvContent !== undefined && envFileContentHas(defaultEnvContent, v)) continue;
        if (ctx.machineEnv[v] !== undefined) continue;
        missing.add(v);
      }
      if (missing.size > 0) missingByScalar.set(node, missing);
    }

    for (const [node, missing] of missingByScalar) {
      const names = [...missing].map((m) => `\`${m}\``).join(', ');
      const file = ctx.config.envFileName ? ` In ${ctx.config.envFileName} or ` : ' ';
      const fixes: LintFix[] = [];
      const defaultEnvAbs = ctx.resolveEnvPath(ctx.config.envFileName);
      if (ctx.envFileContents[defaultEnvAbs] === undefined) {
        fixes.push({
          kind: 'createFile',
          filePath: defaultEnvAbs,
          content: [...missing].sort().map((m) => `${m}=`).join('\n') + '\n',
          title: `Create ${ctx.config.envFileName} with missing variables`,
        });
      }
      diagnostics.push({
        range: nodeRange(node, parse.doc),
        message: `Undefined environment variable${missing.size > 1 ? 's' : ''} ${names}. Define it${file}the service \`environment:\`, or export it on the host.`,
        severity: 'warning',
        rule: 'undefined-env-var',
        fixes,
      });
    }

    for (const svc of parse.services) {
      for (const ref of svc.envFiles) {
        const abs = ctx.resolveEnvPath(ref.path);
        if (ctx.envFileContents[abs] === undefined) {
          diagnostics.push({
            range: nodeRange(ref.node, parse.doc),
            message: `env_file \`${ref.path}\` not found relative to ${ctx.composeDir}.`,
            severity: 'warning',
            rule: 'missing-env-file',
          });
        }
      }
    }
  }

  if (ctx.config.checkDeprecated) {
    for (const svc of parse.services) {
      const deprecations: Array<[YAML.Node, string, string]> = [];
      if (svc.linksNode) {
        deprecations.push([
          svc.linksNode,
          'links',
          '`links` is legacy. Prefer defining inter-service networking explicitly with the default Compose network.',
        ]);
      }
      if (svc.externalLinksNode) {
        deprecations.push([
          svc.externalLinksNode,
          'external_links',
          '`external_links` is legacy. Attach the service to an external network instead.',
        ]);
      }
      if (svc.logDriverNode) {
        deprecations.push([
          svc.logDriverNode,
          'log_driver/log_opt',
          '`log_driver`/`log_opt` are obsolete. Use the `logging:` option instead.',
        ]);
      }
      if (svc.volumeDriverNode) {
        deprecations.push([
          svc.volumeDriverNode,
          'volume_driver',
          '`volume_driver` is obsolete. Use the `driver:` key under `volumes:` instead.',
        ]);
      }
      if (svc.volumesFromNode) {
        deprecations.push([
          svc.volumesFromNode,
          'volumes_from',
          '`volumes_from` is legacy and creates hidden coupling. Define named volumes explicitly instead.',
        ]);
      }
      for (const [node, field, hint] of deprecations) {
        diagnostics.push({
          range: nodeRange(node, parse.doc),
          message: `${field} is deprecated in service \`${svc.name}\`. ${hint}`,
          severity: 'warning',
          rule: 'deprecated-option',
        });
      }
    }
  }

  // -- Port conflicts --
  const intervals: Interval[] = [];
  const hostByEntry = new Map<string, string>();
  {
    for (const svc of parse.services) {
      for (const entry of svc.ports) {
        const range = parseHostRange(entry.hostPort);
        if (range === undefined) continue;
        intervals.push({ ...range, service: svc.name, entry });
        hostByEntry.set(intervalKey(entry), entry.hostPort ?? '');
      }
    }

    intervals.sort((a, b) => a.start - b.start || a.end - b.end);

    for (let i = 0; i < intervals.length; i++) {
      for (let j = i + 1; j < intervals.length; j++) {
        if (intervals[i].end < intervals[j].start) break;
        if (overlaps(intervals[i], intervals[j])) {
          const a = intervals[i];
          const b = intervals[j];
          const reported = b;
          const otherService = a.service === reported.service ? 'the same service' : `service \`${a.service}\``;
          const otherLabel = a.start === a.end ? `host port ${a.start}` : `host ports ${a.start}-${a.end}`;
          const myLabel = reported.start === reported.end ? `${reported.start}` : `${reported.start}-${reported.end}`;
          const fixes: LintFix[] = [];
          const host = hostByEntry.get(intervalKey(reported.entry));
          if (host !== undefined) {
            const next = nextFreePort(intervals);
            const replacement = rebuildPortText(reported.entry, String(next));
            if (replacement) {
              fixes.push({
                kind: 'replace',
                range: nodeRange(reported.entry.node, parse.doc),
                newText: replacement,
                title: `Change host port to free port ${next}`,
              });
            }
          }
          diagnostics.push({
            range: nodeRange(reported.entry.node, parse.doc),
            id: 'port-' + intervalKey(reported.entry),
            message: `Published host port ${myLabel} conflicts with ${otherLabel} (${otherService}). Use a different host port or set a host IP.`,
            severity: 'error',
            rule: 'port-conflict',
            fixes,
          });
        }
      }
    }
  }

  // -- Circular depends_on --
  const cyclicServices = findCycles(parse);
  for (const svc of cyclicServices) {
    const node = svc.depNode ?? svc.valueNode;
    diagnostics.push({
      range: nodeRange(node, parse.doc),
      message: `Circular dependency detected: service \`${svc.name}\` is part of a depends_on cycle.`,
      severity: 'error',
      rule: 'circular-depends-on',
    });
  }

  // Degrade warnings beyond the cap to keep the gutter readable.
  const cap = 50;
  let warnCount = 0;
  for (const d of diagnostics) {
    if (d.severity === 'warning') {
      warnCount++;
      if (warnCount > cap) d.severity = 'info';
    }
  }

  return diagnostics;
}

function collectEnvVarsDefined(
  parse: ParseResult,
  ctx: LintContext,
  defined: Set<string>,
): void {
  for (const svc of parse.services) {
    for (const name of svc.environment) defined.add(name);
  }
  for (const content of Object.values(ctx.envFileContents)) {
    if (typeof content !== 'string') continue;
    for (const key of envFileKeys(content)) defined.add(key);
  }
}

function envFileKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7) : line;
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    const k = key.trim();
    if (k !== '') keys.add(k);
  }
  return keys;
}

export function extractVars(value: string): Set<string> {
  const out = new Set<string>();
  VAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VAR_RE.exec(value)) !== null) {
    const name = m[1] ?? m[2];
    if (name) out.add(name);
  }
  return out;
}

function envFileContentHas(content: string, name: string): boolean {
  return envFileKeys(content).has(name);
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function intervalKey(entry: PortEntry): string {
  if (entry.node.range) {
    return `${entry.node.range[0]}:${entry.node.range[1] ?? 0}`;
  }
  return `${entry.hostPort ?? ''}-${entry.containerPort ?? ''}`;
}

function nextFreePort(intervals: Interval[]): number {
  let candidate = 10000;
  let changed = true;
  while (changed) {
    changed = false;
    for (const int of intervals) {
      if (candidate >= int.start && candidate <= int.end) {
        candidate = int.end + 1;
        changed = true;
      }
    }
  }
  return candidate;
}

function rebuildPortText(entry: PortEntry, newHost: string): string | null {
  const node = entry.node;
  if (!YAML.isScalar(node)) {
    const target = entry.targetPort ?? '';
    if (target === '') return null;
    return `${newHost}:${target}`;
  }
  const raw = String(node.value);
  const slash = raw.indexOf('/');
  const protocol = slash !== -1 ? raw.slice(slash) : '';
  const body = slash !== -1 ? raw.slice(0, slash) : raw;
  const parts = body.split(':');
  const hostIdx = parts.length === 3 ? 1 : parts.length === 2 ? 0 : -1;
  if (hostIdx === -1) return null;
  const containerPart = parts.length === 3 ? parts[2] : parts[1];
  const ipPrefix = parts.length === 3 ? `${parts[0]}:` : '';
  return `${ipPrefix}${newHost}:${containerPart}${protocol}`;
}

function findCycles(parse: ParseResult): Array<{ name: string; depNode?: YAML.Node; valueNode: YAML.Node }> {
  const services = parse.services;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Map<string, boolean>();
  const stack: string[] = [];
  let counter = 0;
  const cycles: string[] = [];

  const byName = new Map(services.map((s) => [s.name, s]));

  const strongConnect = (v: string): void => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.set(v, true);

    const deps = byName.get(v)?.depNames ?? [];
    for (const w of deps) {
      if (!byName.has(w)) continue;
      if (!index.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.get(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.set(w, false);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1 || (scc.length === 1 && selfDependent(scc[0], byName))) {
        cycles.push(...scc);
      }
    }
  };

  for (const s of services) {
    if (!index.has(s.name)) strongConnect(s.name);
  }

  const cyclicSet = new Set(cycles);
  return services
    .filter((s) => cyclicSet.has(s.name))
    .map((s) => ({ name: s.name, depNode: s.depNode, valueNode: s.valueNode }));
}

function selfDependent(name: string, byName: Map<string, ServiceLike>): boolean {
  const deps = byName.get(name)?.depNames ?? [];
  return deps.includes(name);
}

interface ServiceLike {
  depNames?: string[];
}

function nodeRange(node: YAML.Node, doc?: YAML.Document): Range {
  const r = node.range;
  if (!r) return { offset: 0, length: 1 };
  return { offset: r[0], length: rangeLength(node) };
}

function rangeLength(node: YAML.Node): number {
  const r = node.range;
  if (!r) return 1;
  const end = r[2] ?? r[1] ?? r[0];
  return Math.max(1, end - r[0]);
}

export function nodeLineCol(parse: ParseResult, offset: number): { line: number; col: number } {
  if (parse.lineCounter) {
    const pos = parse.lineCounter.linePos(offset);
    if (pos) return { line: pos.line, col: pos.col };
  }
  const textBefore = parse.text.slice(0, offset);
  const line = textBefore.split('\n').length;
  const lastNl = textBefore.lastIndexOf('\n');
  return { line, col: lastNl === -1 ? offset : offset - lastNl };
}

export function getComposeDir(composeFilePath: string): string {
  return path.dirname(composeFilePath);
}