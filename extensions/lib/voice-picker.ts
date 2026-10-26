import { stripVTControlCharacters } from "node:util";
import { Input, Key, matchesKey, SelectList, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { filterVoices, voiceSearchIndex, voiceUnavailableReason, type VoiceItem } from "./voice-catalog.ts";

const clean = (s: string) => stripVTControlCharacters(s).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 256);
/** Local indexed search; no API or configuration operations occur while typing. */
export class VoicePickerComponent implements Component, Focusable {
	private readonly input = new Input({ prompt: "搜索: ", placeholder: "名称 / ID / 引擎（空格分词）" });
	private list!: SelectList;
	private readonly voices: VoiceItem[];
	private readonly index: string[];
	private readonly theme: any;
	private readonly redraw: () => void;
	private readonly done: (id: string | undefined) => void;
	private readonly maxVisible: number;
	private matched = 0;
	get focused(): boolean { return this.input.focused; }
	set focused(value: boolean) { this.input.focused = value; }
	constructor(voices: VoiceItem[], query: string, theme: any, redraw: () => void, done: (id: string | undefined) => void, maxVisible = 10) {
		this.voices = voices; this.index = voiceSearchIndex(voices); this.theme = theme; this.redraw = redraw; this.done = done; this.maxVisible = Math.max(2, Math.min(10, maxVisible));
		this.input.setValue(query.slice(0, 256)); this.update();
	}
	private update(): void {
		const matches = filterVoices(this.voices, this.input.getValue(), this.index);
		this.matched = matches.length;
		this.list = new SelectList(matches.map(v => ({ value: v.id, label: clean(`${v.name} · ${v.id}`), description: clean(`${v.engine ?? "引擎未知"}${voiceUnavailableReason(v) ? ` · 不可选：${voiceUnavailableReason(v)}` : ""}`) })), this.maxVisible, {
			selectedPrefix: (s: string) => this.theme.fg("accent", s), selectedText: (s: string) => this.theme.fg("accent", s), description: (s: string) => this.theme.fg("dim", s), scrollInfo: (s: string) => this.theme.fg("dim", s), noMatch: () => this.theme.fg("warning", "无匹配音色；请修改关键词"),
		});
		this.list.onSelect = item => this.done(item.value);
		this.list.onCancel = () => this.done(undefined);
	}
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) { this.done(undefined); return; }
		if ([Key.up, Key.down, Key.pageUp, Key.pageDown, Key.enter].some(key => matchesKey(data, key))) this.list.handleInput(data);
		else {
			const old = this.input.getValue(); this.input.handleInput(data);
			if (this.input.getValue().length > 256) this.input.setValue(this.input.getValue().slice(0, 256));
			if (old !== this.input.getValue()) this.update();
		}
		this.redraw();
	}
	invalidate(): void { this.input.invalidate(); this.list.invalidate(); }
	render(width: number): string[] {
		width = Math.max(1, width);
		return [this.theme.fg("accent", "选择默认音色"), ...this.input.render(width), this.theme.fg("dim", `匹配 ${this.matched} / ${this.voices.length} · 已实时获取目录`), ...this.list.render(width), this.theme.fg("dim", "↑↓ 选择 · Enter 在线确认并保存 · Esc 不更改"), this.theme.fg("dim", "仅选择音色，不开启语音、不试听；当前在途发音不受影响")].map(line => truncateToWidth(line, width));
	}
}
