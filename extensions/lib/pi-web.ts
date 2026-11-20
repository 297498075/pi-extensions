import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** pi-web binds extensions in RPC mode; other RPC clients need not support command: statuses. */
export function isPiWebHost(ctx: Pick<ExtensionContext, "mode">): boolean {
	if (ctx.mode !== "rpc") return false;
	const host = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
	return host.__piWebHttpDispatcherConfigured === true || host[Symbol.for("pi-web.agentEventStreamInfos")] !== undefined
		|| Boolean(process.env.PI_WEB_HOSTNAME || process.env.PI_WEB_PASSWORD);
}

/** A stable widget key gives pi-web a local expand/collapse button, even during a prompt. */
export function webShelfWidget(key: string) {
	let previous: string | undefined;
	return (ctx: ExtensionContext, lines?: string[]): void => {
		const snapshot = lines?.join("\n");
		if (snapshot === previous) return;
		ctx.ui.setWidget(key, lines);
		previous = snapshot;
	};
}

/** Cost and RPC size stay bounded even when a tool produced megabytes of output. */
export function webSnippet(value: string, limit = 160): string {
	const prefix = value.slice(0, limit * 4);
	const text = stripVTControlCharacters(prefix).replace(/[\s\x00-\x1f\x7f-\x9f]+/g, " ").trim();
	return text.length > limit || prefix.length < value.length ? text.slice(0, limit - 1) + "…" : text;
}

/** pi-web renders select options as Markdown. Keep tool arguments and task subjects literal. */
function optionText(text: string): string {
	const singleLine = stripVTControlCharacters(text).replace(/\s+/g, " ").trim();
	const short = singleLine.length > 120 ? `${singleLine.slice(0, 119)}…` : singleLine;
	return short.replace(/[\\`*_{}\[\]()<>#!~|&]/g, "\\$&");
}

/** Literal text nodes inside a single raw HTML block. Physical blank lines would restart Markdown parsing. */
export function webText(value: string): string {
	return stripVTControlCharacters(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/[\\`$]/g, c => `&#${c.charCodeAt(0)};`).replace(/\r\n?|\n/g, "&#10;");
}

/** label is plain text; body is markup assembled by the extension from escaped text nodes. */
export function webDisclosure(label: string, body: string, open = false): string {
	return `<details${open ? " open" : ""}><summary>${webText(label)}</summary>${body}</details>`;
}

/** The dialog header doesn't scroll. Keep actions reachable on phones; put long, literal text in the scrollable body. */
export async function selectWebActions(ctx: ExtensionContext, text: string, actions: string[], signal?: AbortSignal): Promise<string | undefined> {
	const plain = stripVTControlCharacters(text);
	const preview = plain.split("\n", 4).join("\n").slice(0, 180);
	if (preview === plain) return ctx.ui.select(plain, actions, { signal });
	const more = "Read full text";
	while (!signal?.aborted) {
		const choice = await ctx.ui.select(preview + "…", [more, ...actions], { signal });
		if (choice !== more || signal?.aborted) return choice;
		// confirm's body is Markdown; indentation makes even embedded images/links inert code.
		if (!await ctx.ui.confirm("Full text · Confirm to return to the menu", plain.replace(/^/gm, "    "), { signal })) break;
	}
	return undefined;
}

interface WebPage<T> {
	body: (rows: readonly T[]) => string;
	label: (row: T) => string;
	pageSize: number;
	edit?: (row: T, signal: AbortSignal) => Promise<boolean>;
}

/** Confirm bodies are interactive Markdown; select options are inert. Only paging and edits need a menu. */
export class WebItemBrowser {
	private controller?: AbortController;

	close(): void {
		this.controller?.abort();
		this.controller = undefined;
	}

	async open<T>(ctx: ExtensionContext, title: string, items: () => readonly T[], { body, label, pageSize, edit }: WebPage<T>): Promise<void> {
		if (this.controller || !ctx.hasUI || !ctx.ui?.confirm) return;
		const controller = this.controller = new AbortController();
		const { signal } = controller;
		const size = Math.max(1, Math.min(50, Math.floor(pageSize) || 10));
		let page = 0;
		try {
			while (!signal.aborted) {
				const all = items();
				const pages = Math.max(1, Math.ceil(all.length / size));
				page = Math.min(page, pages - 1);
				const start = page * size;
				const rows = all.slice(start, start + size);
				const heading = `${title} · ${all.length ? `${page + 1}/${pages}` : "Empty"}`;
				const view = (selection: readonly T[], hint: string) => ctx.ui.confirm(heading + hint,
					selection.length ? `<div>${body(selection)}</div>` : "No entries yet.", { signal });
				if (pages === 1) {
					const hint = edit && rows.length ? " · Confirm to edit a task, Cancel to close" : "";
					if (!await view(rows, hint) || signal.aborted || !edit || !rows.length) break;
				}
				// For multi-page data the index is the first dialog. Paging never needs confirmation.
				const labels = rows.map((row, i) => `${start + i + 1} · ${optionText(label(row))}`);
				const options = [...(page + 1 < pages ? ["Next page"] : []), ...(page ? ["Previous page"] : []),
					...(pages > 1 ? ["View this page"] : []), ...labels, pages === 1 ? "Back to view" : "Close"];
				const choice = await ctx.ui.select(heading, options, { signal });
				if (signal.aborted || choice === undefined || choice === "Close") break;
				if (choice === "Back to view") continue;
				if (choice === "Previous page" && page > 0) { page--; continue; }
				if (choice === "Next page" && page + 1 < pages) { page++; continue; }
				const index = labels.indexOf(choice);
				if (choice === "View this page" || (!edit && index >= 0)) {
					if (!await view(index >= 0 ? [rows[index]] : rows, " · Confirm to return to index")) break;
				} else if (!edit || index < 0 || !await edit(rows[index], signal)) break;
			}
		} finally {
			if (this.controller === controller) this.controller = undefined;
		}
	}
}
