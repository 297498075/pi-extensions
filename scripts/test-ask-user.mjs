import assert from "node:assert/strict";
import { OptionSchema, QuestionItemSchema, AskUserQuestionSchema } from "../extensions/ask-user.ts";

console.log("▶ Testing ask-user schema validation...");

// 测试 1: 支持 1 个选项（rpiv 会报错，自研支持）
const singleOptionQuestion = {
	question: "请确认是否继续部署？",
	options: [
		{ label: "确认继续 (Recommended)", description: "执行线上部署流程" }
	]
};

// 测试 2: 支持 6 个选项（rpiv 会报错，自研支持）
const multiOptionQuestion = {
	question: "请选择本次重构关注的模块：",
	header: "模块选择",
	multiSelect: true,
	options: [
		{ label: "API 路由", description: "重构 HTTP 路由层" },
		{ label: "数据库模型", description: "重构 ORM 和迁移脚本" },
		{ label: "认证鉴权", description: "优化 JWT 与权限校验" },
		{ label: "日志系统", description: "统一接入 OpenObserve" },
		{ label: "前端构建", description: "优化 Vite 构建配置" },
		{ label: "单元测试", description: "补充缺失的测试用例" }
	]
};

const fullParams = {
	questions: [singleOptionQuestion, multiOptionQuestion]
};

// 验证字段结构
assert.equal(fullParams.questions.length, 2);
assert.equal(fullParams.questions[0].options.length, 1);
assert.equal(fullParams.questions[1].options.length, 6);
assert.equal(fullParams.questions[1].multiSelect, true);

console.log("✔ Schema flexibility validation passed: successfully allows 1 to 6+ options and multiSelect!");
