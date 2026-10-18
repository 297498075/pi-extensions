import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

interface StatusModalOptions {
	maxWidth?: number;
	maxHeight?: number;
	heightMargin?: number;
	center?: boolean;
}

/** A read-only, scrollable frame; neither a minimum width nor string length can overflow the viewport. */
export class StatusModalComponent implements Component {
	private offset = 0;
	private pageSize = 1;
	private maxOffset = 0;

	private readonly tui: { terminal?: { rows?: number }; requestRender?: () => void };
	private readonly theme: Pick<Theme, "fg">;
	private readonly title: string;
	private readonly lines: string[] | (() => string[]);
	private readonly onClose: () => void;
	private readonly options: StatusModalOptions;

	constructor(
		tui: { terminal?: { rows?: number }; requestRender?: () => void },
		theme: Pick<Theme, "fg">,
		title: string,
		lines: string[] | (() => string[]),
		onClose: () => void,
		options: StatusModalOptions = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.title = title;
		this.lines = lines;
		this.onClose = onClose;
		this.options = options;
	}

	render(width: number): string[] {
		if (width < 1) return [];
		const columns = Math.floor(width);
		const rows = Math.max(1, Math.floor(this.tui.terminal?.rows ?? 24));
		const boxWidth = Math.max(1, Math.min(columns, this.options.maxWidth ?? columns));
		const height = Math.max(1, Math.min(rows, this.options.maxHeight ?? rows) - (this.options.heightMargin ?? 0));
		const framed = boxWidth >= 5 && height >= 3;
		const contentWidth = framed ? boxWidth - 4 : boxWidth;
		const source = typeof this.lines === "function" ? this.lines() : this.lines;
		const body = source.flatMap(line => wrapTextWithAnsi(line, contentWidth))
			.map(line => truncateToWidth(line, contentWidth));
		this.pageSize = Math.max(1, height - (framed ? 2 : 0));
		this.maxOffset = Math.max(0, body.length - this.pageSize);
		this.offset = Math.max(0, Math.min(this.offset, this.maxOffset));

		const frame: string[] = [];
		const title = truncateToWidth(this.title, contentWidth);
		if (framed) frame.push(this.theme.fg("accent", `┌ ${title} ${"─".repeat(Math.max(0, contentWidth - visibleWidth(title)))}┐`));
		for (const line of body.slice(this.offset, this.offset + this.pageSize)) {
			frame.push(framed ? `│ ${line}${" ".repeat(Math.max(0, contentWidth - visibleWidth(line)))} │` : line);
		}
		if (framed) {
			const hint = truncateToWidth(this.maxOffset > 0 ? "↑/↓ · PgUp/PgDn scroll · Enter/Esc close" : "Enter/Esc/click close", contentWidth);
			frame.push(this.theme.fg("muted", `└ ${hint} ${"─".repeat(Math.max(0, contentWidth - visibleWidth(hint)))}┘`));
		}
		const left = this.options.center ? Math.max(0, Math.floor((columns - boxWidth) / 2)) : 0;
		const top = this.options.center ? Math.max(0, Math.floor((rows - frame.length) / 2)) : 0;
		return [
			...Array.from({ length: top }, () => ""),
			...frame.map(line => truncateToWidth(" ".repeat(left) + line, columns)),
		];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
		else if (matchesKey(data, "down")) this.offset = Math.min(this.maxOffset, this.offset + 1);
		else if (matchesKey(data, Key.pageUp)) this.offset = Math.max(0, this.offset - this.pageSize);
		else if (matchesKey(data, Key.pageDown)) this.offset = Math.min(this.maxOffset, this.offset + this.pageSize);
		else if (matchesKey(data, Key.home)) this.offset = 0;
		else if (matchesKey(data, Key.end)) this.offset = this.maxOffset;
		else { this.onClose(); return; }
		this.tui.requestRender?.();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "click") { this.onClose(); return { handled: true }; }
		if (event.type === "wheel") {
			this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + (event.wheelDelta ?? 0)));
			this.tui.requestRender?.();
			return { handled: true };
		}
		return undefined;
	}
}

/** Read-only status must remain visible even when transcript notifications are muted. */
export async function showStatusModal(ctx: ExtensionContext, title: string, lines: string[]): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui?.custom) {
		ctx.ui?.notify?.([title, ...lines].join("\n"), "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keys, done) =>
		new StatusModalComponent(tui, theme, title, lines, () => done(), { heightMargin: 6 }),
		{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } },
	);
}
