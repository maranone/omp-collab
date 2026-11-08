import type { Token } from "@oh-my-pi/pi-utils/marked";
import { Marked } from "@oh-my-pi/pi-utils/marked";
import { listMayContinueAt } from "@oh-my-pi/pi-utils/marked-list";
import type { ReactNode } from "react";
import { memo, useMemo, useRef } from "react";
import { escapeHtml } from "../../lib/format";
import { mathExtension } from "./math";

function unescapeHtml(raw: string): string {
	const parseCodePoint = (value: number): string => {
		if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
			try {
				return String.fromCodePoint(value);
			} catch {}
		}
		return "";
	};

	return raw.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (match, entity) => {
		const lower = entity.toLowerCase();
		switch (lower) {
			case "nbsp":
				return " ";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			case "amp":
				return "&";
			default: {
				if (lower.startsWith("#x")) {
					return parseCodePoint(Number.parseInt(lower.slice(2), 16));
				}
				if (lower.startsWith("#")) {
					return parseCodePoint(Number(lower.slice(1)));
				}
				return match;
			}
		}
	});
}
function safeHref(href: string): string | null {
	const trimmed = href.trim();
	let protocol: string;
	try {
		// Resolve the scheme exactly as the browser will: the URL parser strips leading
		// C0 controls and embedded tab/newline that a text check would carry through.
		({ protocol } = new URL(trimmed, "https://relative.invalid/"));
	} catch {
		return null;
	}
	if (protocol === "https:" || protocol === "http:" || protocol === "mailto:") return trimmed;
	return null; // unknown scheme (javascript:, data:, …)
}

/** Inline SVG fences larger than this fall back to a code block. */
const MAX_INLINE_SVG_CHARS = 400_000;
/** Embedded data: URIs larger than this are refused; multi-MB blobs bloat the DOM. */
const MAX_DATA_URI_CHARS = 12_000_000;

/** Classify a Markdown image/media `src` into an embeddable kind. */
function safeMediaSrc(href: string): { kind: "image" | "video"; src: string } | null {
	const trimmed = href.trim();
	if (trimmed.startsWith("data:")) {
		if (trimmed.length > MAX_DATA_URI_CHARS) return null;
		const mime = (/^data:([^;,]+)/i.exec(trimmed)?.[1] ?? "").toLowerCase();
		if (mime.startsWith("image/")) return { kind: "image", src: trimmed };
		if (mime.startsWith("video/")) return { kind: "video", src: trimmed };
		return null; // data:text/html, data:script, …
	}
	let protocol: string;
	try {
		({ protocol } = new URL(trimmed, "https://relative.invalid/"));
	} catch {
		return null;
	}
	if (protocol !== "https:" && protocol !== "http:") return null;
	if (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(trimmed)) return { kind: "video", src: trimmed };
	return { kind: "image", src: trimmed };
}

/** Magic-number sniff for raw base64 image payloads; defaults to PNG. */
function sniffImageMime(b64: string): string {
	if (b64.startsWith("/9j/")) return "image/jpeg";
	if (b64.startsWith("R0lGOD")) return "image/gif";
	if (b64.startsWith("UklGR")) return "image/webp";
	if (b64.startsWith("PHN2Zw")) return "image/svg+xml";
	return "image/png";
}

/** Turn a fenced media body (bare base64 or a full data: URI) into a usable src. */
function fencedMediaSrc(body: string, lang: string): string | null {
	const trimmed = body.trim();
	if (trimmed.startsWith("data:")) {
		const mime = (/^data:([^;,]+)/i.exec(trimmed)?.[1] ?? "").toLowerCase();
		const ok = lang === "svg" ? mime.startsWith("image/svg") : /^(image|video)\//.test(mime);
		return ok && trimmed.length <= MAX_DATA_URI_CHARS ? trimmed : null;
	}
	if (!/^[A-Za-z0-9+/]+[\s\r\n]*[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) return null;
	const b64 = trimmed.replace(/\s/g, "");
	if (b64.length > MAX_DATA_URI_CHARS) return null;
	if (lang === "image" || lang === "img") return `data:${sniffImageMime(b64)};base64,${b64}`;
	if (lang === "webm") return `data:video/webm;base64,${b64}`;
	if (lang === "mov") return `data:video/quicktime;base64,${b64}`;
	return `data:video/mp4;base64,${b64}`;
}

/** Structural SVG elements the inline sanitizer keeps; anything else is unwrapped. */
const SVG_ALLOWED: Record<string, true> = {
	svg: true, g: true, a: true, path: true, rect: true, circle: true, ellipse: true,
	line: true, polyline: true, polygon: true, text: true, tspan: true, textpath: true,
	defs: true, use: true, symbol: true, marker: true, clippath: true, mask: true,
	pattern: true, lineargradient: true, radialgradient: true, stop: true, filter: true,
	fegaussianblur: true, feoffset: true, feblend: true, fecolormatrix: true,
	femergenode: true, femerge: true, feflood: true, fecomposite: true, fedropshadow: true,
	image: true, title: true, desc: true, style: true,
};
/** Elements whose whole subtree is deleted (script execution / plugin vectors). */
const SVG_DROPPED = [
	"script", "foreignObject", "iframe", "object", "embed", "applet", "audio", "video",
	"animate", "animateTransform", "animateMotion", "set", "handler", "listener",
];

function stripSvgDanger(raw: string): string {
	let s = raw
		.replace(/<!--[\s\S]*?(?:-->|$)/g, "")
		.replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, "")
		.replace(/<\?[\s\S]*?(?:\?>|$)/g, "")
		.replace(/<!doctype[^>]*>?/gi, "")
		.replace(/<!entity[\s\S]*?(?:>|$)/gi, "");
	for (const name of SVG_DROPPED) {
		s = s.replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}\\s*>`, "gi"), "");
		s = s.replace(new RegExp(`<${name}\\b[^>]*/?>`, "gi"), "");
	}
	// A <style> block reaching outward (external refs, CSS expressions) is deleted whole.
	return s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, block =>
		/url\s*\(|@import|expression|javascript|<\//i.test(block) ? "" : block,
	);
}

function cleanSvgAttrs(attrs: string): string {
	const kept: string[] = [];
	const pair = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
	for (const match of attrs.matchAll(pair)) {
		const name = match[1];
		const raw = match[2];
		if (!name || /^on/i.test(name)) continue; // event handlers never survive
		if (raw === undefined) continue; // valueless attributes carry nothing SVG needs
		const value = raw.replace(/^["']|["']$/g, "");
		const lname = name.toLowerCase();
		if (lname === "href" || lname === "xlink:href") {
			// Internal fragment references and inline images only; no external fetches.
			if (/^#/i.test(value) || /^data:image\//i.test(value)) kept.push(`${name}="${escapeHtml(value)}"`);
			continue;
		}
		if (lname === "src") {
			if (/^data:image\//i.test(value)) kept.push(`${name}="${escapeHtml(value)}"`);
			continue;
		}
		if (lname === "style") {
			if (!/url\s*\(|expression|behavior|javascript|@import/i.test(value)) kept.push(`style="${escapeHtml(value)}"`);
			continue;
		}
		kept.push(`${name}="${escapeHtml(value)}"`);
	}
	return kept.length ? ` ${kept.join(" ")}` : "";
}

/**
 * Rebuild an SVG string from an allowlist of elements and attributes. Returns null
 * when the result could not be parsed into only-whitelisted markup (unbalanced
 * quotes, stray `<`), so the caller keeps it as a code block instead.
 */
function sanitizeSvg(raw: string): string | null {
	let s = stripSvgDanger(raw);
	s = s.replace(
		/<(\/?)([A-Za-z][A-Za-z0-9:._-]*)((?:"[^"]*"|'[^']*'|[^<>"'])*?)(\/?)>/g,
		(_all, close: string, tag: string, attrs: string, self: string) => {
			const local = (tag.includes(":") ? tag.slice(tag.indexOf(":") + 1) : tag).toLowerCase();
			if (!SVG_ALLOWED[local]) return ""; // unwrap non-whitelisted markup
			if (close) return `</${tag}>`;
			return `<${tag}${cleanSvgAttrs(attrs)}${self ? " /" : ""}>`;
		},
	);
	// Anything still holding a `<` came from a malformed tag (unterminated quote
	// swallowing markup); refuse the whole fence rather than trust the remnant.
	if (s.replace(/<\/?[A-Za-z][A-Za-z0-9:._-]*(?:"[^"]*"|'[^']*'|[^<>])*?>/g, "").includes("<")) return null;
	if (!/<svg\b/i.test(s)) return null;
	return s.trim();
}

const md = new Marked({
	gfm: true,
	renderer: {
		// Raw HTML tokens (block + inline both arrive here) are escaped, never emitted.
		html({ text }) {
			const cleaned = text.replace(/<\/?(?:advisory|span|text)\b(?:\s[^>]*)?\s*\/?>/gi, "");
			if (cleaned === "") return "";
			return escapeHtml(unescapeHtml(cleaned));
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const url = safeHref(href);
			if (url === null) return inner;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener">${inner}</a>`;
		},
		// Media fences: ```svg renders inline (sanitized), ```mp4/```video/```image
		// embed data-URI players, everything else keeps the default code block.
		code(token) {
			const text = token.text;
			const lang = (token.lang ?? "").match(/^\S*/)?.[0].toLowerCase() ?? "";
			if (lang === "svg" && text.length <= MAX_INLINE_SVG_CHARS) {
				const clean = sanitizeSvg(text);
				if (clean !== null) return `<div class="tr-svg">${clean}</div>\n`;
			}
			if (lang === "mp4" || lang === "webm" || lang === "mov" || lang === "m4v" || lang === "video") {
				const src = fencedMediaSrc(text, lang);
				if (src !== null) return `<video class="tr-video" controls preload="metadata" src="${escapeHtml(src)}"></video>\n`;
			}
			if (lang === "image" || lang === "img") {
				const src = fencedMediaSrc(text, lang);
				if (src !== null) return `<img class="tr-img" alt="" src="${escapeHtml(src)}">\n`;
			}
			const code = token.escaped ? text : escapeHtml(text);
			const language = (token.lang ?? "").match(/^\S*/)?.[0] ?? "";
			return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${code}${text.endsWith("\n") ? "" : "\n"}</code></pre>\n`;
		},
		// Markdown media: data: images/videos and http(s) media URLs embed inline;
		// other schemes collapse to the alt text, like unsafe links do.
		image({ href, title, text }) {
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			const media = safeMediaSrc(href ?? "");
			if (media?.kind === "video") return `<video class="tr-video" controls preload="metadata" src="${escapeHtml(media.src)}"${titleAttr}></video>`;
			if (media?.kind === "image") return `<img class="tr-img" src="${escapeHtml(media.src)}" alt="${escapeHtml(text ?? "")}"${titleAttr}>`;
			return escapeHtml(text ?? "");
		},
	},
	breaks: true,
});
md.use(mathExtension);

function renderMarkdown(text: string): string {
	try {
		return md.parse(text, { async: false });
	} catch {
		return escapeHtml(text);
	}
}

export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
	const html = useMemo(() => renderMarkdown(text), [text]);
	return <div className="tr-md" dangerouslySetInnerHTML={{ __html: html }} />;
});

/**
 * Rendered leading blocks of a streaming text: `source` is the (tab-expanded)
 * text they cover, ending on a stable block boundary, and `html` their markup.
 */
export interface FrozenMarkdownPrefix {
	readonly source: string;
	readonly html: string;
}

const NO_PREFIX: FrozenMarkdownPrefix = { source: "", html: "" };

/**
 * An own-line display-math opener. A closer appended later turns the text from
 * it on into one block across blank lines, so nothing at or past it freezes.
 */
const MATH_OPENER_LINE = /^ {0,3}(?:\$\$|\\\[)[ \t]*$/m;
/** A whitespace-only line from the sticky offset, capturing its terminator ("\n", or "" at end of text). */
const WHITESPACE_LINE = /[^\S\n]*(\n|$)/y;

/**
 * Number of leading `tokens` (lexed from `src`) that end on a stable block
 * boundary: a blank-line break that no append to `src` can move, so that
 * `lex(src) = lex(head) ++ lex(tail)` for the current text and every
 * append-only extension of it. 0 when there is none.
 */
function stableTokenCount(src: string, tokens: readonly Token[]): { count: number; end: number } {
	const opener = MATH_OPENER_LINE.exec(src);
	const mathLimit = opener === null ? src.length : opener.index;
	let pos = 0;
	let count = 0;
	let end = 0;
	for (let i = 0; i < tokens.length; i++) {
		const raw = tokens[i]!.raw;
		const tokenEnd = pos + raw.length;
		if (tokenEnd > mathLimit) break;
		// The break must be followed by real block content: at end of text the
		// next line is unknown; a leading space or newline, or a line of other
		// whitespace, joins the blank run in front of the cut.
		if (raw.endsWith("\n\n") && tokenEnd < src.length) {
			const next = src.charCodeAt(tokenEnd);
			WHITESPACE_LINE.lastIndex = tokenEnd;
			const prev = i > 0 ? tokens[i - 1] : undefined;
			if (
				next !== 0x20 &&
				next !== 0x0a &&
				WHITESPACE_LINE.exec(src) === null &&
				(prev?.type !== "list" || !listMayContinueAt(src, tokenEnd, prev.raw))
			) {
				count = i + 1;
				end = tokenEnd;
			}
		}
		pos = tokenEnd;
	}
	return { count, end };
}

/**
 * Renders streaming Markdown `text`, reusing `prefix` (the result of the
 * previous call for an earlier version of the text) when `text` extends it.
 * Only the text after the prefix is lexed and parsed; blocks of it that end on
 * a stable boundary join the returned prefix. The markup equals
 * `md.parse(text)` byte for byte: anything the split cannot reproduce exactly
 * (reference definitions, carriage returns) renders the whole text instead.
 */
export function renderStreamingMarkdown(
	text: string,
	prefix: FrozenMarkdownPrefix,
): { html: string; prefix: FrozenMarkdownPrefix } {
	// `\r` rewrites line structure under marked's normalization; bail out.
	if (text.includes("\r")) return { html: renderMarkdown(text), prefix: NO_PREFIX };
	// Tabs expand to four spaces (as marked's own normalization does), so token
	// raws tile `src` exactly.
	const src = text.includes("\t") ? text.replaceAll("\t", "    ") : text;
	const base = src.length > prefix.source.length && src.startsWith(prefix.source) ? prefix : NO_PREFIX;
	const rest = base.source.length === 0 ? src : src.slice(base.source.length);
	try {
		const tokens = md.lexer(rest);
		// A reference definition resolves links anywhere, including the frozen
		// prefix, which was lexed without it; with no prefix, `tokens` already
		// lexed the whole text with its definitions.
		for (const _label in tokens.links) {
			return { html: base === NO_PREFIX ? md.parser(tokens) : renderMarkdown(text), prefix: NO_PREFIX };
		}
		const { count, end } = stableTokenCount(rest, tokens);
		if (count === 0) return { html: base.html + md.parser(tokens), prefix: base };
		const frozen: FrozenMarkdownPrefix = {
			source: src.slice(0, base.source.length + end),
			html: base.html + md.parser(tokens.slice(0, count)),
		};
		return { html: frozen.html + md.parser(tokens.slice(count)), prefix: frozen };
	} catch {
		return { html: renderMarkdown(text), prefix: NO_PREFIX };
	}
}

/**
 * {@link Markdown} for a block that is still streaming: settled leading
 * blocks are rendered once and reused, so each token re-parses only the open
 * tail instead of the whole growing block. Output is identical to
 * {@link Markdown} for the same text.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }): ReactNode {
	const prefixRef = useRef(NO_PREFIX);
	const html = useMemo(() => {
		const rendered = renderStreamingMarkdown(text, prefixRef.current);
		prefixRef.current = rendered.prefix;
		return rendered.html;
	}, [text]);
	return <div className="tr-md" dangerouslySetInnerHTML={{ __html: html }} />;
});
