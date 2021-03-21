import {
    createConnection, IConnection,
    CodeAction, CodeActionKind, Command, Diagnostic, DiagnosticSeverity, Position, Range, Files,
    TextDocuments, TextEdit, TextDocumentSyncKind,
    ErrorMessageTracker, ProposedFeatures
} from "vscode-languageserver";
import { TextDocument } from 'vscode-languageserver-textdocument';

import { Trace, LogTraceNotification } from "vscode-jsonrpc";
import { URI } from "vscode-uri";

import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as glob from "glob";
import * as minimatch from "minimatch";

import {
    NoConfigNotification, NoLibraryNotification,
    AllFixesRequest, StatusNotification,
    StartProgressNotification, StopProgressNotification
} from "./types";

import { TextlintFixRepository, AutoFix } from "./autofix";

const DEFAULT_IGNORE_PATTERNS = Object.freeze(["**/.git/**", "**/node_modules/**"]);

let connection: IConnection = createConnection(ProposedFeatures.all);
let documents = new TextDocuments(TextDocument);
let workspaceRoot: string;
let trace: number;
let textlintModule;
let settings;
let ignorePatterns: string[];
documents.listen(connection);
let fixrepos: Map<string/* uri */, TextlintFixRepository> = new Map();

connection.onInitialize(params => {
    workspaceRoot = params.rootPath;
    settings = params.initializationOptions;
    trace = Trace.fromString(settings.trace);
    return resolveTextlint().then(() => {
        return {
            capabilities: {
                textDocumentSync: TextDocumentSyncKind.Full,
                codeActionProvider: true
            }
        };
    });
});

function loadIgnoreFile() {
    ignorePatterns = [];
    ignorePatterns.push(...DEFAULT_IGNORE_PATTERNS);
    const ignorePath = settings.ignorePath ?
        settings.ignorePath :
        path.resolve(workspaceRoot, ".textlintignore");
    const baseDir = path.dirname(ignorePath);
    if (fs.existsSync(ignorePath)) {
        const patterns = fs.readFileSync(ignorePath, "utf-8")
            .split(/\r?\n/)
            .filter((line: string) => !/^\s*$/.test(line) && !/^\s*#/.test(line))
            .map((pattern) => {
                if (pattern.startsWith("!")) {
                    return "!" + path.posix.join(baseDir, pattern.slice(1));
                }
                return path.posix.join(baseDir, pattern)
            });
        ignorePatterns.push(...patterns);
    }
}

function rewind() {
    return resolveTextlint().then(() => {
        let docs = [...fixrepos.keys()].map(uri => {
            clearDiagnostics(uri);
            let d = documents.get(uri);
            if (d) {
                configureLint(uri);
                return d;
            }
        }).filter(d => d);
        return docs ? validateMany(docs) : null;
    })
}

connection.onDidChangeConfiguration(change => {
    let newone = change.settings.textlint;
    TRACE(`onDidChangeConfiguration ${JSON.stringify(newone)}`);
    settings = newone;
    trace = Trace.fromString(newone.trace);
    loadIgnoreFile();
    return rewind();
});
connection.onDidChangeWatchedFiles(params => {
    TRACE("onDidChangeWatchedFiles");
    loadIgnoreFile();
    return rewind();
});

documents.onDidChangeContent(event => {
    let uri = event.document.uri;
    TRACE(`onDidChangeContent ${uri}`);
    if (settings.run === "onType") {
        return validateSingle(event.document);
    }
});
documents.onDidSave(event => {
    let uri = event.document.uri;
    TRACE(`onDidSave ${uri}`);
    if (settings.run === "onSave") {
        return validateSingle(event.document);
    }
});

function resolveTextlint(): Thenable<any> {
    return Files.resolveModulePath(workspaceRoot, "textlint", settings.nodePath, TRACE)
        .then((path: string) => {
            TRACE(`Module textlint got resolved to ${path}`)
            return require(path);
        })
        .then(value => value, error => {
            connection.sendNotification(NoLibraryNotification.type);
            return Promise.reject(error);
        }).then(mod => textlintModule = mod);
}

function configureLint(uri) {
    if (uri.startsWith("file:") && fixrepos.has(uri) === false) {
        fixrepos.set(uri, new TextlintFixRepository(() => {
            if (textlintModule) {
                return Promise.resolve(textlintModule);
            }
            return resolveTextlint();
        }));
    }
}

documents.onDidOpen(event => {
    let uri = event.document.uri;
    TRACE(`onDidOpen ${uri}`);
    configureLint(uri);
});

function clearDiagnostics(uri) {
    TRACE(`clearDiagnostics ${uri}`);
    if (uri.startsWith("file:")) {
        fixrepos.delete(uri);
        connection.sendDiagnostics({ uri, diagnostics: [] });
    }
}
documents.onDidClose(event => {
    let uri = event.document.uri;
    TRACE(`onDidOpen ${uri}`);
    clearDiagnostics(uri);
});

function validateSingle(textDocument: TextDocument) {
    sendStartProgress();
    return validate(textDocument).then(sendOK, error => {
        sendError(error);
    }).then(sendStopProgress);
}

function validateMany(textDocuments: TextDocument[]) {
    let tracker = new ErrorMessageTracker();
    sendStartProgress();
    let promises = textDocuments.map(doc => {
        return validate(doc).then(undefined, error => {
            tracker.add(error.message);
            return Promise.reject(error);
        });
    });
    return Promise.all(promises).then(() => {
        tracker.sendErrors(connection);
        sendOK();
    }, errors => {
        tracker.sendErrors(connection);
        sendError(errors);
    }).then(sendStopProgress);
}

function candidates(root: string) {
    return () => glob.sync(`${root}/.textlintr{c.js,c.yaml,c.yml,c,c.json}`);
}

function findConfig(): string {
    let roots = [candidates(workspaceRoot), () => {
        return fs.existsSync(settings.configPath) ? [settings.configPath] : [];
    }, candidates(os.homedir())];
    for (const fn of roots) {
        let files = fn();
        if (0 < files.length) {
            return files[0];
        }
    }
    connection.sendNotification(NoConfigNotification.type);
    return "";
}

function isTarget(file: string): boolean {
    if (!ignorePatterns) {
        loadIgnoreFile();
    }
    for (const pattern of ignorePatterns) {
        if (minimatch(file, pattern)) {
            return false
        }
    }
    const relativePath = path.relative(workspaceRoot, file);
    return settings.targetPath === "" || minimatch(relativePath, settings.targetPath, {
        matchBase: true
    });
}

function validate(doc: TextDocument): Thenable<void> {
    let uri = doc.uri;
    TRACE(`validate ${uri}`);
    let currentFile = URI.parse(doc.uri).fsPath;
    if (!textlintModule || uri.startsWith("file:") === false || !isTarget(currentFile)) {
        TRACE("validation skiped...");
        return Promise.resolve();
    }
    let conf = findConfig();
    let repo = fixrepos.get(uri);
    if (conf && repo) {
        try {
            TRACE(`configuration file is ${conf}`);
            return repo.newEngine(conf).then(engine => {
                let ext = path.extname(URI.parse(uri).fsPath);
                TRACE(`engine startd... ${ext}`);
                if (-1 < engine.availableExtensions.findIndex(s => s === ext)) {
                    repo.clear();
                    return engine.executeOnText(doc.getText(), ext)
                        .then(([results]) => {
                            return results.messages
                                .map(toDiagnostic)
                                .map(([msg, diag]) => {
                                    repo.register(doc, diag, msg);
                                    return diag;
                                });
                        }).then(diagnostics => {
                            TRACE(`sendDiagnostics ${uri}`);
                            connection.sendDiagnostics({ uri, diagnostics });
                        }, errors => sendError(errors));
                }
            });
        } catch (error) {
            return Promise.reject(error);
        }
    }
    return Promise.resolve();
}

function toDiagnosticSeverity(severity?: number): DiagnosticSeverity {
    switch (severity) {
        case 2: return DiagnosticSeverity.Error;
        case 1: return DiagnosticSeverity.Warning;
        case 0: return DiagnosticSeverity.Information;
    }
    return DiagnosticSeverity.Information;
}

function toDiagnostic(message: TextLintMessage): [TextLintMessage, Diagnostic] {
    let txt = message.ruleId ? `${message.message} (${message.ruleId})` : message.message;
    let pos_start = Position.create(Math.max(0, message.line - 1), Math.max(0, message.column - 1));
    var offset = 0;
    if (message.message.indexOf('->') >= 0) {
        offset = message.message.indexOf(' ->');
    }
    if (message.message.indexOf('"') >= 0) {
        offset = message.message.indexOf('"', message.message.indexOf('"') + 1) - 1;
    }
    let pos_end = Position.create(Math.max(0, message.line - 1), Math.max(0, message.column - 1) + offset);;
    let diag: Diagnostic = {
        message: txt,
        severity: toDiagnosticSeverity(message.severity),
        source: "textlint",
        range: Range.create(pos_start, pos_end),
        code: message.ruleId
    };
    return [message, diag];
}

connection.onCodeAction(params => {
    TRACE("onCodeAction", params);
    let result: CodeAction[] = [];
    let uri = params.textDocument.uri;
    let repo = fixrepos.get(uri);
    if (repo && repo.isEmpty() === false) {
        let doc = documents.get(uri);
        let toAction = (title, edits) => {
            let cmd = Command.create(title, "textlint.applyTextEdits", uri, repo.version, edits);
            return CodeAction.create(title, cmd, CodeActionKind.QuickFix);
        };
        let toTE = af => toTextEdit(doc, af);

        repo.find(params.context.diagnostics).forEach(af => {
            result.push(toAction(`Fix this ${af.ruleId} problem`, [toTE(af)]));
            let same = repo.separatedValues(v => v.ruleId === af.ruleId);
            if (0 < same.length) {
                result.push(toAction(`Fix all ${af.ruleId} problems`, same.map(toTE)));
            }
        });
        let all = repo.separatedValues();
        if (0 < all.length) {
            result.push(toAction(`Fix all auto-fixable problems`, all.map(toTE)));
        }
    }
    return result;
});

function toTextEdit(textDocument: TextDocument, af: AutoFix): TextEdit {
    return TextEdit.replace(
        Range.create(
            textDocument.positionAt(af.fix.range[0]),
            textDocument.positionAt(af.fix.range[1])),
        af.fix.text || "");
}

connection.onRequest(AllFixesRequest.type, (params: AllFixesRequest.Params) => {
    let uri = params.textDocument.uri;
    TRACE(`AllFixesRequest ${uri}`);
    let textDocument = documents.get(uri);
    let repo = fixrepos.get(uri);
    if (repo && repo.isEmpty() === false) {
        return {
            documentVersion: repo.version,
            edits: repo.separatedValues().map(af => toTextEdit(textDocument, af))
        };
    }
});

let inProgress = 0;
function sendStartProgress() {
    TRACE(`sendStartProgress ${inProgress}`);
    if (inProgress < 1) {
        inProgress = 0;
        connection.sendNotification(StartProgressNotification.type);
    }
    inProgress++;
}

function sendStopProgress() {
    TRACE(`sendStopProgress ${inProgress}`);
    if (--inProgress < 1) {
        inProgress = 0;
        connection.sendNotification(StopProgressNotification.type);
    }
}

function sendOK() {
    TRACE("sendOK");
    connection.sendNotification(StatusNotification.type, { status: StatusNotification.Status.OK });
}
function sendError(error) {
    TRACE(`sendError ${error}`);
    let msg = error.message ? error.message : error;
    connection.sendNotification(StatusNotification.type,
        {
            status: StatusNotification.Status.ERROR,
            message: <string>msg,
            cause: error.stack
        });
}

export function TRACE(message: string, data?: any) {
    switch (trace) {
        case Trace.Messages:
            connection.sendNotification(LogTraceNotification.type, {
                message
            });
            break;
        case Trace.Verbose:
            let verbose = "";
            if (data) {
                verbose = typeof data === "string" ? data : JSON.stringify(data);
            }
            connection.sendNotification(LogTraceNotification.type, {
                message, verbose
            });
            break;
        case Trace.Off:
            // do nothing.
            break;
        default:
            break;
    }
}

connection.listen();
