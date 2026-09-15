import * as path from 'path';
import * as vscode from 'vscode';
import { parseCompose, ParseResult, isComposeFileName } from './parser';
import { lint, LintContext, LintDiagnostic, LintFix, nodeLineCol } from './linter';

const diagCollection = vscode.languages.createDiagnosticCollection('compose-lint');

interface Linted {
  parse: ParseResult;
  diagnostics: LintDiagnostic[];
}

const cache = new Map<string, Linted>();

let debounceTimer: ReturnType<typeof setTimeout> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(diagCollection);

  const lintDocument = (doc: vscode.TextDocument): void => {
    if (!isComposeFile(doc)) {
      if (cache.has(doc.uri.toString())) {
        cache.delete(doc.uri.toString());
        diagCollection.delete(doc.uri);
      }
      return;
    }
    const result = runLint(doc);
    cache.set(doc.uri.toString(), result);
    diagCollection.set(doc.uri, toVscoDiagnostics(doc, result));
  };

  const scheduleLint = (doc: vscode.TextDocument): void => {
    if (!isComposeFile(doc)) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (doc.isClosed) return;
      lintDocument(doc);
    }, 350);
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(lintDocument),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleLint(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagCollection.delete(doc.uri);
      cache.delete(doc.uri.toString());
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('composeLint.lint', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) lintDocument(editor.document);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('composeLint.lintWorkspace', async () => {
      const patterns = getPatterns();
      let count = 0;
      for (const pattern of patterns) {
        const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
        for (const uri of uris) {
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            if (isComposeFile(doc)) {
              lintDocument(doc);
              count++;
            }
          } catch {
            // skip unreadable files
          }
        }
      }
      vscode.window.showInformationMessage(`Compose Lint: checked ${count} Compose file(s).`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('composeLint.createEnvFile', async (args: { filePath?: string; content?: string }) => {
      if (!args?.filePath) return;
      const uri = vscode.Uri.file(args.filePath);
      const existing = await vscode.workspace.fs.stat(uri).then(
        () => true,
        () => false,
      );
      if (existing) {
        vscode.window.showWarningMessage(`Compose Lint: ${path.basename(args.filePath)} already exists.`);
        return;
      }
      await vscode.workspace.fs.writeFile(uri, Buffer.from(args.content ?? '', 'utf8'));
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { language: 'yaml' },
      {
        provideCodeActions(document, range, _ctx): vscode.CodeAction[] {
          const cached = cache.get(document.uri.toString());
          if (!cached) return [];
          const actions: vscode.CodeAction[] = [];
          const line = range.start.line;
          for (const d of cached.diagnostics) {
            if (!d.fixes || d.fixes.length === 0) continue;
            const start = positionAt(document, cached.parse, d.range.offset);
            if (start.line !== line && !(start.line <= line && positionAt(document, cached.parse, d.range.offset + Math.max(0, d.range.length - 1)).line >= line)) {
              continue;
            }
            if (start.line > line) continue;
            const end = positionAt(document, cached.parse, d.range.offset + Math.max(0, d.range.length - 1));
            const diagRange = new vscode.Range(start, end);
            if (!range.intersection(diagRange)) continue;
            for (const fix of d.fixes) {
              actions.push(toCodeAction(document, d, fix));
            }
          }
          return actions;
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );

  for (const open of vscode.workspace.textDocuments) {
    lintDocument(open);
  }
}

export function deactivate(): void {
  diagCollection.clear();
}

function runLint(doc: vscode.TextDocument): Linted {
  const text = doc.getText();
  const parse = parseCompose(text);
  const composeDir = path.dirname(doc.uri.fsPath);
  const cfg = vscode.workspace.getConfiguration('composeLint');
  const envFileName = cfg.get<string>('envFileName', '.env');

  const envFileContents: Record<string, string | undefined> = {};
  const recordPath = (p: string): string | undefined => {
    const abs = path.isAbsolute(p) ? p : path.resolve(composeDir, p);
    if (envFileContents[abs] !== undefined) return abs;
    try {
      envFileContents[abs] = require('fs').readFileSync(abs, 'utf8');
    } catch {
      envFileContents[abs] = undefined;
    }
    return abs;
  };

  recordPath(envFileName);
  for (const svc of parse.services) {
    for (const ref of svc.envFiles) {
      if (!ref.path.includes('$')) recordPath(ref.path);
    }
  }

  const ctx: LintContext = {
    config: {
      checkEnvVars: cfg.get<boolean>('checkEnvVars', true),
      checkDeprecated: cfg.get<boolean>('checkDeprecated', true),
      envFileName,
    },
    composeDir,
    envFileContents,
    resolveEnvPath: (relative) =>
      relative.includes('$') ? path.resolve(composeDir, '.env') : path.isAbsolute(relative) ? relative : path.resolve(composeDir, relative),
    machineEnv: process.env as Record<string, string | undefined>,
  };

  return { parse, diagnostics: lint(parse, ctx) };
}

function isComposeFile(doc: vscode.TextDocument): boolean {
  if (doc.languageId !== 'yaml' && doc.languageId !== 'plaintext') {
    if (doc.languageId === 'dockercompose') return true;
    return false;
  }
  if (isComposeFileName(path.basename(doc.uri.fsPath))) return true;
  const patterns = getPatterns();
  return patterns.some((p) => matchesGlob(doc.uri.fsPath, p));
}

function getPatterns(): string[] {
  const cfg = vscode.workspace.getConfiguration('composeLint');
  return cfg.get<string[]>('filePatterns', ['**/*compose*.yaml', '**/*compose*.yml']);
}

function matchesGlob(filePath: string, pattern: string): boolean {
  const neg = pattern.startsWith('!');
  const glob = neg ? pattern.slice(1) : pattern;
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '[^/\\\\]')
    .replace(/\u0000/g, '.*');
  const re = new RegExp(`^${escaped}$`, 'i');
  return neg ? !re.test(filePath) : re.test(filePath);
}

function toVscoDiagnostics(doc: vscode.TextDocument, result: Linted): vscode.Diagnostic[] {
  const out: vscode.Diagnostic[] = [];
  for (const d of result.diagnostics) {
    const start = positionAt(doc, result.parse, d.range.offset);
    const end = positionAt(doc, result.parse, d.range.offset + Math.max(0, d.range.length - 1));
    const diag = new vscode.Diagnostic(
      new vscode.Range(start, end),
      d.message,
      d.severity === 'error'
        ? vscode.DiagnosticSeverity.Error
        : d.severity === 'warning'
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information,
    );
    diag.code = d.rule;
    diag.source = 'compose-lint';
    out.push(diag);
  }
  return out;
}

function positionAt(doc: vscode.TextDocument, parse: ParseResult, offset: number): vscode.Position {
  const clamped = Math.min(Math.max(0, offset), doc.getText().length);
  const { line, col } = nodeLineCol(parse, clamped);
  return new vscode.Position(line - 1, col - 1);
}

function toCodeAction(doc: vscode.TextDocument, diagnostic: LintDiagnostic, fix: LintFix): vscode.CodeAction {
  const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
  if (fix.kind === 'createFile' && fix.filePath) {
    action.command = {
      command: 'composeLint.createEnvFile',
      title: fix.title,
      arguments: [{ filePath: fix.filePath, content: fix.content }],
    };
    return action;
  }

  if (fix.kind === 'replace' && fix.range && fix.newText !== undefined) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      doc.uri,
      new vscode.Range(
        positionAt(doc, cache.get(doc.uri.toString())!.parse, fix.range.offset),
        positionAt(doc, cache.get(doc.uri.toString())!.parse, fix.range.offset + fix.range.length),
      ),
      fix.newText,
    );
    action.edit = edit;
    return action;
  }

  if (fix.kind === 'delete' && fix.range) {
    const parse = cache.get(doc.uri.toString())!.parse;
    const text = doc.getText();
    const start = positionAt(doc, parse, fix.range.offset);
    let end = positionAt(doc, parse, fix.range.offset + fix.range.length);
    const endOffset = fix.range.offset + fix.range.length;
    if (text[endOffset] === '\n') {
      end = new vscode.Position(end.line + 1, 0);
    }
    const edit = new vscode.WorkspaceEdit();
    edit.delete(doc.uri, new vscode.Range(start, end));
    action.edit = edit;
    return action;
  }

  return action;
}