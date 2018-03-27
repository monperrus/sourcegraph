import {
    ReferenceInformation,
    SymbolLocationInformation,
    WorkspaceReferenceParams,
} from 'javascript-typescript-langserver/lib/request-type'
import { Observable } from 'rxjs/Observable'
import { ajax } from 'rxjs/observable/dom/ajax'
import { AjaxResponse } from 'rxjs/observable/dom/AjaxObservable'
import { ErrorObservable } from 'rxjs/observable/ErrorObservable'
import { catchError } from 'rxjs/operators/catchError'
import { map } from 'rxjs/operators/map'
import { Definition, Hover, Location, MarkedString } from 'vscode-languageserver-types'
import { DidOpenTextDocumentParams, InitializeResult, ServerCapabilities } from 'vscode-languageserver/lib/main'
import { AbsoluteRepo, AbsoluteRepoFile, AbsoluteRepoFilePosition, makeRepoURI, parseRepoURI } from '../repo'
import { siteFlags } from '../site/backend'
import { getModeFromExtension, getPathExtension, supportedExtensions } from '../util'
import { normalizeAjaxError } from '../util/errors'
import { memoizeObservable } from '../util/memoize'
import { toAbsoluteBlobURL, toPrettyBlobURL } from '../util/url'

interface LSPRequest {
    method: string
    params?: any
}

export const isEmptyHover = (hover: any): boolean =>
    !hover || !hover.contents || (Array.isArray(hover.contents) && hover.contents.length === 0)

/** Returns the first MarkedString element from the hover, or undefined if it has none. */
export function firstMarkedString(hover: Hover): MarkedString | undefined {
    if (typeof hover.contents === 'string') {
        return hover.contents
    } else if (Array.isArray(hover.contents)) {
        return hover.contents[0]
    }
    return hover.contents.value
}

const wrapLSPRequests = (ctx: AbsoluteRepo, path: string, requests: LSPRequest[]): any[] => [
    {
        id: 0,
        method: 'initialize',
        params: {
            // TODO(sqs): rootPath is deprecated but xlang client proxy currently
            // requires it. Pass rootUri as well (below) for forward compat.
            rootPath: `git://${ctx.repoPath}?${ctx.commitID}`,

            rootUri: `git://${ctx.repoPath}?${ctx.commitID}`,
            mode: `${getModeFromExtension(getPathExtension(path))}`,
        },
    },
    ...requests.map((req, i) => ({ id: i + 1, ...req })),
    {
        id: 1 + requests.length,
        method: 'shutdown',
    },
    {
        // id not included on notifications
        method: 'exit',
    },
]

/** LSP proxy error code for unsupported modes */
export const EMODENOTFOUND = -32000

/**
 * A static list of what is supported on Sourcegraph.com. However, on-prem instances may support
 * less so we prevent future requests after the first mode not found response.
 */
const unsupportedExtensions = new Set<string>()

const isSupported = (path: string): boolean => {
    const ext = getPathExtension(path)
    return supportedExtensions.has(ext) && !unsupportedExtensions.has(ext)
}

// TODO(sqs): This is a messy global var. Refactor this code after
// https://github.com/sourcegraph/sourcegraph/pull/8893 is merged.
let siteHasCodeIntelligence = false

siteFlags.subscribe(v => (siteHasCodeIntelligence = v && v.hasCodeIntelligence))

let loggedSiteHasNoCodeIntelligence = false

const sendLSPRequests = (ctx: AbsoluteRepo, path: string, ...requests: LSPRequest[]): Observable<any> => {
    if (!siteHasCodeIntelligence) {
        if (!loggedSiteHasNoCodeIntelligence) {
            console.log(
                '✱ Visit https://about.sourcegraph.com to enable code intelligence on this server (for hovers, go-to-definition, find references, etc.).'
            )
            loggedSiteHasNoCodeIntelligence = true
        }
        return ErrorObservable.create(
            Object.assign(new Error('Code intelligence is not enabled'), {
                code: EMODENOTFOUND,
            })
        )
    }

    if (!isSupported(path)) {
        return ErrorObservable.create(Object.assign(new Error('Language not supported'), { code: EMODENOTFOUND }))
    }

    return ajax({
        method: 'POST',
        url: `/.api/xlang/${requests.map(({ method }) => method).join(',')}`,
        headers: {
            ...window.context.xhrHeaders,
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(wrapLSPRequests(ctx, path, requests)),
    }).pipe(
        catchError<AjaxResponse, never>(err => {
            normalizeAjaxError(err)
            throw err
        }),
        map(({ response }) => response),
        map(results => {
            for (const result of results) {
                if (result && result.error) {
                    if (result.error.code === EMODENOTFOUND) {
                        unsupportedExtensions.add(getPathExtension(path))
                    }
                    throw Object.assign(new Error(result.error.message), result.error)
                }
            }

            return results.map((result: any) => result && result.result)
        })
    )
}

/**
 * Sends an LSP request to the xlang API.
 * If an error is returned, the Promise is rejected with the error from the response.
 *
 * @param req The LSP request to send
 * @param ctx Repo and revision
 * @param path File path for determining the mode
 * @return The result of the method call
 */
const sendLSPRequest = (req: LSPRequest, ctx: AbsoluteRepo, path: string): Observable<any> =>
    sendLSPRequests(ctx, path, req).pipe(map(results => results[1]))

export const fetchServerCapabilities = memoizeObservable(
    (pos: AbsoluteRepoFile): Observable<ServerCapabilities> =>
        sendLSPRequests(pos, pos.filePath, {
            method: 'textDocument/didOpen',
            params: {
                textDocument: {
                    uri: `git://${pos.repoPath}?${pos.commitID}#${pos.filePath}`,
                },
            } as DidOpenTextDocumentParams,
        }).pipe(map(results => (results[0] as InitializeResult).capabilities)),
    makeRepoURI
)

export const fetchHover = memoizeObservable(
    (pos: AbsoluteRepoFilePosition): Observable<Hover> =>
        sendLSPRequest(
            {
                method: 'textDocument/hover',
                params: {
                    textDocument: {
                        uri: `git://${pos.repoPath}?${pos.commitID}#${pos.filePath}`,
                    },
                    position: {
                        character: pos.position.character! - 1,
                        line: pos.position.line - 1,
                    },
                },
            },
            pos,
            pos.filePath
        ),
    makeRepoURI
)

export const fetchDefinition = memoizeObservable(
    (options: AbsoluteRepoFilePosition): Observable<Definition> =>
        sendLSPRequest(
            {
                method: 'textDocument/definition',
                params: {
                    textDocument: {
                        uri: `git://${options.repoPath}?${options.commitID}#${options.filePath}`,
                    },
                    position: {
                        character: options.position.character! - 1,
                        line: options.position.line - 1,
                    },
                },
            },
            options,
            options.filePath
        ),
    makeRepoURI
)

export function fetchJumpURL(options: AbsoluteRepoFilePosition): Observable<string | null> {
    return fetchDefinition(options).pipe(
        map(def => {
            const defArray = Array.isArray(def) ? def : [def]
            def = defArray[0]
            if (!def) {
                return null
            }

            const uri = parseRepoURI(def.uri) as AbsoluteRepoFilePosition
            uri.position = { line: def.range.start.line + 1, character: def.range.start.character + 1 }
            if (uri.repoPath === options.repoPath && uri.commitID === options.commitID) {
                // Use pretty rev from the current context for same-repo J2D.
                uri.rev = options.rev
                return toPrettyBlobURL(uri)
            }
            return toAbsoluteBlobURL(uri)
        })
    )
}

export const fetchXdefinition = memoizeObservable(
    (options: AbsoluteRepoFilePosition): Observable<SymbolLocationInformation | undefined> =>
        sendLSPRequest(
            {
                method: 'textDocument/xdefinition',
                params: {
                    textDocument: {
                        uri: `git://${options.repoPath}?${options.commitID}#${options.filePath}`,
                    },
                    position: {
                        character: options.position.character! - 1,
                        line: options.position.line - 1,
                    },
                },
            },
            options,
            options.filePath
        ).pipe(map((result: SymbolLocationInformation[]) => result[0])),
    makeRepoURI
)

export const fetchReferences = memoizeObservable(
    (options: AbsoluteRepoFilePosition & { includeDeclaration?: boolean }): Observable<Location[]> =>
        sendLSPRequest(
            {
                method: 'textDocument/references',
                params: {
                    textDocument: {
                        uri: `git://${options.repoPath}?${options.commitID}#${options.filePath}`,
                    },
                    position: {
                        character: options.position.character! - 1,
                        line: options.position.line - 1,
                    },
                    context: {
                        includeDeclaration: options.includeDeclaration !== false, // undefined means true
                    },
                },
            },
            options,
            options.filePath
        ),
    makeRepoURI
)

export const queryImplementation = memoizeObservable(
    (options: AbsoluteRepoFilePosition): Observable<Location[]> =>
        sendLSPRequest(
            {
                method: 'textDocument/implementation',
                params: {
                    textDocument: {
                        uri: `git://${options.repoPath}?${options.commitID}#${options.filePath}`,
                    },
                    position: {
                        character: options.position.character! - 1,
                        line: options.position.line - 1,
                    },
                },
            },
            options,
            options.filePath
        ),
    makeRepoURI
)

interface XReferenceOptions extends WorkspaceReferenceParams, AbsoluteRepoFile {
    /**
     * This is not in the spec, but Go and possibly others support it
     * https://github.com/sourcegraph/go-langserver/blob/885ad3639de0e1e6c230db5395ea0f682534b458/pkg/lspext/lspext.go#L32
     */
    limit: number
}

export const fetchXreferences = memoizeObservable(
    (options: XReferenceOptions): Observable<Location[]> =>
        sendLSPRequest(
            {
                method: 'workspace/xreferences',
                params: {
                    hints: options.hints,
                    query: options.query,
                    limit: options.limit,
                },
            },
            { repoPath: options.repoPath, commitID: options.commitID },
            options.filePath
        ).pipe(map((refInfos: ReferenceInformation[]) => refInfos.map(refInfo => refInfo.reference))),
    options => makeRepoURI(options) + ':' + JSON.stringify([options.query, options.hints, options.limit])
)
