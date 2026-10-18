import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Read-only status must remain visible even when transcript notifications are muted. */
export async function showStatusModal(ctx: ExtensionContext, title: string, lines: string[]): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui?.custom) {
		ctx.ui?.notify?.([title, ...lines].join("\n"), "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		let offset = 0;
		let pageSize = 1;
		let maxOffset = 0;
		return {
			render(width: number): string[] {
				const innerWidth = Math.max(1, width - 4);
				const body = lines.flatMap(line => wrapTextWithAnsi(line, innerWidth));
				pageSize = Math.max(1, (tui.terminal.rows || 24) - 8);
				maxOffset = Math.max(0, body.length - pageSize);
				offset = Math.max(0, Math.min(offset, maxOffset));
				return [
					theme.fg("accent", `┌ ${title} ${"─".repeat(Math.max(0, innerWidth - 2))}`),
					...body.slice(offset, offset + pageSize).map(line => `│ ${line}`),
					theme.fg("muted", "└ ↑/↓ scroll · Enter/Esc close"),
				].map(line => truncateToWidth(line, Math.max(1, width)));
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
				else if (matchesKey(data, "down")) offset = Math.min(maxOffset, offset + 1);
				else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - pageSize);
				else if (matchesKey(data, Key.pageDown)) offset = Math.min(maxOffset, offset + pageSize);
				else { done(); return; }
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } });
}
