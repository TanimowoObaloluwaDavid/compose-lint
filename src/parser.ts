import * as YAML from 'yaml';

export interface PortEntry {
  hostPort: string | undefined;
  containerPort: string | undefined;
  targetPort: string | undefined;
  node: YAML.Node;
}

export interface EnvFileRef {
  path: string;
  node: YAML.Node;
}

export interface ServiceModel {
  name: string;
  keyNode: YAML.Node;
  valueNode: YAML.Node;
  depNames: string[];
  depNode: YAML.Node | undefined;
  ports: PortEntry[];
  environment: string[];
  envFiles: EnvFileRef[];
  linksNode: YAML.Node | undefined;
  externalLinksNode: YAML.Node | undefined;
  logDriverNode: YAML.Node | undefined;
  volumeDriverNode: YAML.Node | undefined;
  volumesFromNode: YAML.Node | undefined;
}

export interface ParseResult {
  text: string;
  doc: YAML.Document | undefined;
  lineCounter: YAML.LineCounter | undefined;
  services: ServiceModel[];
  servicesNode: YAML.Node | undefined;
  versionNode: YAML.Node | undefined;
}

export function isComposeFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (!(lower.endsWith('.yml') || lower.endsWith('.yaml'))) return false;
  return lower.startsWith('compose') || lower.startsWith('docker-compose');
}

export function parsePortShort(text: string): { host: string | undefined; container: string } {
  let v = text.trim();
  const protoIdx = v.indexOf('/');
  if (protoIdx !== -1) v = v.slice(0, protoIdx);
  const parts = v.split(':');
  if (parts.length === 3) {
    return { host: parts[1] || undefined, container: parts[2] };
  }
  if (parts.length === 2) {
    return { host: parts[0] || undefined, container: parts[1] };
  }
  return { host: undefined, container: parts[0] };
}

export function parseHostRange(host: string | undefined): { start: number; end: number } | undefined {
  if (host === undefined || host === '') return undefined;
  const parts = host.split('-');
  if (parts.length > 2) return undefined;
  const a = Number(parts[0].trim());
  if (Number.isNaN(a)) return undefined;
  if (parts.length === 2) {
    const b = Number(parts[1].trim());
    if (Number.isNaN(b) || b < a) return undefined;
    return { start: a, end: b };
  }
  return { start: a, end: a };
}

export function parseCompose(text: string): ParseResult {
  const base: ParseResult = {
    text,
    doc: undefined,
    lineCounter: undefined,
    services: [],
    servicesNode: undefined,
    versionNode: undefined,
  };

  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter, uniqueKeys: true, strict: true });
  base.doc = doc;
  base.lineCounter = lineCounter;

  const contents = doc.contents;
  if (!contents || !YAML.isMap(contents)) return base;

  for (const item of contents.items) {
    const key = scalarString(item.key);
    if (key === 'services') {
      base.servicesNode = toNode(item.value);
      if (isMapValue(item.value)) {
        for (const svc of item.value.items) {
          const name = scalarString(svc.key);
          if (name === undefined || !isMapValue(svc.value) || !svgKey(svc.key)) continue;
          base.services.push(parseService(name, svc.key, svc.value));
        }
      }
    } else if (key === 'version') {
      base.versionNode = toNode(item.value) ?? toNode(item.key);
    }
  }

  return base;
}

function isMapValue(value: unknown): value is YAML.YAMLMap {
  return value !== null && value !== undefined && YAML.isMap(value);
}

function svgKey(value: unknown): value is YAML.Node {
  return value !== null && value !== undefined;
}

function parseService(name: string, keyNode: YAML.Node, map: YAML.YAMLMap): ServiceModel {
  const model: ServiceModel = {
    name,
    keyNode,
    valueNode: map,
    depNames: [],
    depNode: undefined,
    ports: [],
    environment: [],
    envFiles: [],
    linksNode: undefined,
    externalLinksNode: undefined,
    logDriverNode: undefined,
    volumeDriverNode: undefined,
    volumesFromNode: undefined,
  };

  for (const item of map.items) {
    const key = scalarString(item.key);
    if (key === undefined || item.value === undefined || item.value === null) continue;
    switch (key) {
      case 'depends_on': {
        model.depNode = toNode(item.value);
        if (YAML.isSeq(item.value)) {
          for (const dep of item.value.items) {
            const n = scalarString(dep);
            if (n !== undefined) model.depNames.push(n);
          }
        } else if (YAML.isMap(item.value)) {
          for (const dep of item.value.items) {
            const n = scalarString(dep.key);
            if (n !== undefined) model.depNames.push(n);
          }
        }
        break;
      }
      case 'ports': {
        if (YAML.isSeq(item.value)) {
          for (const entry of item.value.items) {
            const parsed = parsePortEntry(entry);
            if (parsed) model.ports.push(parsed);
          }
        } else {
          const parsed = parsePortEntry(item.value);
          if (parsed) model.ports.push(parsed);
        }
        break;
      }
      case 'environment': {
        if (YAML.isMap(item.value)) {
          for (const e of item.value.items) {
            const n = scalarString(e.key);
            if (n !== undefined) model.environment.push(n);
          }
        } else if (YAML.isSeq(item.value)) {
          for (const e of item.value.items) {
            const raw = e !== null && e !== undefined && YAML.isScalar(e) ? String(e.value) : '';
            const eq = raw.indexOf('=');
            model.environment.push(eq === -1 ? raw : raw.slice(0, eq));
          }
        }
        break;
      }
      case 'env_file': {
        if (YAML.isSeq(item.value)) {
          for (const e of item.value.items) {
            const ref = parseEnvFileRef(e);
            if (ref) model.envFiles.push(ref);
          }
        } else {
          const ref = parseEnvFileRef(item.value);
          if (ref) model.envFiles.push(ref);
        }
        break;
      }
      case 'links':
        model.linksNode = toNode(item.value);
        break;
      case 'external_links':
        model.externalLinksNode = toNode(item.value);
        break;
      case 'log_driver':
      case 'log_opt':
        model.logDriverNode = toNode(item.value);
        break;
      case 'volume_driver':
        model.volumeDriverNode = toNode(item.value);
        break;
      case 'volumes_from':
        model.volumesFromNode = toNode(item.value);
        break;
      default:
        break;
    }
  }

  return model;
}

function parsePortEntry(node: unknown): PortEntry | undefined {
  if (node === null || node === undefined) return undefined;
  if (YAML.isScalar(node)) {
    const raw = String(node.value);
    const parsed = parsePortShort(raw);
    const hostRange = parseHostRange(parsed.host);
    const hostPort =
      parsed.host !== undefined && parsed.host !== ''
        ? hostRange
          ? hostRange.start !== hostRange.end
            ? `${hostRange.start}-${hostRange.end}`
            : String(hostRange.start)
          : parsed.host
        : undefined;
    return { hostPort, containerPort: parsed.container, targetPort: parsed.container, node };
  }
  if (YAML.isMap(node)) {
    let published: string | undefined;
    let target: string | undefined;
    for (const item of node.items) {
      const key = scalarString(item.key);
      const val = scalarString(item.value);
      if (key === 'published') published = val !== undefined ? String(val) : undefined;
      if (key === 'target') target = val !== undefined ? String(val) : undefined;
    }
    const hostRange = parseHostRange(published);
    const hostPort =
      published !== undefined && published !== ''
        ? hostRange
          ? hostRange.start !== hostRange.end
            ? `${hostRange.start}-${hostRange.end}`
            : String(hostRange.start)
          : published
        : undefined;
    return { hostPort, containerPort: target, targetPort: target, node };
  }
  return undefined;
}

function parseEnvFileRef(node: unknown): EnvFileRef | undefined {
  if (node === null || node === undefined) return undefined;
  if (YAML.isScalar(node) && typeof node.value === 'string') {
    return { path: node.value, node };
  }
  if (YAML.isMap(node)) {
    for (const item of node.items) {
      if (scalarString(item.key) === 'path') {
        const pathVal = scalarString(item.value);
        if (pathVal !== undefined) return { path: pathVal, node };
      }
    }
  }
  return undefined;
}

function toNode(v: unknown): YAML.Node | undefined {
  if (v === null || v === undefined) return undefined;
  return v as YAML.Node;
}

export function scalarString(node: unknown): string | undefined {
  if (node !== null && node !== undefined && YAML.isScalar(node)) {
    const v = node.value;
    if (typeof v === 'string') return v;
    if (v !== null && v !== undefined) return String(v);
  }
  return undefined;
}

export function walkScalars(node: unknown, cb: (scalar: YAML.Scalar) => void): void {
  if (!node) return;
  if (YAML.isScalar(node)) {
    cb(node);
    return;
  }
  if (YAML.isPair(node)) {
    walkScalars(node.key, cb);
    walkScalars(node.value, cb);
    return;
  }
  if (YAML.isMap(node)) {
    for (const item of node.items) {
      walkScalars(item.key, cb);
      walkScalars(item.value, cb);
    }
    return;
  }
  if (YAML.isSeq(node)) {
    for (const it of node.items) {
      walkScalars(it, cb);
    }
  }
}